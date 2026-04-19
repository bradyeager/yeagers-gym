# Yeager's Gym — Weekly Billing Automation

Reconciles Vagaro appointments against Venmo payments. Lists who trained but didn't pay, emails Brad, and (after Brad confirms) sends Venmo requests.

Runs inside **Claude for Chrome** — no script, no server, no credentials stored anywhere. Brad stays logged into Vagaro + Gmail; Claude reads those tabs.

## The weekly routine (Friday 10 AM, ~5 min)

1. Google Calendar reminder fires at Fri 10 AM: *"Run weekly billing check."*
2. Open Chrome. Make sure you're logged into **Gmail** and **Vagaro Pro** in two tabs.
3. Open the Claude for Chrome side panel.
4. Paste (or select saved recipe) **`prompts/01-weekly-check.md`**.
5. Wait. Claude gathers the week's appointments and payments, writes a log under `billing/logs/`, and sends you an email titled *"Weekly billing — N unpaid"*.
6. **Read the email.** Reply with one of:
   - `confirm: Alice, Jordan` — send Venmo requests to those clients
   - `skip: Tom (paid cash)` — exclude; Claude will log the cash payment
   - `skip: Sarah` — exclude; no cash log (e.g., free session)
7. Re-open Claude for Chrome and paste **`prompts/02-send-requests.md`**. Claude reads your reply, navigates Venmo, and sends each request one at a time — pausing for your OK on each.

That's it. Do this every Friday. If a client disputes a session 6 weeks from now, grep `billing/logs/`.

## Set up the Friday 10 AM reminder (one-time, ~2 min)

Claude for Chrome requires a human to click "go" — it can't fire on a schedule. A recurring calendar event handles that.

1. In Google Calendar, create an event: **"Weekly billing — Yeager's Gym"**
2. Time: **Friday 10:00 AM**, repeats **weekly**, no end date.
3. Duration: 15 minutes.
4. Notification: 0 min before (email + popup).
5. Description — paste this:
   ```
   1. Open Chrome, log into Gmail + Vagaro Pro.
   2. Open Claude for Chrome side panel.
   3. Paste billing/prompts/01-weekly-check.md.
   4. Reply to the billing email with confirm/skip/cash.
   5. Paste billing/prompts/02-send-requests.md.
   ```
6. Save.

## First-time setup (one 30-min session)

Before the first weekly run, do **Phase 0 — Discovery** to build the client roster:

1. Open Chrome with Gmail + Vagaro Pro logged in.
2. Paste **`prompts/00-discovery.md`**.
3. Claude scans the last 4 weeks of Vagaro appointments and Venmo emails, proposes a draft `clients.csv`, and walks you through it row by row.
4. Confirm name matches, default prices, and flag cash-only clients.
5. The final roster lands at `billing/clients.csv`.

Re-run `00-discovery.md` whenever you onboard new clients or someone changes their Venmo handle.

## Files

| File | Purpose | Who edits |
|---|---|---|
| `clients.csv` | Client roster + matching rules | Claude builds, you edit |
| `cash-log.md` | Running log of cash-paid sessions | Claude appends each week |
| `prompts/00-discovery.md` | One-time roster-building recipe | Do not edit |
| `prompts/01-weekly-check.md` | Sunday-night reconciliation recipe | Do not edit |
| `prompts/02-send-requests.md` | Confirmation → send-requests recipe | Do not edit |
| `logs/YYYY-MM-DD.md` | Per-week audit trail | Claude writes |

## Design rules Claude follows

- **Never** send a Venmo request without a per-client visual confirmation from Brad.
- **Never** store login credentials. Brad's browser session is the only auth.
- **Always** write a log file for each weekly run so disputes are traceable.
- **Pause 10–15 seconds** between Venmo requests to avoid rate-limit flags.
- **If matching is ambiguous**, surface it under `NEEDS REVIEW` — do not auto-confirm.

## When things break

- **Vagaro UI changes:** Claude reads the rendered page, so minor redesigns usually work. If the recipe fails, open Vagaro manually, describe what you see, and Claude will adapt.
- **Venmo flags the account:** Stop auto-requests for a week. Resume with a slower cadence.
- **Claude for Chrome access revoked:** Fall back to running `01-weekly-check.md` via Claude Code — paste the week's Vagaro appointment list and Venmo emails manually.

## What this does NOT do

- Does not handle taxes, 1099-K, or bookkeeping exports.
- Does not replace Vagaro (scheduling) or Venmo (payments).
- Does not message clients on Brad's behalf beyond the Venmo request itself.
