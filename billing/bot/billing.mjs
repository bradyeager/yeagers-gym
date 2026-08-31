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
  requireEnv, resolveRepoRoot, loadClients, loadCashEntries, loadExternalUnpaid, loadCancellations,
  loadMatchedLedger, saveMatchedLedger, loadPaymentDrivenRunDates,
  loadSchedule, loadScheduleOverrides, findScheduleEntriesForSlot, isInactiveSlot,
  findScheduleOverrideEntriesForSlot, hasScheduleOverrideForSlot, isInactiveScheduleOverrideSlot,
  fuzzyName, fmtDate, fmtDateTime, fmtDateIso, fmtDateIsoPacific, slugify,
  parseNoteDate, parseNoteDates, enumeratesDates, withRetry,
  venmoRequestLink, githubNewFileUrl, sendBrevoEmail,
  emailShell, sectionLabel, button, buttonOutline, card, NEON_GRADIENT,
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
  BILLING_AS_OF = "", // preview/replay only; production schedule leaves blank
  // Phase 3: where appointments come from.
  //   "ical"          (default) — legacy Vagaro iCal feed via schedule.csv.
  //   "vagaro-events"           — read billing/vagaro-events/*.json (live webhook).
  // ROLLOUT SAFETY: the committed default is "ical" so an unset env (and the
  // scheduled Friday runs) keep using the proven path until Brad validates the
  // vagaro-events path via a manual workflow_dispatch dry-run. The workflow
  // passes APPOINTMENT_SOURCE explicitly from its input; this default only
  // matters when the env is absent.
  APPOINTMENT_SOURCE = "ical",
  // Phase 4: HOW the bot decides who owes money.
  //   "schedule"        (default) — the proven path: fetch a roster of
  //                     appointments (iCal or events), then reconcile each
  //                     against Venmo. Requires a schedule to exist.
  //   "payment-driven"            — NO schedule. Drive everything from actual
  //                     Venmo payments + payment HISTORY (the ledger). Money in
  //                     is what arrived this week; the chase list is computed
  //                     from each client's historical payment cadence.
  // ROLLOUT SAFETY: committed default is "schedule" so the live Friday cron and
  // any unset env keep running the proven behavior until Brad flips the flag via
  // a manual workflow_dispatch dry-run. Reversible — flip the input back to
  // "schedule" and nothing changes.
  BILLING_MODE = "schedule",
} = process.env;

const LOOKBACK_MS = Number(LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
const NOW = BILLING_AS_OF ? new Date(BILLING_AS_OF) : new Date();
if (Number.isNaN(NOW.getTime())) throw new Error(`Invalid BILLING_AS_OF: ${BILLING_AS_OF}`);
const WINDOW_START = new Date(NOW.getTime() - LOOKBACK_MS);
// Payment-driven "this week" money-in window: the 7 days ending at the run.
const PD_WINDOW_DAYS = 7;
const PD_WINDOW_START = new Date(NOW.getTime() - PD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const CLIENTS_CSV = path.join(REPO_ROOT, "billing", "clients.csv");
const SCHEDULE_CSV = path.join(REPO_ROOT, "billing", "schedule.csv");
const SCHEDULE_OVERRIDES_CSV = path.join(REPO_ROOT, "billing", "schedule-overrides.csv");
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");
const VAGARO_EVENTS_DIR = path.join(REPO_ROOT, "billing", "vagaro-events");
const VAGARO_CUSTOMERS_JSON = path.join(REPO_ROOT, "billing", "vagaro-customers.json");

// ---- Vagaro appointments (dispatcher) ----
//
// Phase 3: committed default source is the legacy iCal feed (proven path).
// Set APPOINTMENT_SOURCE=vagaro-events to read the live webhook event archive
// in billing/vagaro-events/*.json once that path is validated.

async function fetchVagaroAppointments() {
  if (APPOINTMENT_SOURCE === "ical") {
    return fetchVagaroAppointmentsFromIcal();
  }
  return fetchVagaroAppointmentsFromEvents();
}

// ---- Vagaro iCal (legacy fallback) ----

async function fetchVagaroAppointmentsFromIcal() {
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

// ---- Vagaro events (Phase 3 — live webhook feed) ----
//
// Each file in billing/vagaro-events/ is one Vagaro webhook envelope:
//   { id, createdDate, type, action, payload: { ... } }
// We only care about type==="appointment" — type==="transaction" and
// type==="customer" tell us about cash/CC payments and roster changes,
// not slot existence.
//
// One appointmentId can fire multiple events (created → modified → deleted).
// We dedupe and keep the LATEST per appointmentId (by modifiedDate ||
// createdDate || envelope createdDate || file mtime). If the latest event
// is a cancellation (action "deleted" or bookingStatus indicating cancel),
// we DROP the appointment — this replaces per-file billing/cancellations/*.md
// for any Vagaro-side cancellation.

async function loadVagaroCustomerMap() {
  try {
    const raw = await fs.readFile(VAGARO_CUSTOMERS_JSON, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// Action strings (from the envelope) that DROP an appointment outright.
// Real enum observed: "created", "deleted", "updated" (NOT "modified").
// Matched generically so any future cancel-ish verb is caught.
function isCancelAction(action) {
  if (!action) return false;
  return /delete|cancel|no.?show/i.test(String(action));
}

// bookingStatus enum strings that mean "don't bill this slot."
// Observed in real payloads: "Deleted", "Service Completed", "Accepted".
// Defensive coverage of values Vagaro uses elsewhere in its API: "Cancelled",
// "No Show", "Late Cancel". Case-insensitive substring match so minor spelling
// drift won't slip cancellations through as billable.
function isCancelledStatus(status) {
  if (!status) return false;
  return /delete|cancel|no.?show/i.test(String(status));
}

// True if THIS single event marks the appointment as cancelled — by action
// (deleted/cancelled/no-show) OR bookingStatus (Deleted/Cancelled/No Show/etc).
function eventIsCancellation(env) {
  const p = env.payload || {};
  return isCancelAction(env.action) || isCancelledStatus(p.bookingStatus);
}

// Sort key for "latest" event per appointmentId. Higher = newer.
// Vagaro stamps modifiedDate when an existing appointment is updated, falls
// back to payload.createdDate, then to the envelope createdDate, then to
// the file mtime if all timestamps are missing (defensive — shouldn't happen
// in real payloads).
function eventTimestamp(env, fileMtimeMs) {
  const p = env.payload || {};
  const candidates = [p.modifiedDate, p.createdDate, env.createdDate];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return fileMtimeMs || 0;
}

export async function fetchVagaroAppointmentsFromEvents() {
  let files;
  try {
    files = await fs.readdir(VAGARO_EVENTS_DIR);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.log(`vagaro-events: directory missing (${VAGARO_EVENTS_DIR}); 0 appointments`);
      return [];
    }
    throw e;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  console.log(`vagaro-events: scanning ${jsonFiles.length} envelope file(s)`);

  const customerMap = await loadVagaroCustomerMap();
  console.log(`vagaro-customers: ${Object.keys(customerMap).length} known customerId→name mapping(s)`);

  // ── PASS 1: group ALL appointment events by appointmentId ──
  // We need every event (not just the latest) because FIX 3 — cancellation
  // dominance — says: if ANY event for an appointmentId is a cancellation,
  // the appointment is dropped, regardless of timestamp ordering. A naive
  // "latest wins" can resurrect a cancelled session when a backfilled
  // `created` carries a newer createdDate than the `deleted` event.
  const eventsByApptId = new Map(); // apptId → [{ env, ts, source }]
  let skippedNonAppointment = 0, skippedNoApptId = 0, skippedParseErr = 0;

  for (const f of jsonFiles) {
    const full = path.join(VAGARO_EVENTS_DIR, f);
    let raw, env, mtimeMs = 0;
    try {
      raw = await fs.readFile(full, "utf8");
      env = JSON.parse(raw);
      const st = await fs.stat(full);
      mtimeMs = st.mtimeMs;
    } catch (_e) {
      skippedParseErr++;
      continue;
    }
    if (!env || env.type !== "appointment") { skippedNonAppointment++; continue; }
    const apptId = env.payload?.appointmentId;
    if (!apptId) { skippedNoApptId++; continue; }
    const ts = eventTimestamp(env, mtimeMs);
    if (!eventsByApptId.has(apptId)) eventsByApptId.set(apptId, []);
    eventsByApptId.get(apptId).push({ env, ts, source: f });
  }
  console.log(
    `vagaro-events: ${eventsByApptId.size} unique appointmentId(s); ` +
    `skipped ${skippedNonAppointment} non-appointment, ${skippedNoApptId} missing apptId, ${skippedParseErr} parse-err`,
  );

  // ── PASS 2: per appointmentId, apply cancellation dominance, then emit ──
  // ONE billing record per appointment (each Vagaro appointment event is
  // already one attendee — no schedule.csv expansion in events mode). The
  // record shape matches what reconcile() expects:
  //   { date, summary, description, client_name, vagaroAmount, unidentified }
  const appts = [];
  let skippedCancelled = 0, skippedOld = 0, skippedFuture = 0;
  let skippedNonBillable = 0, skippedNoStart = 0;
  let addedKnown = 0, addedUnknown = 0;

  for (const [apptId, events] of eventsByApptId.entries()) {
    // FIX 3 — cancellation dominance: if ANY event cancels this appointment,
    // drop it full-stop (no resurrection by a newer-timestamped `created`).
    // (events is an array of { env, ts, source } wrappers — unwrap to env.)
    if (events.some((e) => eventIsCancellation(e.env))) { skippedCancelled++; continue; }

    // Otherwise use the LATEST non-cancel event for the appointment's details.
    const latest = events.reduce((a, b) => (b.ts > a.ts ? b : a));
    const { env, source } = latest;
    const p = env.payload || {};

    const summary = (p.serviceTitle || "").trim();
    if (!isBillableSession(summary)) { skippedNonBillable++; continue; }

    if (!p.startTime) { skippedNoStart++; continue; }
    const start = new Date(p.startTime);
    if (Number.isNaN(start.getTime())) { skippedNoStart++; continue; }
    if (start < WINDOW_START) { skippedOld++; continue; }
    if (start > NOW)         { skippedFuture++; continue; }

    // FIX 2 — the Vagaro-resolved price for this appointment. Numeric (e.g.
    // 40, 45, 50, 70, 100). reconcile() uses this as the FIRST-choice expected
    // price, freeing the bot from schedule.csv pricing entirely.
    const vagaroAmount = (p.amount != null && !Number.isNaN(Number(p.amount)))
      ? Number(p.amount) : null;

    const customerId = p.customerId || "";
    const mappedName = customerId ? (customerMap[customerId] || "") : "";

    if (mappedName) {
      // FIX 1 — resolved client flows straight to roster matching.
      appts.push({
        date: start,
        summary,
        description: `customerId=${customerId} appointmentId=${apptId} amount=${vagaroAmount} source=${source}`,
        client_name: mappedName,
        vagaroAmount,
        unidentified: false,
      });
      addedKnown++;
    } else {
      // FIX 4(b) — FULL-ID VISIBILITY. The email's UNIDENTIFIED renderer
      // prints r.appt.summary ONLY, so bake the FULL customerId + service +
      // price into the summary. Brad copies the id straight from the email
      // into vagaro-customers.json. Empty client_name + unidentified:true →
      // lands in the UNIDENTIFIED bucket in reconcile().
      const idStr = customerId || "<none>";
      const priceStr = vagaroAmount != null ? ` @ $${vagaroAmount}` : "";
      appts.push({
        date: start,
        summary: `Unknown Vagaro client [id=${idStr}] — ${summary}${priceStr}`,
        description: `Unknown Vagaro client id=${customerId} appointmentId=${apptId} amount=${vagaroAmount} source=${source}`,
        client_name: "",
        vagaroAmount,
        unidentified: true,
      });
      addedUnknown++;
    }
  }

  console.log(
    `vagaro-events filter: added ${addedKnown} known + ${addedUnknown} unknown-customer; ` +
    `skipped ${skippedCancelled} cancelled, ${skippedNonBillable} non-billable, ` +
    `${skippedOld} old, ${skippedFuture} future, ${skippedNoStart} no-start-time`,
  );

  if (appts.length > 0) {
    console.log(`First ${Math.min(3, appts.length)} appointments:`);
    appts.slice(0, 3).forEach((a) =>
      console.log(`  ${a.date.toISOString()} | summary="${a.summary}" | client_name="${a.client_name}" | $${a.vagaroAmount}`),
    );
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

export function isLikelyAutoDateMemo(note) {
  return /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?$/i.test(String(note || "").trim());
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
  const subjMatch = subject.match(/^(.+?)\s+paid your?\s+\$([\d,.]+)/i) || subject.match(/^(.+?)\s+paid\s+\$([\d,.]+)\s+to your Venmo account/i);
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
  // the right session. EXCEPTION: when the memo date equals the payment date
  // ("Jun 09, 2026" sent on 6/9), it's almost always Venmo's auto-filled
  // default memo, not a session reference — treat as no date evidence so the
  // payment can match a nearby session by proximity (Laci pays Friday's
  // session on Tuesday with the default memo).
  let noteDate = parseNoteDate(note, date.getUTCFullYear());
  if (noteDate &&
      noteDate.getUTCMonth() === date.getUTCMonth() &&
      noteDate.getUTCDate() === date.getUTCDate()) {
    // Default-memo exception: when the parsed date equals the payment send date,
    // it's Venmo's auto-fill — UNLESS the memo also contains real content
    // ("Training 6/19/26" — the client is intentionally tagging the session
    // date). Only null when the memo is JUST the date with nothing meaningful
    // around it (whitespace / punctuation is fine).
    const trimmed = (note || "").trim();
    // Numeric memos such as "8/26" or "8.24" are strong user-entered
    // service-date evidence even when payment happened the same day. The old
    // heuristic discarded them and let a Wednesday payment settle Friday.
    // Only a bare month-name date remains eligible for the legacy auto-fill
    // exception (e.g. "Aug 24, 2026").
    if (isLikelyAutoDateMemo(trimmed)) noteDate = null;
  }
  return { gmail_id: msg.id, sender_display_name, sender_handle, amount, note, noteDate, date, subject };
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
export function expandSlots(slots, schedule, scheduleOverrides = []) {
  const groups = new Map();
  for (const slot of slots) {
    const key = slot.date.toISOString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  const out = [];
  for (const group of groups.values()) {
    const hasOverride = scheduleOverrides.length
      ? hasScheduleOverrideForSlot(scheduleOverrides, group[0].date)
      : false;
    const entries = hasOverride
      ? findScheduleOverrideEntriesForSlot(scheduleOverrides, group[0].date)
      : (schedule.length ? findScheduleEntriesForSlot(schedule, group[0].date) : []);
    const hasInactive = hasOverride
      ? isInactiveScheduleOverrideSlot(scheduleOverrides, group[0].date)
      : (schedule.length ? isInactiveSlot(schedule, group[0].date) : false);
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
        // When fewer iCal events exist than schedule rows, the slot proves the
        // time existed but not that every scheduled client attended. Paid rows
        // may still reconcile; an unpaid row is downgraded to review below.
        mapping_ambiguous: n < k,
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

// ---- Ledger provenance bridge ----

// payment-driven mode records that money arrived, but it does not prove which
// appointment the money settled. Older payment-driven rows predate the
// source_mode field, so their weekly log date is used to identify them.
export function isPaymentDrivenLedgerEntry(entry, paymentDrivenRunDates = new Set()) {
  if (entry?.source_mode === "schedule") return false;
  if (entry?.source_mode === "payment-driven") return true;
  if (entry?.corrected_by) return false; // explicit human adjudication wins
  const matchedDate = String(entry?.matched_at || "").slice(0, 10);
  return Boolean(matchedDate && paymentDrivenRunDates.has(matchedDate));
}

export function trustedScheduleLedger(priorMatches, paymentDrivenRunDates = new Set()) {
  return priorMatches.filter((m) => !isPaymentDrivenLedgerEntry(m, paymentDrivenRunDates));
}

// ---- Production configuration guard ----
//
// A scheduled, non-dry run is the one that emails Brad a real chase list and
// commits the ledger. It is only trustworthy on the approved path:
//   BILLING_MODE=schedule + APPOINTMENT_SOURCE=ical
// payment-driven is a vacation/no-bookings DIAGNOSTIC: it has no schedule, so
// its "who owes" list is inferred from historical cadence. Emailing that as a
// normal debt/chase email is how a degraded run passed for a real one for
// weeks. vagaro-events is built but not yet validated as production.
//
// Dry runs are exempt — exploring either path with DRY_RUN=true is the
// sanctioned way to validate it before flipping the default.
export function assertProductionConfig({ billingMode, appointmentSource, dryRun }) {
  if (dryRun) return;
  const problems = [];
  if (billingMode !== "schedule") {
    problems.push(
      `BILLING_MODE must be "schedule" for a non-dry production run (got "${billingMode}"). ` +
      `"payment-driven" is a dry-run diagnostic only and must never send a normal debt/chase email.`,
    );
  }
  if (appointmentSource !== "ical") {
    problems.push(
      `APPOINTMENT_SOURCE must be "ical" for a non-dry production run (got "${appointmentSource}"). ` +
      `"vagaro-events" is built but not yet approved for production.`,
    );
  }
  if (problems.length) {
    throw new Error(
      `Refusing to run: unapproved production configuration.\n  - ${problems.join("\n  - ")}\n` +
      `Fix the workflow inputs, or set DRY_RUN=true to explore this configuration safely.`,
    );
  }
}

// ---- Summary counts (single source of truth) ----
//
// Every count Brad reads — log summary, email subject, email stat strip —
// must be derived from the FINAL result rows and nothing else. The email
// previously counted only THIS WEEK's rows for "Unpaid"/"Review" and filed
// older open rows under a separate "Carryover" chip, so a week whose only two
// review rows were carryover rendered "0 Review" while the log said
// needs_review: 2 and both rows were plainly visible in the body.
export function summaryCounts(results) {
  const n = (status) => results.filter((r) => r.status === status).length;
  return {
    paid_venmo: n("PAID_VENMO"),
    paid_cash: n("PAID_CASH"),
    paid_prepaid: n("PAID_PREPAID"),
    unpaid: n("UNPAID"),
    needs_review: n("NEEDS_REVIEW"),
    cash_pending: n("CASH_PENDING"),
    unknown: n("UNKNOWN"),
    unidentified: n("UNIDENTIFIED_SLOT"),
    cancelled: n("CANCELLED"),
  };
}

// Both email templates end their subject with "— N unpaid, M review".
// Pulling the numbers back out of the rendered subject is deliberate: it
// verifies what Brad will actually READ, not what we intended to render, and
// it covers the command-center template (email-moneyline.mjs) without
// reaching into it.
export function parseSubjectCounts(subject) {
  const m = String(subject || "").match(/(\d+)\s+unpaid,\s*(\d+)\s+review/i);
  return m ? { unpaid: Number(m[1]), needs_review: Number(m[2]) } : null;
}

// Fail BEFORE a normal billing email whenever the numbers disagree.
export function assertSummaryConsistency({ results, logCounts, subject }) {
  const counts = summaryCounts(results);
  const problems = [];
  for (const [k, v] of Object.entries(counts)) {
    if (logCounts[k] !== v) problems.push(`log ${k}=${logCounts[k]} but final rows have ${v}`);
  }
  const subjectCounts = parseSubjectCounts(subject);
  if (!subjectCounts) {
    problems.push(`could not read "N unpaid, M review" out of the email subject: "${subject}"`);
  } else {
    if (subjectCounts.unpaid !== counts.unpaid) {
      problems.push(`email says ${subjectCounts.unpaid} unpaid but final rows have ${counts.unpaid}`);
    }
    if (subjectCounts.needs_review !== counts.needs_review) {
      problems.push(`email says ${subjectCounts.needs_review} review but final rows have ${counts.needs_review}`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Refusing to send: summary counts disagree with the final result rows.\n  - ${problems.join("\n  - ")}`,
    );
  }
  return counts;
}

// ---- Payment allocation invariant ----
//
// sum(session allocations) + unallocated remainder = gross receipt, for every
// payment. A PAID session allocates exactly the session price it settled (so a
// $75 receipt against a $70 session allocates $70 and preserves a $5 remainder
// for the smoothie instead of swallowing the whole receipt). A NEEDS_REVIEW row
// allocates nothing — the money is spoken for but nothing is settled, so the
// full amount stays as remainder pending human resolution.
export function assertAllocationInvariant(allocations) {
  const problems = [];
  for (const a of allocations) {
    const allocated = a.sessions.reduce((s, x) => s + x.amount, 0);
    if (allocated > a.gross + 1e-9) {
      problems.push(`${a.sender} $${a.gross}: allocated $${allocated} exceeds the gross receipt`);
    }
    if (Math.abs(allocated + a.remainder - a.gross) > 1e-9) {
      problems.push(`${a.sender} $${a.gross}: allocations $${allocated} + remainder $${a.remainder} != gross`);
    }
    // Identity is the SLOT, not the calendar day: a client legitimately trains
    // twice on one date (Lacey 6/10, Peggy 5/25), and one receipt covering both
    // is exactly the combined payment this repair exists to support. Only the
    // same slot being settled twice is a real double-settle.
    const seen = new Set();
    for (const s of a.sessions) {
      const key = s.slot ?? `${s.date}__${s.client}`;
      if (seen.has(key)) problems.push(`${a.sender} $${a.gross}: session ${s.date} / ${s.client} settled twice by one receipt`);
      seen.add(key);
    }
  }
  if (problems.length) {
    throw new Error(`Refusing to send: payment allocation invariant violated.\n  - ${problems.join("\n  - ")}`);
  }
}

export function reconcile(appointments, payments, clients, cashLog, cancellations = [], priorMatches = [], externalUnpaid = []) {
  const byVagaroName = new Map(clients.map((c) => [c.vagaro_name.toLowerCase(), c]));
  const usedPayments = new Set();
  const results = [];
  // Payments locked by prior weekly runs — can never be matched again. This
  // is the only durable defense against the Jacob $70 "5/27" → Mon 6/1
  // double-count bug. We index by BOTH Gmail message-id (real, durable for
  // anything matched after the ledger was introduced) AND a content
  // fingerprint (sender+amount+note+date — covers historical backfilled
  // entries that don't have real Gmail ids).
  const priorMatchIds = new Set(priorMatches.map((m) => m.gmail_id).filter(Boolean));
  const fingerprint = (sender, amount, note, dateIso) =>
    `${(sender || "").toLowerCase()}|${amount}|${(note || "").toLowerCase()}|${dateIso || ""}`;
  const priorFingerprints = new Set(
    priorMatches.map((m) =>
      fingerprint(m.payment?.sender, m.payment?.amount, m.payment?.note, m.payment?.date),
    ),
  );
  const isPriorMatch = (p) => {
    if (p.gmail_id && priorMatchIds.has(p.gmail_id)) return true;
    const fp = fingerprint(p.sender_display_name, p.amount, p.note, fmtDateIso(p.date));
    return priorFingerprints.has(fp);
  };
  // ── Ledger continuity (session pre-pay) ──
  // A locked payment must still PAY FOR the session it was locked to.
  // Without this, a re-run inside the same window sees the payment locked,
  // can't re-match it, and flips an already-settled session back to UNPAID
  // (the paid_venmo:19→4 collapse). Index prior matches by (session date,
  // client). Each KEY holds a QUEUE of matches — a client can have two settled
  // sessions on the same calendar day (Lacey trained twice 6/10; Peggy had two
  // 5/25 sessions). A single-value map would strand the 2nd session → UNPAID;
  // the queue lets each appointment consume one prior match.
  const priorBySession = new Map();
  for (const m of priorMatches) {
    const d = m.matched_to?.date;
    const c = (m.matched_to?.client || "").toLowerCase();
    if (!d || !c || d.startsWith("n/a")) continue;
    const key = `${d}__${c}`;
    if (!priorBySession.has(key)) priorBySession.set(key, []);
    priorBySession.get(key).push(m);
  }
  // FIX 5 — ledger continuity must survive the iCal→events date-provenance
  // change. Old ledger entries (matched_to.date) were keyed in UTC (iCal mode
  // wrote fmtDateIso = UTC day). Events mode keys sessions on the Pacific day.
  // A 5 PM+ PT session is on the NEXT UTC day, so the same session that paid
  // under UTC keying could strand and flip back to UNPAID (the paid_venmo
  // 19→4 evening-class bug). Probe the prior-session index with:
  //   • the Pacific key (new canonical), then
  //   • the legacy UTC key (old ledger entries), then
  //   • the Pacific key ±1 day (covers the UTC/PT day-boundary straddle).
  // The ±1-day neighbor probe is safe because the index is ALREADY keyed by
  // client name — a neighbor-day hit can only be the SAME client, so we won't
  // steal another client's settled session.
  const neighborKeys = (date, name) => {
    const lc = name.toLowerCase();
    const pac = fmtDateIsoPacific(date);
    const utc = fmtDateIso(date);
    const keys = [
      `${pac}__${lc}`,                            // 1. Pacific (canonical)
      `${utc}__${lc}`,                            // 2. legacy UTC
    ];
    // ONLY probe ±1 day when the appointment actually crossed the midnight-UTC
    // boundary (Pacific date ≠ UTC date — i.e. ≥5PM PT). Otherwise the ±1 probe
    // is too greedy: a morning session steals the next morning's settled ledger
    // entry, leaving the rightful owner UNPAID. Daytime appts' Pacific key
    // already equals the legacy UTC key, so no neighbor probing is needed.
    if (pac !== utc) {
      const d = new Date(date);
      const prevDay = new Date(d.getTime() - 24 * 60 * 60 * 1000);
      const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      keys.push(`${fmtDateIsoPacific(prevDay)}__${lc}`);   // 3. Pacific − 1 day
      keys.push(`${fmtDateIsoPacific(nextDay)}__${lc}`);   // 4. Pacific + 1 day
    }
    return keys;
  };
  const takePriorForSession = (appt, roster) => {
    for (const key of neighborKeys(appt.date, roster.vagaro_name)) {
      const queue = priorBySession.get(key);
      if (queue && queue.length) {
        // Consume ONE prior match from this key's queue. A second appointment
        // for the same (client, day) will take the next one; a third finds the
        // queue empty and falls through to live matching / UNPAID as before.
        return queue.shift();
      }
    }
    return null;
  };
  // New matches made by THIS run — main() will append to the ledger.
  const newMatches = [];

  // ── Note-keyword routing (Mathieu/Rachel disambiguation) ──
  // For each payment, figure out which roster client (if any) explicitly
  // claims it via a note_keywords match. A claimed payment is reserved for
  // that client even if the sender display name matches a sibling row
  // (e.g. Mathieu's "$70 Rachael" sender=Mathieu but claimed by Rachel).
  const noteClaimedBy = new Map(); // payment index → roster client
  payments.forEach((p, idx) => {
    const note = (p.note || "").toLowerCase();
    if (!note) return;
    for (const c of clients) {
      const kws = c.note_keywords || [];
      if (!kws.length) continue;
      if (kws.some((kw) => kw && note.includes(kw))) {
        noteClaimedBy.set(idx, c);
        break;
      }
    }
  });

  // ── Cancellations (Brad didn't actually train — vacation, sick, etc.) ──
  // Human-entered ledger dates are already Pacific calendar dates. Date
  // objects are UTC instants and must be converted to Pacific. Use one rule
  // for cancellations, cash confirmations, and verified missing bank/Zelle.
  const serviceDay = (date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : fmtDateIsoPacific(date);
  const cancelKey = (date, name) => `${serviceDay(date)}__${(name || "").toLowerCase()}`;
  const cancelledSet = new Set(cancellations.map((c) => cancelKey(c.date, c.name)));

  // ── Combined-payment reservation pre-pass ──
  //
  // The greedy loop below walks appointments in order, lets each take the
  // best-scoring payment, then marks that payment spent. Two defects fall out:
  //   • a $140 receipt covering two $70 sessions scores as an exact multiple
  //     ("package"), settles the FIRST session, and is consumed — so the second
  //     session reports UNPAID even though the client paid for it;
  //   • nothing distinguishes "$140 = my two sessions" from "$140 = me + two
  //     other people + a drink", so a mixed receipt silently settles a session.
  //
  // This pass runs BEFORE the loop and answers one question per payment: do we
  // know EXACTLY which sessions this receipt covers? Only two answers count,
  // both deterministic:
  //   A. the memo names the dates ("7/10 and 7/13") and each named date has
  //      exactly one open session for this client;
  //   B. the memo names no date, the amount is an exact k-multiple (k≥2) of one
  //      session price, and this client has EXACTLY k open sessions at that
  //      price in the window ("Thurs & Fri" with exactly two eligible).
  // Everything else — ambiguity, mixed-person, mixed-service — is deliberately
  // NOT reserved and falls through to NEEDS_REVIEW instead of being guessed.
  const ADDON_RE = /\b(drinks?|shakes?|smoothies?|proteins?|peptides?|supplements?|consults?|consultations?|retainers?|tips?)\b/i;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clientTokens = clients.map((c) => {
    const toks = new Set();
    for (const kw of c.note_keywords || []) if (kw && kw.length >= 3) toks.add(kw.toLowerCase());
    for (const nm of [c.vagaro_name, ...(c.venmo_display_names || [])]) {
      for (const t of String(nm || "").toLowerCase().split(/[^a-z]+/)) if (t.length >= 3) toks.add(t);
    }
    return { client: c, tokens: [...toks] };
  });
  // Which roster clients does this memo name? Two or more distinct people in
  // one memo means the receipt is split across humans and we cannot know how.
  const clientsNamedIn = (note) => {
    const lc = String(note || "").toLowerCase();
    const hit = new Set();
    if (!lc) return hit;
    for (const { client, tokens } of clientTokens) {
      if (tokens.some((t) => new RegExp(`\\b${escapeRe(t)}\\b`).test(lc))) hit.add(client.vagaro_name);
    }
    return hit;
  };
  const payMeta = payments.map((p) => {
    // Respect parseVenmoEmail's date semantics: a null noteDate means "no date
    // evidence" (including the Venmo auto-filled default memo), so we must NOT
    // re-parse one back into existence. Only an already-dated memo gets scanned
    // for the ADDITIONAL dates of a combined payment.
    const all = p.noteDate ? parseNoteDates(p.note, new Date(p.date).getUTCFullYear()) : [];
    const noteDates = p.noteDate ? (all.length ? all : [p.noteDate]) : [];
    const named = clientsNamedIn(p.note);
    return { noteDates, named, mixed: named.size >= 2 || ADDON_RE.test(p.note || "") };
  });
  const senderMatches = (p, roster) => {
    const nameMatch = roster.venmo_handle && p.sender_handle === roster.venmo_handle.toLowerCase();
    const namesToCheck = roster.venmo_display_names?.length ? roster.venmo_display_names : [roster.vagaro_name];
    return nameMatch || namesToCheck.some((name) => fuzzyName(p.sender_display_name, name) >= 0.8);
  };
  // Per-appointment view of the same gates the loop applies, so the pre-pass
  // only ever reserves sessions the loop would actually try to settle.
  const apptMeta = appointments.map((appt) => {
    if (appt.unidentified) return null;
    const roster = byVagaroName.get((appt.client_name || "").toLowerCase());
    if (!roster) return null;
    if (cancelledSet.has(cancelKey(appt.date, roster.vagaro_name))) return null;
    if (roster.prepaid || roster.pays_cash) return null;
    // Already settled by a prior run — ledger continuity will reproduce it.
    if (neighborKeys(appt.date, roster.vagaro_name).some((k) => (priorBySession.get(k) || []).length > 0)) return null;
    const expectedPrice = appt.vagaroAmount ?? appt.price_override ?? roster.default_price;
    return { roster, expectedPrice };
  });
  const reservedFor = new Map(); // appointment index → payment index
  const registerReservation = (pIdx, picked) => {
    for (const e of picked) reservedFor.set(e.aIdx, pIdx);
  };
  payments.forEach((p, pIdx) => {
    if (isPriorMatch(p)) return;          // locked by a prior run
    if (payMeta[pIdx].mixed) return;      // never guess a mixed receipt
    const eligible = [];
    appointments.forEach((appt, aIdx) => {
      const info = apptMeta[aIdx];
      if (!info || reservedFor.has(aIdx)) return;
      if (!senderMatches(p, info.roster)) return;
      const claimed = noteClaimedBy.get(pIdx);
      if (claimed && claimed.vagaro_name !== info.roster.vagaro_name) return;
      if (!withinDateWindow(p.date, appt.date)) return;
      eligible.push({ aIdx, appt, info });
    });
    if (eligible.length < 2) return;      // nothing combined to resolve

    // A. Explicit dates: the memo must genuinely ENUMERATE dates (not merely
    //    contain two things that parse as dates — see enumeratesDates), and
    //    every named date must resolve to exactly one session.
    if (payMeta[pIdx].noteDates.length >= 2 && enumeratesDates(p.note)) {
      const picked = [];
      for (const nd of payMeta[pIdx].noteDates) {
        const hits = eligible.filter((e) => sameDay(nd, e.appt.date));
        if (hits.length !== 1) return;    // missing or ambiguous → don't guess
        picked.push(hits[0]);
      }
      // A priceless session can't be part of a proven split: its share would
      // book as $0 and freeze that $0 into the ledger. Path B already skips
      // these; path A must too.
      if (picked.some((e) => !e.info.expectedPrice)) return;
      if (picked.reduce((s, e) => s + e.info.expectedPrice, 0) > p.amount) return;
      registerReservation(pIdx, picked);
      return;
    }

    // B. No dates: exact k-multiple AND exactly k eligible sessions at that
    //    price, with no other eligible session competing for the same money.
    if (payMeta[pIdx].noteDates.length === 0) {
      const byPrice = new Map();
      for (const e of eligible) {
        const q = e.info.expectedPrice;
        if (!q) continue;
        if (!byPrice.has(q)) byPrice.set(q, []);
        byPrice.get(q).push(e);
      }
      for (const [q, group] of byPrice) {
        const k = p.amount / q;
        if (!Number.isInteger(k) || k < 2) continue;
        if (group.length !== k) continue;               // ambiguous count
        if (group.length !== eligible.length) continue; // other sessions compete
        registerReservation(pIdx, group);
        return;
      }
    }
  });
  const reservedPayments = new Set(reservedFor.values());
  // Dollars of each receipt already committed to a session this run.
  const allocatedByPayment = new Map();
  const allocationSessions = new Map();
  // Book at most what the receipt actually carried, and never a negative.
  // amountScore accepts a payment within $2 of the price and matchedSessionPrice
  // then snaps UP to the session price, so a $68 receipt for a $70 session would
  // otherwise book $70 against a $68 gross — and the invariant below would abort
  // the entire Friday run because a client rounded down. The clamp keeps
  // checkoutAmount (what Brad types into Vagaro) at the real session price while
  // the ledger records only money that actually arrived.
  const allocate = (pIdx, amount, session) => {
    const already = allocatedByPayment.get(pIdx) || 0;
    const booked = Math.max(0, Math.min(amount, payments[pIdx].amount - already));
    allocatedByPayment.set(pIdx, already + booked);
    if (!allocationSessions.has(pIdx)) allocationSessions.set(pIdx, []);
    allocationSessions.get(pIdx).push({ ...session, amount: booked });
    return booked;
  };

  for (let apptIndex = 0; apptIndex < appointments.length; apptIndex++) {
    const appt = appointments[apptIndex];
    if (appt.unidentified) {
      results.push({ appt, status: "UNIDENTIFIED_SLOT" });
      continue;
    }

    const roster = byVagaroName.get((appt.client_name || "").toLowerCase());

    if (!roster) {
      results.push({ appt, status: "UNKNOWN", note: `Client "${appt.client_name}" not in roster` });
      continue;
    }

    // Honor cancellations BEFORE prepaid/pays_cash gates so a vacation week
    // for any client type drops cleanly.
    if (cancelledSet.has(cancelKey(appt.date, roster.vagaro_name))) {
      const cxl = cancellations.find((c) => cancelKey(c.date, c.name) === cancelKey(appt.date, roster.vagaro_name));
      results.push({ appt, roster, status: "CANCELLED", note: cxl?.reason || "" });
      continue;
    }

    if (roster.prepaid) {
      const ppPrice = appt.price_override ?? roster.default_price;
      results.push({ appt, roster, status: "PAID_PREPAID", expectedPrice: ppPrice, checkoutAmount: ppPrice });
      continue;
    }

    // FIX 2 — pricing source priority:
    //   1. appt.vagaroAmount  (events mode: the price Vagaro itself recorded —
    //      Peggy team $40, Annie solo $70, etc. come straight from Vagaro).
    //   2. appt.price_override (iCal mode: schedule.csv slot-specific price).
    //   3. roster.default_price (clients.csv fallback).
    // This is what frees the bot from schedule.csv pricing. clients.csv
    // valid_prices remain ADDITIONAL tolerance via acceptablePrices, not the
    // primary source.
    const expectedPrice = appt.vagaroAmount ?? appt.price_override ?? roster.default_price;
    // Every amount the bot should treat as paid-in-full for this client:
    // the slot's expected price (incl. the Vagaro amount) + any client-level
    // valid_prices (couple solo vs together, group vs alone). A $5 smoothie on
    // top of any of these is also accepted (handled in amountScore).
    const acceptablePrices = [...new Set([
      expectedPrice,
      appt.vagaroAmount,
      ...(roster.acceptable_prices || []),
    ].filter((n) => n != null))];

    // Ledger continuity: this session was already settled by a prior run.
    // Reproduce that attribution instead of re-matching (its payment is
    // locked, so re-matching would falsely flip the session to UNPAID).
    const prior = takePriorForSession(appt, roster);
    if (prior) {
      const pay = {
        sender_display_name: prior.payment?.sender,
        // For a combined receipt the ledger stores the gross AND this session's
        // share; replay the share so money-in totals don't re-inflate on every
        // subsequent run. Single-session entries have no session_amount and are
        // reproduced exactly as before.
        amount: prior.matched_to?.session_amount ?? prior.payment?.amount,
        gross_amount: prior.payment?.amount,
        note: prior.payment?.note,
        date: prior.payment?.date && !String(prior.payment.date).startsWith("n/a")
          ? new Date(prior.payment.date) : new Date(appt.date),
      };
      if (prior.matched_to.status === "NEEDS_REVIEW") {
        results.push({
          appt, roster, status: "NEEDS_REVIEW", payment: pay, expectedPrice,
          note: `Received $${pay.amount}, expected $${expectedPrice}`, fromLedger: true,
        });
      } else {
        const checkoutAmount = matchedSessionPrice(pay.amount, acceptablePrices);
        results.push({ appt, roster, status: "PAID_VENMO", payment: pay, expectedPrice, checkoutAmount, fromLedger: true });
      }
      continue;
    }

    if (roster.pays_cash) {
      const dueHit = externalUnpaid.find(
        (c) => serviceDay(c.date) === serviceDay(appt.date) && fuzzyName(c.name, roster.vagaro_name) >= 0.8,
      );
      if (dueHit) {
        results.push({
          appt, roster, status: "UNPAID", expectedPrice, checkoutAmount: expectedPrice,
          note: dueHit.notes || "External payment verified not received",
          externalPaymentVerifiedUnpaid: true,
        });
        continue;
      }
      const cashHit = cashLog.find(
        (c) => serviceDay(c.date) === serviceDay(appt.date) && fuzzyName(c.name, roster.vagaro_name) >= 0.8,
      );
      if (cashHit) results.push({ appt, roster, status: "PAID_CASH", payment: cashHit, expectedPrice, checkoutAmount: expectedPrice });
      else results.push({ appt, roster, status: "CASH_PENDING", expectedPrice, checkoutAmount: expectedPrice });
      continue;
    }

    // A session the pre-pass proved this receipt covers. Settle exactly this
    // session's price and leave the rest of the receipt available for its other
    // reserved sessions (and any genuine remainder unallocated).
    const reservedIdx = reservedFor.get(apptIndex);
    if (reservedIdx != null) {
      const p = payments[reservedIdx];
      usedPayments.add(reservedIdx);
      const share = allocate(reservedIdx, expectedPrice,
        { date: fmtDateIsoPacific(appt.date), client: roster.vagaro_name, slot: apptIndex });
      if (p.gmail_id) {
        newMatches.push({
          gmail_id: p.gmail_id,
          matched_at: new Date().toISOString(),
          source_mode: "schedule",
          // session_amount is this session's share; payment.amount stays the
          // gross so the ledger still records the real receipt (and the
          // content fingerprint that locks it keeps matching).
          matched_to: {
            date: fmtDateIsoPacific(appt.date), client: roster.vagaro_name,
            status: "PAID_VENMO", combined: true, session_amount: share,
          },
          payment: { sender: p.sender_display_name, amount: p.amount, note: p.note, date: fmtDateIso(p.date) },
        });
      }
      results.push({
        appt, roster, status: "PAID_VENMO",
        // A per-session VIEW of the receipt. Both email templates total money-in
        // as sum(row.payment.amount) over paid rows, so handing every settled
        // session the gross would report one $140 receipt as $280 collected.
        payment: { ...p, amount: share, gross_amount: p.amount, combined: true },
        expectedPrice, checkoutAmount: expectedPrice, combined: true,
      });
      continue;
    }

    const candidates = payments
      .map((p, idx) => ({ p, idx }))
      .filter(({ idx }) => !usedPayments.has(idx))
      // Reserved by the combined-payment pre-pass for a known set of sessions.
      // Only those sessions may draw on it — otherwise an unrelated appointment
      // earlier in the array could take the receipt back.
      .filter(({ idx }) => !reservedPayments.has(idx))
      // Ledger filter: if a prior weekly run already claimed this exact
      // payment (by Gmail id OR content fingerprint), it's locked.
      .filter(({ p }) => !isPriorMatch(p))
      // Note-keyword claim: if the payment's memo explicitly names someone
      // else (e.g. "Rachael" routes to Rachel), don't let other clients
      // grab it. A payment NOT claimed by anyone falls through to the
      // sender-match logic below — unchanged behavior for the 95% case.
      .filter(({ idx }) => {
        const claimed = noteClaimedBy.get(idx);
        return !claimed || claimed.vagaro_name === roster.vagaro_name;
      })
      // Note-date strictness: a memo with a parseable date (e.g. "5/27",
      // "5.25", "May 25, 2026", "Workout 5/29") only matches sessions on
      // THAT date. Kills the cross-week false positives where a payment
      // for last week's session got grabbed for this week's same-slot
      // session. Payments with no date in the note fall through normally.
      // Deliberately still the STRICT single-date rule. Combined receipts are
      // handled entirely by the reservation pre-pass (and are filtered out of
      // this list above), so widening this to "any date named in the memo"
      // would buy nothing and would break requirement 5: with two dates in
      // scope the greedy earliest-appointment scan could consume a payment its
      // memo pinned to the later session.
      .filter(({ p }) => !p.noteDate || sameDay(p.noteDate, appt.date))
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
        // allowPackage:false — an exact multiple ($140 against a $70 session)
        // is NOT proof this one session was paid. Only the pre-pass, which
        // knows which sessions the receipt covers, may settle a multiple.
        // An unresolved multiple now lands in NEEDS_REVIEW instead of silently
        // settling one session and swallowing the rest of the receipt.
        amountScore: acceptablePrices.length
          ? amountScore(p.amount, acceptablePrices, { allowPackage: false })
          : 0.5,
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
      // Record the match in the ledger so a future run can never re-grab
      // this Gmail message for a different session.
      const recordMatch = (status) => {
        if (!best.p.gmail_id) return;
        newMatches.push({
          gmail_id: best.p.gmail_id,
          matched_at: new Date().toISOString(),
          source_mode: "schedule",
          matched_to: {
            date: fmtDateIsoPacific(appt.date),
            client: roster.vagaro_name,
            status,
          },
          payment: {
            sender: best.p.sender_display_name,
            amount: best.p.amount,
            note: best.p.note,
            date: fmtDateIso(best.p.date),
          },
        });
      };
      if (best.amountScore >= 0.8) {
        usedPayments.add(best.idx);
        recordMatch("PAID_VENMO");
        const checkoutAmount = matchedSessionPrice(best.p.amount, acceptablePrices);
        // Allocate only the session price actually settled. A $75 receipt on a
        // $70 session allocates $70 and leaves a $5 remainder for the smoothie
        // rather than booking the whole receipt against one session.
        allocate(best.idx, checkoutAmount ?? expectedPrice ?? best.p.amount,
          { date: fmtDateIsoPacific(appt.date), client: roster.vagaro_name });
        results.push({ appt, roster, status: "PAID_VENMO", payment: best.p, expectedPrice, checkoutAmount });
      } else {
        // Mark as used too — a NEEDS_REVIEW payment is still "spoken for" by
        // this session. Without this it doubles in the unmatched list.
        usedPayments.add(best.idx);
        recordMatch("NEEDS_REVIEW");
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
    if (p.gmail_id && priorMatchIds.has(p.gmail_id)) return; // ledger lock
    if (isPriorMatch(p)) return; // ledger lock (gmail_id OR fingerprint)
    const client = resolveClient(p);
    if (!client) return;
    if (!p.noteDate) return; // require date evidence — no amount-only guessing
    const accept = client.acceptable_prices?.length ? client.acceptable_prices : [client.default_price];
    // HIGH-CONFIDENCE ONLY: pair a leftover payment to an unidentified slot
    // ONLY when the payment's memo names that slot's exact date AND the amount
    // is acceptable for this client. (Earlier amount-only pairing produced a
    // false "Lacey Thu noon" — never again.)
    const cand = results
      .map((r, ri) => ({ r, ri }))
      .filter(({ r, ri }) => r.status === "UNIDENTIFIED_SLOT" && !pairedSlots.has(ri))
      .filter(({ r }) => sameDay(p.noteDate, r.appt.date))
      .filter(({ }) => amountScore(p.amount, accept) >= 0.8)
      .sort((a, b) =>
        Math.abs(new Date(p.date) - new Date(a.r.appt.date)) -
        Math.abs(new Date(p.date) - new Date(b.r.appt.date)));
    if (cand.length === 0) return;
    const { r, ri } = cand[0];
    pairedSlots.add(ri);
    usedPayments.add(idx);
    if (p.gmail_id) {
      newMatches.push({
        gmail_id: p.gmail_id,
        matched_at: new Date().toISOString(),
        source_mode: "schedule",
        matched_to: { date: fmtDateIsoPacific(r.appt.date), client: client.vagaro_name, status: "PAID_VENMO", inferred: true },
        payment: { sender: p.sender_display_name, amount: p.amount, note: p.note, date: fmtDateIso(p.date) },
      });
    }
    const exp = accept.find((a) => amountScore(p.amount, [a]) >= 0.8) ?? client.default_price;
    results[ri] = { appt: r.appt, roster: client, status: "PAID_VENMO", payment: p, expectedPrice: exp, checkoutAmount: exp, inferred: true };
  });

  // ?? FALSE-DEBT GUARD ??
  // iCal tells us that a service slot existed, but schedule.csv supplies the
  // client identity. If the slot-to-client mapping was underdetermined, or if
  // the same client has evidence of an off-pattern/rescheduled payment, a bare
  // UNPAID row is not strong enough to chase. Downgrade it to NEEDS_REVIEW.
  // This is deliberately asymmetric: uncertainty may delay a request, but may
  // never create debt.
  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri];
    if (r.status !== "UNPAID" || !r.roster) continue;
    const name = r.roster.vagaro_name;
    const reasons = [];
    if (r.appt.mapping_ambiguous) {
      reasons.push("iCal slot does not uniquely prove this scheduled client attended");
    }
    const inferredNearby = results.some((x, xi) =>
      xi !== ri && x.inferred && x.status === "PAID_VENMO" &&
      x.roster?.vagaro_name === name &&
      Math.abs(new Date(x.appt.date) - new Date(r.appt.date)) <= 7 * 86400000);
    if (inferredNearby) reasons.push("paid off-pattern session exists nearby ? possible reschedule");

    const pendingSameClient = payments
      .map((p, idx) => ({ p, idx }))
      .filter(({ idx, p }) => !usedPayments.has(idx) && !isPriorMatch(p))
      .find(({ p }) => {
        const c = resolveClient(p);
        return c?.vagaro_name === name && withinDateWindow(p.date, r.appt.date);
      });
    if (pendingSameClient) {
      reasons.push(`unallocated ${name} payment exists ($${pendingSameClient.p.amount}, note: "${pendingSameClient.p.note || ""}")`);
    }
    if (reasons.length) {
      results[ri] = { ...r, status: "NEEDS_REVIEW", note: reasons.join("; ") };
    }
  }

  const unmatchedPayments = payments.filter((p, idx) => !usedPayments.has(idx) && !isPriorMatch(p));
  // Per-receipt allocation ledger: what each payment settled, and what is left
  // over. sessions[] + remainder must always reconstruct the gross amount —
  // asserted by assertAllocationInvariant() before any email goes out.
  const allocations = payments.map((p, idx) => {
    const sessions = allocationSessions.get(idx) || [];
    const allocated = allocatedByPayment.get(idx) || 0;
    return {
      gmail_id: p.gmail_id,
      sender: p.sender_display_name,
      note: p.note,
      gross: p.amount,
      sessions,
      remainder: p.amount - allocated,
    };
  });
  return { results, unmatchedPayments, newMatches, allocations };
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
// `allowPackage` (default true, preserving every existing call site) controls
// the exact-multiple rule. The main candidate scorer passes false: a $140
// receipt is not evidence that THIS $70 session was paid — it's evidence of a
// combined payment, which only the reservation pre-pass is allowed to split.
function amountScore(received, acceptable, { allowPackage = true } = {}) {
  const prices = Array.isArray(acceptable) ? acceptable : [acceptable];
  for (const expected of prices) {
    if (!expected) continue;
    if (received === expected) return 1;
    if (received === expected + 5) return 1;           // smoothie add-on
    const ratio = received / expected;
    if (allowPackage && Math.abs(ratio - Math.round(ratio)) < 0.02 && ratio >= 1) return 1; // package
    if (Math.abs(received - expected) <= 2) return 1;  // rounding
  }
  return 0.5;
}

function sameDay(a, b) {
  // Pacific-time comparison — bot runs in UTC; PT sessions after 5 PM cross
  // midnight UTC and would falsely fail same-day checks with .getDate() etc.
  return fmtDateIsoPacific(a) === fmtDateIsoPacific(b);
}

// Payment can be up to 7 days BEFORE session (prepay) or 14 days AFTER
// (late payment). Tunable if real-world data shows other patterns.
function withinDateWindow(payDate, apptDate) {
  const diff = (payDate - apptDate) / (24 * 60 * 60 * 1000);
  return diff >= -7 && diff <= 14;
}

// ---- Email building ----

function cashEntryLink({ date, name, amount, note = "per weekly billing email" }) {
  const iso = fmtDateIsoPacific(date);
  const slug = slugify(name);
  const filename = `billing/cash-entries/${iso}-${slug}.md`;
  const value = `${iso} | ${name} | $${amount} | ${note}\n`;
  return githubNewFileUrl({ filename, value, message: `Cash: ${name} $${amount} ${iso}` });
}

// Deep links that launch the bank app on a phone where the non-Venmo money
// lands. These are mobile URL schemes — if one doesn't open the app on Brad's
// device, edit it here (e.g. a universal https:// link).
// HTTPS links (custom schemes like chase:// break Brevo's click-tracking →
// 404). On a phone these open the bank app via universal links, else the site.
const BANK_APP_LINKS = {
  chase: "https://secure.chase.com/web/auth/dashboard",
  capitalone: "https://verified.capitalone.com/auth/signin",
};

// Short payment-method label from the client's notes.
function paymentMethodHint(roster) {
  const n = (roster.notes || "").toLowerCase();
  if (n.includes("zelle") || n.includes("zeal")) {
    if (n.includes("chase")) return "Zelle · Chase";
    if (n.includes("capital one") || n.includes("capitalone")) return "Zelle · Capital One";
    return "Zelle";
  }
  if (n.includes("check")) return n.includes("cash") ? "check / cash" : "check";
  return "cash";
}

// Returns { label, url } for the "Verify in <bank>" button, or null when the
// client pays by check/cash (no app to open).
function bankVerify(roster) {
  const n = (roster.notes || "").toLowerCase();
  if (n.includes("chase")) return { label: "Verify in Chase", url: BANK_APP_LINKS.chase };
  if (n.includes("capital one") || n.includes("capitalone")) return { label: "Verify in Capital One", url: BANK_APP_LINKS.capitalone };
  return null;
}

function reviewResolutionLink({ date, name, disposition, detail }) {
  const iso = fmtDateIsoPacific(date);
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

  // Headline counts are TOTALS over the final result rows, not just this
  // week's. Splitting them by age is a display concern (the Lagging section
  // below); it must never shrink the number Brad reads at the top. A week
  // whose only two review rows were carryover used to render "0 review".
  const totals = summaryCounts(results);
  const weekLabel = `${fmtDate(THIS_WEEK_START)} – ${fmtDate(now)}`;
  const subjParts = [];
  if (lagging.length) subjParts.push(`${lagging.length} carryover`);
  subjParts.push(`${totals.unpaid} unpaid`);
  subjParts.push(`${totals.needs_review} review`);
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
    const externalDue = Boolean(r.externalPaymentVerifiedUnpaid);
    const noteText = `Training ${fmtDate(r.appt.date)} ? Yeager's Gym`;
    const requestUrl = !externalDue && handle ? venmoRequestLink(handle, price, noteText) : "";
    const cashUrl = cashEntryLink({ date: r.appt.date, name: r.roster.vagaro_name, amount: price });
    let inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(r.roster.vagaro_name)}</strong> ? ${fmtDate(r.appt.date)} ? $${price}</div>`;
    if (externalDue) {
      inner += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin:8px 0;">${escapeHtml(r.note || "External payment verified not received.")}</div>`;
    }
    inner += `<div style="margin-top:10px;">`;
    if (requestUrl) inner += button({ href: requestUrl, label: `Request $${price} on Venmo`, color: "pink" });
    else if (!externalDue) inner += `<span style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;">Add Venmo handle in clients.csv to enable request</span> `;
    inner += buttonOutline({ href: cashUrl, label: externalDue ? "Confirm paid when received" : "Log as cash", color: "teal" });
    inner += `</div>`;
    return card(inner, "pink");
  };

  const reviewCard = (r) => {
    const expected = r.expectedPrice || r.roster?.default_price || 0;
    const received = r.payment?.amount ?? null;
    const name = r.roster.vagaro_name;
    let inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(name)}</strong> | ${fmtDate(r.appt.date)} | REVIEW, DO NOT REQUEST</div>`;
    if (received != null) {
      inner += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-bottom:8px;">Expected $${expected} | payment evidence $${received}${r.payment?.note ? ` | "${escapeHtml(r.payment.note)}"` : ""}</div>`;
    }
    inner += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-bottom:8px;">${escapeHtml(r.note || "Attendance, reschedule, rate, or allocation is not yet confirmed.")}</div>`;
    inner += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textDim};">Verify the evidence first. Review items are not receivables and intentionally have no request button.</div>`;
    return card(inner, "teal");
  };

  let body = "";

  // ── TOKEN EXPIRY WARNING (top, impossible to miss) ──
  // Set the GOOGLE_TOKEN_EXPIRES secret (YYYY-MM-DD) when you issue a token.
  // The bot warns starting 14 days out so there's time to re-auth.
  body += tokenExpiryNotice(now);

  // Top-line summary strip (table-based for Outlook)
  const chips = [];
  if (lagging.length) chips.push({ n: lagging.length, label: "Carryover", color: "pink" });
  chips.push({ n: totals.unpaid, label: "Unpaid", color: totals.unpaid ? "pink" : "textMuted" });
  chips.push({ n: totals.needs_review, label: "Review", color: totals.needs_review ? "teal" : "textMuted" });
  chips.push({ n: paidVenmo.length + paidCash.length + paidPrepaid.length, label: "Paid", color: "teal" });
  if (unidentified.length) chips.push({ n: unidentified.length, label: "Unidentified", color: "teal" });
  body += statStrip(chips);

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

  // CHECK / ZELLE / CASH — these clients pay outside Venmo. "Verify" deep-links
  // to the bank app where the money lands (Chase / Capital One) so Brad can
  // confirm it arrived; "Confirm paid" logs it so it won't reappear next week.
  if (cashPending.length) {
    body += sectionLabel(`Expected via check / Zelle / cash — ${cashPending.length}`, "teal");
    body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:10px;">These pay outside Venmo. Tap Verify to open the bank app and confirm it landed, then Confirm paid to log it.</div>`;
    for (const r of cashPending) {
      const price = r.checkoutAmount ?? r.expectedPrice ?? r.roster.default_price ?? "?";
      const bank = bankVerify(r.roster);
      const cashUrl = cashEntryLink({ date: r.appt.date, name: r.roster.vagaro_name, amount: price });
      let inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(r.roster.vagaro_name)}</strong> — ${fmtDate(r.appt.date)} — $${price} <span style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};">${escapeHtml(paymentMethodHint(r.roster))}</span></div>`;
      inner += `<div style="margin-top:10px;">`;
      if (bank) inner += button({ href: bank.url, label: bank.label, color: "pink" });
      inner += buttonOutline({ href: cashUrl, label: "Confirm paid", color: "teal" });
      inner += `</div>`;
      body += card(inner, "teal");
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

  // THIS WEEK — full session roster, grouped by day, ✅ paid / ❌ unpaid.
  // The at-a-glance "who's square" view Brad asked for.
  const dayName = (d) => new Date(d).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles", weekday: "long", month: "numeric", day: "numeric",
  });
  const dayKey = (d) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(d));
  const timeOf = (d) => new Date(d).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
  });
  const markFor = (r) => {
    if (r.status === "PAID_VENMO") return { icon: "&#9989;", red: false, tag: r.inferred ? " (moved)" : "" };
    if (r.status === "PAID_CASH") return { icon: "&#9989;", red: false, tag: " (cash)" };
    if (r.status === "PAID_PREPAID") return { icon: "&#9989;", red: false, tag: " (prepaid)" };
    if (r.status === "NEEDS_REVIEW") return { icon: "&#9203;", red: false, tag: r.payment?.amount != null ? ` (review &#183; payment $${r.payment.amount})` : " (review)" };
    if (r.status === "CASH_PENDING") return { icon: "&#9203;", red: false, tag: ` (${escapeHtml(paymentMethodHint(r.roster))})` };
    if (r.status === "UNPAID") return { icon: "&#10060;", red: true, tag: "" };
    if (r.status === "UNIDENTIFIED_SLOT") return { icon: "&#10067;", red: true, tag: ` &#183; ${escapeHtml(r.appt.summary || "unknown")}` };
    return { icon: "&#8226;", red: false, tag: "" };
  };

  const byDay = new Map();
  for (const r of results) {
    const k = dayKey(r.appt.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  if (byDay.size) {
    body += sectionLabel("This Week — Session Ledger", "teal");
    body += `<div style="font-family:${FONTS.body};font-size:12px;color:${PALETTE.textMuted};margin-bottom:12px;">&#9989; paid &#160;&#183;&#160; &#10060; unpaid &#160;&#183;&#160; &#9203; expected (check/Zelle) &#160;&#183;&#160; &#10067; unidentified</div>`;
    for (const k of [...byDay.keys()].sort()) {
      const rows = byDay.get(k).sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date));
      body += `<div style="margin:14px 0 6px;font-family:${FONTS.display};font-size:13px;font-weight:700;color:${PALETTE.teal};">${dayName(k + "T20:00:00Z")}</div>`;
      for (const r of rows) {
        const m = markFor(r);
        const name = r.roster?.vagaro_name || "(unidentified)";
        const color = m.red ? PALETTE.pink : PALETTE.textPrimary;
        body += `<div style="font-size:14px;color:${color};padding:3px 0;">${m.icon}&#160; <span style="color:${PALETTE.textMuted};font-size:12px;">${timeOf(r.appt.date)}</span>&#160; ${escapeHtml(name)}<span style="color:${PALETTE.textMuted};font-size:12px;">${m.tag}</span></div>`;
      }
    }
  }

  // UNMATCHED PAYMENTS (with their memos, so Brad can hand-assign)
  if (unmatchedPayments.length) {
    body += sectionLabel(`Unmatched Venmo payments — ${unmatchedPayments.length}`, "textMuted");
    for (const p of unmatchedPayments) {
      body += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};padding:4px 0;border-bottom:1px solid ${PALETTE.border};">${fmtDate(p.date)} · ${escapeHtml(p.sender_display_name)} · $${p.amount} · "${escapeHtml(p.note || "")}"</div>`;
    }
  }

  // ── WEEK LEDGER — the two numbers Brad cares about most ──
  // Venmo collected = actual $ that hit Venmo for matched sessions this run.
  // Outstanding = money owed but not yet in (unpaid sessions + short balances).
  // Confirmed due is firm UNPAID only. Review exposure is deliberately not
  // receivable dollars; uncertainty must never become a collection amount.
  const venmoCollected = paidVenmo.reduce((s, r) => s + (r.payment?.amount || 0), 0);
  const confirmedDue = [...unpaid, ...lagging.filter((r) => r.status === "UNPAID")]
    .reduce((s, r) => s + (r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price ?? 0), 0);
  const outColor = confirmedDue > 0 ? PALETTE.pink : PALETTE.teal;
  body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bgPanel}" style="background-color:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:12px;margin-top:26px;">`
    + `<tr><td colspan="2" bgcolor="${PALETTE.teal}" height="4" style="height:4px;line-height:4px;font-size:0;background:${NEON_GRADIENT};">&nbsp;</td></tr>`
    + `<tr>`
    + `<td width="50%" valign="top" style="padding:18px 20px;border-right:1px solid ${PALETTE.border};">`
      + `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};">Venmo Collected This Week</div>`
      + `<div style="font-family:${FONTS.display};font-size:30px;font-weight:800;color:${PALETTE.teal};margin-top:8px;">$${venmoCollected.toLocaleString()}</div></td>`
    + `<td width="50%" valign="top" style="padding:18px 20px;">`
      + `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};">Confirmed Due</div>`
      + `<div style="font-family:${FONTS.display};font-size:30px;font-weight:800;color:${outColor};margin-top:8px;">$${confirmedDue.toLocaleString()}</div></td>`
    + `</tr></table>`;

  // ── VAGARO CHECKOUT PROMPT — auto-generated for Claude for Chrome ──
  // Brad uses Vagaro's calendar "checkout" UI as a visual paid-checkmark.
  // The bot already knows who paid this week, so we render the full
  // copy-paste prompt with the client list pre-filled at the bottom of the
  // email. Canonical rules live at billing/CHECKOUT-PROMPT.md.
  const checkoutPrompt = buildCheckoutPrompt(results, now);
  body += sectionLabel(`Vagaro Checkout — copy block below into Claude for Chrome`, "teal");
  body += `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textMuted};margin-bottom:8px;">Triple-click inside the box, ⌘A, ⌘C, then paste into a new Claude for Chrome session. Full rules + this week's paid clients are baked in.</div>`;
  body += `<pre style="background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:6px;padding:12px;font-family:${FONTS.display};font-size:8px;line-height:1.4;color:${PALETTE.textPrimary};white-space:pre-wrap;overflow-x:auto;">${escapeHtml(checkoutPrompt)}</pre>`;

  const footer = `Week ${weekLabel} · log: billing/logs/${fmtDateIso(now)}.md · ${GITHUB_OWNER}/${GITHUB_REPO}`;
  const html = emailShell({ title: `Week ending ${fmtDate(now)}`, bodyHtml: body, footerNote: footer });
  return { subject, html };
}

// ── Vagaro checkout prompt for Claude for Chrome ──
// Returns the full prompt (rules + this week's paid client list) as plain
// text so Brad can copy-paste a single block into a fresh chat each week.
export function buildCheckoutPrompt(results, now) {
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
the real money already came via Venmo / check / Zelle; Vagaro's payment-method
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

// Summary stat cards as a single table row (Outlook-safe; no flexbox).
function statStrip(items) {
  if (!items.length) return "";
  const w = Math.floor(100 / items.length);
  const cells = items.map((it, i) => {
    const c = PALETTE[it.color] || PALETTE.teal;
    const padl = i === 0 ? "0" : "5px";
    return `<td width="${w}%" valign="top" style="padding:0 0 0 ${padl};">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bgPanel}" style="background-color:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-top:3px solid ${c};border-radius:8px;">`
      + `<tr><td style="padding:11px 12px;">`
      + `<div style="font-family:${FONTS.display};font-size:22px;font-weight:800;color:${c};line-height:1;">${it.n}</div>`
      + `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-top:6px;">${it.label}</div>`
      + `</td></tr></table></td>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;"><tr>${cells}</tr></table>`;
}

// Warns 14 days before the Google OAuth token expires (set GOOGLE_TOKEN_EXPIRES
// = YYYY-MM-DD when you issue/refresh a token). Returns "" when not set or
// more than 14 days out. Includes the exact re-auth steps so Brad never has to
// hunt for them. (Better long-term fix: publish the OAuth app to Production so
// tokens stop expiring — see SETUP.md.)
function tokenExpiryNotice(now) {
  const raw = process.env.GOOGLE_TOKEN_EXPIRES;
  if (!raw) return "";
  const exp = new Date(raw + "T12:00:00Z");
  if (Number.isNaN(exp.getTime())) return "";
  const days = Math.ceil((exp - now) / 86400000);
  if (days > 14) return "";
  const expired = days < 0;
  const secretsUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/settings/secrets/actions`;
  const headline = expired
    ? `GOOGLE ACCESS EXPIRED ${-days} day${-days === 1 ? "" : "s"} ago — the bot can't read Venmo emails until you re-auth`
    : `GOOGLE ACCESS EXPIRES IN ${days} DAY${days === 1 ? "" : "S"} (${raw}) — re-auth before then or the bot goes blind`;
  return `<div style="border:1px solid ${PALETTE.pink};border-radius:12px;overflow:hidden;margin-bottom:20px;box-shadow:0 0 30px rgba(239,50,149,0.20);">`
    + `<div style="height:4px;background:${PALETTE.pink};"></div>`
    + `<div style="padding:16px 18px;">`
    + `<div style="font-family:${FONTS.display};font-size:13px;font-weight:700;color:${PALETTE.pink};letter-spacing:0.06em;">&#9888; ${headline}</div>`
    + `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};line-height:1.55;margin-top:10px;">Fix (~5 min): open <b>developers.google.com/oauthplayground</b> &rarr; gear icon &rarr; "Use your own OAuth credentials" (paste Client ID + Secret) &rarr; authorize scope <b>gmail.readonly</b> as <b>thebradyeager@gmail.com</b> &rarr; "Exchange authorization code for tokens" &rarr; copy the <b>refresh token</b>. Then update the <b>GOOGLE_REFRESH_TOKEN</b> and <b>GOOGLE_TOKEN_EXPIRES</b> secrets here: ${secretsUrl}</div>`
    + `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-top:10px;">Permanent fix: publish the OAuth app to Production (Google Cloud Console &rarr; OAuth consent screen) so tokens stop expiring. See billing/SETUP.md.</div>`
    + `</div></div>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT-DRIVEN MODE (BILLING_MODE=payment-driven)
//
// The owner's schedule changes weekly and Vagaro can't feed a roster. So we
// stop guessing a schedule and drive billing from actual Venmo payments plus
// payment HISTORY (the matched-payments ledger):
//   1. MONEY IN     — every Venmo payment in the 7-day window, matched to a
//                     client. Sum the total. New matches get locked to the
//                     ledger (gmail_id) so a dollar is never double-counted.
//   2. CHASE LIST   — history-driven. A "REGULAR" (paid in ≥ N of the last 5
//                     completed weeks) who has NO payment THIS week → soft
//                     "did they train?" nudge with a Venmo request button.
//   3. CASH/CHECK/ZELLE — pays_cash roster clients never hit Venmo; list them
//                     as a standing "verify in bank" reminder.
//   4. UNMATCHED    — in-window payments that matched no roster client.
//   5. NEEDS REVIEW — a matched payment whose amount is anomalous vs usual.
// ═══════════════════════════════════════════════════════════════════════

// ── Cadence tuning constants ──
// A client is a REGULAR if they paid in at least this many of the last
// CADENCE_WINDOW_WEEKS completed weeks. 3-of-5 tolerates one vacation/skip
// without dropping a true weekly client off the chase list.
export const REGULAR_WEEKS_THRESHOLD = 3;
export const CADENCE_WINDOW_WEEKS = 5;
// A matched in-window payment flags NEEDS_REVIEW when it falls below this
// fraction of the client's usual amount (and isn't a known acceptable price).
// Light touch — we only want the obvious "$30 when they usually pay $70".
const REVIEW_LOW_FRACTION = 0.7;

// Is this ledger entry real TRAINING income for cadence purposes? Excludes
// EXTRA_SERVICE (Jacob programming, James peptides) and any "n/a-*" session
// (non-training one-offs). Used to keep the chase list honest.
function isTrainingLedgerEntry(m) {
  const status = m.matched_to?.status || "";
  const date = m.matched_to?.date || "";
  if (status === "EXTRA_SERVICE") return false;
  if (String(date).startsWith("n/a")) return false;
  return true;
}

// Bucket index of a date relative to NOW's 7-day windows.
//   0  = current week  (PD_WINDOW_START → NOW)
//   1  = one completed week before that, etc.
// Negative = future (shouldn't happen). We bucket by the date money ARRIVED.
function weekBucketIndex(date, now = NOW) {
  const ms = now.getTime() - new Date(date).getTime();
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
}

// Mode (most frequent) of an array of numbers; ties broken by the larger
// value (a client who sometimes pays $50 and sometimes $70 → assume the
// higher when tied, so we don't under-request).
function modeAmount(amounts) {
  if (!amounts.length) return null;
  const counts = new Map();
  for (const a of amounts) counts.set(a, (counts.get(a) || 0) + 1);
  let best = null, bestN = -1;
  for (const [val, n] of counts) {
    if (n > bestN || (n === bestN && val > best)) { best = val; bestN = n; }
  }
  return best;
}

// Build per-client cadence from the ledger history. Returns a Map keyed by
// vagaro_name → { regular, usual, lastPaid, weeksPaid, paidThisWeek }.
export function computeCadence(clients, priorMatches, payments, now = NOW) {
  const byName = new Map(clients.map((c) => [c.vagaro_name, c]));
  // Resolve a ledger entry's client to a roster row (it stores vagaro_name).
  const cad = new Map();
  for (const c of clients) {
    // Skip clients that never use Venmo (cash/check/Zelle) or pre-paid — they
    // can't have a Venmo cadence, and including them would chase phantoms.
    if (c.pays_cash || c.prepaid) continue;
    cad.set(c.vagaro_name, {
      client: c,
      regular: false,
      usual: c.default_price ?? null,
      lastPaid: null,
      weeksPaid: 0,
      paidThisWeek: false,
      recentAmounts: [],
      weekSet: new Set(),
    });
  }

  // Walk historical ledger entries (real training income only).
  for (const m of priorMatches) {
    if (!isTrainingLedgerEntry(m)) continue;
    const name = m.matched_to?.client;
    if (!name || !cad.has(name)) continue;
    const c = byName.get(name);
    const payDate = m.payment?.date;
    if (!payDate || String(payDate).startsWith("n/a")) continue;
    const bucket = weekBucketIndex(payDate, now);
    const entry = cad.get(name);
    // Track last-paid date across all history.
    if (!entry.lastPaid || new Date(payDate) > new Date(entry.lastPaid)) {
      entry.lastPaid = payDate;
    }
    // A current-week (bucket 0) ledger payment means they already paid this
    // week — even though we matched it on a PRIOR run (so it's a prior-match
    // lock, not a live MONEY-IN hit). This keeps already-paid regulars OFF the
    // chase list. Without it, every client whose week-N payment is already
    // ledgered would be wrongly chased (the "9 phantom chases" bug).
    if (bucket === 0) entry.paidThisWeek = true;
    // Cadence counts the last CADENCE_WINDOW_WEEKS COMPLETED weeks (buckets
    // 1..CADENCE_WINDOW_WEEKS). Bucket 0 is the current (incomplete) week.
    if (bucket >= 1 && bucket <= CADENCE_WINDOW_WEEKS) {
      entry.weekSet.add(bucket);
      // Snap amount to the real session price (strip smoothie) for "usual".
      const accept = c.acceptable_prices?.length ? c.acceptable_prices : [c.default_price];
      const snapped = matchedSessionPrice(m.payment.amount, accept) ?? m.payment.amount;
      entry.recentAmounts.push(snapped);
    }
  }

  // Fold in THIS-week matched payments (from the live reconcile, not yet in
  // the prior ledger) so paidThisWeek is accurate on the very first run.
  for (const p of payments) {
    const name = p.matchedClient;             // set by reconcilePaymentsToClients
    if (!name || !cad.has(name)) continue;
    const bucket = weekBucketIndex(p.date, now);
    if (bucket === 0) cad.get(name).paidThisWeek = true;
  }

  for (const [, entry] of cad) {
    entry.weeksPaid = entry.weekSet.size;
    entry.regular = entry.weeksPaid >= REGULAR_WEEKS_THRESHOLD;
    const m = modeAmount(entry.recentAmounts);
    if (m != null) entry.usual = m;
  }
  return cad;
}

// Match every in-window Venmo payment to a roster client, reusing the same
// matching primitives reconcile() uses (note-keyword claim, venmo_display_names,
// venmo_handle, fuzzyName). NO schedule, NO appointments. Records new matches
// to the ledger (gmail_id locked) so a payment is never double-counted.
//
// Returns { moneyIn, unmatched, newMatches, total }.
//   moneyIn:  [{ payment, client, checkoutAmount, low }]  (client may be null? no —
//             only matched payments are moneyIn; unmatched go to `unmatched`)
export function reconcilePaymentsToClients(payments, clients, priorMatches) {
  const priorMatchIds = new Set(priorMatches.map((m) => m.gmail_id).filter(Boolean));
  const fingerprint = (sender, amount, note, dateIso) =>
    `${(sender || "").toLowerCase()}|${amount}|${(note || "").toLowerCase()}|${dateIso || ""}`;
  const priorFingerprints = new Set(
    priorMatches.map((m) =>
      fingerprint(m.payment?.sender, m.payment?.amount, m.payment?.note, m.payment?.date)),
  );
  const isPriorMatch = (p) => {
    if (p.gmail_id && priorMatchIds.has(p.gmail_id)) return true;
    const fp = fingerprint(p.sender_display_name, p.amount, p.note, fmtDateIso(p.date));
    return priorFingerprints.has(fp);
  };

  // Note-keyword routing (Mathieu "Rachael" → Rachel), same as reconcile().
  const claimFor = (p) => {
    const note = (p.note || "").toLowerCase();
    if (!note) return null;
    for (const c of clients) {
      const kws = c.note_keywords || [];
      if (kws.length && kws.some((kw) => kw && note.includes(kw))) return c;
    }
    return null;
  };
  // Sender → roster client (handle or fuzzy display-name), excluding a row
  // that is note-claimed by someone else.
  const resolveClient = (p) => {
    const claimed = claimFor(p);
    if (claimed) return claimed;
    return clients.find((c) => {
      if (c.note_keywords?.length) {
        // A note-keyword client is only matched via its keyword (handled
        // above) OR when no sibling claims it — but to keep Celestin vs Rachel
        // disambiguation correct, a payment with no claiming keyword still
        // falls to the sender display name below.
      }
      const handleMatch = c.venmo_handle && p.sender_handle === c.venmo_handle.toLowerCase();
      const names = c.venmo_display_names?.length ? c.venmo_display_names : [c.vagaro_name];
      return handleMatch || names.some((n) => fuzzyName(p.sender_display_name, n) >= 0.8);
    }) || null;
  };

  const moneyIn = [];
  const unmatched = [];
  const newMatches = [];
  for (const p of payments) {
    // IMPORTANT: isPriorMatch does NOT suppress display. The owner re-triggers
    // the workflow repeatedly within a week — on a re-run every payment is
    // already ledger-locked, so skipping locked payments would render MONEY IN
    // empty/under-counted. MONEY IN must show EVERY in-window receipt. The
    // ledger lock ONLY governs (a) which matches get APPENDED this run (no
    // duplicate gmail_ids) and (b) cadence "paidThisWeek". So we compute the
    // lock once and use it solely to gate the newMatches append below.
    const locked = isPriorMatch(p);
    const client = resolveClient(p);
    if (!client) { unmatched.push(p); continue; }
    // Pre-paid clients (Robert) only ever Venmo $5 smoothies → not income.
    if (client.prepaid) { unmatched.push(p); continue; }
    const accept = client.acceptable_prices?.length ? client.acceptable_prices : [client.default_price];
    const checkoutAmount = matchedSessionPrice(p.amount, accept) ?? p.amount;
    const score = amountScore(p.amount, accept);
    p.matchedClient = client.vagaro_name; // used by computeCadence (paidThisWeek)
    moneyIn.push({ payment: p, client, checkoutAmount, low: score < 0.8 });
    // Append to the ledger ONLY if this is a brand-new payment (not already
    // locked) — keeps the ledger idempotent across same-week re-runs.
    if (p.gmail_id && !locked) {
      newMatches.push({
        gmail_id: p.gmail_id,
        matched_at: new Date().toISOString(),
        source_mode: "payment-driven",
        matched_to: {
          date: fmtDateIsoPacific(p.date),
          client: client.vagaro_name,
          status: score >= 0.8 ? "PAID_VENMO" : "NEEDS_REVIEW",
        },
        payment: {
          sender: p.sender_display_name,
          amount: p.amount,
          note: p.note,
          date: fmtDateIso(p.date),
        },
      });
    }
  }
  const total = moneyIn.reduce((s, m) => s + (m.payment.amount || 0), 0);
  return { moneyIn, unmatched, newMatches, total };
}

// ── Payment-driven email (command-center look via lib.mjs primitives) ──
export function buildPaymentDrivenEmail({
  moneyIn, unmatched, cadence, clients, now = NOW, windowStart = PD_WINDOW_START,
}) {
  const money = (n) => `$${Number(n || 0).toLocaleString()}`;
  const total = moneyIn.reduce((s, m) => s + (m.payment.amount || 0), 0);

  // ── CHASE LIST: regulars with no payment this week ──
  const chase = [];
  for (const [name, c] of cadence) {
    if (!c.regular) continue;
    if (c.paidThisWeek) continue;
    chase.push({ name, usual: c.usual, lastPaid: c.lastPaid, client: c.client });
  }
  chase.sort((a, b) => new Date(b.lastPaid || 0) - new Date(a.lastPaid || 0));

  // ── NEEDS REVIEW: matched but anomalously low vs usual ──
  const review = [];
  for (const m of moneyIn) {
    const cad = cadence.get(m.client.vagaro_name);
    const usual = cad?.usual ?? m.client.default_price;
    if (!usual) continue;
    // Skip when the amount is an acceptable price for this client (couple solo
    // vs together, group rate) — those aren't anomalies.
    const accept = m.client.acceptable_prices?.length ? m.client.acceptable_prices : [m.client.default_price];
    if (amountScore(m.payment.amount, accept) >= 0.8) continue;
    if (m.payment.amount < usual * REVIEW_LOW_FRACTION) {
      review.push({ ...m, usual });
    }
  }

  // ── CASH / CHECK / ZELLE standing list ──
  const cashClients = clients.filter((c) => c.pays_cash);

  const subject = `Weekly billing — week ending ${fmtDate(now)} — ${money(total)} in, ${chase.length} to chase`;

  let body = "";
  // Token-expiry banner (kept verbatim from schedule mode).
  body += tokenExpiryNotice(now);

  // Top stat strip: money in · payments · to chase · unmatched.
  body += statStrip([
    { n: money(total), label: "Money In", color: "teal" },
    { n: moneyIn.length, label: "Payments", color: "teal" },
    { n: chase.length, label: "To Chase", color: chase.length ? "pink" : "textMuted" },
    { n: unmatched.length, label: "Unmatched", color: unmatched.length ? "purple" : "textMuted" },
  ]);

  // ── MONEY IN ──
  body += sectionLabel("Money In — This Week", "teal");
  if (!moneyIn.length) {
    body += card(`<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};">No Venmo payments in the last 7 days.</div>`, "border");
  } else {
    const rows = [...moneyIn]
      .sort((a, b) => new Date(b.payment.date) - new Date(a.payment.date))
      .map((m) => {
        const nm = m.client.vagaro_name;
        const amt = money(m.payment.amount);
        // Only show the checkout snap when it's a confident full-payment match
        // (strip-the-smoothie). For low/review amounts the snap is a guess, so
        // suppress it — the ⚑ review flag tells Brad to eyeball it instead.
        const co = !m.low && m.checkoutAmount != null && m.checkoutAmount !== m.payment.amount
          ? ` <span style="color:${PALETTE.textMuted};">(→ $${m.checkoutAmount})</span>` : "";
        const flag = m.low ? ` <span style="color:${PALETTE.pink};">⚑ review</span>` : "";
        return `<tr>`
          + `<td style="padding:7px 10px;font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};border-bottom:1px solid ${PALETTE.divider};"><strong>${escapeHtml(nm)}</strong></td>`
          + `<td align="right" style="padding:7px 10px;font-family:${FONTS.display};font-size:13px;color:${PALETTE.teal};font-weight:700;border-bottom:1px solid ${PALETTE.divider};white-space:nowrap;">${amt}${co}${flag}</td>`
          + `<td style="padding:7px 10px;font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};border-bottom:1px solid ${PALETTE.divider};white-space:nowrap;">${fmtDate(m.payment.date)}</td>`
          + `<td style="padding:7px 10px;font-family:${FONTS.display};font-size:11px;color:${PALETTE.textDim};border-bottom:1px solid ${PALETTE.divider};">${escapeHtml(m.payment.note || "")}</td>`
          + `</tr>`;
      }).join("");
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bgPanel}" style="background-color:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:8px;">${rows}`
      + `<tr><td style="padding:9px 10px;font-family:${FONTS.display};font-size:13px;color:${PALETTE.textPrimary};font-weight:700;">TOTAL</td>`
      + `<td align="right" colspan="3" style="padding:9px 10px;font-family:${FONTS.display};font-size:15px;color:${PALETTE.teal};font-weight:800;">${money(total)}</td></tr>`
      + `</table>`;
  }

  // ── CHASE LIST ──
  body += sectionLabel(`Chase List — ${chase.length}`, "pink");
  body += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-bottom:10px;">Regulars (paid ${REGULAR_WEEKS_THRESHOLD}+ of the last ${CADENCE_WINDOW_WEEKS} weeks) with no payment this week. Soft nudge — only chase if they actually trained.</div>`;
  if (!chase.length) {
    body += card(`<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.teal};">All regulars have paid this week. Nothing to chase.</div>`, "teal");
  } else {
    for (const ch of chase) {
      const handle = ch.client.venmo_handle;
      const usual = ch.usual || ch.client.default_price || 0;
      const lastTxt = ch.lastPaid ? fmtDate(ch.lastPaid) : "—";
      let inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};margin-bottom:4px;">`
        + `<strong>${escapeHtml(ch.name)}</strong> — usually ~$${usual}, last paid ${lastTxt}. Did they train?</div>`;
      inner += `<div style="margin-top:10px;">`;
      if (handle) {
        inner += button({
          href: venmoRequestLink(handle, usual, `Training — Yeager's Gym`),
          label: `Request $${usual}`,
          color: "pink",
        });
      } else {
        inner += `<span style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:11px;">No Venmo handle on file — add one to clients.csv to enable a one-tap request.</span> `;
      }
      // Soft dismiss: log a "wasn't trained / skip" note so we know it was reviewed.
      const skipUrl = githubNewFileUrl({
        filename: `billing/cancellations/${fmtDateIso(now)}-${slugify(ch.name)}.md`,
        value: `${fmtDateIsoPacific(now)} | ${ch.name} | wasn't trained / skip\n`,
        message: `Skip: ${ch.name} ${fmtDateIso(now)}`,
      });
      inner += buttonOutline({ href: skipUrl, label: "Wasn't trained / skip", color: "teal" });
      inner += `</div>`;
      body += card(inner, "pink");
    }
  }

  // ── NEEDS REVIEW ──
  if (review.length) {
    body += sectionLabel(`Needs Review — ${review.length}`, "purple");
    for (const r of review) {
      const inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};">`
        + `<strong>${escapeHtml(r.client.vagaro_name)}</strong> paid ${money(r.payment.amount)} — usually ~$${r.usual}.`
        + `${r.payment.note ? ` <span style="color:${PALETTE.textDim};">"${escapeHtml(r.payment.note)}"</span>` : ""}</div>`
        + `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-top:6px;">Eyeball — short session, partial payment, or a memo to read.</div>`;
      body += card(inner, "purple");
    }
  }

  // ── CASH / CHECK / ZELLE ──
  body += sectionLabel("Cash / Check / Zelle — Verify in Bank", "teal");
  body += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-bottom:10px;">These clients never pay via Venmo, so cadence can't see them. Confirm in your bank app when they train.</div>`;
  if (!cashClients.length) {
    body += card(`<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};">No cash/check/Zelle clients on the roster.</div>`, "border");
  } else {
    for (const c of cashClients) {
      const method = paymentMethodHint(c);
      const bank = bankVerify(c);
      let inner = `<div style="font-family:${FONTS.body};font-size:13px;color:${PALETTE.textPrimary};margin-bottom:4px;">`
        + `<strong>${escapeHtml(c.vagaro_name)}</strong> — ${escapeHtml(method)} · usually $${c.default_price ?? "?"}</div>`;
      if (bank) {
        inner += `<div style="margin-top:8px;">` + button({ href: bank.url, label: bank.label, color: "teal" }) + `</div>`;
      }
      body += card(inner, "teal");
    }
  }

  // ── UNMATCHED ──
  if (unmatched.length) {
    body += sectionLabel(`Unmatched Payments — ${unmatched.length}`, "purple");
    body += `<div style="font-family:${FONTS.display};font-size:11px;color:${PALETTE.textMuted};margin-bottom:10px;">In-window Venmo payments that didn't match a roster client — new clients, $5 smoothies, one-offs. Eyeball.</div>`;
    let list = "";
    [...unmatched]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .forEach((p) => {
        list += `<tr><td style="padding:8px 12px;font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};border-bottom:1px solid ${PALETTE.divider};">`
          + `<span style="color:${PALETTE.textPrimary};">${escapeHtml(p.sender_display_name)}</span> · <span style="color:${PALETTE.teal};font-weight:700;">${money(p.amount)}</span> · ${fmtDate(p.date)} · "${escapeHtml(p.note || "")}"`
          + `</td></tr>`;
      });
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bgPanel}" style="background-color:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-radius:8px;">${list}</table>`;
  }

  const footer = `Payment-driven mode · window ${fmtDateIso(windowStart)} → ${fmtDateIso(now)} · cadence ${REGULAR_WEEKS_THRESHOLD}/${CADENCE_WINDOW_WEEKS} weeks`;
  const html = emailShell({
    title: `Week ending ${fmtDate(now)} · ${money(total)} in · ${chase.length} to chase`,
    bodyHtml: body,
    footerNote: footer,
    subtitle: "Payment-Driven Reconciliation",
  });
  return { subject, html, chase, review, moneyInTotal: total };
}

// Payment-driven weekly log. Mirrors writeLog's section headers so downstream
// tooling (vagaro-prompt, monthly summary) can still parse the money lines.
async function writePaymentDrivenLog({ payments, moneyIn, unmatched, chase, review, cashClients }) {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `${fmtDateIsoPacific(NOW)}.md`);
  const money = (n) => `$${Number(n || 0).toLocaleString()}`;
  const total = moneyIn.reduce((s, m) => s + (m.payment.amount || 0), 0);
  let md = `# Weekly billing log (payment-driven) — ${fmtDateIso(NOW)}\n\n`;
  md += `Window: ${PD_WINDOW_START.toISOString()} → ${NOW.toISOString()}\n\n`;
  md += `## Money in (${moneyIn.length}) — total ${money(total)}\n`;
  for (const m of [...moneyIn].sort((a, b) => new Date(a.payment.date) - new Date(b.payment.date))) {
    md += `- ${fmtDateIso(m.payment.date)} | ${m.client.vagaro_name} | $${m.payment.amount}`
      + `${!m.low && m.checkoutAmount != null ? ` | checkout $${m.checkoutAmount}` : ""}`
      + `${m.low ? " | NEEDS_REVIEW" : ""} | note: "${m.payment.note || ""}"\n`;
  }
  md += `\n## Chase list (${chase.length})\n`;
  for (const ch of chase) {
    md += `- ${ch.name} | usually ~$${ch.usual} | last paid ${ch.lastPaid || "—"}\n`;
  }
  md += `\n## Cash / check / Zelle (${cashClients.length})\n`;
  for (const c of cashClients) {
    md += `- ${c.vagaro_name} | ${paymentMethodHint(c)} | usually $${c.default_price ?? "?"}\n`;
  }
  md += `\n## Venmo payments received (${payments.length})\n`;
  for (const p of payments) {
    md += `- ${fmtDateIso(p.date)} | ${p.sender_display_name} (@${p.sender_handle || "?"}) | $${p.amount} | "${p.note}"\n`;
  }
  if (unmatched.length) {
    md += `\n## Unmatched Venmo payments\n`;
    for (const p of unmatched) {
      md += `- ${fmtDateIso(p.date)} | ${p.sender_display_name} | $${p.amount} | "${p.note}"\n`;
    }
  }
  md += `\n## Summary\n`;
  md += `- mode: payment-driven\n`;
  md += `- money_in_count: ${moneyIn.length}\n`;
  md += `- money_in_total: ${total}\n`;
  md += `- chase: ${chase.length}\n`;
  md += `- needs_review: ${review.length}\n`;
  md += `- unmatched: ${unmatched.length}\n`;
  await fs.writeFile(file, md, "utf8");
  return file;
}

// Orchestration for payment-driven mode. Called from main() when
// BILLING_MODE=payment-driven. Deliberately skips iCal + schedule.csv.
async function runPaymentDriven() {
  // NOTE: VAGARO_ICAL_URL is intentionally NOT required here.
  requireEnv("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID);
  requireEnv("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET);
  requireEnv("GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN);
  requireEnv("BREVO_API_KEY", BREVO_API_KEY);
  console.log("Billing mode: payment-driven (no schedule, no iCal)");
  console.log(`Window: ${PD_WINDOW_START.toISOString()} → ${NOW.toISOString()}`);

  const [clients, priorMatches, allPayments] = await Promise.all([
    loadClients(CLIENTS_CSV),
    loadMatchedLedger(REPO_ROOT),
    fetchVenmoPayments(),
  ]);
  console.log(`Loaded ${clients.length} clients, ${priorMatches.length} prior matches, ${allPayments.length} Venmo payments (Gmail window)`);

  // MONEY IN = payments in the 7-day window only.
  const windowPayments = allPayments.filter((p) => new Date(p.date) >= PD_WINDOW_START);
  console.log(`${windowPayments.length} payments in the 7-day money-in window`);

  const { moneyIn, unmatched, newMatches, total } =
    reconcilePaymentsToClients(windowPayments, clients, priorMatches);
  console.log(`Matched ${moneyIn.length} (${total} total), ${unmatched.length} unmatched, ${newMatches.length} new ledger locks`);

  if (DRY_RUN !== "true") {
    await saveMatchedLedger(REPO_ROOT, [...priorMatches, ...newMatches]);
  }

  // Cadence uses the FULL ledger history + this week's live matches.
  const cadence = computeCadence(clients, priorMatches, windowPayments, NOW);

  const { subject, html, chase, review } = buildPaymentDrivenEmail({
    moneyIn, unmatched, cadence, clients, now: NOW, windowStart: PD_WINDOW_START,
  });
  const cashClients = clients.filter((c) => c.pays_cash);

  const logFile = await writePaymentDrivenLog({
    payments: windowPayments, moneyIn, unmatched, chase, review, cashClients,
  });
  console.log(`Wrote log: ${logFile}`);
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

// ---- Log file ----

async function writeLog({ appointments, payments, results, unmatchedPayments }) {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `${fmtDateIsoPacific(NOW)}.md`);
  let md = `# Weekly billing log — ${fmtDateIso(NOW)}\n\n`;
  md += `Window: ${WINDOW_START.toISOString()} → ${NOW.toISOString()}\n\n`;
  md += `## Appointments (${appointments.length})\n`;
  for (const r of results) {
    const name = r.roster?.vagaro_name || r.appt.client_name || `[unidentified: ${r.appt.summary || "?"}]`;
    const price = r.expectedPrice ?? r.roster?.default_price ?? "?";
    const co = r.checkoutAmount != null ? ` | checkout $${r.checkoutAmount}` : "";
    md += `- ${fmtDateTime(r.appt.date)} | ${name} | $${price}${co} | ${r.status}`;
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
  // Same helper the email uses — one derivation, from the final rows only.
  const counts = summaryCounts(results);
  md += `\n## Summary\n`;
  for (const [k, v] of Object.entries(counts)) md += `- ${k}: ${v}\n`;
  await fs.writeFile(file, md, "utf8");
  return { file, counts };
}

// ---- Main ----

async function main() {
  // Gate FIRST — before any mode branches. A non-dry run that isn't on the
  // approved schedule+ical path must fail loudly here rather than produce a
  // normal-looking billing email from a degraded path.
  assertProductionConfig({
    billingMode: BILLING_MODE,
    appointmentSource: APPOINTMENT_SOURCE,
    dryRun: DRY_RUN === "true",
  });
  // Phase 4: payment-driven mode is a fully separate code path. It skips iCal
  // and schedule.csv entirely and drives billing from Venmo + payment history.
  // The committed default is "schedule" so the live Friday cron is unaffected.
  if (BILLING_MODE === "payment-driven") {
    return runPaymentDriven();
  }
  // Phase 3: only require the iCal URL when we're actually using iCal.
  // The committed default source is "ical"; "vagaro-events" reads from the
  // on-disk webhook archive and doesn't need the iCal secret at all.
  if (APPOINTMENT_SOURCE === "ical") {
    requireEnv("VAGARO_ICAL_URL", VAGARO_ICAL_URL);
  }
  requireEnv("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID);
  requireEnv("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET);
  requireEnv("GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN);
  requireEnv("BREVO_API_KEY", BREVO_API_KEY);
  console.log(`Appointment source: ${APPOINTMENT_SOURCE}`);
  console.log(`Window: ${WINDOW_START.toISOString()} → ${NOW.toISOString()}`);
  const [clients, schedule, scheduleOverrides, cashLog, externalUnpaid, cancellations, priorMatches, paymentDrivenRunDates, rawSlots, payments] = await Promise.all([
    loadClients(CLIENTS_CSV),
    loadSchedule(SCHEDULE_CSV),
    loadScheduleOverrides(SCHEDULE_OVERRIDES_CSV),
    loadCashEntries(REPO_ROOT),
    loadExternalUnpaid(REPO_ROOT),
    loadCancellations(REPO_ROOT),
    loadMatchedLedger(REPO_ROOT),
    loadPaymentDrivenRunDates(REPO_ROOT),
    fetchVagaroAppointments(),
    fetchVenmoPayments(),
  ]);
  const schedulePriorMatches = trustedScheduleLedger(priorMatches, paymentDrivenRunDates);
  const evidenceOnlyCount = priorMatches.length - schedulePriorMatches.length;
  console.log(`Loaded ${clients.length} clients, ${schedule.length} schedule rows, ${scheduleOverrides.length} date-specific overrides, ${cashLog.length} cash entries, ${externalUnpaid.length} verified external unpaid, ${cancellations.length} cancellations, ${priorMatches.length} prior matches (${evidenceOnlyCount} payment-driven evidence-only)`);
  const paymentsThroughNow = payments.filter((p) => new Date(p.date) <= NOW);
  console.log(`Found ${rawSlots.length} slots, ${paymentsThroughNow.length} Venmo payments through ${NOW.toISOString()} (${payments.length - paymentsThroughNow.length} future-to-preview excluded)`);

  // FIX 1 — in events mode, each Vagaro appointment event is already ONE
  // attendee with a Vagaro-resolved client_name + price. Do NOT route through
  // expandSlots (that clobbers the resolved name with schedule.csv rows and
  // re-prices from schedule). Emit the per-appointment records as-is. iCal
  // mode still expands raw slots via schedule.csv, unchanged.
  const appointments = APPOINTMENT_SOURCE === "ical"
    ? expandSlots(rawSlots, schedule, scheduleOverrides)
    : rawSlots;
  const identified = appointments.filter((a) => !a.unidentified).length;
  const unidentified = appointments.length - identified;
  console.log(`Appointment resolution: ${identified} identified + ${unidentified} unidentified`);

  const { results, unmatchedPayments, newMatches, allocations } = reconcile(appointments, paymentsThroughNow, clients, cashLog, cancellations, schedulePriorMatches, externalUnpaid);
  console.log(`Reconciled ${newMatches.length} new payment match${newMatches.length === 1 ? "" : "es"} for the ledger.`);
  if (DRY_RUN !== "true") {
    await saveMatchedLedger(REPO_ROOT, [...priorMatches, ...newMatches]);
  }

  // The Gmail window is wider than the appointment window to catch
  // late-arriving emails near the boundary. Payments older than the
  // appointment window legitimately won't match any session here, so
  // suppress them from the email (still kept in the log for audit).
  const unmatchedInWindow = unmatchedPayments.filter((p) => new Date(p.date) >= WINDOW_START);

  // EMAIL_STYLE selects the template. Default is the current proven layout;
  // "command-center" uses the v2 / Strength Lab design (see email-v2.mjs).
  // Live Friday email stays on the default unless this env var is explicitly set.
  const style = process.env.EMAIL_STYLE === "command-center" ? "command-center" : "default";
  console.log(`Email template: ${style}`);
  let subject, html;
  if (style === "command-center") {
    const { buildEmailV2 } = await import("./email-v2.mjs");
    const checkoutPrompt = buildCheckoutPrompt(results, NOW);
    ({ subject, html } = buildEmailV2({
      results, unmatchedPayments: unmatchedInWindow, now: NOW, windowStart: WINDOW_START, checkoutPrompt,
    }));
  } else {
    ({ subject, html } = buildEmail({ results, unmatchedPayments: unmatchedInWindow }));
  }
  const { file: logFile, counts: logCounts } = await writeLog({ appointments, payments: paymentsThroughNow, results, unmatchedPayments });
  console.log(`Wrote log: ${logFile}`);
  // Dump log to console for easy review (dry-run never commits the file).
  console.log("\n=== LOG FILE CONTENTS ===");
  console.log(await fs.readFile(logFile, "utf8"));
  console.log("=== END LOG ===\n");

  // Degraded-run detection. Both must hold before Brad gets a normal billing
  // email: the money each receipt settled has to reconstruct that receipt, and
  // the numbers in the email have to equal the numbers in the log and in the
  // final rows. A mismatch means the run is lying about itself — fail loudly.
  assertAllocationInvariant(allocations);
  const finalCounts = assertSummaryConsistency({ results, logCounts, subject });
  console.log(`Summary verified — ${JSON.stringify(finalCounts)}`);

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

