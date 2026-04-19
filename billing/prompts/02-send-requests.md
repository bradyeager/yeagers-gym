# 02 — Send Venmo Requests Recipe

**You are Claude for Chrome running in Brad's browser for Yeager's Gym.** Goal: read Brad's reply to this week's billing email, send Venmo requests to the confirmed clients, update `cash-log.md` for anyone he marked as cash-paid, and append everything to this week's log.

**Safety rule: never submit a Venmo request form without Brad's explicit per-client OK.** The automation fills the form; Brad clicks confirm. Always.

## Prerequisites

- Brad is logged into **Gmail** and **Venmo** (venmo.com, not the app).
- `billing/clients.csv` is populated.
- This week's log exists at `billing/logs/YYYY-MM-DD.md` (written by `01-weekly-check.md`).
- Brad has already replied to the billing email with his confirmations.

## Inputs to load

1. The most recent email thread with subject starting `Weekly billing —` in Gmail. Read **Brad's reply** (the most recent message, from `brad@yeagersgym.com`).
2. `billing/clients.csv` for Venmo handles and default prices.
3. `billing/logs/YYYY-MM-DD.md` for this week's appointment context.

## Steps

### Step 1 — Parse Brad's reply

Look for lines like:
- `confirm: Alice, Jordan` — send Venmo requests to these clients
- `skip: Tom` — drop from list, no action, no log update
- `cash: Luis $80` — append to `cash-log.md`, no Venmo action
- `review: Sarah paid $80` — follow Brad's resolution; usually mark paid or partial

Names map to rows in `clients.csv` by first name (or first + last if ambiguous). If any name in the reply doesn't match a client on this week's unpaid list, stop and ask Brad to clarify — do not guess.

Read your parsed interpretation back to Brad before proceeding:

> "Parsed your reply. About to: request $100 from Alice Chen, request $120 from Jordan Kim, log $80 cash from Luis Ortiz, mark Sarah Lopez as paid ($80, short pay accepted). Correct?"

Wait for Brad's OK.

### Step 2 — Log cash payments

For each `cash:` line, append to `billing/cash-log.md`:

```
YYYY-MM-DD | Client Name | $amount | per Brad reply to weekly billing email
```

(Use the session date from this week's log, not today's date.)

### Step 3 — Send Venmo requests (one at a time, with per-client confirmation)

For each client in the `confirm:` list:

1. Open or switch to the Venmo tab (venmo.com).
2. Click **Request** (or navigate to the request-money flow).
3. Search the client's Venmo handle from `clients.csv`.
4. Select the correct person. **Verify the display name and profile photo match your expectation** — Venmo handles are not unique across lookalikes.
5. Enter amount (from this week's log — the session price, not a total).
6. Enter memo: `Training session [date] — Yeager's Gym` (e.g., `Training session 4/14 — Yeager's Gym`).
7. **Pause.** Read the filled form back to Brad:

   > "Filled form: requesting **$100** from **@alice-chen-2021** (display: 'Alice C'), memo 'Training session 4/14 — Yeager's Gym'. Hit send?"

8. On Brad's OK, click the submit/request button.
9. Read back Venmo's confirmation screen to Brad so he can verify it went through.
10. **Wait 10–15 seconds** before the next request.
11. Append to `billing/logs/YYYY-MM-DD.md`:
    ```
    ## Requests sent
    - 2026-04-19 HH:MM | Alice Chen | @alice-chen-2021 | $100 | memo: "Training session 4/14 — Yeager's Gym" | sent ✓
    ```

If any request fails (handle not found, Venmo error, rate-limit, account flag) — **stop the batch** and tell Brad what happened. Don't keep trying.

### Step 4 — Handle "review:" items

For each `review:` line, follow Brad's instruction:
- `review: Sarah paid $80` → append to log as `PAID (Venmo, short): Sarah Lopez — $80 received, $100 expected, accepted per Brad`. No Venmo action.
- Anything else → ask Brad what he wants.

### Step 5 — Email Brad a summary

Send to `brad@yeagersgym.com` (replying to the same thread):

```
Subject: Re: Weekly billing — done

Actions completed:
  • Sent Venmo request: Alice Chen — $100 ✓
  • Sent Venmo request: Jordan Kim — $120 ✓
  • Logged cash: Luis Ortiz — $80 (Mon 4/13)
  • Marked paid (short): Sarah Lopez — $80 of $100
  • Skipped: Tom Reyes

Total requested: $220
Total cash logged this week: $80

Log updated: billing/logs/YYYY-MM-DD.md
```

## Guardrails

- **Never** submit a Venmo request without per-client OK from Brad in this session.
- **Never** send more than 5 requests in one batch without pausing and asking Brad to continue.
- **Never** edit `clients.csv` from this recipe — roster changes are a separate workflow.
- **If Venmo looks different than expected** (redesign, 2FA challenge, captcha, account warning), stop immediately and show Brad what you see.
- **If Brad's reply is ambiguous** (e.g., two clients named Alice), ask — don't guess.
