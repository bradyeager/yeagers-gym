// Report context only. This module has no provider access or write operations.
const candidateStatuses = new Set(["PAID_VENMO", "PAID_CASH", "PAID_PREPAID"]);
const cell = (value) => String(value ?? "UNKNOWN").replace(/[|\r\n]/g, " ").trim();
const money = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? "$" + value.toFixed(2) : "UNKNOWN";

export function renderVagaroCandidates(rows, { source, cashEntryCount = 0, cancellationCount = 0 } = {}) {
  const output = [
    "# Vagaro reconciliation candidates — analysis only",
    "Source report: " + cell(source),
    "Overlays inspected: " + cashEntryCount + " cash entries, " + cancellationCount + " cancellations.",
    "",
    "These are historical report matches, not evidence of current native payment or attendance.",
    "New Venmo receipts arriving after the source report are not included.",
    "The sole billing owner verifies original receipt/payment evidence, exact appointment, service date, amount/allocation and current unpaid state before bookkeeping.",
    "Skip already-settled appointments. Missing identity or conflicting allocation stays UNKNOWN/review-only.",
    "Prepaid coverage does not establish a new cash payment or a zero-dollar checkout.",
    "No new charge, request, unsupported price change or customer notification is authorized by this report.",
    "",
    "| Report date/time | Client | Report status | Report expected | Report allocation | Native settlement |",
    "|---|---|---|---|---|---|",
  ];
  let count = 0;
  for (const row of rows) {
    if (!candidateStatuses.has(row.status)) continue;
    count++;
    const identity = row.client ? cell(row.name) : cell(row.name) + " — UNKNOWN identity; review only";
    const allocation = row.status === "PAID_PREPAID"
      ? "Prepaid coverage; verify source"
      : money(row.checkoutAmount);
    output.push("| " + [
      cell(row.dow) + " " + cell(row.mdate) + " " + cell(row.time),
      identity, cell(row.status), money(row.expected), allocation, "UNVERIFIED",
    ].join(" | ") + " |");
  }
  if (!count) output.push("", "No paid report candidates.");
  output.push("", "After any authorized recording, verify the saved transaction ID, exact appointment, actual external tender and amount, and suppressed receipt. If the response is uncertain, inspect before retrying.");
  return output.join("\n");
}
