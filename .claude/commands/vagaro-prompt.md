---
description: Print a fresh Vagaro checkout block reflecting the most recent log plus any post-run cash/cancellation commits.
allowed-tools: Bash, Read
---

# /vagaro-prompt

Print a fresh "PAID CLIENTS THIS WEEK" block for Claude for Chrome to consume.

Use after committing a **Wasn't trained** or **Log as cash** from the email,
when you want an up-to-date prompt **without** triggering a full workflow run
(which would generate another email).

## Steps

```
cd billing/bot
node vagaro-prompt.mjs
```

Output goes straight to stdout — already formatted as the copy-paste block.

## What it does

1. Finds the most recent `billing/logs/YYYY-MM-DD.md`
2. Parses the Appointments section (date, time, client, checkout $, status)
3. Loads CURRENT `billing/cash-entries/` and `billing/cancellations/`
4. Overlays:
   - Any `CASH_PENDING` with a matching cash-entry → `PAID_CASH`
   - Any session matching a cancellation → dropped from the list
5. Emits the `==== PAID CLIENTS THIS WEEK ====` block sorted most-recent-day first

## Limitation to mention to Brad

It does **NOT** see Venmo payments that arrived since the log was generated.
For brand-new payments, the workflow has to re-run (`/test-billing-email` —
it triggers + polls + reports). Tell him that explicitly if he asks why a
client he just got paid by isn't on the list.

## Report back

Just relay the output. No commentary unless he asked a question.
