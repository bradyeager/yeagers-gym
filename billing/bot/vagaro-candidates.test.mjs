import test from "node:test";
import assert from "node:assert/strict";
import { renderVagaroCandidates } from "./vagaro-candidates.mjs";
const row = (extra = {}) => ({
  dow: "Tue", mdate: "10/13", time: "8:00 AM", name: "Example Client",
  client: { default_price: 100 }, expected: 100, checkoutAmount: 70,
  status: "PAID_VENMO", ...extra,
});
test("old report matches never become native settlement or executable price instructions", () => {
  const result = renderVagaroCandidates([row()], { source: "2026-10-09.md" });
  assert.match(result, /2026-10-09.md/);
  assert.match(result, /UNVERIFIED/);
  assert.match(result, /\$100\.00 \| \$70\.00/);
  assert.doesNotMatch(result, /enter \$|ADJUST TOTAL|trained solo|PAID CLIENTS THIS WEEK/);
  assert.match(result, /Skip already-settled/);
  assert.match(result, /inspect before retrying/);
});
test("prepaid report never instructs a zero-dollar checkout", () => {
  const result = renderVagaroCandidates([row({ status: "PAID_PREPAID", checkoutAmount: 0 })]);
  assert.match(result, /Prepaid coverage; verify source/);
  assert.doesNotMatch(result, /\$0\.00/);
});
test("unknown identity and missing amounts remain review-only", () => {
  const result = renderVagaroCandidates([row({ client: undefined, expected: null, checkoutAmount: null })]);
  assert.match(result, /UNKNOWN identity; review only/);
  assert.match(result, /UNKNOWN \| UNKNOWN \| UNVERIFIED/);
  assert.doesNotMatch(result, /\$0\.00/);
});
test("cash and cent amounts preserve their actual reported tender and value", () => {
  const result = renderVagaroCandidates([row({ status: "PAID_CASH", expected: 45.25, checkoutAmount: 45.25 })]);
  assert.match(result, /PAID_CASH \| \$45\.25 \| \$45\.25 \| UNVERIFIED/);
});
test("cancelled and unpaid rows are excluded", () => {
  const result = renderVagaroCandidates([row({ status: "CANCELLED" }), row({ status: "UNPAID" })]);
  assert.match(result, /No paid report candidates/);
  assert.doesNotMatch(result, /Example Client/);
});
test("malformed nonfinite amounts are never formatted as money", () => {
  const result = renderVagaroCandidates([row({ expected: NaN, checkoutAmount: -1 })]);
  assert.match(result, /UNKNOWN \| UNKNOWN \| UNVERIFIED/);
});
test("row text cannot inject markdown lines into the report", () => {
  const result = renderVagaroCandidates([row({ name: "Example|Client\nInjected" })]);
  assert.match(result, /Example Client Injected/);
  assert.doesNotMatch(result, /\nInjected/);
});

test("CLI reads cent amounts from a spaced path and only emits analysis", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const run = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "billing cli "));
  try {
    const bot = path.join(root, "billing", "bot");
    const logs = path.join(root, "billing", "logs");
    await fs.mkdir(bot, { recursive: true });
    await fs.mkdir(logs);
    for (const file of ["vagaro-prompt.mjs", "vagaro-candidates.mjs", "lib.mjs"]) {
      await fs.copyFile(new URL(file, import.meta.url), path.join(bot, file));
    }
    await fs.writeFile(path.join(root, "billing", "clients.csv"), "vagaro_name,default_price\nExample Client,45.25\nPrepaid Client,70\n");
    const log = [
      "- Tue, 10/13, 8:00 AM | Example Client | $45.25 | checkout $45.25 | PAID_VENMO",
      "- Tue, 10/13, 9:00 AM | Prepaid Client | $70 | checkout $0 | PAID_PREPAID",
      "- Tue, 10/13, 10:00 AM | Unknown Person | $? | PAID_VENMO",
    ].join("\n");
    const logPath = path.join(logs, "2026-10-16.md");
    await fs.writeFile(logPath, log);
    const { stdout, stderr } = await run(process.execPath, [path.join(bot, "vagaro-prompt.mjs")]);
    assert.equal(stderr, "");
    assert.match(stdout, /PAID_VENMO \| \$45\.25 \| \$45\.25 \| UNVERIFIED/);
    assert.match(stdout, /Prepaid coverage; verify source/);
    assert.match(stdout, /Unknown Person — UNKNOWN identity; review only/);
    assert.doesNotMatch(stdout, /enter \$|ADJUST TOTAL|\$0\.00/);
    assert.equal(await fs.readFile(logPath, "utf8"), log);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
