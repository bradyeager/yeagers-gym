#!/usr/bin/env node
// Build an analysis-only candidate list from the latest weekly report,
// with the existing cash-entry/cancellation overlays. This does not read
// current Vagaro settlement state or receipts arriving after that report.
// Report matches must never be used as ready-to-execute checkout instructions.

import fs from "node:fs/promises";
import { renderVagaroCandidates } from "./vagaro-candidates.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadClients, loadCashEntries, loadCancellations, fuzzyName } from "./lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
const apptRe = /^\- (\w{3}), (\d+\/\d+), (\d+:\d+ [AP]M) \| (.+?) \| \$([\d.]+|\?)(?: \| checkout \$([\d.]+))? \| (\w+)/;
const logYear = Number(latest.slice(0, 4));

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

console.log(renderVagaroCandidates(lines, {
  source: latest,
  cashEntryCount: cashEntries.length,
  cancellationCount: cancellations.length,
}));
