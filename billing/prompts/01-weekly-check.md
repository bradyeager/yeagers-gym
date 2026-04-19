# 01 — Weekly Reconciliation Recipe (Friday 10 AM, ~5 min)

**You are Claude for Chrome running in Brad's browser for Yeager's Gym.** Goal: identify clients who trained this week but haven't paid via Venmo, then email Brad the unpaid list. **Do not send anything to any client in this recipe.** Requests are sent only in `02-send-requests.md` after Brad replies.

## Prerequisites

- Brad is logged into **Vagaro Pro** and **Gmail**.
- `billing/clients.csv` exists and is populated (run `00-discovery.md` first if not).
- `billing/cash-log.md` exists.

## Inputs to load

1. **`billing/clients.csv`** — the roster. Read the full file. Ignore lines starting with `#`.
2. **`billing/cash-log.md`** — cash payments already recorded. Read the full file.

If Claude for Chrome can't access local files, ask Brad to paste both contents.

## Steps

### Step 1 — Gather this week's appointments from Vagaro

1. In Vagaro Pro, navigate to the appointment view.
2. Set date range: **previous Friday through this Friday morning** (i.e., last 7 days ending today; sessions scheduled for Friday afternoon/evening after the run will roll into next week's check).
3. Filter to **completed / checked-in** only — skip cancellations and no-shows.
4. Extract each appointment: `date, client_name, service, price`.
5. For each appointment, look up the client in `clients.csv` by `vagaro_name`. If no match, flag as **UNKNOWN CLIENT** and surface to Brad in the email — do not assume.

### Step 2 — Gather this week's Venmo payments from Gmail

1. In Gmail, search: `from:venmo@venmo.com "paid you" newer_than:8d`
2. For each matching email, extract: `sender_display_name, sender_handle, amount, date, note`.

### Step 3 — Match payments to appointments

For each appointment from Step 1:

- **If the client is flagged `pays_cash=true` in the roster** AND `cash-log.md` has a `YYYY-MM-DD | Client Name | $amount` line matching this week's session → mark as **PAID (cash)**.
- **If `pays_cash=true` but no cash-log entry yet for this session** → mark as **CASH PENDING** (Brad will confirm in his reply).
- **Otherwise**, find a Venmo payment where:
  - `sender_handle` matches the client's `venmo_handle`, OR
  - `sender_display_name` fuzzy-matches `venmo_display_name` (same first name + last initial is sufficient).
  - AND `amount` is within ±20% of `default_price` (or exact multiples of it, in case of package pre-pay).
  - AND `date` is within 3 days before to 7 days after the appointment.
- If exactly one Venmo payment matches → **PAID (Venmo)**.
- If no Venmo match and client is not cash → **UNPAID**.
- If match is ambiguous (wrong amount, two candidates, similar names) → **NEEDS REVIEW**.

Venmo payments that don't match any appointment this week → note at the bottom of the report ("Received but unmatched"). Could be a deposit, a friend paying Brad back, or a package pre-pay.

### Step 4 — Write the weekly log

Create `billing/logs/YYYY-MM-DD.md` (use today's date) with this structure:

```markdown
# Weekly billing log — YYYY-MM-DD

## Appointments (N)
- 2026-04-14 Tue | Alice Chen | PT 60min | $100 | PAID (Venmo: alice-chen-2021, $100, 2026-04-14)
- 2026-04-15 Wed | Sarah Lopez | PT 60min | $100 | NEEDS REVIEW: received $80, expected $100
- 2026-04-16 Thu | Jordan Kim | PT 90min | $120 | UNPAID
- ...

## Venmo payments received this week (N, total $X)
- 2026-04-14 | Alice C (@alice-chen-2021) | $100 | "Training"
- ...

## Unmatched Venmo payments
- 2026-04-17 | Unknown Friend | $50 | "dinner" — likely personal, not client

## Summary
- Total sessions: 13
- Paid (Venmo): 9 ($890)
- Paid (cash): 1 ($80)
- Cash pending: 0
- Unpaid: 2 ($190)
- Needs review: 1 ($100 session, $80 received)
```

If Claude for Chrome can't write local files, include the log content in the email to Brad so he can save it manually.

### Step 5 — Email Brad

Send from Gmail to `brad@yeagersgym.com`:

```
Subject: Weekly billing — N unpaid, M needs review (week of MMM DD)

UNPAID (ready to request):
  • Alice Chen — Tue 4/14 — $100 — no Venmo payment found
  • Jordan Kim — Thu 4/16 — $120 — no Venmo payment found
  • Tom Reyes — Sat 4/18 — $70 — no Venmo payment found

NEEDS REVIEW:
  • Sarah Lopez — Wed 4/15 — session $100, received $80 from @sarah-l-9.
    Short pay, tip shortage, or wrong amount?

PAID (confirmed — no action needed):
  • Mike Chen, Dana Wells, Chris Park, ... (9 clients)

CASH PENDING (expected cash, confirm in reply):
  • Luis Ortiz — Mon 4/13 — $80

UNMATCHED VENMO RECEIVED (FYI):
  • $50 from Unknown Friend on 4/17 "dinner"

---
Reply with one line per action:
  confirm: Alice, Jordan     → send Venmo requests to these
  skip: Tom                  → drop from list (no action)
  cash: Luis $80             → log as cash-paid
  review: Sarah paid $80     → treat as paid / partial / etc.

Log: billing/logs/YYYY-MM-DD.md
```

## Guardrails

- **Do not** send any Venmo requests in this recipe.
- **Do not** email any client. Only Brad gets an email.
- **If any step fails** (Vagaro UI mismatch, Gmail search returns zero, etc.), stop and tell Brad exactly what you saw and what you expected. Do not proceed with partial data.
- **Pause and confirm** with Brad before sending the final email — give him a chance to read the summary and veto.
