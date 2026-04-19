#!/usr/bin/env node
// Weekly Vagaro/Venmo billing reconciliation for Yeager's Gym.
// Runs in GitHub Actions on Fridays. Reads Vagaro iCal + Gmail,
// matches against billing/clients.csv, emails Brad via Brevo,
// writes a log to billing/logs/YYYY-MM-DD.md.

import fs from "node:fs/promises";
import path from "node:path";
import ical from "node-ical";
import { google } from "googleapis";

// ---- Config from env ----
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

function requireEnv(name, val) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv("VAGARO_ICAL_URL", VAGARO_ICAL_URL);
requireEnv("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID);
requireEnv("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET);
requireEnv("GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN);
requireEnv("BREVO_API_KEY", BREVO_API_KEY);

const LOOKBACK_MS = Number(LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - LOOKBACK_MS);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CLIENTS_CSV = path.join(REPO_ROOT, "billing", "clients.csv");
const CASH_LOG_MD = path.join(REPO_ROOT, "billing", "cash-log.md");
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");

// ---- Load roster ----

async function loadClients() {
  const raw = await fs.readFile(CLIENTS_CSV, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const header = lines.shift();
  if (!header || !header.startsWith("vagaro_name,")) {
    throw new Error(`Unexpected clients.csv header: ${header}`);
  }
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    return {
      vagaro_name: cells[0],
      venmo_handle: cells[1] || "",
      venmo_display_name: cells[2] || "",
      default_price: cells[3] ? Number(cells[3]) : null,
      pays_cash: (cells[4] || "").toLowerCase() === "true",
      notes: cells[5] || "",
    };
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === "," && !inQuotes) {
      cells.push(cur); cur = "";
    } else { cur += c; }
  }
  cells.push(cur);
  return cells;
}

async function loadCashLog() {
  try {
    const raw = await fs.readFile(CASH_LOG_MD, "utf8");
    const lines = raw.split("\n");
    const entries = [];
    for (const line of lines) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*\$?([\d.]+)/);
      if (m) entries.push({ date: m[1], name: m[2].trim(), amount: Number(m[3]) });
    }
    return entries;
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// ---- Vagaro iCal ----

async function fetchVagaroAppointments() {
  const events = await ical.async.fromURL(VAGARO_ICAL_URL);
  const appts = [];
  for (const ev of Object.values(events)) {
    if (ev.type !== "VEVENT") continue;
    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
    if (start < WINDOW_START || start > NOW) continue;
    const status = (ev.status || "").toUpperCase();
    if (status === "CANCELLED") continue;
    const summary = (ev.summary || "").trim();
    appts.push({
      date: start,
      summary,
      description: (ev.description || "").trim(),
      location: (ev.location || "").trim(),
      client_name: extractClientName(summary, ev.description),
    });
  }
  appts.sort((a, b) => a.date - b.date);
  return appts;
}

// Vagaro iCal SUMMARY varies ("Alice Chen - PT 60", "PT 60 w/ Alice", etc.).
// Try a few patterns, then fall back to matching the whole summary against the roster.
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

  // Subject form: "Alice Chen paid you $100.00"
  const subjMatch = subject.match(/^(.+?)\s+paid you\s+\$([\d,.]+)/i);
  if (!subjMatch) return null;
  const sender_display_name = subjMatch[1].trim();
  const amount = Number(subjMatch[2].replace(/,/g, ""));

  // Handle: look for @username or venmo.com/u/<handle> in body/snippet
  const handleMatch = (body + "\n" + snippet).match(/venmo\.com\/u\/([A-Za-z0-9._-]+)/i)
    || (body + "\n" + snippet).match(/@([A-Za-z0-9._-]+)/);
  const sender_handle = handleMatch ? handleMatch[1].toLowerCase() : "";

  // Note: Venmo emails often include the payment note in quotes after the amount line.
  const noteMatch = body.match(/"([^"\n]{1,140})"/);
  const note = noteMatch ? noteMatch[1].trim() : "";

  const date = dateHdr ? new Date(dateHdr) : new Date();

  return { sender_display_name, sender_handle, amount, note, date, subject };
}

function extractBody(payload) {
  if (!payload) return "";
  const chunks = [];
  const walk = (p) => {
    if (p.body?.data) {
      chunks.push(Buffer.from(p.body.data, "base64").toString("utf8"));
    }
    if (p.parts) for (const sub of p.parts) walk(sub);
  };
  walk(payload);
  return chunks.join("\n");
}

// ---- Matching ----

function fuzzyName(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const aParts = na.split(/\s+/);
  const bParts = nb.split(/\s+/);
  // Same first name + last-initial match counts as strong.
  if (aParts[0] === bParts[0]) {
    const aLast = aParts[aParts.length - 1];
    const bLast = bParts[bParts.length - 1];
    if (aLast === bLast) return 1;
    if (aLast[0] === bLast[0]) return 0.8;
    return 0.6;
  }
  return 0;
}

function reconcile(appointments, payments, clients, cashLog) {
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
      if (cashHit) {
        results.push({ appt, roster, status: "PAID_CASH", payment: cashHit });
      } else {
        results.push({ appt, roster, status: "CASH_PENDING" });
      }
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
      .map(({ p, idx }) => ({
        p, idx,
        amountScore: expectedPrice ? amountScore(p.amount, expectedPrice) : 0.5,
      }))
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
  // Multiples (package pre-pay) count as full match.
  const ratio = received / expected;
  if (Math.abs(ratio - Math.round(ratio)) < 0.02 && ratio >= 1) return 1;
  const pct = Math.abs(received - expected) / expected;
  if (pct <= 0.2) return 0.8;
  return 0;
}

function sameDay(a, b) {
  const ad = new Date(a), bd = new Date(b);
  return ad.getFullYear() === bd.getFullYear() &&
    ad.getMonth() === bd.getMonth() &&
    ad.getDate() === bd.getDate();
}

function withinDateWindow(payDate, apptDate) {
  const diff = (payDate - apptDate) / (24 * 60 * 60 * 1000);
  return diff >= -3 && diff <= 7;
}

// ---- Venmo deep-link ----

function venmoRequestLink(handle, amount, note) {
  if (!handle) return "";
  const params = new URLSearchParams({
    txn: "charge",
    recipients: handle,
    amount: String(amount),
    note,
  });
  return `https://account.venmo.com/pay?${params.toString()}`;
}

// ---- Email (Brevo) ----

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}
function fmtDateIso(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function buildEmail({ results, unmatchedPayments }) {
  const unpaid = results.filter((r) => r.status === "UNPAID");
  const review = results.filter((r) => r.status === "NEEDS_REVIEW");
  const unknown = results.filter((r) => r.status === "UNKNOWN");
  const paidVenmo = results.filter((r) => r.status === "PAID_VENMO");
  const paidCash = results.filter((r) => r.status === "PAID_CASH");
  const cashPending = results.filter((r) => r.status === "CASH_PENDING");

  const weekOf = results.length ? fmtDate(results[0].appt.date) : fmtDate(WINDOW_START);

  const subject = `Weekly billing — ${unpaid.length} unpaid, ${review.length} needs review (week of ${weekOf})`;

  const line = (r) => {
    const price = r.expectedPrice || r.roster?.default_price || "?";
    const d = fmtDate(r.appt.date);
    const name = r.roster?.vagaro_name || r.appt.client_name;
    const handle = r.roster?.venmo_handle;
    const noteText = `Training session ${fmtDate(r.appt.date)} — Yeager's Gym`;
    const link = handle ? venmoRequestLink(handle, price, noteText) : "";
    return { d, name, price, handle, link, noteText };
  };

  let html = `<div style="font-family: -apple-system, sans-serif; max-width: 600px;">`;
  html += `<h2 style="margin-top:0;">Weekly billing — week of ${weekOf}</h2>`;
  html += `<p><strong>${unpaid.length} unpaid</strong> · <strong>${review.length} needs review</strong> · ${paidVenmo.length} paid (Venmo) · ${paidCash.length} paid (cash) · ${cashPending.length} cash pending</p>`;

  if (unpaid.length) {
    html += `<h3 style="color:#c02;">Unpaid — tap to request</h3><ul style="padding-left:1em;">`;
    for (const r of unpaid) {
      const L = line(r);
      html += `<li style="margin-bottom:0.6em;"><strong>${L.name}</strong> — ${L.d} — $${L.price}`;
      if (L.link) html += `<br><a href="${L.link}" style="display:inline-block;padding:6px 14px;background:#3D95CE;color:white;text-decoration:none;border-radius:4px;font-size:14px;margin-top:4px;">Request $${L.price} from @${L.handle}</a>`;
      else html += ` <em>(no Venmo handle on file — add to clients.csv)</em>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  if (review.length) {
    html += `<h3 style="color:#c60;">Needs review</h3><ul style="padding-left:1em;">`;
    for (const r of review) {
      const L = line(r);
      html += `<li><strong>${L.name}</strong> — ${L.d} — session $${L.price}, received $${r.payment?.amount} from @${r.payment?.sender_handle}. ${r.note || ""}</li>`;
    }
    html += `</ul>`;
  }

  if (unknown.length) {
    html += `<h3 style="color:#c60;">Unknown clients (not in roster)</h3><ul style="padding-left:1em;">`;
    for (const r of unknown) {
      html += `<li>${fmtDate(r.appt.date)} — "${r.appt.summary}" — ${r.note}</li>`;
    }
    html += `</ul>`;
  }

  if (cashPending.length) {
    html += `<h3>Cash pending (confirm by editing billing/cash-log.md)</h3><ul style="padding-left:1em;">`;
    for (const r of cashPending) {
      html += `<li>${r.roster.vagaro_name} — ${fmtDate(r.appt.date)} — expected $${r.roster.default_price || "?"}</li>`;
    }
    html += `</ul>`;
  }

  if (paidVenmo.length || paidCash.length) {
    html += `<h3 style="color:#282;">Paid — no action</h3><p style="color:#555;">`;
    const names = [...paidVenmo, ...paidCash].map((r) => r.roster.vagaro_name).join(", ");
    html += `${names} (${paidVenmo.length + paidCash.length} clients)</p>`;
  }

  if (unmatchedPayments.length) {
    html += `<h3>Unmatched Venmo payments (FYI)</h3><ul style="padding-left:1em;">`;
    for (const p of unmatchedPayments) {
      html += `<li>${fmtDate(p.date)} — ${p.sender_display_name} (@${p.sender_handle || "?"}) — $${p.amount} — "${p.note}"</li>`;
    }
    html += `</ul>`;
  }

  html += `<hr><p style="color:#777;font-size:12px;">Log: <code>billing/logs/${fmtDateIso(NOW)}.md</code></p>`;
  html += `</div>`;

  return { subject, html };
}

async function sendEmail(subject, html) {
  if (DRY_RUN === "true") {
    console.log("DRY_RUN — would have sent email:");
    console.log("Subject:", subject);
    console.log(html);
    return;
  }
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: RECIPIENT_EMAIL }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Brevo send failed: ${resp.status} ${body}`);
  }
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
  console.log(`Window: ${WINDOW_START.toISOString()} → ${NOW.toISOString()}`);
  const [clients, cashLog, appointments, payments] = await Promise.all([
    loadClients(),
    loadCashLog(),
    fetchVagaroAppointments(),
    fetchVenmoPayments(),
  ]);
  console.log(`Loaded ${clients.length} clients, ${cashLog.length} cash entries`);
  console.log(`Found ${appointments.length} appointments, ${payments.length} Venmo payments`);

  const { results, unmatchedPayments } = reconcile(appointments, payments, clients, cashLog);
  const { subject, html } = buildEmail({ results, unmatchedPayments });
  const logFile = await writeLog({ appointments, payments, results, unmatchedPayments });
  console.log(`Wrote log: ${logFile}`);
  await sendEmail(subject, html);
  console.log(`Sent email: ${subject}`);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  // Best-effort failure email so Brad knows to check.
  if (DRY_RUN !== "true" && BREVO_API_KEY) {
    try {
      await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: SENDER_NAME, email: SENDER_EMAIL },
          to: [{ email: RECIPIENT_EMAIL }],
          subject: "Weekly billing — FAILED",
          htmlContent: `<p>Weekly billing run failed at ${NOW.toISOString()}.</p><pre>${String(err.stack || err).slice(0, 2000)}</pre><p>Check GitHub Actions logs.</p>`,
        }),
      });
    } catch (_) { /* ignore */ }
  }
  process.exit(1);
});
