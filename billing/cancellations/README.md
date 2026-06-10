# Cancellations

Sessions Brad didn't actually train — vacation, illness, weather, last-minute
cancels — that Vagaro's iCal feed still has as recurring events. Without these
entries the bot would bill the client as `CASH_PENDING` (Zelle clients) or
`UNPAID` (Venmo clients) for a session that never happened.

## Format

One file per cancellation. Filename is `YYYY-MM-DD-clientslug.md`. Contents:

```
YYYY-MM-DD | Client Name | reason
```

Example: `2026-05-28-stacy-tesler-cpy.md`

```
2026-05-28 | Stacy Tesler CPY | vacation
```

The reason field is free-text — anything after the last `|` is treated as
human notes (e.g. `vacation`, `sick`, `gym closed`, `no-show`).

## How to add one

The fastest path is the **"Wasn't trained"** button on any unpaid or
cash-pending action card in the weekly billing email. It opens a GitHub
"create new file" form already pre-filled — just hit commit.

You can also add files manually:

```sh
echo "2026-05-28 | Stacy Tesler CPY | vacation" > 2026-05-28-stacy-tesler-cpy.md
```

## What the bot does with them

On the next reconciliation run the bot loads every `.md` in this directory,
indexes by `(date, client name)`, and any iCal slot matching a cancellation
is dropped from billing — it appears in The Tape as `cancelled` (muted) so
you can verify the skip was honored, but doesn't count in unpaid/review/
collected/outstanding totals.

## When NOT to use this

- **Client paid the cancellation fee anyway** — leave the session in, log
  it as cash via the normal Log-as-cash button. Don't cancel.
- **Client rescheduled to a different time the same week** — Vagaro creates
  a new iCal event. The original event might still be there as a placeholder.
  Cancel the original; the new one will get matched normally.
- **Recurring inactive client** — mark them `INACTIVE` in `schedule.csv`
  instead. Cancellations are for one-off skips on otherwise-active clients.
