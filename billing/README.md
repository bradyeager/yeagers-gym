# Yeager's Gym — Weekly Billing Automation

Reconciles Vagaro appointments against Venmo payments, emails you an unpaid-client list with tap-to-request Venmo buttons, every Friday morning. No Chrome, no pasting, no manual triggers.

## What happens every Friday

1. **10 AM PT (roughly):** GitHub Actions fires `weekly-billing.yml`.
2. Bot fetches your Vagaro calendar (via iCal feed), Venmo receipts (via Gmail OAuth), and `clients.csv`.
3. Bot matches payments to appointments, classifies each session as paid/unpaid/needs-review/cash-paid.
4. Bot emails you via Brevo: unpaid clients with pre-filled "Request $X from @handle" buttons.
5. Bot commits a weekly log to `billing/logs/YYYY-MM-DD.md` (disputes → `git log`).

## Your Friday

Open the email on your phone. For each unpaid client, tap the button → Venmo app opens with amount + note pre-filled → tap Send. 30 seconds total.

For cash payments: add a line to `billing/cash-log.md` (`YYYY-MM-DD | Client Name | $amount | notes`) in the GitHub web UI. The next run will recognize it.

## Set it up

**First-time setup: see [`SETUP.md`](./SETUP.md).** ~45 min to wire up:
- Vagaro iCal feed URL
- Google OAuth (Gmail readonly scope)
- Brevo API key
- GitHub Secrets
- A test run via workflow_dispatch

Once that's done, it runs itself every Friday.

## Files

| File | Purpose |
|---|---|
| `SETUP.md` | One-time wiring instructions (read this first) |
| `clients.csv` | Client roster — name, Venmo handle, default price, cash-only flag |
| `cash-log.md` | Append-only log of cash-paid sessions |
| `bot/billing.mjs` | The Node script that runs in GitHub Actions |
| `bot/package.json` | Node dependencies |
| `logs/YYYY-MM-DD.md` | Per-week audit log, written by the bot |
| `prompts/*.md` | Claude-for-Chrome fallback recipes (see below) |

## Updating the roster

Edit `clients.csv` in GitHub's web UI (or locally + push). The next run picks it up. No redeploy needed.

## Manual re-run

Something seems off? Go to the **Actions** tab → **Weekly billing reconciliation** → **Run workflow**. Set `dry_run=true` to preview the email without sending.

## Fallback: Claude-for-Chrome recipes

If the automation breaks and you need results immediately, the `prompts/` folder still contains manual recipes:

- `prompts/00-discovery.md` — one-time, builds the initial `clients.csv` by scanning 4 weeks of history
- `prompts/01-weekly-check.md` — manual version of the weekly reconciliation
- `prompts/02-send-requests.md` — manual Venmo request sender (useful if you ever want human-in-the-loop per request)

These run in Claude for Chrome. See headers of each file for the full procedure.

## Design rules

- **No stored passwords.** Gmail uses OAuth refresh tokens (can be revoked anytime at myaccount.google.com). Vagaro uses a feed URL (no login). Brevo uses an API key.
- **No client-facing actions from the bot.** The bot emails you; you tap send on each Venmo request. Venmo's own servers send the requests.
- **Read-only Gmail scope.** The bot cannot send or delete email from your account.
- **Every weekly run writes a log.** Disputes are traceable via `git log -- billing/logs/`.

## Limits

- **Vagaro plan must expose iCal.** If yours doesn't, fall back to `prompts/`.
- **Venmo email format can change.** If Venmo restructures their receipts, the regex in `bot/billing.mjs` needs an update. Low frequency (maybe 1-2x/year).
- **DST drift.** GitHub cron runs at 17:00 UTC year-round = 10 AM PDT (summer) / 9 AM PST (winter). The 1-hour winter shift is cosmetic.
- **Venmo deep-link behavior varies by device.** Pre-filled amount usually works on the Venmo app (iOS/Android) and on venmo.com if logged in. On rare edge cases you may need to type the amount manually — the email includes it as text too.
- **Volume.** Brevo's free tier is 300 emails/day (more than enough — this sends you 1/week). Gmail API quotas are effectively unlimited for this use case.
