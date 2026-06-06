---
description: Render, push, trigger the workflow, poll, and summarize the live billing email run.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, mcp__github__actions_run_trigger, mcp__github__actions_get, mcp__github__actions_list, mcp__github__get_job_logs, mcp__github__list_commits, mcp__github__get_commit
---

# /test-billing-email

End-to-end test loop for the weekly billing email. Use after any change to:
- `billing/bot/*.mjs`
- `billing/clients.csv`, `billing/schedule.csv`
- `billing/cancellations/*`, `billing/cash-entries/*`
- `.github/workflows/weekly-billing.yml`

Don't restate this runbook in your output. Run it and report.

## 1. Pre-flight — fast fail before involving production

```
cd billing/bot
node --check email-moneyline.mjs && node --check email-v2.mjs \
  && node --check billing.mjs && node --check lib.mjs
node preview.mjs > /dev/null
```

Then audit `billing/preview/weekly-v2.html`:

- No adjacent `</a>\s*<a` button pairs (regression check for the bleed bug)
- Every `class="yg-btnrow"` has at least one `class="yg-btn-cell"` inside
- `WEEKLY VAGARO CHECKOUT — YEAGER'S GYM` present (the Playbook block is intact)
- `Email template:` log line present after a dry-run is impossible from here — skip
- Hero string `YEAGER'S GYM` present

If any check fails, **stop**. Tell the user what failed and don't push.

## 2. Push if dirty

```
git fetch origin main -q
git status --short
```

If there are uncommitted changes under `billing/` or `.github/`, commit them with a
1–2 sentence message describing the actual change (the WHY, not the what — no
"updated email template"; prefer "fix button bleed by switching to td-padding").

Never add Claude / AI attribution. Push:

```
git push origin main
```

Retry up to 4× on network errors with backoff (2s, 4s, 8s, 16s).

## 3. Trigger the workflow

Try `mcp__github__actions_run_trigger` first:
- owner: `bradyeager`
- repo: `yeagers-gym`
- workflow_id: `weekly-billing.yml`
- ref: `main`
- inputs:
  - `dry_run`: `"false"`
  - `lookback_days`: `"8"`
  - `email_style`: `"command-center"`

**If it returns 403 "Resource not accessible by integration"** — the
GitHub App install doesn't have `actions: write`. Fall back:

1. Capture the current HEAD sha (`git rev-parse HEAD`) — call it BASELINE.
2. Tell the user, in one line:
   > "Tap **Run workflow** at
   > https://github.com/bradyeager/yeagers-gym/actions/workflows/weekly-billing.yml
   > with `email_style = command-center`. I'll poll and report when it
   > finishes."
3. Wait. Begin polling step 4 once they confirm they tapped (or just start
   polling immediately and trust they will).

Capture the run id either from the trigger response or, in fallback mode,
from `mcp__github__actions_list` (`list_workflow_runs`, branch=main,
event=workflow_dispatch) — pick the newest run whose head_sha == BASELINE
AND created_at > now-when-you-started-polling.

## 4. Poll

Use `mcp__github__actions_get` every 15–20 s.

- Cap at 5 minutes (~15 polls).
- Stop when `status == "completed"`.
- Note the `conclusion` (`success` | `failure` | `cancelled`).

If 5 minutes elapse without completion: report the current status and stop.
Don't keep polling indefinitely.

## 5. Read the logs

`mcp__github__get_job_logs` on the `run` job of that workflow run.

Extract:

- `Email template: <value>` — must be `command-center`
- The Summary block at the bottom of the log (paid_venmo / paid_cash / paid_prepaid
  / unpaid / needs_review / cash_pending / cancelled / unknown / unidentified counts)
- `Sent email: <subject>` line
- Any clients with unusual matches (e.g. payments matched across week boundaries,
  multiple unmatched payments from a roster client)

## 6. Report back — tight

5–8 lines. Format:

```
Run <id> · <conclusion>
Template: command-center ✓
Counts: <P> paid · <U> unpaid · <R> review · <C> cancelled · <UI> unid
Subject: "<subject line>"

Look at in your inbox:
- <each action-required item — name, day/time, expected $, what to tap>

<one line about what to eyeball in Outlook desktop if relevant>
```

If conclusion is `failure`, paste the last 20 lines of the failed step and stop.
Don't propose fixes in the same turn — let the user direct the next move.
