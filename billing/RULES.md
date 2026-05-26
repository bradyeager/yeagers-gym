# Yeager's Gym — Billing Rules

The authoritative reference for client-specific pricing, payment methods, and special cases. When the bot's behavior surprises you, check here first.

This file is read by humans (you + future Claude sessions). The bot reads `clients.csv` and `schedule.csv` — keep those in sync with whatever's in this doc.

---

## Standard pricing

| Session type | Price |
|---|---|
| 1:1 Personal Training (60 min) | $70 |
| 1:1 Personal Training (90 min) | $100 |
| 2:1 Semi-Private (60 min) | $50/attendee |
| 3:1 Semi-Private (60 min) | $45/attendee |
| Protein smoothie add-on | +$5 (auto-accepted by bot) |

Exceptions and per-client overrides below.

---

## Payment methods

| Method | Bot behavior |
|---|---|
| **Venmo** (default) | Bot reads Venmo emails from `venmo@venmo.com`, matches sender to roster, marks PAID_VENMO when amount matches. |
| **Cash** | `pays_cash=true` in clients.csv. Bot generates "Log $X cash" button each session; you click weekly to record. |
| **Check** | Same as cash (`pays_cash=true`). Add `notes="Pays by check"`. |
| **Zeal → Chase Business** | Same as cash. Currently: Lisa Knievel. |
| **Zeal → Personal** | Same as cash. Currently: Stacy Tesler. |
| **Prepaid** | `prepaid=true` in clients.csv. Bot marks PAID_PREPAID, never bills, never asks. Currently: Robert Brower (paid all of 2026). |

---

## Per-client rules

### Danny + Adriana Duty (couple, Mon 4pm 2:1)
- Both train: **$100 total** (one $100 payment expected)
- Only one shows: **$70** (NEEDS_REVIEW; tap Accept)
- **Adriana** pays via Venmo (display name "Adriana Duty")
- $335 one-time payment in May 2026 = 2 sessions + peptides
- $5-over (e.g., $75) = smoothie

### Melissa Rios + Julio (couple, Mon 5pm 2:1)
- Both train: **$100**
- Melissa alone: **$70** (NEEDS_REVIEW; tap Accept)
- Melissa pays via Venmo (display name "Melissa Rios")
- Husband Julio doesn't have his own Vagaro booking

### Annie + David Deioma (couple, Wed 10am 2:1)
- Both train: **$100**
- David pays via Venmo from business account: **"Mudroom Backpacks"**
- David doesn't have his own Vagaro booking

### Katelin Lowther + Anna Cessna (Mon 9am, sometimes 3:1 with Dina)
- 2:1 (just Katelin + Anna): **$50 each**
- 3:1 (Dina joins): **$45 each**
- Katelin's Venmo display: **"katie lowther"** (or sometimes husband "James Lowther")
- Anna's Venmo: "Anna Cessna"
- Dina's Venmo: "Dina Bates"
- *Schedule.csv assumes 3:1 ($45). If Dina absent and they pay $50, smoothie tolerance auto-accepts.*

### Dina Bates
- Mon 9am 3:1: **$45**
- 2:1 (without 3rd): **$50**

### Danika Elenes
- **Flat $65** regardless of session length or type

### Rachel Bertholino (Wed)
- **Husband Mathieu pays for her.** Venmo from "Celestin Mathieu" (his name).
- Rachel doesn't pay; mappings handle attribution.

### Celestin Mathieu (Thu)
- Thu 11am with someone: **$50**
- Thu alone: **$70** (NEEDS_REVIEW)
- ALSO pays for wife Rachel's Wed sessions.

### Tonnie Dahl (changing schedule)
- **Tue 8am: $45** — Senior Games group (3:1 with Peggy + Robert; see below)
- **Thu 9am: $70** — regular 1:1, unchanged
- $5-over = smoothie

### San Diego Senior Games (Tue 8am, 3:1 group)
- Started 5/19/2026
- Attendees: **Peggy Happ**, **Tonnie Dahl**, **Robert Brower**
- **$45 each per session**
- Robert's seat is covered by his 2026 prepay (no payment expected from him)
- Vagaro may create ONE iCal booking for the whole group — the bot detects the "3:1" ratio in the SUMMARY and bills all 3 attendees from `schedule.csv`. If only one Vagaro booking exists, no further action needed.

### Jeanette Davey
- **Pays by check** every time
- **Tue 8am 1:1: $70**
- **Fri 8am 2:1 with Peggy: $50**

### Peggy Happ
- Mon 8am 2:1: **$50**
- Fri 8am 2:1 with Jeanette: **$50**
- Venmo display: "Peggy Barlow Happ"

### Michelle DeLorenzo
- **1 of 2 weekly sessions is FREE** through ~Aug 2026 (10-week promo from May 2026)
- Expect 1 PAID + 1 UNPAID per week → tap "Accept as paid" on the free one
- Venmo display: "Michelle DeLorenzo" (Vagaro shows as "michelle Delorenza")

### Lacey James
- Fri 7am (or 7:30 — verify) 1:1: **$70**
- Venmo display: **"Laci James"**

### Lisa Knievel
- Mon 7am 1:1 + Fri 9am 1:1: **$70 each**
- **Pays via Zeal → Chase Business checking**
- Bot expects you to log via cash-pending button

### Stacy Tesler
- **Thu morning** (time TBD): **$70**
- **Pays via Zeal → Personal checking**

### Robert Brower
- Tue 9am + Thu 10am: $70 each
- **Prepaid all of 2026** (no per-session billing expected)
- Any Venmo from him = $5 smoothie payments (lands in Unmatched, harmless)

### Jacob Bain
- Mon 6am 1:1: $70

### Kerry Kreczmer
- Mon 2pm 2:1: $50

---

## Hope Daskalos

- **NOT in roster** — old drop-in client from out of town
- Any Venmo from her lands in Unmatched payments (correct behavior)
- If she becomes a regular, add her to clients.csv + schedule.csv

---

## "INACTIVE" placeholder bookings

Several Vagaro recurring bookings are for clients who aren't currently training (Maria Alvarez, Jill Naharms, Trevor Ramsay, April Mahanal Maschka, Lisa Perez, Saidah Coston, Kate Rubalcava). They show in your iCal feed but should NOT be billed.

Marked in `schedule.csv` as `client_name=INACTIVE`. Bot skips them entirely.

When one of these returns:
1. Replace the `INACTIVE` marker in schedule.csv with their real name
2. Add them to clients.csv with default_price, payment method, etc.

---

## Bot behaviors to remember

- **Smoothie tolerance ($5)**: payment exactly $5 over the expected session price counts as PAID. No NEEDS_REVIEW.
- **Couple sessions**: bot expects the "together" price by default. Solo attendance triggers NEEDS_REVIEW; tap Accept.
- **Sender display name fuzzy match** handles nicknames ("Laci" → "Lacey", "katie" → "Katelin") and business names ("Mudroom" → "Mudroom Backpacks"). Last name must match for nicknames.
- **Multiple display names per client**: `venmo_display_name` in clients.csv accepts comma-separated values (e.g., Katelin's row has `"katie lowther,James Lowther"` since her husband sometimes pays).
- **Unmatched payments** are real, just not auto-attributable. Brad reviews weekly:
  - Drop-in clients (Hope)
  - Backpaid for sessions outside the iCal window
  - First-week sync gaps where session wasn't backfilled yet
- **Unidentified slots** = iCal events whose day+time isn't in schedule.csv AND isn't marked INACTIVE. Either add to schedule or mark INACTIVE.

---

## When pricing rules change

1. Update **this file** first (so the rule is documented).
2. Update **schedule.csv** with the new `price_override` for the affected slot(s).
3. Update **clients.csv** if the change is permanent (`default_price`) vs slot-specific (`price_override` only).
4. Commit + push. Next Friday picks up automatically.
