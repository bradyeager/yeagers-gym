# Vagaro Weekly Checkout — Reference

This file is the **durable, hand-editable** copy of the weekly Vagaro checkout
prompt. The bot **auto-generates a complete, pre-filled version of this prompt
every Friday** at the bottom of the billing email — just copy-paste from there.

This file exists so you can:
- Read the rules without waiting for Friday's email
- Edit the rules (then paste your edit into `CHECKOUT_RULES` in `billing/bot/billing.mjs`)
- Hand it to a new Claude session without the auto-generated client list

---

## How the weekly flow works

1. **Friday ~10 AM PT:** billing email lands at brad@bradyeager.com.
2. Scroll to the bottom — **"Vagaro Checkout — copy block below into Claude
   for Chrome"** section.
3. Triple-click the gray box, ⌘A → ⌘C.
4. Open a **new** Claude for Chrome session, paste, send.
5. Claude walks the calendar from most-recent day backwards, checking off
   every paid client at the cash field. Outputs a summary when done.

The auto-generated block contains the same rules below **plus the
pre-filled "PAID CLIENTS THIS WEEK" list** built from the bot's
reconciliation. You don't fill anything in by hand.

---

## When to update these rules

- New nickname / spouse mapping → add to the NICKNAME MAP
- New session pattern (new group, new day, new rate) → add to SESSION CONTEXT
- Vagaro UI changed → update CHECKOUT STEPS
- New client → update `clients.csv` + `schedule.csv` (the rules section here
  rarely needs touching)

To apply: edit `CHECKOUT_RULES` in `billing/bot/billing.mjs` and copy the
same text into the section below.

---

## Canonical rules (mirrors `CHECKOUT_RULES` in billing.mjs)

```
WEEKLY VAGARO CHECKOUT — YEAGER'S GYM

ROLE: You are Claude in Brad's Chrome browser. Brad is logged into Vagaro.
TASK: Mark each paid client below as "checked out" in Vagaro's calendar so
they show as paid. Brad uses cash as a universal paid-marker (intentional —
the real money already came via Venmo / check / Zelle; Vagaro's payment-method
field is just a visual checkmark for him).

URL: https://us05.vagaro.com/merchants/calendar/v3

WORK ORDER: most-recent day → oldest day (the list below is already in that
order). Use the calendar's < arrow to step back one day at a time.

═══ HARD RULES ═══
1. Payment method is ALWAYS "Cash". Never ask, never use any other method.
2. The "enter $X" amount in the list is the SOURCE OF TRUTH. Vagaro's
   checkout screen often shows a DIFFERENT default total — most commonly when
   a 2:1 / couple client trained SOLO that day (Vagaro shows the $50 pair
   rate, but they owe $70 alone). When the list amount differs from Vagaro's
   shown total you MUST CHANGE VAGARO'S TOTAL FIRST, then pay:
     a. Edit the line-item/price (or Total) so the total equals the list
        amount. Do NOT change the service TYPE — only the dollar total matters.
     b. Then enter that same amount in the Cash field.
     c. Confirm Total = Cash = Amount Paid = list amount, Change Due = $0.00.
   Skipping (a) makes Vagaro record an over/under-payment and it WON'T let you
   finish. Lines needing this are flagged "⚠ ADJUST TOTAL".
3. Do NOT delete any appointments. Brad handles deletions.
4. Do NOT touch sessions that aren't on the list. If a calendar slot exists
   but isn't on the list, leave it alone — it's either unpaid (Brad will
   chase) or someone else's category.
5. If a session already shows a green check / "Checked out" status, skip
   and note it in the summary as "already done".
6. If a client's name doesn't match anything on the calendar that day, skip
   and log it as MISSING — never guess.

═══ NICKNAME / NAMING MAP ═══
Many clients' Vagaro calendar name differs from their Venmo / nickname:
• Lisa, Leesha               → Lisa Knievel
• Tawny, Tani                → Tonnie Dahl
• Carrie                     → Kerry Kreczmer
• Michelle                   → michelle Delorenza  (yes, lowercase m in Vagaro)
• Mathieu, Celestin          → Celestin Mathieu
• Laci                       → Lacey James
• Katie, Kate                → Katelin Lowther
• Adriana Duty               → "Danny Duty" on the calendar  (Adriana is his wife and pays)
• Julio                      → "Melissa Rios" on the calendar (Julio is her husband)
• David, Mudroom, Mudroom Backpacks → "Annie Deioma" on the calendar
                                       (David is her husband; pays via business Venmo)
• James Lowther              → "Katelin Lowther" on the calendar (Katelin's husband)

═══ SESSION-LEVEL CONTEXT ═══
• Tue 8 AM is a 5-PERSON TEAM session: Peggy, Tonnie, Robert, Annie, David.
  Each is $40. David shares Annie's calendar block (they're a couple).
  Mudroom pays $80 covering both Annie + David in one transaction.
• Wed 9 AM is Rachel Bertholino. Her husband Mathieu pays (Venmo shows
  "Celestin Mathieu").
• Wed 10 AM is Annie Deioma (couple 2:1 with David). Mudroom pays.
• Mon 9 AM is a 3:1 group: Dina + Anna + Katelin — each $45.
• Mon 8 AM has TWO sessions at the same time: Peggy (2:1, $50) and
  Michelle (1:1, $70). They're different calendar blocks.
• Couples (Danny+Adriana, Melissa+Julio, Annie+David): one payment covers
  the calendar block; don't look for a second.
• Robert Brower is prepaid for all of 2026. Still check him off — use
  whatever Vagaro shows as the amount, or $0 if it's blank.

═══ CHECKOUT STEPS (per appointment) ═══
1. Navigate to the target day on the calendar (use the < arrow at top).
2. Click the appointment block for the named client.
3. When the popup opens, click the green "Checkout" button at the bottom
   right of the popup. Fallback if you can't see it:
   document.querySelector('BUTTON.vg-tk-btn.vg-btn-primary').click()
4. On the checkout screen, verify the client name matches.
5. Find the Cash field, triple-click to select, type the amount from the
   list (no $ sign, no decimal — e.g., 70 not $70.00), press Tab.
6. Verify: Cash = list amount, Amount Paid = list amount, Change Due = $0.00.
7. Click the green Checkout button.
8. Click Done → Go to Calendar.

═══ FAILURE / EDGE CASES ═══
• If Vagaro's UI looks different than described (update, new screen): STOP
  and tell Brad what you see. Do not improvise.
• If two clients with the same first name appear at similar times: confirm
  with Brad before processing either.
• If a "Senior Games" / "Team" 5-person Tue 8am session shows on the
  calendar, check off each listed attendee individually (Vagaro will have
  separate blocks for each, or one block with attendees — confirm).

═══ OUTPUT WHEN DONE ═══
Summarize:
  ✅ Checked out: N / total
  ⏭ Skipped (already done): list of names
  ❌ MISSING (on list but no calendar match): list of names + dates
  ⚠ Failed / errored: list with reason
```

---

## When the bot generates it weekly, this block follows:

```
==== PAID CLIENTS THIS WEEK (work backwards) ====

Friday 5/30:
  • 6:30 AM  Lacey James — $70
  • 7:30 AM  Jeanette Davey — $50
  • 7:30 AM  Peggy Happ — $50

Thursday 5/29:
  • 6:30 AM  Stacy Tesler CPY — $70
  • 9:00 AM  Tonnie Dahl — $70
  ... etc
```

Brad doesn't type that list — it comes pre-filled from the bot's
reconciliation data each Friday.
