#!/usr/bin/env node
// Renders sample weekly + monthly billing emails with synthetic data.
// Output lands in billing/preview/ so Brad can eyeball the YG layout
// before wiring up any real credentials.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot } from "./lib.mjs";

// Dynamic imports after faking env so module-level env reads succeed.
const { reconcile, buildEmail: buildWeekly } = await import("./billing.mjs");
const { buildEmail: buildMonthly, totalsFromLogs } = await import("./monthly.mjs");

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const OUT_DIR = path.join(REPO_ROOT, "billing", "preview");

// ---- Synthetic weekly data ----

const today = new Date("2026-04-17T17:00:00Z"); // a Friday
const day = (n) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000);

const clients = [
  { vagaro_name: "Alice Chen", venmo_handle: "alice-chen-2021", venmo_display_name: "Alice C", default_price: 100, pays_cash: false, notes: "" },
  { vagaro_name: "Jordan Kim", venmo_handle: "jordan-kim", venmo_display_name: "Jordan K", default_price: 120, pays_cash: false, notes: "" },
  { vagaro_name: "Mike Chen", venmo_handle: "mike-chen-sd", venmo_display_name: "Mike C", default_price: 100, pays_cash: false, notes: "" },
  { vagaro_name: "Dana Wells", venmo_handle: "dana-wells", venmo_display_name: "Dana W", default_price: 100, pays_cash: false, notes: "" },
  { vagaro_name: "Chris Park", venmo_handle: "chris-park-92", venmo_display_name: "Chris P", default_price: 100, pays_cash: false, notes: "" },
  { vagaro_name: "Sarah Lopez", venmo_handle: "sarah-l-9", venmo_display_name: "Sarah L", default_price: 100, pays_cash: false, notes: "" },
  { vagaro_name: "Tom Reyes", venmo_handle: "tom-reyes", venmo_display_name: "Tom R", default_price: 70, pays_cash: false, notes: "" },
  { vagaro_name: "Luis Ortiz", venmo_handle: "", venmo_display_name: "", default_price: 80, pays_cash: true, notes: "Cash only" },
];

const appointments = [
  { date: day(6), summary: "Alice Chen - PT 60", description: "", client_name: "Alice Chen" },
  { date: day(5), summary: "Luis Ortiz - PT 60", description: "", client_name: "Luis Ortiz" },
  { date: day(5), summary: "Mike Chen - PT 60", description: "", client_name: "Mike Chen" },
  { date: day(4), summary: "Sarah Lopez - PT 60", description: "", client_name: "Sarah Lopez" },
  { date: day(3), summary: "Jordan Kim - PT 90", description: "", client_name: "Jordan Kim" },
  { date: day(3), summary: "Dana Wells - PT 60", description: "", client_name: "Dana Wells" },
  { date: day(2), summary: "Chris Park - PT 60", description: "", client_name: "Chris Park" },
  { date: day(1), summary: "Tom Reyes - PT 30", description: "", client_name: "Tom Reyes" },
  { date: day(1), summary: "Pat Miller - PT 60", description: "", client_name: "Pat Miller" }, // unknown
];

const payments = [
  { sender_display_name: "Alice Chen", sender_handle: "alice-chen-2021", amount: 100, note: "training", date: day(6) },
  { sender_display_name: "Mike Chen",  sender_handle: "mike-chen-sd",   amount: 100, note: "", date: day(5) },
  { sender_display_name: "Sarah Lopez", sender_handle: "sarah-l-9",     amount: 80,  note: "training", date: day(4) }, // short
  { sender_display_name: "Dana Wells", sender_handle: "dana-wells",     amount: 100, note: "", date: day(3) },
  { sender_display_name: "Chris Park", sender_handle: "chris-park-92",  amount: 100, note: "", date: day(2) },
  { sender_display_name: "Mom",        sender_handle: "",              amount: 50,  note: "dinner", date: day(1) }, // unmatched
];

const cashLog = [
  // intentionally empty so Luis shows as CASH_PENDING with a Log-cash button
];

const { results, unmatchedPayments } = reconcile(appointments, payments, clients, cashLog);

const windowStart = day(8);
const { subject: weeklySubject, html: weeklyHtml } = buildWeekly({
  results, unmatchedPayments, now: today, windowStart,
});

// ---- Synthetic monthly data ----
// Four weekly logs — enough variety to exercise the summary layout.

const fakeLogs = [
  {
    date: "2026-03-06",
    parsed: {
      appointments: [
        { date: "2026-03-02", name: "Alice Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-03", name: "Jordan Kim", price: 120, status: "PAID_VENMO", paidAmount: 120 },
        { date: "2026-03-04", name: "Luis Ortiz", price: 80, status: "PAID_CASH", paidAmount: 80 },
        { date: "2026-03-04", name: "Mike Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-05", name: "Chris Park", price: 100, status: "PAID_VENMO", paidAmount: 100 },
      ],
    },
  },
  {
    date: "2026-03-13",
    parsed: {
      appointments: [
        { date: "2026-03-09", name: "Alice Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-10", name: "Dana Wells", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-11", name: "Luis Ortiz", price: 80, status: "PAID_CASH", paidAmount: 80 },
        { date: "2026-03-12", name: "Sarah Lopez", price: 100, status: "NEEDS_REVIEW", paidAmount: 80 },
        { date: "2026-03-13", name: "Tom Reyes", price: 70, status: "UNPAID", paidAmount: null },
      ],
    },
  },
  {
    date: "2026-03-20",
    parsed: {
      appointments: [
        { date: "2026-03-16", name: "Alice Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-17", name: "Jordan Kim", price: 120, status: "PAID_VENMO", paidAmount: 120 },
        { date: "2026-03-18", name: "Luis Ortiz", price: 80, status: "PAID_CASH", paidAmount: 80 },
        { date: "2026-03-18", name: "Mike Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-19", name: "Chris Park", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-20", name: "Dana Wells", price: 100, status: "UNPAID", paidAmount: null },
      ],
    },
  },
  {
    date: "2026-03-27",
    parsed: {
      appointments: [
        { date: "2026-03-23", name: "Alice Chen", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-24", name: "Jordan Kim", price: 120, status: "PAID_VENMO", paidAmount: 120 },
        { date: "2026-03-25", name: "Luis Ortiz", price: 80, status: "PAID_CASH", paidAmount: 80 },
        { date: "2026-03-26", name: "Sarah Lopez", price: 100, status: "PAID_VENMO", paidAmount: 100 },
        { date: "2026-03-27", name: "Tom Reyes", price: 70, status: "PAID_VENMO", paidAmount: 70 },
      ],
    },
  },
];

const totals = totalsFromLogs(fakeLogs);
const monthStart = new Date(Date.UTC(2026, 2, 1));
const monthEnd = new Date(Date.UTC(2026, 3, 1) - 1);
const { subject: monthlySubject, html: monthlyHtml } = buildMonthly({
  monthLabel: "March 2026",
  totals,
  weekCount: fakeLogs.length,
  start: monthStart,
  end: monthEnd,
});

// ---- Write files ----

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, "weekly.html"), weeklyHtml, "utf8");
await fs.writeFile(path.join(OUT_DIR, "monthly.html"), monthlyHtml, "utf8");

console.log("Wrote:");
console.log(`  ${path.join(OUT_DIR, "weekly.html")}   → subject: ${weeklySubject}`);
console.log(`  ${path.join(OUT_DIR, "monthly.html")}  → subject: ${monthlySubject}`);
console.log("\nView via htmlpreview.github.io after push:");
console.log("  https://htmlpreview.github.io/?https://github.com/bradyeager/yeagers-gym/blob/claude/automate-venmo-billing-pR6HL/billing/preview/weekly.html");
console.log("  https://htmlpreview.github.io/?https://github.com/bradyeager/yeagers-gym/blob/claude/automate-venmo-billing-pR6HL/billing/preview/monthly.html");
