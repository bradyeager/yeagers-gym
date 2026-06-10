---
description: File schedule changes, cancellations, and date-range skips from plain-English input.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /move

Handles all schedule mutations: permanent slot changes, temporary skips, date-range cancellations. Brad types plain English after `/move` (or just runs `/move` and then describes in the next message).

Don't narrate. Just ask for the description if none was given, then execute and report what was done in ≤5 lines.

---

## Inputs to load first (always, before acting)

```
cat billing/schedule.csv
ls billing/cancellations/
```

Also read `billing/clients.csv` for exact `vagaro_name` values — those are the canonical identifiers.

---

## Classify each statement into one of three operation types

### A. Permanent slot change
"Annie moved from Tue 8am to Wed 10am"
"Kerry is now Mon 2pm instead of Mon 3pm"

**Action:**
1. Find the old row(s) in `billing/schedule.csv` — locate by day+time+client. If they're still there, remove them (edit in place).
2. If the new slot row doesn't already exist, add it using the same format.
3. **Also create a cancellation file** for any occurrence of the OLD slot that falls within the next 14 days (so the bot doesn't bill the old slot on the next run). Use the pattern below.
4. Commit with a message like: `schedule: Kerry Kreczmer Mon 2pm (was 3pm)`

### B. Temporary skip (1–3 specific dates)
"Jacob missed Monday"
"Stacy cancelled Thursday 6/12"
"Annie and David skipped Wed 6/10"

**Action:**
Create one `billing/cancellations/YYYY-MM-DD-clientslug.md` file per client per date. File content: `YYYY-MM-DD | Exact Vagaro Name | reason`

If the user gives a date like "this Monday" or "last Thursday", resolve it from today's date (2026-06-10).

Commit: `cancel: Jacob Bain 2026-06-08`

### C. Date-range absence
"Dina is out until August 1"
"Lisa away for the next 3 weeks starting 6/15"

**Action:**
1. Find ALL occurrences of this client in `billing/schedule.csv` to know which days of the week they train.
2. Generate one cancellation file covering every session date in the range. Each line: `YYYY-MM-DD | Exact Vagaro Name | out through YYYY-MM-DD`
3. Name the file: `billing/cancellations/YYYY-MM-DD-YYYY-MM-DD-clientslug.md` (start-end in filename).
4. Commit: `cancel: Dina Bates 2026-06-15 through 2026-07-31`

---

## Exact Vagaro Name lookup rule

Always use `vagaro_name` from `billing/clients.csv`, not a nickname. If the input says "Dena", "Deana", or "Dina" → look up and use `Dina Bates`. Case matters — match exactly.

---

## Cancellation file format

```
YYYY-MM-DD | Exact Vagaro Name | reason (free text)
```

For date ranges, one line per session date in the range:

```
2026-06-15 | Dina Bates | out through 2026-08-01
2026-06-22 | Dina Bates | out through 2026-08-01
2026-06-29 | Dina Bates | out through 2026-08-01
...
```

---

## Report format (≤5 lines after committing)

```
Done. Committed N file(s):
- cancellations/2026-06-15-dina-bates.md  (14 dates: Mon 6/15 → Mon 7/27)
- schedule.csv  (removed Tue 8am Annie row — was already updated last session)
Next run will skip those slots.
```

If a vagaro_name doesn't exist in clients.csv, stop and ask Brad for the exact name before writing files.
