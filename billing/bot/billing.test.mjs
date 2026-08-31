// Behavioral fixtures for the YGBILL-BOT-01 production repair.
//
// Run: npm test   (node --test, no framework, no new dependency)
//
// These cover the six defects the repair targets: production mode/source
// defaults, the Friday-evening cron, explicit memo-date reservation, combined
// payments settling multiple sessions, mixed receipts staying in review, and
// summary counters that must equal the final result rows.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  reconcile, buildEmail, summaryCounts, parseSubjectCounts,
  assertProductionConfig, assertSummaryConsistency, assertAllocationInvariant,
  trustedScheduleLedger, isPaymentDrivenLedgerEntry, isLikelyAutoDateMemo, expandSlots,
} from "./billing.mjs";
import { parseNoteDate, parseNoteDates, enumeratesDates, fmtDate, fmtDateIsoPacific, loadScheduleOverrides } from "./lib.mjs";
import { buildMoneyLine } from "./email-moneyline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ---- fixtures scaffolding -------------------------------------------------

// 17:00 UTC = 10 AM PDT — a normal morning session whose Pacific day equals
// its UTC day, so these fixtures don't accidentally exercise the ±1-day
// timezone probe.
const at = (iso, hourUtc = 17) => new Date(`${iso}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

const client = (over = {}) => ({
  vagaro_name: "Lacey James",
  venmo_handle: "",
  venmo_display_names: ["Laci James"],
  default_price: 70,
  acceptable_prices: [],
  pays_cash: false,
  prepaid: false,
  note_keywords: [],
  notes: "",
  ...over,
});

const LACEY = client();
const CELESTIN = client({
  vagaro_name: "Celestin Mathieu",
  venmo_display_names: ["Celestin Mathieu"],
  default_price: 50,
  acceptable_prices: [50, 70],
  note_keywords: ["mathieu"],
});

const appt = (iso, name = "Lacey James", over = {}) => ({
  date: at(iso),
  client_name: name,
  summary: `${name} - 1:1`,
  unidentified: false,
  ...over,
});

// Mirrors parseVenmoEmail's contract: noteDate is the FIRST date in the memo,
// or null when the memo carries no date evidence.
const pay = (amount, note, iso, over = {}) => {
  const date = at(iso, 20);
  return {
    gmail_id: over.gmail_id ?? `msg-${amount}-${iso}`,
    sender_display_name: "Laci James",
    sender_handle: "",
    amount,
    note,
    noteDate: parseNoteDate(note, date.getUTCFullYear()),
    date,
    subject: "You got paid",
    ...over,
  };
};

const run = (appointments, payments, clients = [LACEY], priorMatches = []) =>
  reconcile(appointments, payments, clients, [], [], priorMatches);

const statuses = (results) => results.map((r) => r.status);

// ---- Fixture A — explicit dates -------------------------------------------

test("Fixture A: $140 memo '7/10 and 7/13' settles both Lacey sessions", () => {
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const p = pay(140, "7/10 and 7/13", "2026-07-13");
  const { results, allocations, unmatchedPayments } = run(appts, [p]);

  assert.deepEqual(statuses(results), ["PAID_VENMO", "PAID_VENMO"]);
  assert.equal(results[0].checkoutAmount, 70);
  assert.equal(results[1].checkoutAmount, 70);

  const alloc = allocations[0];
  assert.equal(alloc.gross, 140);
  assert.equal(alloc.sessions.reduce((s, x) => s + x.amount, 0), 140, "total allocated is $140");
  assert.equal(alloc.remainder, 0, "no remainder");
  assert.deepEqual(alloc.sessions.map((s) => s.date), ["2026-07-10", "2026-07-13"]);
  assert.equal(unmatchedPayments.length, 0);
  assertAllocationInvariant(allocations);
});

test("Fixture A: rerun is idempotent — payment is not counted twice", () => {
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const p = pay(140, "7/10 and 7/13", "2026-07-13");

  const first = run(appts, [p]);
  assert.equal(first.newMatches.length, 2, "one ledger entry per settled session");
  assert.deepEqual(first.newMatches.map((m) => m.matched_to.date), ["2026-07-10", "2026-07-13"]);

  // Second run sees the ledger the first run would have written.
  const second = run(appts, [p], [LACEY], first.newMatches);
  assert.deepEqual(statuses(second.results), ["PAID_VENMO", "PAID_VENMO"], "both stay settled");
  assert.equal(second.newMatches.length, 0, "no duplicate ledger entries on rerun");
  assert.equal(second.unmatchedPayments.length, 0, "locked payment is not re-offered");
  assert.ok(second.results.every((r) => r.fromLedger), "both reproduced from the ledger");
  assertAllocationInvariant(second.allocations);
});

// ---- Fixture B — weekday combined payment ---------------------------------

test("Fixture B: $140 memo 'Thurs & Fri' settles exactly two eligible sessions", () => {
  const appts = [appt("2026-07-09"), appt("2026-07-10")];
  const p = pay(140, "Thurs & Fri", "2026-07-10");
  const { results, allocations } = run(appts, [p]);

  assert.deepEqual(statuses(results), ["PAID_VENMO", "PAID_VENMO"]);
  assert.equal(allocations[0].sessions.length, 2);
  assert.equal(allocations[0].remainder, 0);
  assertAllocationInvariant(allocations);
});

test("Fixture B: ambiguous candidates are reviewed, never guessed", () => {
  // Three eligible $70 sessions for a $140 receipt — which two did it pay for?
  // Unknowable, so nothing may be settled.
  const appts = [appt("2026-07-08"), appt("2026-07-09"), appt("2026-07-10")];
  const p = pay(140, "Thurs & Fri", "2026-07-10");
  const { results, allocations } = run(appts, [p]);

  assert.equal(results.filter((r) => r.status === "PAID_VENMO").length, 0, "nothing guessed");
  assert.equal(results.filter((r) => r.status === "NEEDS_REVIEW").length, 1);
  assert.equal(results.filter((r) => r.status === "UNPAID").length, 2);
  assert.equal(allocations[0].sessions.length, 0, "an unresolved receipt allocates nothing");
  assert.equal(allocations[0].remainder, 140);
  assertAllocationInvariant(allocations);
});

// ---- Fixture C — mixed-person payment -------------------------------------

test("Fixture C: mixed-person Celestin $140 stays in review", () => {
  const appts = [
    appt("2026-07-09", "Celestin Mathieu"),
    appt("2026-07-10", "Celestin Mathieu"),
  ];
  const p = pay(140, "Mathieu james violette and 1 drink", "2026-07-10", {
    sender_display_name: "Celestin Mathieu",
    gmail_id: "msg-mixed",
  });
  const { results, allocations } = run(appts, [p], [CELESTIN, LACEY]);

  assert.equal(results.filter((r) => r.status === "PAID_VENMO").length, 0,
    "does not settle one Mathieu session");
  assert.equal(allocations[0].sessions.length, 0,
    "does not split across Mathieu sessions");
  assert.equal(results.filter((r) => r.status === "NEEDS_REVIEW").length, 1,
    "remains review pending human resolution");
  assert.equal(allocations[0].remainder, 140, "full receipt unallocated");
  assertAllocationInvariant(allocations);
});

// ---- Fixture D — dated payment reservation --------------------------------

test("Fixture D: an earlier session cannot consume a payment dated later", () => {
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const p = pay(70, "7/13", "2026-07-13");
  const { results } = run(appts, [p]);

  assert.equal(results[0].status, "UNPAID", "7/10 cannot take the 7/13 payment");
  assert.equal(results[1].status, "PAID_VENMO", "the named date receives it");
  assert.equal(results[1].payment.gmail_id, p.gmail_id);
});

// ---- Fixture E — summary ---------------------------------------------------

test("Fixture E: two review rows report as 2 in results, log, and email", () => {
  const now = at("2026-07-31");
  // Both rows are >7 days old — the exact shape that used to render "0 review"
  // because the email counted only the current week and filed these under a
  // separate Carryover chip.
  const results = [
    { appt: appt("2026-07-10"), roster: LACEY, status: "NEEDS_REVIEW", payment: pay(65, "", "2026-07-10"), expectedPrice: 70 },
    { appt: appt("2026-07-13"), roster: LACEY, status: "NEEDS_REVIEW", payment: pay(65, "", "2026-07-13"), expectedPrice: 70 },
  ];

  const counts = summaryCounts(results);
  assert.equal(counts.needs_review, 2, "result rows: 2");

  const { subject } = buildEmail({ results, unmatchedPayments: [], now, windowStart: at("2026-07-01") });
  assert.equal(parseSubjectCounts(subject).needs_review, 2, "email summary: 2");

  // The log derives from the same helper, so this is the log's number too.
  assert.doesNotThrow(() => assertSummaryConsistency({ results, logCounts: counts, subject }));
});

test("Fixture E: a disagreeing summary blocks the email", () => {
  const now = at("2026-07-31");
  const results = [
    { appt: appt("2026-07-10"), roster: LACEY, status: "NEEDS_REVIEW", payment: pay(65, "", "2026-07-10"), expectedPrice: 70 },
  ];
  assert.throws(
    () => assertSummaryConsistency({
      results,
      logCounts: { ...summaryCounts(results), needs_review: 0 },
      subject: "Weekly billing — week ending Jul 31 — 0 unpaid, 1 review",
    }),
    /summary counts disagree/i,
  );
  assert.throws(
    () => assertSummaryConsistency({
      results,
      logCounts: summaryCounts(results),
      subject: "Weekly billing — week ending Jul 31 — 0 unpaid, 0 review",
    }),
    /email says 0 review but final rows have 1/i,
  );
  // Guards against a template whose subject stops carrying the counts at all.
  assert.throws(
    () => assertSummaryConsistency({ results, logCounts: summaryCounts(results), subject: "Weekly billing" }),
    /could not read/i,
  );
});

// ---- Fixture F — configuration guard --------------------------------------

test("Fixture F: non-dry production run blocks on the wrong mode or source", () => {
  assert.throws(
    () => assertProductionConfig({ billingMode: "payment-driven", appointmentSource: "ical", dryRun: false }),
    /BILLING_MODE must be "schedule"/,
  );
  assert.throws(
    () => assertProductionConfig({ billingMode: "schedule", appointmentSource: "vagaro-events", dryRun: false }),
    /APPOINTMENT_SOURCE must be "ical"/,
  );
  // The approved production path passes.
  assert.doesNotThrow(
    () => assertProductionConfig({ billingMode: "schedule", appointmentSource: "ical", dryRun: false }),
  );
  // Dry runs may still explore either path — that's how they get validated.
  assert.doesNotThrow(
    () => assertProductionConfig({ billingMode: "payment-driven", appointmentSource: "vagaro-events", dryRun: true }),
  );
});

// ---- Workflow defaults + cron (mechanical verification) --------------------

test("scheduled workflow resolves to schedule + ical on the Friday-evening cron", async () => {
  const yml = await fs.readFile(
    path.join(REPO_ROOT, ".github", "workflows", "weekly-billing.yml"), "utf8",
  );

  // Scheduled runs supply no inputs, so the `||` fallback IS the scheduled mode.
  assert.match(yml, /BILLING_MODE:\s*\$\{\{\s*github\.event\.inputs\.billing_mode\s*\|\|\s*'schedule'\s*\}\}/);
  assert.match(yml, /APPOINTMENT_SOURCE:\s*\$\{\{\s*github\.event\.inputs\.appointment_source\s*\|\|\s*'ical'\s*\}\}/);
  assert.doesNotMatch(yml, /\|\|\s*'payment-driven'/, "no payment-driven fallback anywhere");

  // Manual dispatch defaults must agree with the scheduled path.
  const billingModeInput = yml.slice(yml.indexOf("billing_mode:"));
  assert.match(billingModeInput.slice(0, 400), /default:\s*schedule\b/);
  const sourceInput = yml.slice(yml.indexOf("appointment_source:"));
  assert.match(sourceInput.slice(0, 400), /default:\s*ical\b/);
  const lookbackInput = yml.slice(yml.indexOf("lookback_days:"));
  assert.match(lookbackInput.slice(0, 250), /default:\s*["']?5["']?\b/, "scheduled appointment window starts before Monday but excludes prior Friday");

  // Friday 9 PM PDT / 8 PM PST in San Diego.
  assert.match(yml, /- cron:\s*"0 4 \* \* 6"/);
  assert.doesNotMatch(yml, /- cron:\s*"0 17 \* \* 5"/, "old Friday-morning cron is gone");
});

// ---- Regression: existing single-session behavior --------------------------

test("normal one-session matching is unchanged", () => {
  const appts = [appt("2026-07-10")];
  const p = pay(70, "training", "2026-07-10");
  const { results, allocations, unmatchedPayments } = run(appts, [p]);

  assert.deepEqual(statuses(results), ["PAID_VENMO"]);
  assert.equal(results[0].checkoutAmount, 70);
  assert.equal(unmatchedPayments.length, 0);
  assert.equal(allocations[0].remainder, 0);
  assertAllocationInvariant(allocations);
});

test("a $5 add-on stays an add-on: $75 settles a $70 session with $5 remainder", () => {
  const appts = [appt("2026-07-10")];
  const p = pay(75, "training + shake", "2026-07-10");
  const { results, allocations } = run(appts, [p]);

  assert.equal(results[0].status, "PAID_VENMO");
  assert.equal(results[0].checkoutAmount, 70, "checkout is the session price, not the receipt");
  assert.equal(allocations[0].sessions[0].amount, 70);
  assert.equal(allocations[0].remainder, 5, "the smoothie is preserved as remainder");
  assertAllocationInvariant(allocations);
});

test("a short payment still lands in review", () => {
  const appts = [appt("2026-07-10")];
  const { results } = run(appts, [pay(40, "training", "2026-07-10")]);
  assert.equal(results[0].status, "NEEDS_REVIEW");
});

test("an unpaid session with no payment is still UNPAID", () => {
  const { results } = run([appt("2026-07-10")], []);
  assert.deepEqual(statuses(results), ["UNPAID"]);
});


// ---- Provenance + Pacific-date regressions ---------------------------------

test("payment-driven ledger observations never masquerade as settled sessions", () => {
  const pdDates = new Set(["2026-08-29"]);
  const legacyPd = { gmail_id: "pd", matched_at: "2026-08-29T00:47:30Z", matched_to: { date: "2026-08-24", client: "A" } };
  const explicitPd = { ...legacyPd, gmail_id: "pd2", matched_at: "2026-09-01T00:00:00Z", source_mode: "payment-driven" };
  const schedule = { ...legacyPd, gmail_id: "sched", source_mode: "schedule" };
  const corrected = { ...legacyPd, gmail_id: "manual", corrected_by: "Brad" };

  assert.equal(isPaymentDrivenLedgerEntry(legacyPd, pdDates), true);
  assert.equal(isPaymentDrivenLedgerEntry(explicitPd, pdDates), true);
  assert.equal(isPaymentDrivenLedgerEntry(schedule, pdDates), false);
  assert.equal(isPaymentDrivenLedgerEntry(corrected, pdDates), false);
  assert.deepEqual(trustedScheduleLedger([legacyPd, explicitPd, schedule, corrected], pdDates).map((m) => m.gmail_id), ["sched", "manual"]);
});

test("Friday-evening run labels and action dates stay on the Pacific service day", () => {
  const fridayNinePmPdt = new Date("2026-08-29T04:00:00Z");
  assert.equal(fmtDate(fridayNinePmPdt), "Fri, 8/28");
  assert.equal(fmtDateIsoPacific(fridayNinePmPdt), "2026-08-28");
});


test("numeric same-day Venmo memo remains explicit service-date evidence", () => {
  assert.equal(isLikelyAutoDateMemo("8/26"), false);
  assert.equal(isLikelyAutoDateMemo("8.24"), false);
  assert.equal(isLikelyAutoDateMemo("8-25-26"), false);
  assert.equal(isLikelyAutoDateMemo("Aug 24, 2026"), true);
});

test("ambiguous schedule replication cannot create a firm unpaid debt", () => {
  const ambiguous = appt("2026-07-10", "Lacey James", { mapping_ambiguous: true });
  const { results } = run([ambiguous], []);
  assert.equal(results[0].status, "NEEDS_REVIEW");
  assert.match(results[0].note, /does not uniquely prove/i);
});

test("nearby inferred reschedule downgrades remaining scheduled debt to review", () => {
  const scheduled = appt("2026-07-10");
  const moved = appt("2026-07-09", null, { unidentified: true, summary: "60 Mins - 1:1 Personal Training" });
  const p = pay(70, "7/9", "2026-07-09");
  const { results } = run([scheduled, moved], [p]);
  const scheduledRow = results.find((r) => r.appt === scheduled);
  const inferred = results.find((r) => r.inferred);
  assert.equal(inferred?.status, "PAID_VENMO");
  assert.equal(scheduledRow.status, "NEEDS_REVIEW");
  assert.match(scheduledRow.note, /possible reschedule/i);
});

// ---- Allocation invariant --------------------------------------------------

test("allocation conservation is enforced", () => {
  assert.throws(
    () => assertAllocationInvariant([
      { sender: "X", gross: 140, remainder: 0, sessions: [{ date: "2026-07-10", client: "A", amount: 100 }, { date: "2026-07-13", client: "A", amount: 100 }] },
    ]),
    /exceeds the gross receipt/,
  );
  assert.throws(
    () => assertAllocationInvariant([
      { sender: "X", gross: 140, remainder: 40, sessions: [{ date: "2026-07-10", client: "A", amount: 70 }] },
    ]),
    /!= gross/,
  );
  assert.throws(
    () => assertAllocationInvariant([
      { sender: "X", gross: 140, remainder: 0, sessions: [{ date: "2026-07-10", client: "A", amount: 70 }, { date: "2026-07-10", client: "A", amount: 70 }] },
    ]),
    /settled twice/,
  );
});

// ---- Regressions caught by adversarial review of this repair ---------------

test("a within-$2 underpayment cannot allocate above the receipt", () => {
  // amountScore treats |received - expected| <= 2 as paid in full and
  // matchedSessionPrice snaps UP to $70. Booking the snapped price against a
  // $68 gross would trip the invariant and abort the whole Friday run.
  for (const amount of [68, 69, 69.5]) {
    const { results, allocations } = run([appt("2026-07-10")], [pay(amount, "training", "2026-07-10")]);
    assert.equal(results[0].status, "PAID_VENMO", `$${amount} still settles`);
    assert.equal(results[0].checkoutAmount, 70, `$${amount} still checks out at the session price`);
    assert.equal(allocations[0].sessions[0].amount, amount, `$${amount} allocates only what arrived`);
    assert.equal(allocations[0].remainder, 0);
    assert.doesNotThrow(() => assertAllocationInvariant(allocations), `$${amount} must not abort the run`);
  }
});

test("a combined receipt is not double-counted in money-in totals", () => {
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const p = pay(140, "7/10 and 7/13", "2026-07-13");
  const { results, newMatches } = run(appts, [p]);

  const collected = results
    .filter((r) => r.status === "PAID_VENMO")
    .reduce((s, r) => s + (r.payment?.amount || 0), 0);
  assert.equal(collected, 140, "both templates sum row payment amounts — must equal the receipt");
  assert.equal(results[0].payment.gross_amount, 140, "the gross receipt is still recoverable");

  // And it must not re-inflate once the rows are replayed from the ledger.
  const second = run(appts, [p], [LACEY], newMatches);
  const collectedAgain = second.results
    .filter((r) => r.status === "PAID_VENMO")
    .reduce((s, r) => s + (r.payment?.amount || 0), 0);
  assert.equal(collectedAgain, 140, "ledger replay reports the same $140, not $280");
});

test("one receipt may settle two sessions on the SAME day", () => {
  // Lacey trained twice on 6/10; Peggy had two 5/25 sessions. Keying the
  // double-settle guard on the calendar day alone aborted the run for them.
  const appts = [appt("2026-07-10"), { ...appt("2026-07-10"), date: at("2026-07-10", 20) }];
  const { results, allocations } = run(appts, [pay(140, "training", "2026-07-10")]);

  assert.deepEqual(statuses(results), ["PAID_VENMO", "PAID_VENMO"]);
  assert.equal(allocations[0].sessions.length, 2);
  assert.equal(allocations[0].remainder, 0);
  assert.doesNotThrow(() => assertAllocationInvariant(allocations));
});

test("the same slot settled twice is still rejected", () => {
  assert.throws(
    () => assertAllocationInvariant([
      { sender: "X", gross: 140, remainder: 0, sessions: [
        { date: "2026-07-10", client: "A", amount: 70, slot: 3 },
        { date: "2026-07-10", client: "A", amount: 70, slot: 3 },
      ] },
    ]),
    /settled twice/,
  );
});

test("a time range in the memo cannot steal an earlier session", () => {
  // "7/10 7-8 pm": the hyphen in the time range must not parse as July 8 and
  // let the 7/8 appointment consume a payment the memo pinned to 7/10.
  const appts = [appt("2026-07-08"), appt("2026-07-10")];
  const { results } = run(appts, [pay(70, "7/10 7-8 pm", "2026-07-10")]);

  assert.equal(results[0].status, "UNPAID", "7/8 must not take it");
  assert.equal(results[1].status, "PAID_VENMO", "7/10 gets it");
  assert.deepEqual(parseNoteDates("7/10 7-8 pm", 2026).map((d) => d.toISOString().slice(0, 10)), ["2026-07-10"]);
});

test("a single-session payment whose memo names two dates goes to the named session", () => {
  // $70 with memo "7/10 and 7/13" is NOT a combined receipt (it only covers
  // one session). The earlier appointment must not consume it via the widened
  // date set — requirement 5 still governs.
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const { results } = run(appts, [pay(70, "7/13 and 7/10", "2026-07-13")]);
  const paid = results.filter((r) => r.status === "PAID_VENMO");
  assert.equal(paid.length, 1, "only one session can be settled by $70");
  assert.equal(paid[0].appt.date.toISOString().slice(0, 10), "2026-07-13",
    "the payment's own parsed noteDate (7/13) decides, not the earliest appointment");
});

test("a hyphen-dated single memo still matches its session", () => {
  // parseNoteDates ignores hyphen separators, but parseNoteDate does not, so
  // the single-date fallback must keep working.
  const appts = [appt("2026-07-10"), appt("2026-07-13")];
  const { results } = run(appts, [pay(70, "training 7-13", "2026-07-13")]);
  assert.equal(results[0].status, "UNPAID");
  assert.equal(results[1].status, "PAID_VENMO");
});

// ---- Phantom dates must never widen a reservation -------------------------

// Each memo names ONE session but contains a second thing that parses as a
// date. Reserving on it silently marks an unpaid session PAID and drops it off
// the chase list — money lost with no guard tripped.
for (const [memo, label] of [
  ["7/13 6.30 pm", "period-style clock time"],
  ["7/13 6-30 pm", "hyphen-style clock time"],
  ["7/13 Maya 15 min late", "a name whose first three letters spell a month"],
  ["7/13 Julie 2 people", "another month-prefixed name"],
]) {
  test(`phantom date rejected: ${label} — "${memo}"`, () => {
    const appts = [appt("2026-06-30"), appt("2026-07-13")];
    const { results } = run(appts, [pay(140, memo, "2026-07-13")]);
    assert.equal(results[0].status, "UNPAID",
      "the session the client never named must stay on the chase list");
    assert.notEqual(results[1].status, "UNPAID", "the named session is still handled");
  });
}

test("enumeratesDates distinguishes a list of sessions from a date beside noise", () => {
  assert.equal(enumeratesDates("7/10 and 7/13"), true);
  assert.equal(enumeratesDates("6.8 and 6.10"), true);
  assert.equal(enumeratesDates("7/10, 7/13"), true);
  assert.equal(enumeratesDates("7/10 + 7/13"), true);

  assert.equal(enumeratesDates("7/13 6.30 pm"), false);
  assert.equal(enumeratesDates("5/20 Maya 15 min late"), false);
  assert.equal(enumeratesDates("7/13"), false);
  assert.equal(enumeratesDates("7/13, thanks"), false, "trailing comma is not an enumeration");
  assert.equal(enumeratesDates(""), false);
});

test("only real month words parse as months", () => {
  assert.deepEqual(parseNoteDates("Maya 15", 2026), []);
  assert.deepEqual(parseNoteDates("Julie 2", 2026), []);
  assert.equal(parseNoteDates("May 15", 2026)[0].toISOString().slice(0, 10), "2026-05-15");
  assert.equal(parseNoteDates("July 2", 2026)[0].toISOString().slice(0, 10), "2026-07-02");
  assert.equal(parseNoteDates("Sept 3", 2026)[0].toISOString().slice(0, 10), "2026-09-03");
});

test("a period-separated combined memo still reserves — '.' is a real separator here", () => {
  // Live memos use "5.25", "6.8" etc, so the period cannot simply be banned.
  const appts = [appt("2026-06-08"), appt("2026-06-10")];
  const { results, allocations } = run(appts, [pay(140, "6.8 and 6.10", "2026-06-10")]);
  assert.deepEqual(statuses(results), ["PAID_VENMO", "PAID_VENMO"]);
  assert.equal(allocations[0].remainder, 0);
});

test("a session with no price is never folded into a combined reservation", () => {
  // A blank default_price cell parses to null. Booking its share would allocate
  // $0 and freeze that $0 into the ledger, hiding the whole receipt.
  const priceless = client({ vagaro_name: "Nulla Price", venmo_display_names: ["Laci James"], default_price: null });
  const appts = [appt("2026-07-10", "Nulla Price"), appt("2026-07-13", "Nulla Price")];
  const { results, allocations } = run(appts, [pay(140, "7/10 and 7/13", "2026-07-13")], [priceless]);

  assert.ok(!results.some((r) => r.status === "PAID_VENMO" && (r.payment?.amount ?? 0) === 0),
    "no session may settle for $0");
  assert.ok(allocations[0].sessions.every((s) => s.amount > 0), "no $0 allocation is recorded");
  assertAllocationInvariant(allocations);
});

// ---- Multi-date memo parsing ----------------------------------------------

test("parseNoteDates finds every date; parseNoteDate still returns the first", () => {
  const ds = parseNoteDates("7/10 and 7/13", 2026);
  assert.equal(ds.length, 2);
  assert.deepEqual(ds.map((d) => d.toISOString().slice(0, 10)), ["2026-07-10", "2026-07-13"]);
  assert.equal(parseNoteDate("7/10 and 7/13", 2026).toISOString().slice(0, 10), "2026-07-10");

  assert.deepEqual(parseNoteDates("Mathieu james violette and 1 drink", 2026), []);
  assert.equal(parseNoteDates("Workout 6/29 and shot", 2026).length, 1);
  assert.equal(parseNoteDates("", 2026).length, 0);
  assert.equal(parseNoteDates("Jun 01, 2026", 2026)[0].toISOString().slice(0, 10), "2026-06-01");
});

test("command-center never counts review exposure as confirmed debt", () => {
  const now = at("2026-08-28", 23);
  const unpaid = {
    status: "UNPAID", appt: appt("2026-08-24"), roster: LACEY,
    expectedPrice: 70, checkoutAmount: 70,
  };
  const review = {
    status: "NEEDS_REVIEW", appt: appt("2026-08-25"), roster: LACEY,
    expectedPrice: 100, checkoutAmount: 100, note: "attendance uncertain",
  };
  const { subject, html, preheader } = buildMoneyLine({
    results: [unpaid, review], unmatchedPayments: [], now,
    windowStart: at("2026-08-21"), checkoutPrompt: "", theme: "brand",
  });

  assert.match(subject, /1 unpaid, 1 review/);
  assert.match(preheader, /\$70 confirmed due/);
  assert.match(html, /Confirmed Due/);
  assert.match(html, /\$70 confirmed due/);
  assert.match(html, /Review - Do Not Request/);
  assert.match(html, /attendance uncertain/);
  assert.doesNotMatch(preheader, /\$170/);
  assert.doesNotMatch(html, /Request \$100 balance/);
});

test("manual multi-purpose receipt allocations replay only the session share", () => {
  const jacob = client({
    vagaro_name: "Jacob Bain", venmo_display_names: ["Jacob Bain"], default_price: 70,
  });
  const livePayment = pay(190, "08/19, 08/25, and SEP", "2026-08-25", {
    gmail_id: "jacob-190", sender_display_name: "Jacob Bain",
  });
  const paymentRecord = { sender: "Jacob Bain", amount: 190, note: "08/19, 08/25, and SEP", date: "2026-08-25" };
  const prior = [
    { gmail_id: "jacob-190", source_mode: "manual", corrected_by: "Brad", matched_to: { date: "2026-08-19", client: "Jacob Bain", status: "PAID_VENMO", session_amount: 70 }, payment: paymentRecord },
    { gmail_id: "jacob-190", source_mode: "manual", corrected_by: "Brad", matched_to: { date: "2026-08-25", client: "Jacob Bain", status: "PAID_VENMO", session_amount: 70 }, payment: paymentRecord },
    { gmail_id: "jacob-190", source_mode: "manual", corrected_by: "Brad", matched_to: { date: "n/a-programming-2026-09", client: "Jacob Bain", status: "EXTRA_SERVICE", session_amount: 50 }, payment: paymentRecord },
  ];
  const { results, unmatchedPayments } = run([appt("2026-08-25", "Jacob Bain")], [livePayment], [jacob], prior);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "PAID_VENMO");
  assert.equal(results[0].payment.amount, 70);
  assert.equal(results[0].payment.gross_amount, 190);
  assert.equal(unmatchedPayments.length, 0);
});

test("default email excludes review exposure from confirmed due and request actions", () => {
  const now = at("2026-08-28", 23);
  const unpaid = {
    status: "UNPAID", appt: appt("2026-08-24"), roster: LACEY,
    expectedPrice: 70, checkoutAmount: 70,
  };
  const review = {
    status: "NEEDS_REVIEW", appt: appt("2026-08-25"), roster: LACEY,
    expectedPrice: 100, checkoutAmount: 100, note: "attendance uncertain",
  };
  const { subject, html } = buildEmail({ results: [unpaid, review], unmatchedPayments: [], now, windowStart: at("2026-08-21") });

  assert.match(subject, /1 unpaid/);
  assert.match(subject, /1 review/);
  assert.match(html, /Confirmed Due/);
  assert.match(html, /\$70/);
  assert.match(html, /REVIEW, DO NOT REQUEST/);
  assert.match(html, /attendance uncertain/);
  assert.doesNotMatch(html, /Outstanding.*\$170/);
  assert.doesNotMatch(html, /Request \$100 balance/);
});

test("date-specific schedule overrides replace only the matching recurring slot", () => {
  const recurring = [
    { day_of_week: 1, time: "09:00", client_name: "Dina Bates", price_override: 45 },
    { day_of_week: 1, time: "09:00", client_name: "Anna Cessna", price_override: 45 },
    { day_of_week: 1, time: "09:00", client_name: "Katelin Lowther", price_override: 45 },
  ];
  const overrides = [
    { date_iso: "2026-08-24", time: "09:00", client_name: "Anna Cessna", price_override: 45 },
    { date_iso: "2026-08-24", time: "09:00", client_name: "Katelin Lowther", price_override: 45 },
  ];
  const slot = { date: new Date("2026-08-24T16:00:00Z"), summary: "60 Min 2:1" };
  const rows = expandSlots([slot], recurring, overrides);
  assert.deepEqual(rows.map((r) => r.client_name), ["Anna Cessna", "Katelin Lowther"]);
  assert.ok(rows.every((r) => r.mapping_ambiguous), "one iCal event cannot prove both seats attended");
});

test("schedule override CSV loader preserves exact dates and prices", async () => {
  const tmp = path.join(REPO_ROOT, "billing", "bot", `schedule-override-test-${process.pid}.csv`);
  await fs.writeFile(tmp, "date,time,client_name,price_override,notes\n2026-08-24,15:00,Dina Bates,70,one-off\n", "utf8");
  try {
    const rows = await loadScheduleOverrides(tmp);
    assert.deepEqual(rows, [{ date_iso: "2026-08-24", time: "15:00", client_name: "Dina Bates", price_override: 70, notes: "one-off" }]);
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("verified missing Zelle converts external-payment pending to confirmed due", () => {
  const stacy = client({
    vagaro_name: "Stacy Tesler CPY", venmo_display_names: [], default_price: 70,
    pays_cash: true, notes: "Pays via Zelle -> Capital One personal checking",
  });
  const externalUnpaid = [{
    date: "2026-08-27", name: "Stacy Tesler CPY", amount: 70,
    notes: "late cancellation chargeable; Zelle verified not received",
  }];
  const { results } = reconcile(
    [appt("2026-08-27", "Stacy Tesler CPY")], [], [stacy], [], [], [], externalUnpaid,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "UNPAID");
  assert.equal(results[0].externalPaymentVerifiedUnpaid, true);
  assert.match(results[0].note, /verified not received/);

  const { html, preheader } = buildMoneyLine({
    results, unmatchedPayments: [], now: at("2026-08-28", 23),
    windowStart: at("2026-08-21"), checkoutPrompt: "", theme: "brand",
  });
  assert.match(preheader, /\$70 confirmed due/);
  assert.match(html, /Confirmed Due - External Rail/);
  assert.match(html, /Zelle was checked/);
  assert.match(html, /Confirm paid when received/);
  assert.doesNotMatch(html, /Request \$70 on Venmo/);
  assert.doesNotMatch(html, /Wasn't trained/);
});

test("dated cash or Zelle confirmations use the Pacific service date", () => {
  const stacy = client({ vagaro_name: "Stacy Tesler CPY", default_price: 70, pays_cash: true });
  const cashLog = [{ date: "2026-08-27", name: "Stacy Tesler CPY", amount: 70, notes: "Zelle" }];
  const { results } = reconcile([appt("2026-08-27", "Stacy Tesler CPY")], [], [stacy], cashLog, [], [], []);
  assert.equal(results[0].status, "PAID_CASH");
});

