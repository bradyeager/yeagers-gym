# 00 — Discovery Recipe (one-time, builds the initial roster)

> **Note:** this is still the recommended way to build `billing/clients.csv` the first time. Once populated, the primary automation (`.github/workflows/weekly-billing.yml`) takes over for the weekly routine.

**You are Claude for Chrome running in Brad's browser for Yeager's Gym.** Goal: build `billing/clients.csv` by cross-referencing the last 4 weeks of Vagaro appointments with Venmo payment emails. Do not send anything to any client. This is a setup run.

## Prerequisites (ask Brad to confirm before starting)

- Brad is logged into **Vagaro Pro** (merchant dashboard, not the public booking link). Confirm the correct URL with him before navigating.
- Brad is logged into **Gmail** in another tab.
- `billing/clients.csv` currently has only header + commented example rows.

## Steps

### Step 1 — Pull Vagaro appointment history

1. In the Vagaro Pro tab, navigate to the appointment/calendar view.
2. Set date range: **last 4 weeks ending today**.
3. Filter to **completed / checked-in** appointments only (skip cancellations and no-shows).
4. Extract each appointment as: `date, client_name, service, price`.
5. Read each row back to Brad and confirm the list looks right before moving on.

If Vagaro's UI doesn't cleanly expose price, ask Brad to confirm his standard pricing (the CLAUDE.md file in this repo has starting rates: in-person $70–$170, remote $149/mo).

### Step 2 — Pull Venmo payment emails

1. Switch to the Gmail tab.
2. Search: `from:venmo@venmo.com "paid you" newer_than:30d`
3. For each matching email, extract:
   - `sender_display_name` (the name shown in the email, e.g., "Alice Chen")
   - `sender_handle` (the @username, usually in the email body)
   - `amount` in dollars
   - `date` received
   - `note` (the memo on the Venmo payment)
4. Build a list of all payments received in the last 4 weeks.

### Step 3 — Join appointments ↔ payments

For each Vagaro appointment, find the best-matching Venmo payment using:
- **Name fuzziness:** "Alice Chen" in Vagaro → "Alice C" or "Alice Chen" display name on Venmo → handle `alice-chen-2021`.
- **Amount:** exact match preferred; ±20% tolerance allowed for tips or short sessions.
- **Date proximity:** payment within 3 days before or 7 days after the appointment.

For each client who shows up in the appointment list:
- If matched cleanly to a Venmo payer → row for `clients.csv`.
- If no Venmo match in 4 weeks → likely cash client; mark `pays_cash=true` and ask Brad to confirm.
- If multiple candidates → ask Brad to pick.

### Step 4 — Confirm row-by-row with Brad

For each proposed row, read it aloud and wait for Brad's OK:

> "Row for Alice Chen: Venmo handle `alice-chen-2021`, display name 'Alice C', default price $100, pays_cash=false. Confirm or edit?"

Accept Brad's edits. Common edits:
- Different default price (package client, longer session)
- Pays cash after all
- Typo in handle

### Step 5 — Write `clients.csv`

Write the confirmed roster to `billing/clients.csv` using the existing header row. Keep the example comment lines at the top for future reference. If Claude for Chrome can't write local files, have Brad open the file in his editor and paste the rows in — present the CSV content in a single clean block.

### Step 6 — Summarize

Email Brad (to `brad@yeagersgym.com` via Gmail) a summary:

```
Subject: Yeager's Gym — Client roster built (N clients)

Roster summary:
  • N total clients
  • X Venmo payers
  • Y cash-only clients
  • Z clients with ambiguous matches (listed below for you to eyeball)

Next step: on Sunday night, run prompts/01-weekly-check.md.
```

## Guardrails

- **Do not** send anything to clients. This recipe only emails Brad.
- **Do not** make up prices or handles. If unsure, ask.
- **Do not** rely on memos — they're inconsistent per Brad. Lean on sender name + amount + date.
- **Pause** after each major step and confirm with Brad before moving on.
