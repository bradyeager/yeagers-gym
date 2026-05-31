#!/usr/bin/env node
// Weekly Vagaro/Venmo billing reconciliation for Yeager's Gym.
// Runs Fridays in GitHub Actions. Emails Brad via Brevo with
// tap-to-action buttons (Venmo request, log cash, resolve review).

import fs from "node:fs/promises";
import path from "node:path";
import ical from "node-ical";
import { google } from "googleapis";
import {
  PALETTE, FONTS, GITHUB_OWNER, GITHUB_REPO, DEFAULT_BRANCH,
  requireEnv, resolveRepoRoot, loadClients, loadCashEntries,
  loadSchedule, findScheduleEntriesForSlot, isInactiveSlot,
  fuzzyName, fmtDate, fmtDateTime, fmtDateIso, slugify, parseNoteDate, withRetry,
  venmoRequestLink, githubNewFileUrl, sendBrevoEmail,
  emailShell, sectionLabel, button, buttonOutline, card,
} from "./lib.mjs";

const {
  VAGARO_ICAL_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  BREVO_API_KEY,
  RECIPIENT_EMAIL = "brad@bradyeager.com",
  SENDER_EMAIL = "brad@yeagersgym.com",
  SENDER_NAME = "Yeager's Gym Billing Bot",
  LOOKBACK_DAYS = "14",
  PAYMENT_LOOKBACK_DAYS = "21",
  DRY_RUN = "false",
} = process.env;

const LOOKBACK_MS = Number(LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - LOOKBACK_MS);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const CLIENTS_CSV = path.join(REPO_ROOT, "billing", "clients.csv");
const SCHEDULE_CSV = path.join(REPO_ROOT, "billing", "schedule.csv");
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");

// ---- Vagaro iCal ----

async function fetchVagaroAppointments() {
  const events = await withRetry(() => ical.async.fromURL(VAGARO_ICAL_URL), { label: "Vagaro iCal fetch" });
  const all = Object.values(events);
  const typeCounts = {};
  for (const ev of all) typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
  console.log(`iCal: ${all.length} total entries; types:`, typeCounts);

  const appts = [];
  let skippedCancelled = 0, skippedOld = 0, skippedFuture = 0, skippedNonBillable = 0;
  let addedSingle = 0, addedRecurring = 0;

  for (const ev of all) {
    if (ev.type !== "VEVENT") continue;
    if ((ev.status || "").toUpperCase() === "CANCELLED") { skippedCancelled++; continue; }

    const summary = (ev.summary || "").trim();
    const description = (ev.description || "").trim();

    // Skip non-billable events (personal tasks, lunch, errands, training blocks).
    // Billable Vagaro services always include a ratio like "1:1", "2:1", "3:1".
    if (!isBillableSession(summary)) { skippedNonBillable++; continue; }

    if (ev.rrule) {
      const occurrences = ev.rrule.between(WINDOW_START, NOW, true);
      for (const occ of occurrences) {
        appts.push({
          date: occ,
          summary,
          description,
          client_name: extractClientName(summary, description),
        });
        addedRecurring++;
      }
      continue;
    }

    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
    if (start < WINDOW_START) { skippedOld++; continue; }
    if (start > NOW) { skippedFuture++; continue; }

    appts.push({
      date: start,
      summary,
      description,
      client_name: extractClientName(summary, description),
    });
    addedSingle++;
  }

  console.log(`iCal filter: added ${addedSingle} single + ${addedRecurring} recurring; skipped ${skippedOld} old, ${skippedFuture} future, ${skippedCancelled} cancelled, ${skippedNonBillable} non-billable`);

  // Show first 3 events for diagnostics so we can tune extractClientName
  if (appts.length > 0) {
    console.log(`First ${Math.min(3, appts.length)} events:`);
    appts.slice(0, 3).forEach((a) =>
      console.log(`  ${a.date.toISOString()} | summary="${a.summary}" | desc="${a.description.slice(0, 80)}" | extracted_name="${a.client_name}"`),
    );
  } else {
    // Show first 3 RAW VEVENTs so we can see what they look like
    const rawVevents = all.filter((e) => e.type === "VEVENT").slice(0, 3);
    console.log(`No appointments in window. Sample of ${rawVevents.length} raw VEVENTs:`);
    rawVevents.forEach((e, i) => {
      console.log(`  [${i}] start=${e.start} status=${e.status || ""} rrule=${!!e.rrule} summary="${(e.summary || "").slice(0, 80)}"`);
    });
  }

  appts.sort((a, b) => a.date - b.date);
  return appts;
}

// Whitelist Vagaro service-type keywords. Ratio-only checks ("1:1", "2:1")
// were too lax — "Get Forrest & Aspen @ 2:40" slipped through. If Brad adds
// new service types in Vagaro, extend the keyword list here.
function isBillableSession(summary) {
  if (!summary) return false;
  if (/personal training/i.test(summary)) return true;
  if (/semi[-\s]?private/i.test(summary)) return true;
  return false;
}

function extractClientName(summary, description) {
  if (!summary) return "";
  const patterns = [
    /^([A-Z][a-zA-Z'\-]+(?:\s[A-Z][a-zA-Z'\-]+)+)\s*[-–—:]/,
    /with\s+([A-Z][a-zA-Z'\-]+(?:\s[A-Z][a-zA-Z'\-]+)+)/i,
    /w\/\s*([A-Z][a-zA-Z'\-]+(?:\s[A-Z][a-zA-Z'\-]+)+)/i,
  ];
  for (const re of patterns) {
    const m = summary.match(re);
    if (m) return m[1].trim();
  }
  if (description) {
    const m = description.match(/Client[:\s]+([A-Z][a-zA-Z'\-]+(?:\s[A-Z][a-zA-Z'\-]+)+)/);
    if (m) return m[1].trim();
  }
  return summary;
}

// ---- Gmail (Venmo receipts) ----

async function fetchVenmoPayments() {
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  // Broader sender match — Venmo sends from venmo@venmo.com,
  // notifications@venmo.com, no-reply@venmo.com, etc. Use the domain.
  // Payment window is wider than appointment window to catch late-arriving
  // emails and boundary cases (~8-day appt window + ~7 day matching slop).
  const query = `from:venmo.com "paid you" newer_than:${PAYMENT_LOOKBACK_DAYS}d`;
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 200 });
  const msgs = list.data.messages || [];
  const payments = [];
  for (const { id } of msgs) {
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const payment = parseVenmoEmail(full.data);
    if (payment) payments.push(payment);
  }
  return payments;
}

function parseVenmoEmail(msg) {
  const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  const subject = headers["subject"] || "";
  const dateHdr = headers["date"] || "";
  const snippet = msg.snippet || "";
  // Prefer the text/plain MIME part — cleaner than HTML, no DOCTYPE noise.
  const body = extractBody(msg.payload, "text/plain") || extractBody(msg.payload);
  // Handles both "Name paid you $X" (direct payment) and
  // "Name paid your $X request" (paid a request Brad sent them).
  const subjMatch = subject.match(/^(.+?)\s+paid your?\s+\$([\d,.]+)/i);
  if (!subjMatch) {
    if (subject.toLowerCase().includes("paid")) {
      console.log(`Venmo parser: skipping unrecognized subject "${subject}"`);
    }
    return null;
  }
  const sender_display_name = subjMatch[1].trim();
  const amount = Number(subjMatch[2].replace(/,/g, ""));
  // Only match the canonical Venmo profile URL. The "@username" fallback
  // grabbed CSS @media and other false positives.
  const handleMatch = (body + "\n" + snippet).match(/venmo\.com\/u\/([A-Za-z0-9._-]+)/i);
  const sender_handle = handleMatch ? handleMatch[1].toLowerCase() : "";
  const note = extractVenmoNote(body);
  const date = dateHdr ? new Date(dateHdr) : new Date();
  // Many clients write the session date in the memo ("5/19", "Missed session
  // 5/19", "Training w/Jeanette 5/8/26"). Extract it to pin late payments to
  // the right session.
  const noteDate = parseNoteDate(note, date.getUTCFullYear());
  return { sender_display_name, sender_handle, amount, note, noteDate, date, subject };
}

function extractBody(payload, mimeType = null) {
  if (!payload) return "";
  if (mimeType) {
    const part = findMimePart(payload, mimeType);
    return part?.body?.data ? Buffer.from(part.body.data, "base64").toString("utf8") : "";
  }
  const chunks = [];
  const walk = (p) => {
    if (p.body?.data) chunks.push(Buffer.from(p.body.data, "base64").toString("utf8"));
    if (p.parts) for (const sub of p.parts) walk(sub);
  };
  walk(payload);
  return chunks.join("\n");
}

function findMimePart(payload, mimeType) {
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  if (payload.parts) {
    for (const sub of payload.parts) {
      const found = findMimePart(sub, mimeType);
      if (found) return found;
    }
  }
  return null;
}

// Strip HTML tags + decode the most common entities. Block-level tags become
// newlines so a single-line HTML email turns into readable lines.
function stripHtml(s) {
  if (!s.includes("<")) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|li|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Pull the client-supplied note from a Venmo email body.
// Venmo splits the amount display across lines like:
//     "<sender> paid you"
//     "$"
//     "50"       (dollars)
//     "00"       (cents)
//     "<note>"   ← what we want
//     "See transaction"
// We strip HTML, then walk past the amount fragments and return the first
// non-fragment line that isn't transaction boilerplate.
function extractVenmoNote(body) {
  if (!body) return "";
  const text = stripHtml(body);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const paidIdx = lines.findIndex((l) => /paid your?\b/i.test(l));
  if (paidIdx < 0) return "";

  // Matches Venmo's split-amount fragments: "$", "50", "100", "00", ".00", ".25"
  const AMOUNT_FRAGMENT = /^(\$|\$?\d{1,4}|\.?\d{1,2})$/;
  const BOILERPLATE = /^(see (transaction|details|payment)|view|sent to|transaction|venmo|click|powered by|©|all rights|the venmo|paypal|money credited|estimated arrival|destination|date$|transaction id|@yeagersgym)/i;

  for (let i = paidIdx + 1; i < Math.min(paidIdx + 15, lines.length); i++) {
    const raw = lines[i];
    if (!raw) continue;
    if (raw.length > 140) continue;
    if (AMOUNT_FRAGMENT.test(raw)) continue;
    if (BOILERPLATE.test(raw)) continue;
    if (/paid your?\b/i.test(raw)) continue;  // Skip duplicate "X paid you" lines in HTML
    if (!/[A-Za-z0-9]/.test(raw)) continue;
    return raw.replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

// ---- Reconciliation ----

// Expand raw iCal slots into per-client appointments via the schedule.
// Each slot can produce N entries (one per client in that day+time).
// Slots not in the schedule produce one UNIDENTIFIED entry.
// Group iCal events by date+time. Schedule.csv is the source of truth
// for WHO attends a given slot — every active entry there gets billed.
// iCal events just confirm the session happened. If iCal has more events
// than schedule entries (a stranger booked into that slot), excess events
// → UNIDENTIFIED unless an INACTIVE marker covers the slot.
//
// This handles both:
//   - Single Vagaro booking covering multiple attendees (Senior Games 3:1)
//     → 1 iCal event + 3 schedule entries = 3 records, all billed.
//   - Separate parallel sessions at the same time (Mon 8am Peggy 2:1 +
//     michelle 1:1) → 2 iCal events + 2 schedule entries = 2 records.
export function expandSlots(slots, schedule) {
  const groups = new Map();
  for (const slot of slots) {
    const key = slot.date.toISOString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  const out = [];
  for (const group of groups.values()) {
    const entries = schedule.length ? findScheduleEntriesForSlot(schedule, group[0].date) : [];
    const hasInactive = schedule.length ? isInactiveSlot(schedule, group[0].date) : false;
    const n = group.length;
    const k = entries.length;

    // Bill every active schedule entry. If iCal has fewer events than
    // entries (e.g. Senior Games 1 booking → 3 attendees), entries share
    // an iCal event for slot context.
    for (let i = 0; i < k; i++) {
      const slot = group[Math.min(i, n - 1)];
      out.push({
        ...slot,
        client_name: entries[i].client_name,
        price_override: entries[i].price_override,
        unidentified: false,
      });
    }
    // Excess iCal events (more bookings than schedule) → UNIDENTIFIED
    // (suppressed when an INACTIVE marker is present at the slot).
    if (!hasInactive && n > k) {
      for (let i = k; i < n; i++) {
        out.push({ ...group[i], client_name: null, unidentified: true });
      }
    }
  }
  return out;
}

export function reconcile(appointments, payments, clients, cashLog) {
  const byVagaroName = new Map(clients.map((c) => [c.vagaro_name.toLowerCase(), c]));
  const usedPayments = new Set();
  const results = [];

  for (const appt of appointments) {
    if (appt.unidentified) {
      results.push({ appt, status: "UNIDENTIFIED_SLOT" });
      continue;
    }

    const roster = byVagaroName.get((appt.client_name || "").toLowerCase());

    if (!roster) {
      results.push({ appt, status: "UNKNOWN", note: `Client "${appt.client_name}" not in roster` });
      continue;
    }

    if (roster.prepaid) {
      const ppPrice = appt.price_override ?? roster.default_price;
      results.push({ appt, roster, status: "PAID_PREPAID", expectedPrice: ppPrice, checkoutAmount: ppPrice });
      continue;
    }

    // Schedule's price_override beats clients.csv default_price for
    // slot-specific pricing (e.g. group rate, Tuesday vs Thursday,
    // Jeanette $70 on Tue vs $50 on Fri).
    const expectedPrice = appt.price_override ?? roster.default_price;
    // Every amount the bot should treat as paid-in-full for this client:
    // the slot's expected price + any client-level valid_prices (couple solo
    // vs together, group vs alone). A $5 smoothie on top of any of these is
    // also accepted (handled in amountScore).
    const acceptablePrices = [...new Set([
      expectedPrice,
      ...(roster.acceptable_prices || []),
    ].filter((n) => n != null))];

    if (roster.pays_cash) {
      const cashHit = cashLog.find(
        (c) => sameDay(c.date, appt.date) && fuzzyName(c.name, roster.vagaro_name) >= 0.8,
      );
      if (cashHit) results.push({ appt, roster, status: "PAID_CASH", payment: cashHit, expectedPrice, checkoutAmount: expectedPrice });
      else results.push({ appt, roster, status: "CASH_PENDING", expectedPrice, checkoutAmount: expectedPrice });
      continue;
    }
    const candidates = payments
      .map((p, idx) => ({ p, idx }))
      .filter(({ idx }) => !usedPayments.has(idx))
      .filter(({ p }) => {
        const nameMatch = roster.venmo_handle && p.sender_handle === roster.venmo_handle.toLowerCase();
        const namesToCheck = roster.venmo_display_names?.length
          ? roster.venmo_display_names
          : [roster.vagaro_name];
        const displayMatch = namesToCheck.some(
          (name) => fuzzyName(p.sender_display_name, name) >= 0.8,
        );
        return nameMatch || displayMatch;
      })
      .filter(({ p }) => withinDateWindow(p.date, appt.date))
      .map(({ p, idx }) => ({
        p, idx,
        amountScore: acceptablePrices.length ? amountScore(p.amount, acceptablePrices) : 0.5,
        // 1 if the client wrote this session's date in the memo, else 0.
        noteDateMatch: p.noteDate && sameDay(p.noteDate, appt.date) ? 1 : 0,
        dateGap: Math.abs((new Date(p.date) - new Date(appt.date)) / (24 * 60 * 60 * 1000)),
      }))
      // Best amount first; then a memo that names this exact session date;
      // then the payment closest in time to the session.
      .sort((a, b) =>
        b.amountScore - a.amountScore ||
        b.noteDateMatch - a.noteDateMatch ||
        a.dateGap - b.dateGap);

    if (candidates.length === 0) {
      results.push({ appt, roster, status: "UNPAID", expectedPrice });
    } else {
      const best = candidates[0];
      if (best.amountScore >= 0.8) {
        usedPayments.add(best.idx);
        const checkoutAmount = matchedSessionPrice(best.p.amount, acceptablePrices);
        results.push({ appt, roster, status: "PAID_VENMO", payment: best.p, expectedPrice, checkoutAmount });
      } else {
        // Mark as used too — a NEEDS_REVIEW payment is still "spoken for" by
        // this session. Without this it doubles in the unmatched list.
        usedPayments.add(best.idx);
        results.push({
          appt, roster, status: "NEEDS_REVIEW",
          payment: best.p, expectedPrice,
          note: `Received $${best.p.amount}, expected $${expectedPrice}`,
        });
      }
    }
  }

  // ── SECOND PASS: reschedule auto-pairing ──
  // A client who moved to a non-standard time leaves an UNIDENTIFIED_SLOT
  // (a session with no schedule mapping) AND an unmatched payment (named, but
  // no session matched it). Pair them: for each leftover payment from a known
  // roster client, find an unidentified slot that same week whose amount fits
  // that client. This catches most reschedules without the Vagaro API.
  const resolveClient = (p) => clients.find((c) => {
    const handleMatch = c.venmo_handle && p.sender_handle === c.venmo_handle.toLowerCase();
    const names = c.venmo_display_names?.length ? c.venmo_display_names : [c.vagaro_name];
    return handleMatch || names.some((n) => fuzzyName(p.sender_display_name, n) >= 0.8);
  });
  const pairedSlots = new Set();
  payments.forEach((p, idx) => {
    if (usedPayments.has(idx)) return;
    const client = resolveClient(p);
    if (!client) return;
    const accept = client.acceptable_prices?.length ? client.acceptable_prices : [client.default_price];
    // Candidate unidentified slots this client's payment could cover.
    const cand = results
      .map((r, ri) => ({ r, ri }))
      .filter(({ r, ri }) => r.status === "UNIDENTIFIED_SLOT" && !pairedSlots.has(ri))
      .filter(({ r }) => withinDateWindow(p.date, r.appt.date))
      .filter(({ r }) => amountScore(p.amount, accept) >= 0.8 || (p.noteDate && sameDay(p.noteDate, r.appt.date)))
      .map(({ r, ri }) => ({
        r, ri,
        noteDateMatch: p.noteDate && sameDay(p.noteDate, r.appt.date) ? 1 : 0,
        dateGap: Math.abs((new Date(p.date) - new Date(r.appt.date)) / 86400000),
      }))
      .sort((a, b) => b.noteDateMatch - a.noteDateMatch || a.dateGap - b.dateGap);
    if (cand.length === 0) return;
    const { r, ri } = cand[0];
    pairedSlots.add(ri);
    usedPayments.add(idx);
    const exp = accept.find((a) => amountScore(p.amount, [a]) >= 0.8) ?? client.default_price;
    results[ri] = { appt: r.appt, roster: client, status: "PAID_VENMO", payment: p, expectedPrice: exp, checkoutAmount: exp, inferred: true };
  });

  const unmatchedPayments = payments.filter((_, idx) => !usedPayments.has(idx));
  return { results, unmatchedPayments };
}

// Which acceptable price did this payment actually satisfy? Strips the $5
// smoothie and snaps to the real session price (e.g. $75 → $70, $50 → $50).
// This is the amount Brad must enter in Vagaro's checkout. Returns null if
// nothing matched.
function matchedSessionPrice(received, acceptable) {
  const prices = (Array.isArray(acceptable) ? acceptable : [acceptable]).filter((n) => n != null);
  // Prefer an exact / smoothie / rounding match; fall back to closest.
  for (const p of prices) if (amountScore(received, [p]) >= 0.8) return p;
  return prices.length ? prices.reduce((a, b) => (Math.abs(b - received) < Math.abs(a - received) ? b : a)) : null;
}

// `acceptable` is an array of valid full-payment amounts for this session.
// Returns 1 (paid in full) if `received` equals any acceptable amount, that
// amount + $5 (protein smoothie), an exact multiple (package pre-pay), or is
// within $2 (rounding). Otherwise 0.5 → NEEDS_REVIEW.
function amountScore(received, acceptable) {
  const prices = Array.isArray(acceptable) ? acceptable : [acceptable];
  for (const expected of prices) {
    if (!expected) continue;
    if (received === expected) return 1;
    if (received === expected + 5) return 1;           // smoothie add-on
    const ratio = received / expected;
    if (Math.abs(ratio - Math.round(ratio)) < 0.02 && ratio >= 1) return 1; // package
    if (Math.abs(received - expected) <= 2) return 1;  // rounding
  }
  return 0.5;
}

function sameDay(a, b) {
  const ad = new Date(a), bd = new Date(b);
  return ad.getFullYear() === bd.getFullYear() && ad.getMonth() === bd.getMonth() && ad.getDate() === bd.getDate();
}

// Payment can be up to 7 days BEFORE session (prepay) or 14 days AFTER
// (late payment). Tunable if real-world data shows other patterns.
function withinDateWindow(payDate, apptDate) {
  const diff = (payDate - apptDate) / (24 * 60 * 60 * 1000);
  return diff >= -7 && diff <= 14;
}

// ---- Email building ----

function cashEntryLink({ date, name, amount, note = "per weekly billing email" }) {
  const iso = fmtDateIso(date);
  const slug = slugify(name);
  const filename = `billing/cash-entries/${iso}-${slug}.md`;
  const value = `${iso} | ${name} | $${amount} | ${note}\n`;
  return githubNewFileUrl({ filename, value, message: `Cash: ${name} $${amount} ${iso}` });
}

function reviewResolutionLink({ date, name, disposition, detail }) {
  const iso = fmtDateIso(date);
  const slug = slugify(name);
  const filename = `billing/review-resolutions/${iso}-${slug}-${disposition}.md`;
  const value = `${iso} | ${name} | ${disposition} | ${detail}\n`;
  return githubNewFileUrl({ filename, value, message: `Review: ${name} ${disposition}` });
}

export function buildEmail({ results, unmatchedPayments, now = NOW, windowStart = WINDOW_START }) {
  // "This week" = the 7 days ending at the run (last Sat → this Fri for a
  // Friday run). Anything older that's still open is a carryover from a
  // prior week → surfaced first under "Lagging Indicators".
  const THIS_WEEK_START = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isLagging = (r) => new Date(r.appt.date) < THIS_WEEK_START;

  const unpaidAll = results.filter((r) => r.status === "UNPAID");
  const reviewAll = results.filter((r) => r.status === "NEEDS_REVIEW");
  const unknown = results.filter((r) => r.status === "UNKNOWN");
  const unidentified = results.filter((r) => r.status === "UNIDENTIFIED_SLOT");
  const paidVenmo = results.filter((r) => r.status === "PAID_VENMO");
  const paidCash = results.filter((r) => r.status === "PAID_CASH");
  const paidPrepaid = results.filter((r) => r.status === "PAID_PREPAID");
  const cashPending = results.filter((r) => r.status === "CASH_PENDING");

  // Split open items into carryover (lagging) vs current week.
  const lagging = [...unpaidAll, ...reviewAll].filter(isLagging)
    .sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date));
  const unpaid = unpaidAll.filter((r) => !isLagging(r));
  const review = reviewAll.filter((r) => !isLagging(r));

  const weekLabel = `${fmtDate(THIS_WEEK_START)} – ${fmtDate(now)}`;
  const subjParts = [];
  if (lagging.length) subjParts.push(`${lagging.length} carryover`);
  subjParts.push(`${unpaid.length} unpaid`);
  subjParts.push(`${review.length} review`);
  const subject = `Weekly billing — week ending ${fmtDate(now)} — ${subjParts.join(", ")}`;

  // ---- Reusable card renderers ----

  // Genuinely-short amount = below every acceptable price.
  const shortfall = (r) => {
    const accept = (r.roster?.acceptable_prices?.length ? r.roster.acceptable_prices : [r.expectedPrice]).filter((n) => n != null);
    const minAccept = accept.length ? Math.min(...accept) : (r.expectedPrice || 0);
    const recv = r.payment?.amount || 0;
    return minAccept - recv; // >0 means short
  };

  const unpaidCard = (r) => {
    const price = r.expectedPrice || r.roster?.default_price || "?";
    const handle = r.roster?.venmo_handle;
    const noteText = `Training ${fmtDate(r.appt.date)} — Yeager's Gym`;
    const requestUrl = handle ? venmoRequestLink(handle, price, noteText) : "";
    const cashUrl = cashEntryLink({ date: r.appt.date, name: r.roster.vagaro_name, amount: price });
    let inner = `<div style="font-family:${FONTS.body};font-size:15px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(r.roster.vagaro_name)}</strong> — ${fmtDate(r.appt.date)} — $${price}</div>`;
    inner += `<div style="margin-top:10px;">`;
    if (requestUrl) inner += button({ href: requestUrl, label: `Request $${price} on Venmo`, color: "pink" });
    else inner += `<span style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;">Add Venmo handle in clients.csv to enable request</span> `;
    inner += buttonOutline({ href: cashUrl, label: "Log as cash", color: "teal" });
    inner += `</div>`;
    return card(inner, "pink");
  };

  const reviewCard = (r) => {
    const expected = r.expectedPrice || r.roster?.default_price || 0;
    const received = r.payment?.amount || 0;
    const name = r.roster.vagaro_name;
    const handle = r.roster?.venmo_handle;
    const short = shortfall(r);
    let inner = `<div style="font-family:${FONTS.body};font-size:15px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(name)}</strong> — ${fmtDate(r.appt.date)}</div>`;
    inner += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-bottom:10px;">Expected $${expected} · received $${received}${r.payment?.note ? ` · "${escapeHtml(r.payment.note)}"` : ""}${short > 0 ? ` · short $${short}` : received > expected ? ` · over $${received - expected}` : ""}</div>`;
    // Only actionable button: request the shortfall via Venmo (no GitHub).
    if (short > 0 && handle) {
      inner += `<div>` + button({
        href: venmoRequestLink(handle, short, `Balance from training ${fmtDate(r.appt.date)} — Yeager's Gym`),
        label: `Request $${short} balance`,
        color: "pink",
      }) + `</div>`;
    } else {
      inner += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textDim};">Eyeball only — no action needed if this looks right.</div>`;
    }
    return card(inner, "teal");
  };

  let body = "";

  // Top-line summary strip
  body += `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;">`;
  if (lagging.length) body += statChip(lagging.length, "carryover", "pink");
  body += statChip(unpaid.length, "unpaid", unpaid.length ? "pink" : "textMuted");
  body += statChip(review.length, "review", review.length ? "teal" : "textMuted");
  body += statChip(paidVenmo.length + paidCash.length + paidPrepaid.length, "paid", "teal");
  if (unidentified.length) body += statChip(unidentified.length, "unidentified", "teal");
  body += `</div>`;

  // One-time UX hint: pink "Request" buttons open Venmo; teal "Log as cash"
  // buttons open GitHub (sign in once, check "keep me signed in").
  if (lagging.length || unpaid.length) {
    body += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textDim};margin-bottom:18px;">Pink buttons open Venmo. Teal "Log as cash" opens GitHub — sign in once and it remembers you.</div>`;
  }

  // ---- LAGGING INDICATORS (carryover from prior weeks) ----
  if (lagging.length) {
    body += sectionLabel(`⚠ Lagging Indicators — ${lagging.length} (from last week)`, "pink");
    body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:12px;">Open items carried over from a prior week. Clear these first.</div>`;
    for (const r of lagging) {
      body += r.status === "UNPAID" ? unpaidCard(r) : reviewCard(r);
    }
    body += `<hr class="glow" style="border:none;border-top:1px solid ${PALETTE.border};margin:24px 0;">`;
  }

  // ---- THIS WEEK ----
  // UNPAID
  if (unpaid.length) {
    body += sectionLabel(`Unpaid — ${unpaid.length}`, "pink");
    for (const r of unpaid) body += unpaidCard(r);
  }

  // NEEDS REVIEW
  if (review.length) {
    body += sectionLabel(`Needs review — ${review.length}`, "teal");
    for (const r of review) body += reviewCard(r);
  }

  // UNIDENTIFIED SLOTS
  if (unidentified.length) {
    body += sectionLabel(`Unidentified slots — ${unidentified.length}`, "teal");
    body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:12px;">A session ran at a time not mapped in schedule.csv. If it's a real client, add them; otherwise ignore.</div>`;
    for (const r of unidentified) {
      const summary = r.appt.summary || "(no title)";
      body += card(
        `<div style="color:${PALETTE.textPrimary};"><strong>${fmtDateTime(r.appt.date)}</strong></div><div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-top:4px;">${escapeHtml(summary)}</div>`,
        "teal",
      );
    }
  }

  // UNKNOWN
  if (unknown.length) {
    body += sectionLabel(`Unknown clients — ${unknown.length}`, "teal");
    for (const r of unknown) {
      body += card(
        `<div style="color:${PALETTE.textPrimary};">${fmtDate(r.appt.date)} — "${escapeHtml(r.appt.summary)}"</div><div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-top:4px;">${escapeHtml(r.note || "")}. Add to clients.csv.</div>`,
        "teal",
      );
    }
  }

  // CASH / CHECK / ZEAL — informational, no action needed (these clients pay
  // outside Venmo on a regular cadence; only the exception matters).
  if (cashPending.length) {
    body += sectionLabel(`Expected via check / Zeal / cash — ${cashPending.length}`, "teal");
    body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:10px;">No action needed — these clients pay outside Venmo. Listed so you can spot anyone who didn't.</div>`;
    for (const r of cashPending) {
      const price = r.expectedPrice ?? r.roster.default_price ?? "?";
      body += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};padding:4px 0;border-bottom:1px solid ${PALETTE.border};">${fmtDate(r.appt.date)} · ${escapeHtml(r.roster.vagaro_name)} · $${price}</div>`;
    }
  }

  // RESCHEDULED — auto-matched a known client's payment to a session that ran
  // at a non-standard time. Shown separately so Brad can confirm at a glance.
  const inferred = [...paidVenmo].filter((r) => r.inferred);
  if (inferred.length) {
    body += sectionLabel(`Rescheduled — auto-matched ${inferred.length} (confirm)`, "teal");
    body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:10px;">A session ran at a non-standard time; the bot paired it to this client's payment by name + amount. Glance to confirm.</div>`;
    for (const r of inferred) {
      body += `<div style="font-family:${FONTS.display};font-size:13px;color:${PALETTE.textPrimary};padding:5px 0;border-bottom:1px solid ${PALETTE.border};">${escapeHtml(r.roster.vagaro_name)} · ${fmtDateTime(r.appt.date)} · $${r.payment?.amount} <span style="color:${PALETTE.textMuted};">${escapeHtml(r.appt.summary || "")}${r.payment?.note ? ` · "${escapeHtml(r.payment.note)}"` : ""}</span></div>`;
    }
  }

  // PAID (collapsed)
  const allPaid = [...paidVenmo, ...paidCash, ...paidPrepaid];
  if (allPaid.length) {
    body += sectionLabel(`Paid — ${allPaid.length}`, "teal");
    const names = allPaid.map((r) => {
      const tag = r.status === "PAID_CASH" ? " (cash)" : r.status === "PAID_PREPAID" ? " (prepaid)" : r.inferred ? " (moved)" : "";
      return escapeHtml(r.roster.vagaro_name) + tag;
    }).join(", ");
    body += `<div style="color:${PALETTE.textMuted};font-size:14px;line-height:1.6;margin-bottom:10px;">${names}</div>`;
  }

  // UNMATCHED PAYMENTS (with their memos, so Brad can hand-assign)
  if (unmatchedPayments.length) {
    body += sectionLabel(`Unmatched Venmo payments — ${unmatchedPayments.length}`, "textMuted");
    for (const p of unmatchedPayments) {
      body += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};padding:4px 0;border-bottom:1px solid ${PALETTE.border};">${fmtDate(p.date)} · ${escapeHtml(p.sender_display_name)} · $${p.amount} · "${escapeHtml(p.note || "")}"</div>`;
    }
  }

  // ── VAGARO CHECKOUT PROMPT — auto-generated for Claude for Chrome ──
  // Brad uses Vagaro's calendar "checkout" UI as a visual paid-checkmark.
  // The bot already knows who paid this week, so we render the full
  // copy-paste prompt with the client list pre-filled at the bottom of the
  // email. Canonical rules live at billing/CHECKOUT-PROMPT.md.
  const checkoutPrompt = buildCheckoutPrompt(results, now);
  body += sectionLabel(`Vagaro Checkout — copy block below into Claude for Chrome`, "teal");
  body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:8px;">Triple-click inside the box, ⌘A, ⌘C, then paste into a new Claude for Chrome session. Full rules + this week's paid clients are baked in.</div>`;
  body += `<pre style="background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:6px;padding:14px;font-family:${FONTS.display};font-size:12px;line-height:1.45;color:${PALETTE.textPrimary};white-space:pre-wrap;overflow-x:auto;">${escapeHtml(checkoutPrompt)}</pre>`;

  const footer = `Week ${weekLabel} · log: billing/logs/${fmtDateIso(now)}.md · ${GITHUB_OWNER}/${GITHUB_REPO}`;
  const html = emailShell({ title: `Week ending ${fmtDate(now)}`, bodyHtml: body, footerNote: footer });
  return { subject, html };
}

// ── Vagaro checkout prompt for Claude for Chrome ──
// Returns the full prompt (rules + this week's paid client list) as plain
// text so Brad can copy-paste a single block into a fresh chat each week.
function buildCheckoutPrompt(results, now) {
  const paid = results.filter((r) =>
    r.status === "PAID_VENMO" || r.status === "PAID_CASH" || r.status === "PAID_PREPAID",
  );
  // Group by local date (Pacific). Most recent day first so checkout walks
  // backwards Fri → Mon as Brad prefers.
  const byDate = new Map();
  for (const r of paid) {
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(r.appt.date));
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }
  const dayKeys = [...byDate.keys()].sort().reverse();

  const lines = [];
  for (const key of dayKeys) {
    const label = new Date(key + "T20:00:00Z").toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles", weekday: "long", month: "numeric", day: "numeric",
    });
    lines.push("");
    lines.push(`${label}:`);
    // Sort earliest session first within the day
    byDate.get(key).sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date));
    for (const r of byDate.get(key)) {
      const name = r.roster.vagaro_name;
      // Amount Brad must ENTER in Vagaro = the real session price the client
      // paid (solo vs together), smoothie stripped. Falls back to expected.
      const amt = r.checkoutAmount ?? r.expectedPrice ?? r.roster.default_price ?? "?";
      const time = new Date(r.appt.date).toLocaleTimeString("en-US", {
        timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
      });
      const notes = [];
      // Vagaro likely shows the slot's configured price; if the amount-to-enter
      // differs (2:1 client trained solo, couple where one came), Claude must
      // EDIT Vagaro's total first or Vagaro blocks the checkout.
      const configured = r.expectedPrice ?? r.roster.default_price;
      if (typeof amt === "number" && typeof configured === "number" && amt !== configured) {
        notes.push(`⚠ ADJUST TOTAL: Vagaro likely shows $${configured}; change the total to $${amt} before entering cash`);
      }
      if (r.status === "PAID_PREPAID") notes.push("prepaid — still check off; use Vagaro's shown amount or $0");
      else if (r.inferred) notes.push("rescheduled — verify the calendar name matches before checkout");
      else if (r.payment?.sender_display_name) {
        const sender = r.payment.sender_display_name;
        const senderFirst = sender.split(" ")[0].toLowerCase();
        const clientFirst = name.split(" ")[0].toLowerCase();
        if (senderFirst !== clientFirst && !sender.toLowerCase().includes(clientFirst)) {
          notes.push(`paid by ${sender}`);
        }
      }
      const ctx = notes.length ? "\n      ↳ " + notes.join("\n      ↳ ") : "";
      lines.push(`  • ${time}  ${name} — enter $${amt}${ctx}`);
    }
  }

  return CHECKOUT_RULES + "\n\n==== PAID CLIENTS THIS WEEK (work backwards) ====" +
    (lines.length ? "\n" + lines.join("\n") : "\n  (none — nothing to check off)");
}

const CHECKOUT_RULES = `WEEKLY VAGARO CHECKOUT — YEAGER'S GYM

ROLE: You are Claude in Brad's Chrome browser. Brad is logged into Vagaro.
TASK: Mark each paid client below as "checked out" in Vagaro's calendar so
they show as paid. Brad uses cash as a universal paid-marker (intentional —
the real money already came via Venmo / check / Zeal; Vagaro's payment-method
field is just a visual checkmark for him).

URL: https://us05.vagaro.com/merchants/calendar/v3

WORK ORDER: most-recent day → oldest day (the list below is already in that
order). Use the calendar's < arrow to step back one day at a time.

═══ HARD RULES ═══
1. Payment method is ALWAYS "Cash". Never ask, never use any other method.
2. The "enter $X" amount in the list is the SOURCE OF TRUTH. Vagaro's
   checkout screen often shows a DIFFERENT default total — most commonly when
   a 2:1 / couple client trained SOLO that day (Vagaro shows the $50 pair
   rate, but they owe $70 alone). When the list amount differs from Vagaro's
   shown total you MUST CHANGE VAGARO'S TOTAL FIRST, then pay:
     a. On the checkout screen, edit the line-item/price (or the Total) so the
        total equals the list amount. Do NOT change the service TYPE — Brad
        doesn't care that it still says "2:1"; only the dollar total matters.
     b. Then enter that same amount in the Cash field.
     c. Confirm Total = Cash = Amount Paid = list amount, Change Due = $0.00.
   If you skip step (a), Vagaro records an over/under-payment and WON'T let
   you finish. Lines needing this are flagged "⚠ ADJUST TOTAL" below.
3. Do NOT delete any appointments. Brad handles deletions.
4. Do NOT touch sessions that aren't on the list. If a calendar slot exists
   but isn't on the list, leave it alone — it's either unpaid (Brad will
   chase) or someone else's category.
5. If a session already shows a green check / "Checked out" status, skip
   and note it in the summary as "already done".
6. If a client's name doesn't match anything on the calendar that day, skip
   and log it as MISSING — never guess.

═══ NICKNAME / NAMING MAP ═══
Many clients' Vagaro calendar name differs from their Venmo / nickname:
• Lisa, Leesha               → Lisa Knievel
• Tawny, Tani                → Tonnie Dahl
• Carrie                     → Kerry Kreczmer
• Michelle                   → michelle Delorenza  (yes, lowercase m in Vagaro)
• Mathieu, Celestin          → Celestin Mathieu
• Laci                       → Lacey James
• Katie, Kate                → Katelin Lowther
• Adriana Duty               → "Danny Duty" on the calendar  (Adriana is his wife and pays)
• Julio                      → "Melissa Rios" on the calendar (Julio is her husband)
• David, Mudroom, Mudroom Backpacks → "Annie Deioma" on the calendar
                                       (David is her husband; pays via business Venmo)
• James Lowther              → "Katelin Lowther" on the calendar (Katelin's husband)

═══ SESSION-LEVEL CONTEXT (so you don't get confused) ═══
• Tue 8 AM is a 5-PERSON TEAM session: Peggy, Tonnie, Robert, Annie, David.
  Each is $40. David shares Annie's calendar block (they're a couple).
  Mudroom pays $80 covering both Annie + David in one transaction.
• Wed 9 AM is Rachel Bertholino. Her husband Mathieu pays (Venmo shows
  "Celestin Mathieu").
• Wed 10 AM is Annie Deioma (couple 2:1 with David). Mudroom pays.
• Mon 9 AM is a 3:1 group: Dina + Anna + Katelin — each $45.
• Mon 8 AM has TWO sessions at the same time: Peggy (2:1, $50) and
  Michelle (1:1, $70). They're different calendar blocks.
• Couples (Danny+Adriana, Melissa+Julio, Annie+David): one payment covers
  the calendar block; don't look for a second.
• Robert Brower is prepaid for all of 2026. Still check him off — use
  whatever Vagaro shows as the amount, or $0 if it's blank.

═══ CHECKOUT STEPS (per appointment) ═══
1. Navigate to the target day on the calendar (use the < arrow at top).
2. Click the appointment block for the named client.
3. When the popup opens, click the green "Checkout" button at the bottom
   right of the popup. Fallback if you can't see it:
   document.querySelector('BUTTON.vg-tk-btn.vg-btn-primary').click()
4. On the checkout screen, verify the client name matches.
5. Find the Cash field, triple-click to select, type the amount from the
   list (no $ sign, no decimal — e.g., 70 not $70.00), press Tab.
6. Verify: Cash = list amount, Amount Paid = list amount, Change Due = $0.00.
7. Click the green Checkout button.
8. Click Done → Go to Calendar.

═══ FAILURE / EDGE CASES ═══
• If Vagaro's UI looks different than described (update, new screen): STOP
  and tell Brad what you see. Do not improvise.
• If two clients with the same first name appear at similar times: confirm
  with Brad before processing either.
• If a "Senior Games" / "Team" 5-person Tue 8am session shows on the
  calendar, check off each listed attendee individually (Vagaro will have
  separate blocks for each, or one block with attendees — confirm).

═══ OUTPUT WHEN DONE ═══
Summarize:
  ✅ Checked out: N / total
  ⏭ Skipped (already done): list of names
  ❌ MISSING (on list but no calendar match): list of names + dates
  ⚠ Failed / errored: list with reason

Brad will review and handle exceptions manually.`;

function statChip(n, label, color = "teal") {
  const c = PALETTE[color] || PALETTE.teal;
  const glow = n > 0 ? `box-shadow:0 0 0 1px ${c}22, 0 8px 24px -14px ${c};` : "";
  return `<div style="flex:1;min-width:104px;background:linear-gradient(155deg,${PALETTE.bgPanel} 0%,#101018 100%);border:1px solid ${PALETTE.border};border-top:3px solid ${c};border-radius:9px;padding:13px 15px;${glow}">`
    + `<div style="font-family:${FONTS.display};font-size:30px;font-weight:800;color:${c};line-height:1;text-shadow:0 0 14px ${c}55;">${n}</div>`
    + `<div style="font-family:${FONTS.display};font-size:10px;text-transform:uppercase;letter-spacing:0.18em;color:${PALETTE.textMuted};margin-top:7px;">${label}</div></div>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Log file ----

async function writeLog({ appointments, payments, results, unmatchedPayments }) {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `${fmtDateIso(NOW)}.md`);
  let md = `# Weekly billing log — ${fmtDateIso(NOW)}\n\n`;
  md += `Window: ${WINDOW_START.toISOString()} → ${NOW.toISOString()}\n\n`;
  md += `## Appointments (${appointments.length})\n`;
  for (const r of results) {
    const name = r.roster?.vagaro_name || r.appt.client_name || `[unidentified: ${r.appt.summary || "?"}]`;
    const price = r.expectedPrice ?? r.roster?.default_price ?? "?";
    md += `- ${fmtDateTime(r.appt.date)} | ${name} | $${price} | ${r.status}`;
    if (r.payment) {
      const ident = r.payment.sender_handle
        ? `@${r.payment.sender_handle}`
        : `"${r.payment.sender_display_name || r.payment.name || "?"}"`;
      const noteSuffix = r.payment.note ? `, note: "${r.payment.note}"` : "";
      md += ` (matched ${ident}, $${r.payment.amount}${noteSuffix})`;
    }
    if (r.inferred) md += ` [INFERRED reschedule]`;
    if (r.note) md += ` — ${r.note}`;
    md += `\n`;
  }
  md += `\n## Venmo payments received (${payments.length})\n`;
  for (const p of payments) {
    md += `- ${fmtDateIso(p.date)} | ${p.sender_display_name} (@${p.sender_handle || "?"}) | $${p.amount} | "${p.note}"\n`;
  }
  if (unmatchedPayments.length) {
    md += `\n## Unmatched Venmo payments\n`;
    for (const p of unmatchedPayments) {
      md += `- ${fmtDateIso(p.date)} | ${p.sender_display_name} | $${p.amount} | "${p.note}"\n`;
    }
  }
  const counts = {
    paid_venmo: results.filter((r) => r.status === "PAID_VENMO").length,
    paid_cash: results.filter((r) => r.status === "PAID_CASH").length,
    paid_prepaid: results.filter((r) => r.status === "PAID_PREPAID").length,
    unpaid: results.filter((r) => r.status === "UNPAID").length,
    needs_review: results.filter((r) => r.status === "NEEDS_REVIEW").length,
    cash_pending: results.filter((r) => r.status === "CASH_PENDING").length,
    unknown: results.filter((r) => r.status === "UNKNOWN").length,
    unidentified: results.filter((r) => r.status === "UNIDENTIFIED_SLOT").length,
  };
  md += `\n## Summary\n`;
  for (const [k, v] of Object.entries(counts)) md += `- ${k}: ${v}\n`;
  await fs.writeFile(file, md, "utf8");
  return file;
}

// ---- Main ----

async function main() {
  requireEnv("VAGARO_ICAL_URL", VAGARO_ICAL_URL);
  requireEnv("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID);
  requireEnv("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET);
  requireEnv("GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN);
  requireEnv("BREVO_API_KEY", BREVO_API_KEY);
  console.log(`Window: ${WINDOW_START.toISOString()} → ${NOW.toISOString()}`);
  const [clients, schedule, cashLog, rawSlots, payments] = await Promise.all([
    loadClients(CLIENTS_CSV),
    loadSchedule(SCHEDULE_CSV),
    loadCashEntries(REPO_ROOT),
    fetchVagaroAppointments(),
    fetchVenmoPayments(),
  ]);
  console.log(`Loaded ${clients.length} clients, ${schedule.length} schedule rows, ${cashLog.length} cash entries`);
  console.log(`Found ${rawSlots.length} slots, ${payments.length} Venmo payments`);

  const appointments = expandSlots(rawSlots, schedule);
  const identified = appointments.filter((a) => !a.unidentified).length;
  const unidentified = appointments.length - identified;
  console.log(`Schedule lookup: ${identified} identified + ${unidentified} unidentified slots`);

  const { results, unmatchedPayments } = reconcile(appointments, payments, clients, cashLog);

  // The Gmail window is wider than the appointment window to catch
  // late-arriving emails near the boundary. Payments older than the
  // appointment window legitimately won't match any session here, so
  // suppress them from the email (still kept in the log for audit).
  const unmatchedInWindow = unmatchedPayments.filter((p) => new Date(p.date) >= WINDOW_START);

  const { subject, html } = buildEmail({ results, unmatchedPayments: unmatchedInWindow });
  const logFile = await writeLog({ appointments, payments, results, unmatchedPayments });
  console.log(`Wrote log: ${logFile}`);
  // Dump log to console for easy review (dry-run never commits the file).
  console.log("\n=== LOG FILE CONTENTS ===");
  console.log(await fs.readFile(logFile, "utf8"));
  console.log("=== END LOG ===\n");
  await sendBrevoEmail({
    apiKey: BREVO_API_KEY,
    to: RECIPIENT_EMAIL,
    from: SENDER_EMAIL,
    fromName: SENDER_NAME,
    subject,
    html,
    dryRun: DRY_RUN === "true",
  });
  console.log(DRY_RUN === "true" ? `Dry run — no email sent. Subject: ${subject}` : `Sent email: ${subject}`);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Fatal error:", err);
    if (DRY_RUN !== "true" && BREVO_API_KEY) {
      try {
        await sendBrevoEmail({
          apiKey: BREVO_API_KEY,
          to: RECIPIENT_EMAIL,
          from: SENDER_EMAIL,
          fromName: SENDER_NAME,
          subject: "Weekly billing — FAILED",
          html: emailShell({
            title: "Weekly billing run failed",
            bodyHtml: `<div style="color:${PALETTE.danger};font-family:${FONTS.body};margin-bottom:16px;">Run failed at ${NOW.toISOString()}.</div><pre style="background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:6px;padding:12px;color:${PALETTE.textPrimary};font-family:${FONTS.display};font-size:12px;overflow-x:auto;">${escapeHtml(String(err.stack || err).slice(0, 2000))}</pre><div style="color:${PALETTE.textMuted};margin-top:16px;font-size:13px;">Check GitHub Actions logs: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions</div>`,
          }),
        });
      } catch (_) { /* ignore */ }
    }
    process.exit(1);
  });
}
