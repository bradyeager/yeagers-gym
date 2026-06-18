# Operations Runbook — Yeager's Gym Billing Bot

For Brad + any future Claude session (any model — Sonnet and Haiku handle all
of this; you don't need the expensive ones for routine ops). Read
`billing/RULES.md` for business logic; this file is **what to do when
something breaks or changes.**

---

## The 60-second mental model

```
Vagaro calendar → Google Calendar sync → iCal feed ─┐
Venmo emails → Gmail ───────────────────────────────┼→ GitHub Action (Fri 10am PT)
billing/*.csv + cancellations/ + cash-entries/ ─────┘        │
                                                    reconcile → email Brad
                                                              → commit log + ledger
```

Brad acts on the email (tap buttons → commits files). Files shape next run.
`matched-payments.json` is the bot's memory — a payment matches ONE session, ever.

## Weekly routine (what Brad does)

1. Friday ~10 AM: email arrives.
2. Tap buttons: Request (Venmo) / Log as cash / Wasn't trained / Verify bank.
3. If anything moved or changed, tell a Claude session in plain English
   (a walkthrough like "Annie moved to Monday, Jacob cancelled") — it files
   the cancellations/ledger fixes. Cheap model is fine.
4. Re-run the workflow if you want a corrected email + fresh Vagaro block:
   Actions → Weekly billing → Run workflow → email_style=command-center.
5. Copy the Playbook block → Claude for Chrome → Vagaro checkouts.

## Symptom → Fix

| Symptom | Likely cause | Fix |
|---|---|---|
| **No Friday email at all** | Workflow failed. GitHub emails the repo owner on failed runs — check inbox/spam, then Actions tab → red run → read the log | See failure types below |
| Log: `invalid_grant` / Google auth error | Google refresh token died (password change, security event, app revoked) | Redo SETUP.md §OAuth: OAuth Playground → new refresh token → update `GOOGLE_REFRESH_TOKEN` secret |
| Log: Brevo 401 | API key revoked or IP allowlist re-enabled | Brevo dashboard → SMTP & API → check key + "Authorised IPs" must be OFF for API keys |
| Email arrives but **0 sessions** | Vagaro→Google Calendar sync broke, or `VAGARO_ICAL_URL` invalid | Vagaro: Settings → Calendar Sync → reconnect; grab fresh iCal URL from Google Calendar → update secret |
| Email arrives but **0 payments** (everyone unpaid) | Venmo changed their email format, or Gmail filter eating them | Search Gmail `from:venmo.com newer_than:7d` — if emails exist, the parser regex in `billing.mjs` (`parseVenmoEmail`) needs updating to the new format |
| Client falsely UNPAID, payment exists with a date in the memo | Memo date ≠ session date (strict note-date) | Either correct: memo refers to a different session (check!), or add a manual ledger entry pinning the payment (see below) |
| Client falsely PAID / wrong session | Misattribution | Edit `billing/matched-payments.json`: find the entry, fix `matched_to.date`, add `"corrected_by": "..."`, commit |
| Session billed for someone on vacation | iCal still has the recurring slot | "Wasn't trained" button, or add `billing/cancellations/YYYY-MM-DD-name.md` |
| Phantom client every week | schedule.csv has a stale row | Remove the row (or mark INACTIVE) |
| Unidentified slot every week | Real session missing from schedule.csv | Add the row |
| Outlook shows light background | Outlook desktop ignores dark-mode hints | Known limit. "View in browser" renders correctly |

## Manual ledger entry (pin a payment to a session)

Append to `billing/matched-payments.json`:

```json
{
  "gmail_id": "manual-<short-description>",
  "matched_at": "<today>T00:00:00Z",
  "matched_to": { "date": "YYYY-MM-DD", "client": "Exact Vagaro Name", "status": "PAID_VENMO" },
  "payment": { "sender": "Venmo Display Name", "amount": 50, "note": "the memo", "date": "YYYY-MM-DD" },
  "corrected_by": "why"
}
```

Commit. Next run honors it (continuity) and locks the payment (no double-spend).

## Secrets inventory (GitHub → Settings → Secrets → Actions)

`VAGARO_ICAL_URL` · `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` ·
`GOOGLE_REFRESH_TOKEN` · `GOOGLE_TOKEN_EXPIRES` · `BREVO_API_KEY`

If any leaks: rotate at the source (Google Cloud console / Brevo / regenerate
iCal), paste the new value into the secret. Nothing else changes.

## Slash commands (any Claude Code session in this repo)

- `/test-billing-email` — preflight render → push → trigger → poll → summarize
- `/vagaro-prompt` — regenerate the checkout block from latest log + your
  newest cash/cancellation commits (no email, no API calls)
- `/move` — file schedule changes from plain English. Examples:
  - "Dina is out until August 1" → generates a date-range cancellation file
  - "Kerry moved from Mon 3pm to Mon 2pm permanently" → edits schedule.csv + cancels old-slot sessions in the next 2 weeks
  - "Jacob missed Monday" → creates a single cancellation file

## Issue intake (from your phone — no Claude Code session needed)

Cheapest way to file billing changes on the go:

1. Open **github.com/bradyeager/yeagers-gym/issues/new**
2. Title: short description ("Dina out until Aug 1")
3. Body: plain English ("Dina Bates is out every Monday until August 1. Lisa paid cash $70 for 6/9.")
4. Apply label: **billing-intake**

The `claude-billing-intake.yml` workflow fires, commits the correct files,
and closes the issue. Costs ~$0.01/issue (Haiku model). Requires
`ANTHROPIC_API_KEY` in repo Settings → Secrets → Actions.

## Monthly P&L

Runs automatically on the 1st of each month at 10 AM PT.
Reads all weekly logs from the prior month, deduplicates sessions,
and emails: total revenue, Venmo vs cash split, unpaid outstanding, 1099-K note.

Manual trigger: Actions → Monthly billing summary → Run workflow → month_offset=-1.

## Failure notifications

GitHub emails the repo owner by default when a workflow fails. Verify:
**github.com/settings/notifications** → GitHub Actions → Email checked.
Full setup + Slack fallback: `billing/prompts/04-github-notifications.md`.

## Privacy / private repo migration

All billing data (client names, amounts, Venmo handles) is currently in the
public `yeagers-gym` repo. Migration guide to a private repo:
`billing/prompts/03-private-repo-setup.md`

## Files that are data (Brad-editable, bot-read)

- `billing/clients.csv` — roster, prices, valid_prices, note_keywords
- `billing/schedule.csv` — who trains when; INACTIVE = ignore slot
- `billing/cancellations/*.md` — `date | name | reason` (one skip per file)
- `billing/cash-entries/*.md` — `date | name | $amount | note`
- `billing/matched-payments.json` — the bot's memory; editable with care

## Files that are code (change with care, test with `node preview.mjs`)

- `billing/bot/billing.mjs` — fetch, parse, reconcile, send
- `billing/bot/lib.mjs` — loaders, matchers, helpers
- `billing/bot/email-moneyline.mjs` — the Miami email template
- `.github/workflows/weekly-billing.yml` — the Friday trigger
