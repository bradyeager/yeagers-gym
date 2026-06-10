#!/usr/bin/env node
// Regenerate the Vagaro checkout prompt on demand — reads the most recent
// weekly log, overlays any cash-entries or cancellations Brad committed
// SINCE the log was written, and emits the copy-paste block for Claude
// for Chrome.
//
// Use when:
//   • You committed a "Wasn't trained" or "Log as cash" from the email
//     and want a fresh Vagaro list reflecting it (without re-running the
//     full workflow + getting another email).
//
// Limitation:
//   • Does NOT see NEW Venmo payments arriving after the log was generated
//     — re-run the workflow for that. This script only re-overlays the
//     manual commits (cash-log, cancellations).

import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot, loadClients, loadCashEntries, loadCancellations, fmtDateIso, fuzzyName } from "./lib.mjs";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");

const files = (await fs.readdir(LOGS_DIR)).filter((f) => f.endsWith(".md")).sort();
if (!files.length) {
  console.error("No log files in billing/logs/. Run the weekly workflow first.");
  process.exit(1);
}
const latest = files[files.length - 1];
const logRaw = await fs.readFile(path.join(LOGS_DIR, latest), "utf8");

const [clients, cashEntries, cancellations] = await Promise.all([
  loadClients(path.join(REPO_ROOT, "billing", "clients.csv")),
  loadCashEntries(REPO_ROOT),
  loadCancellations(REPO_ROOT),
]);

// Parse the Appointments section: lines like
//   "- Mon, 6/1, 6:00 AM | Jacob Bain | $70 | checkout $70 | PAID_VENMO (...)"
// or older lines without "checkout $X" (those fall back to expected price).
// Extracts day, time, client name, checkout amount, status.
const apptRe = /^\- (\w{3}), (\d+\/\d+), (\d+:\d+ [AP]M) \| (.+?) \| \$([\d?]+)(?: \| checkout \$([\d.]+))? \| (\w+)/;
const logYear = Number(latest.slice(0, 4));
const dayNameToNum = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function appointmentDateFromLog(dow, mdate) {
  // mdate "6/1" → assume year from log filename; pin to PT noon to avoid TZ drift.
  const [mo, da] = mdate.split("/").map(Number);
  return new Date(Date.UTC(logYear, mo - 1, da, 19)); // 12pm PT ≈ 19:00 UTC
}

const lines = [];
for (const line of logRaw.split("\n")) {
  const m = line.match(apptRe);
  if (!m) continue;
  const [, dow, mdate, time, name, expectedStr, checkoutStr, status] = m;
  const date = appointmentDateFromLog(dow, mdate);
  const client = clients.find((c) => c.vagaro_name.toLowerCase() === name.toLowerCase().trim());
  const expected = expectedStr === "?" ? null : Number(expectedStr);
  let checkoutAmount = checkoutStr ? Number(checkoutStr) : expected;
  lines.push({ dow, mdate, time, name: name.trim(), client, expected, checkoutAmount, status, date });
}

// ── Overlay: apply cash-entries + cancellations ──
const sameDay = (a, b) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

for (const l of lines) {
  // Cash-entry upgrade: CASH_PENDING → PAID_CASH if Brad just logged it.
  if (l.status === "CASH_PENDING") {
    const hit = cashEntries.find(
      (c) =>
        sameDay(new Date(c.date), l.date) &&
        fuzzyName(c.name, l.name) >= 0.8,
    );
    if (hit) {
      l.status = "PAID_CASH";
      l.checkoutAmount = l.checkoutAmount ?? Number(hit.amount) ?? l.expected;
      l.note = `cash-logged via ${hit.source || "cash-log"}`;
    }
  }
  // Cancellation: drop entirely (Brad marked it Wasn't trained).
  const cxl = cancellations.find(
    (c) =>
      sameDay(new Date(c.date), l.date) &&
      fuzzyName(c.name, l.name) >= 0.8,
  );
  if (cxl) {
    l.status = "CANCELLED";
    l.cancelReason = cxl.reason;
  }
}

// ── Group by day, most-recent-first ──
const days = new Map();
for (const l of lines) {
  if (!["PAID_VENMO", "PAID_CASH", "PAID_PREPAID"].includes(l.status)) continue;
  const key = `${l.dow}|${l.mdate}|${l.date.toISOString().slice(0, 10)}`;
  if (!days.has(key)) days.set(key, []);
  days.get(key).push(l);
}

const dayKeysDesc = [...days.keys()].sort((a, b) => {
  const da = a.split("|")[2];
  const db = b.split("|")[2];
  return db.localeCompare(da);
});

// ── Generate the PAID CLIENTS block ──
function adjustNote(l) {
  if (l.status === "PAID_PREPAID") return " (prepaid)";
  if (!l.client) return "";
  const exp = l.expected ?? 0;
  const co = l.checkoutAmount ?? exp;
  // Couple-default solo case: expected default is $100 but checkout snaps to $70.
  if (l.client.default_price === 100 && co !== 100 && co !== 80 && co < 100) {
    return `  ⚠ ADJUST TOTAL (trained solo, not couple — Vagaro will show couple rate)`;
  }
  // Tue team @ $40 (Peggy/Tonnie/Annie) — Vagaro shows their non-team rate.
  const isTueTeam = l.dow === "Tue" && l.time === "8:00 AM";
  if (isTueTeam && co === 40 && (l.client.default_price ?? 0) !== 40) {
    return `  ⚠ ADJUST TOTAL (Tue team, not her usual rate)`;
  }
  if (isTueTeam && co === 80) {
    return `  ⚠ ADJUST TOTAL (Tue team — covers Annie + David)`;
  }
  return "";
}

const fullDayName = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

let block = "==== PAID CLIENTS THIS WEEK (work backwards) ====\n";
for (const key of dayKeysDesc) {
  const [dow, mdate] = key.split("|");
  const rows = days.get(key).sort((a, b) => {
    // Sort by AM/PM time ascending within a day.
    const parse = (t) => {
      const m = t.match(/(\d+):(\d+) ([AP])M/);
      const [, h, mi, ap] = m;
      const hr = (Number(h) % 12) + (ap === "P" ? 12 : 0);
      return hr * 60 + Number(mi);
    };
    return parse(a.time) - parse(b.time);
  });
  block += `\n${fullDayName[dow]} ${mdate}:\n`;
  for (const l of rows) {
    const amt =
      l.status === "PAID_PREPAID"
        ? "$0"
        : l.checkoutAmount != null
        ? `$${l.checkoutAmount}`
        : `$${l.expected}`;
    block += `  • ${l.time.padEnd(8)}  ${l.name} — enter ${amt}${adjustNote(l)}\n`;
  }
}

console.log(`# Generated from ${latest}`);
console.log(`# Overlaid: ${cashEntries.length} cash entries, ${cancellations.length} cancellations`);
console.log("");
console.log(block);
