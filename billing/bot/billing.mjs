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
  fuzzyName, fmtDate, fmtDateIso, slugify,
  venmoRequestLink, githubNewFileUrl, sendBrevoEmail,
  emailShell, sectionLabel, button, buttonOutline, card,
} from "./lib.mjs";

const {
  VAGARO_ICAL_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  BREVO_API_KEY,
  RECIPIENT_EMAIL = "brad@yeagersgym.com",
  SENDER_EMAIL = "brad@yeagersgym.com",
  SENDER_NAME = "Yeager's Gym Billing Bot",
  LOOKBACK_DAYS = "8",
  DRY_RUN = "false",
} = process.env;

const LOOKBACK_MS = Number(LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - LOOKBACK_MS);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const CLIENTS_CSV = path.join(REPO_ROOT, "billing", "clients.csv");
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");

// ---- Vagaro iCal ----

async function fetchVagaroAppointments() {
  const events = await ical.async.fromURL(VAGARO_ICAL_URL);
  const appts = [];
  for (const ev of Object.values(events)) {
    if (ev.type !== "VEVENT") continue;
    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
    if (start < WINDOW_START || start > NOW) continue;
    if ((ev.status || "").toUpperCase() === "CANCELLED") continue;
    const summary = (ev.summary || "").trim();
    appts.push({
      date: start,
      summary,
      description: (ev.description || "").trim(),
      client_name: extractClientName(summary, ev.description),
    });
  }
  appts.sort((a, b) => a.date - b.date);
  return appts;
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
  const query = `from:venmo@venmo.com "paid you" newer_than:${LOOKBACK_DAYS}d`;
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
  const body = extractBody(msg.payload);
  const subjMatch = subject.match(/^(.+?)\s+paid you\s+\$([\d,.]+)/i);
  if (!subjMatch) return null;
  const sender_display_name = subjMatch[1].trim();
  const amount = Number(subjMatch[2].replace(/,/g, ""));
  const handleMatch = (body + "\n" + snippet).match(/venmo\.com\/u\/([A-Za-z0-9._-]+)/i)
    || (body + "\n" + snippet).match(/@([A-Za-z0-9._-]+)/);
  const sender_handle = handleMatch ? handleMatch[1].toLowerCase() : "";
  const noteMatch = body.match(/"([^"\n]{1,140})"/);
  const note = noteMatch ? noteMatch[1].trim() : "";
  const date = dateHdr ? new Date(dateHdr) : new Date();
  return { sender_display_name, sender_handle, amount, note, date, subject };
}

function extractBody(payload) {
  if (!payload) return "";
  const chunks = [];
  const walk = (p) => {
    if (p.body?.data) chunks.push(Buffer.from(p.body.data, "base64").toString("utf8"));
    if (p.parts) for (const sub of p.parts) walk(sub);
  };
  walk(payload);
  return chunks.join("\n");
}

// ---- Reconciliation ----

export function reconcile(appointments, payments, clients, cashLog) {
  const byVagaroName = new Map(clients.map((c) => [c.vagaro_name.toLowerCase(), c]));
  const usedPayments = new Set();
  const results = [];

  for (const appt of appointments) {
    const roster = byVagaroName.get((appt.client_name || "").toLowerCase());

    if (!roster) {
      results.push({ appt, status: "UNKNOWN", note: `Client "${appt.client_name}" not in roster` });
      continue;
    }

    if (roster.pays_cash) {
      const cashHit = cashLog.find(
        (c) => sameDay(c.date, appt.date) && fuzzyName(c.name, roster.vagaro_name) >= 0.8,
      );
      if (cashHit) results.push({ appt, roster, status: "PAID_CASH", payment: cashHit });
      else results.push({ appt, roster, status: "CASH_PENDING" });
      continue;
    }

    const expectedPrice = roster.default_price;
    const candidates = payments
      .map((p, idx) => ({ p, idx }))
      .filter(({ idx }) => !usedPayments.has(idx))
      .filter(({ p }) => {
        const nameMatch = roster.venmo_handle && p.sender_handle === roster.venmo_handle.toLowerCase();
        const displayMatch = fuzzyName(p.sender_display_name, roster.venmo_display_name || roster.vagaro_name) >= 0.8;
        return nameMatch || displayMatch;
      })
      .filter(({ p }) => withinDateWindow(p.date, appt.date))
      .map(({ p, idx }) => ({ p, idx, amountScore: expectedPrice ? amountScore(p.amount, expectedPrice) : 0.5 }))
      .sort((a, b) => b.amountScore - a.amountScore);

    if (candidates.length === 0) {
      results.push({ appt, roster, status: "UNPAID", expectedPrice });
    } else {
      const best = candidates[0];
      if (best.amountScore >= 0.8) {
        usedPayments.add(best.idx);
        results.push({ appt, roster, status: "PAID_VENMO", payment: best.p, expectedPrice });
      } else {
        results.push({
          appt, roster, status: "NEEDS_REVIEW",
          payment: best.p, expectedPrice,
          note: `Received $${best.p.amount}, expected $${expectedPrice}`,
        });
      }
    }
  }

  const unmatchedPayments = payments.filter((_, idx) => !usedPayments.has(idx));
  return { results, unmatchedPayments };
}

function amountScore(received, expected) {
  if (!expected) return 0.5;
  if (received === expected) return 1;
  const ratio = received / expected;
  // Exact multiple (package pre-pay) counts as full match.
  if (Math.abs(ratio - Math.round(ratio)) < 0.02 && ratio >= 1) return 1;
  // Within a couple dollars (rounding / cents) counts as full match.
  if (Math.abs(received - expected) <= 2) return 1;
  // Anything else is surface-for-review.
  return 0.5;
}

function sameDay(a, b) {
  const ad = new Date(a), bd = new Date(b);
  return ad.getFullYear() === bd.getFullYear() && ad.getMonth() === bd.getMonth() && ad.getDate() === bd.getDate();
}

function withinDateWindow(payDate, apptDate) {
  const diff = (payDate - apptDate) / (24 * 60 * 60 * 1000);
  return diff >= -3 && diff <= 7;
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
  const unpaid = results.filter((r) => r.status === "UNPAID");
  const review = results.filter((r) => r.status === "NEEDS_REVIEW");
  const unknown = results.filter((r) => r.status === "UNKNOWN");
  const paidVenmo = results.filter((r) => r.status === "PAID_VENMO");
  const paidCash = results.filter((r) => r.status === "PAID_CASH");
  const cashPending = results.filter((r) => r.status === "CASH_PENDING");

  const weekOf = results.length ? fmtDate(results[0].appt.date) : fmtDate(windowStart);
  const subject = `Weekly billing — ${unpaid.length} unpaid, ${review.length} needs review (week of ${weekOf})`;

  let body = "";

  // Top-line summary strip
  body += `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;">`;
  body += statChip(unpaid.length, "unpaid", unpaid.length ? "pink" : "textMuted");
  body += statChip(review.length, "review", review.length ? "purple" : "textMuted");
  body += statChip(paidVenmo.length + paidCash.length, "paid", "teal");
  body += statChip(cashPending.length, "cash pending", cashPending.length ? "purple" : "textMuted");
  body += `</div>`;

  // UNPAID
  if (unpaid.length) {
    body += sectionLabel(`Unpaid — ${unpaid.length}`, "pink");
    for (const r of unpaid) {
      const price = r.expectedPrice || r.roster?.default_price || "?";
      const handle = r.roster?.venmo_handle;
      const noteText = `Training ${fmtDate(r.appt.date)} — Yeager's Gym`;
      const requestUrl = handle ? venmoRequestLink(handle, price, noteText) : "";
      const cashUrl = cashEntryLink({ date: r.appt.date, name: r.roster.vagaro_name, amount: price });

      let inner = `<div style="font-family:${FONTS.body};font-size:15px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(r.roster.vagaro_name)}</strong> — ${fmtDate(r.appt.date)} — $${price}</div>`;
      inner += `<div style="margin-top:10px;">`;
      if (requestUrl) inner += button({ href: requestUrl, label: `Request $${price} on Venmo`, color: "pink" });
      else inner += `<span style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;">No Venmo handle in clients.csv</span> `;
      inner += buttonOutline({ href: cashUrl, label: "Log as cash", color: "teal" });
      inner += `</div>`;
      body += card(inner, "pink");
    }
  }

  // NEEDS REVIEW
  if (review.length) {
    body += sectionLabel(`Needs review — ${review.length}`, "purple");
    for (const r of review) {
      const expected = r.expectedPrice || r.roster?.default_price || 0;
      const received = r.payment?.amount || 0;
      const diff = expected - received;
      const name = r.roster.vagaro_name;
      const noteText = `Balance from training ${fmtDate(r.appt.date)} — Yeager's Gym`;
      const handle = r.roster?.venmo_handle;

      let inner = `<div style="font-family:${FONTS.body};font-size:15px;color:${PALETTE.textPrimary};margin-bottom:4px;"><strong>${escapeHtml(name)}</strong> — ${fmtDate(r.appt.date)}</div>`;
      inner += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-bottom:10px;">Session $${expected} · received $${received} from @${escapeHtml(r.payment?.sender_handle || "?")}${diff > 0 ? ` · short $${diff}` : diff < 0 ? ` · over $${-diff}` : ""}</div>`;
      inner += `<div>`;
      // Accept as-is
      inner += buttonOutline({
        href: reviewResolutionLink({ date: r.appt.date, name, disposition: "accepted", detail: `Accepted $${received} of $${expected}` }),
        label: "Accept as paid",
        color: "teal",
      });
      // Request the diff (only if short)
      if (diff > 0 && handle) {
        inner += button({
          href: venmoRequestLink(handle, diff, noteText),
          label: `Request $${diff} diff`,
          color: "pink",
        });
      }
      // Dispute
      inner += buttonOutline({
        href: reviewResolutionLink({ date: r.appt.date, name, disposition: "disputed", detail: `Disputed — received $${received}, expected $${expected}` }),
        label: "Mark disputed",
        color: "purple",
      });
      inner += `</div>`;
      body += card(inner, "purple");
    }
  }

  // UNKNOWN
  if (unknown.length) {
    body += sectionLabel(`Unknown clients — ${unknown.length}`, "purple");
    for (const r of unknown) {
      body += card(
        `<div style="color:${PALETTE.textPrimary};">${fmtDate(r.appt.date)} — "${escapeHtml(r.appt.summary)}"</div><div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};margin-top:4px;">${escapeHtml(r.note || "")}. Add to clients.csv.</div>`,
        "purple",
      );
    }
  }

  // CASH PENDING
  if (cashPending.length) {
    body += sectionLabel(`Cash pending — ${cashPending.length}`, "teal");
    for (const r of cashPending) {
      const price = r.roster.default_price || "?";
      const cashUrl = cashEntryLink({ date: r.appt.date, name: r.roster.vagaro_name, amount: price });
      let inner = `<div style="color:${PALETTE.textPrimary};"><strong>${escapeHtml(r.roster.vagaro_name)}</strong> — ${fmtDate(r.appt.date)} — expected $${price}</div>`;
      inner += `<div style="margin-top:10px;">`;
      inner += button({ href: cashUrl, label: `Log $${price} cash`, color: "teal" });
      inner += `</div>`;
      body += card(inner, "teal");
    }
  }

  // PAID (collapsed)
  if (paidVenmo.length || paidCash.length) {
    body += sectionLabel(`Paid — ${paidVenmo.length + paidCash.length}`, "teal");
    const names = [...paidVenmo, ...paidCash].map((r) => escapeHtml(r.roster.vagaro_name)).join(", ");
    body += `<div style="color:${PALETTE.textMuted};font-size:14px;line-height:1.6;margin-bottom:10px;">${names}</div>`;
  }

  // UNMATCHED PAYMENTS
  if (unmatchedPayments.length) {
    body += sectionLabel(`Unmatched Venmo payments — ${unmatchedPayments.length}`, "textMuted");
    for (const p of unmatchedPayments) {
      body += `<div style="font-family:${FONTS.display};font-size:12px;color:${PALETTE.textMuted};padding:4px 0;border-bottom:1px solid ${PALETTE.border};">${fmtDate(p.date)} · ${escapeHtml(p.sender_display_name)} · $${p.amount} · "${escapeHtml(p.note || "")}"</div>`;
    }
  }

  const footer = `Log committed to billing/logs/${fmtDateIso(now)}.md · Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`;
  const html = emailShell({ title: `Week of ${weekOf}`, bodyHtml: body, footerNote: footer });
  return { subject, html };
}

function statChip(n, label, color = "teal") {
  const c = PALETTE[color] || PALETTE.teal;
  return `<div style="flex:1;min-width:120px;background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-top:3px solid ${c};border-radius:6px;padding:12px 14px;"><div style="font-family:${FONTS.display};font-size:28px;font-weight:700;color:${c};line-height:1;">${n}</div><div style="font-family:${FONTS.display};font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:${PALETTE.textMuted};margin-top:6px;">${label}</div></div>`;
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
    const name = r.roster?.vagaro_name || r.appt.client_name;
    const price = r.expectedPrice ?? r.roster?.default_price ?? "?";
    md += `- ${fmtDateIso(r.appt.date)} | ${name} | $${price} | ${r.status}`;
    if (r.payment) md += ` (matched @${r.payment.sender_handle || r.payment.name}, $${r.payment.amount})`;
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
    unpaid: results.filter((r) => r.status === "UNPAID").length,
    needs_review: results.filter((r) => r.status === "NEEDS_REVIEW").length,
    cash_pending: results.filter((r) => r.status === "CASH_PENDING").length,
    unknown: results.filter((r) => r.status === "UNKNOWN").length,
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
  const [clients, cashLog, appointments, payments] = await Promise.all([
    loadClients(CLIENTS_CSV),
    loadCashEntries(REPO_ROOT),
    fetchVagaroAppointments(),
    fetchVenmoPayments(),
  ]);
  console.log(`Loaded ${clients.length} clients, ${cashLog.length} cash entries`);
  console.log(`Found ${appointments.length} appointments, ${payments.length} Venmo payments`);

  const { results, unmatchedPayments } = reconcile(appointments, payments, clients, cashLog);
  const { subject, html } = buildEmail({ results, unmatchedPayments });
  const logFile = await writeLog({ appointments, payments, results, unmatchedPayments });
  console.log(`Wrote log: ${logFile}`);
  await sendBrevoEmail({
    apiKey: BREVO_API_KEY,
    to: RECIPIENT_EMAIL,
    from: SENDER_EMAIL,
    fromName: SENDER_NAME,
    subject,
    html,
    dryRun: DRY_RUN === "true",
  });
  console.log(`Sent email: ${subject}`);
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
