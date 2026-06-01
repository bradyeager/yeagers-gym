# Yeager's Gym Billing Email — Design Handoff

> Hand this entire document to a fresh Claude session ("Claude Design"). They have everything they need to iterate.

---

## 1. Mission

Make the weekly billing email more aesthetically refined while keeping every piece of information, every section, every behavior, and every brand rule intact. This is a **visual polish pass** — typography, spacing, rhythm, hierarchy, treatment — not a content or feature change.

Think: refined performance-lab dashboard, not redesigned product.

---

## 2. Context: what this email is

The Yeager's Gym billing bot runs every Friday at 10 AM PT. It reads:
- **Vagaro iCal** → who trained that week (sessions, day, time, service type)
- **Gmail** → who paid via Venmo (sender, amount, memo, date)
- **`billing/cash-log.md`** → cash/Zelle/check payments Brad has logged

It reconciles them and emails the result to Brad. Every Friday, ~30 sessions, ~$1,500/week Venmo + cash flows through it.

The email is Brad's billing command center for the week:
1. See who paid
2. Tap to chase who didn't
3. Verify external (Zelle/check) payments via deep-links to his bank apps
4. Copy a pre-filled prompt into Claude for Chrome to mark sessions paid in Vagaro

---

## 3. Audience

**One person — Brad Yeager**, owner of Yeager's Gym (San Diego strength + velocity-based training coaching).
- Reads it on **iPhone first**, **Outlook desktop second**.
- Needs to scan in **60 seconds**: who paid, who didn't, what to do next.
- Will tap buttons directly: Venmo requests, bank-app verifies, GitHub cash-log commits.
- Technical enough to understand a JSON log but not a developer — the email is the UI.

Brand voice is "Data + Fire": confident, numerical, direct. The email reports facts; it doesn't try to flatter.

---

## 4. Current State

- **Template code:** `billing/bot/email-v2.mjs`
- **Rendered preview:** `billing/preview/weekly-v2.html`
- **Live preview URL:** https://htmlpreview.github.io/?https://github.com/bradyeager/yeagers-gym/blob/main/billing/preview/weekly-v2.html
- **Real run output (June 1):** https://github.com/bradyeager/yeagers-gym/blob/main/billing/logs/2026-06-01.md

The current v2 template ships these sections:
1. Header (wordmark + week-ending date + status pill)
2. Weekly Readout (six metric tiles, 3+3)
3. System Status card (state + reason + next move)
4. Manual Action Queue (priority-numbered cards)
5. This Week — Session Ledger (grouped by day, ✅❌⏳❓ icons)
6. Unmatched / Unidentified (conditional)
7. Vagaro Checkout Instructions (verbatim copy-paste block)
8. Footer (window, log path, contact)

Brad has approved this structure. **Keep the sections; refine their presentation.**

---

## 5. Brand source of truth

The canonical YG brand reference lives at `YG-Brand-Style-Reference.md` in Brad's design archive. Key extracts below — use these exact hex values, not approximations.

### Canonical brand colors
| Role | Hex | Use |
|---|---|---|
| Teal | `#48C4CC` | Headers, data accents, trust, structure — **dominant** |
| Hot pink | `#EF3295` | CTAs, urgency, action — **sparingly** |
| Purple | `#9B6FD4` | Tertiary accents — peptide content elsewhere on the brand, used here for unidentified |

### Semantic colors (added for billing context)
| Role | Hex |
|---|---|
| Green (paid/confirmed) | `#22C55E` |
| Yellow (review/pending) | `#FACC15` |
| Red (unpaid/failure) | `#EF4444` |

### Surfaces + text
| Role | Hex |
|---|---|
| Background | `#0A0E17` |
| Card surface | `#111827` |
| Panel | `#151B2A` |
| Border | `#1E293B` |
| White | `#FFFFFF` |
| Body text | `#E5E7EB` |
| Muted text | `#9CA3AF` |
| Disabled text | `#64748B` |

### Color discipline (Brad's rules)
- **Teal dominates.** Most non-status structure uses teal.
- **Pink = action required, period.** Don't use pink as decoration.
- **Green/yellow/red are semantic.** Don't decorate with them.
- **Limit red.** Brad rejected a 4px red top-bar in the header — felt like a fire alarm. Use red sparingly: status pill when ACTION REQUIRED, the ❌ icon, the unpaid tile value, the unpaid amount tag.
- **Max two brand colors per logical view + neutrals + status.** The neon gradient (teal → purple → pink) is allowed as one decorative flourish in the header bar (already removed in latest — currently teal-only).

### Fonts (email-safe — no external imports)
- **Body:** `Inter, Arial, Helvetica, sans-serif`
- **Mono (numbers, dates, money, times, the Vagaro block only):** `ui-monospace, Menlo, "SF Mono", Consolas, monospace`

---

## 6. Hard constraints — cannot change

### Email rendering
- **Outlook desktop must render correctly.** This means:
  - **Tables, not flexbox.** No `display:flex`, no CSS Grid.
  - Use `<table role="presentation">` with `width="N"` and `bgcolor` attributes.
  - **Inline CSS only.** No external stylesheets, no `<style>` blocks for layout (Outlook strips them).
  - **No `@font-face` / no external font imports.**
  - **No JavaScript.**
  - **Max width 720px**, centered.
  - Prefer `width="N"` and `bgcolor="#xxx"` HTML attributes over `style=` for table cells — Outlook respects them more reliably.
- Must look good in **dark mode iOS Mail / Gmail iOS app** (the primary view).
- Use HTML entities for icons (✅ `&#9989;`, ❌ `&#10060;`, ⏳ `&#9203;`, ❓ `&#10067;`) — they're robust across clients.

### Information that cannot be removed
- **Vagaro Checkout block must be preserved verbatim** in a `<pre>` with `white-space:pre-wrap`. Do NOT rewrite, reformat, summarize, or "correct" anything in it. It's a copy-paste prompt fed to Claude for Chrome. Keep it small (~9px is fine — it's reference, not reading material) but legible if zoomed.
- All eight sections above must remain.
- Every client with a session that week must appear in the session ledger. Don't collapse to totals.
- Action items (unpaid/review/cash-pending/unidentified) must each have actionable controls — don't merge them into a paragraph.

### Decisions already locked
- ❌ No "Bot confidence" field anywhere (the bot doesn't compute one; spec said do not invent).
- ❌ No "Expected Final State" card (speculative — bot can't predict tap outcomes).
- ❌ No `#38BDF8` blue (not in brand palette — use teal for external-payment verify).

---

## 7. What's open for design

- Typography — sizes, weights, letter-spacing, line-heights, rhythm
- Card spacing, padding, border-radius
- Hierarchy via size/weight/spacing rather than color
- Tile geometry (currently 3+3 — could be different if better)
- Action card layout (currently two-column with expected/received on right)
- Section dividers and breathing room
- Numerical typography (mono is required; alignment, sizes, weights are open)
- Subtle texture / accents that work in email (gradients on table-row bgcolors, etc.)
- Status pill treatment, position, language
- Header treatment (currently teal accent bar + bold wordmark + small subtitle + week date + status pill)
- Visual treatment of priority numbers, status badges
- Information density (denser or roomier — your call)

If you want to propose a structural change (merging sections, adding a new one), **surface it as a question** — don't ship it without Brad's confirmation.

---

## 8. Section-by-section reference

### 1. Header / Transmission Bar
Currently: teal `#48C4CC` accent bar (4px) at top, **YEAGER'S GYM** large bold white, "WEEKLY BILLING LAB" small teal subtitle, "Week ending Mon, 6/1" in mono muted. Status pill (green ALL CLEAR / yellow REVIEW / red ACTION REQUIRED) top-right.

### 2. Weekly Readout — metric tiles
Six tiles in two rows. Each has a colored top border (3px) matching its semantic color:
- Row 1: Paid Sessions (green) · Unpaid (red if >0) · Needs Review (yellow if >0)
- Row 2: Venmo Collected This Week ($X teal) · Outstanding — Not Yet Paid ($X pink if >0) · Unidentified (purple if >0)

Values in mono, labels in body. Tile bg: `#111827`. Border: `#1E293B`.

### 3. System Status card
One card with left border accent matching status color. "ACTION REQUIRED" / "REVIEW" / "ALL CLEAR" headline in white. Then "Reason:" line and "Next move:" line.

### 4. Manual Action Queue
Priority-numbered cards. Sort order: P1 (unpaid, red) → P2 (mismatch, yellow) → P3 (external verify, teal) → P4 (unidentified, purple) → P5 (unknown, purple).

Each card structure:
- Left column: priority + type label (e.g., "PRIORITY 1 · UNPAID"), client name (bold), datetime (mono muted)
- Right column: Expected $X, Received $Y, Δ ±$Z, payment method
- Divider
- "Issue:" line, "Required fix:" line (fix label in pink)
- Action buttons row: pink Request button + optional teal outline Confirm/Verify button

### 5. This Week — Session Ledger
Grouped by day. Each row:
- Status icon (colored) — 22px wide cell
- Time (mono muted) — 72px wide cell
- Name (body) + optional inline tag (muted, or status-colored only when conveying amount info like "$120 unpaid")

Day header bold white above each group.

### 6. Unmatched / Unidentified (conditional)
Small cards for each unidentified slot. List of unmatched Venmo payments (mono small).

### 7. Vagaro Checkout Instructions — **VERBATIM**
Section label "VAGARO CHECKOUT INSTRUCTIONS". One-line intro: "Use this block exactly when checking out sessions in Vagaro." Then a panel with `<pre style="white-space:pre-wrap; font-family:monospace; line-height:1.45; font-size:~9px">` containing the prompt text **exactly as the bot generated it**.

### 8. Footer
Window dates, log path, "Yeager's Gym Billing Bot · brad@yeagersgym.com · San Diego, CA". Small, muted, mono.

---

## 9. Data shape

```js
buildEmailV2({
  results: Array<{
    status: "PAID_VENMO" | "PAID_CASH" | "PAID_PREPAID" |
            "CASH_PENDING" | "UNPAID" | "NEEDS_REVIEW" |
            "UNKNOWN" | "UNIDENTIFIED_SLOT",
    appt: { date: Date, summary: string, client_name?: string },
    roster?: {
      vagaro_name: string,
      venmo_handle?: string,
      default_price: number,
      acceptable_prices?: number[],
      notes?: string,        // contains payment-method hints like "Zelle → Chase"
      prepaid?: boolean,
    },
    payment?: {
      sender_display_name: string,
      amount: number,
      note?: string,
      date: Date,
      noteDate?: Date,
    },
    expectedPrice?: number,
    checkoutAmount?: number,  // amount to enter at Vagaro checkout
    inferred?: boolean,       // auto-paired reschedule
  }>,
  unmatchedPayments: Array<{
    sender_display_name: string,
    amount: number,
    note?: string,
    date: Date,
  }>,
  now: Date,
  windowStart: Date,
  checkoutPrompt: string,  // VERBATIM render in a <pre>
})
→ { subject: string, html: string, preheader: string }
```

---

## 10. Workflow: how to iterate

```
1. Edit billing/bot/email-v2.mjs
2. cd billing/bot && node preview.mjs
   → regenerates billing/preview/weekly-v2.html with synthetic test data
3. Open billing/preview/weekly-v2.html locally (or push and view via htmlpreview)
4. To see it against real data, push the change, then trigger:
   GitHub Actions → "Weekly billing reconciliation" → Run workflow →
   Email template: command-center
   Email lands at brad@bradyeager.com in ~90 seconds.
```

The preview data file (`billing/bot/preview.mjs`) covers every state: paid Venmo, paid cash, cash pending, unpaid, needs review, unknown client, unmatched Venmo. It's a good test bed.

---

## 11. Realistic data density

A typical week:
- ~30-35 sessions
- 24-28 paid Venmo
- 3-5 paid cash/Zelle
- 1-3 prepaid (Robert Brower's 2026 package — always)
- 0-2 unpaid (action)
- 0-2 needs review (mismatch)
- 0-2 cash-pending (Zelle awaiting verify)
- 0-1 unidentified slot
- Roughly $1,400-1,800 Venmo per week

So the email is **information-dense**. The session ledger is ~30 lines. The action queue is usually 2-5 cards. The Vagaro checkout block is ~150 lines of plain text. **Plan for density** — sprawling whitespace won't serve.

---

## 12. Deliverable

A revised `billing/bot/email-v2.mjs` that:
1. Produces a more aesthetically refined HTML email
2. Renders correctly in Gmail (web, iOS) and Outlook desktop
3. Honors all hard constraints in §6
4. Preserves section structure from §8
5. Keeps the Vagaro Checkout block byte-for-byte intact

Plus a short note describing the visual choices made (so Brad understands the intent).

---

## 13. Reference: existing `email-v2.mjs`

The current implementation is ~400 lines of vanilla JavaScript producing inline-CSS HTML. It uses table-based layout throughout. Read it before rewriting — many of the structural choices are forced by Outlook constraints, and you'll want to inherit them.

Path: `billing/bot/email-v2.mjs` on the `main` branch of https://github.com/bradyeager/yeagers-gym

Helper functions worth reusing:
- `categorize(results, now)` — splits results into lagging vs current-week buckets
- `buildActionQueue(cats)` — produces the priority-sorted action items
- `ledger(results)` — produces the day-grouped session ledger
- `esc(s)`, `money(n)`, `timeOf(d)`, `dayLabel(d)`, `dayKey(d)`, `fmtShort(d)` — formatters

---

## 14. Questions to surface (not assume)

If anything below isn't clear from the materials, **ask Brad before shipping**:
- Whether to add SVG icons (vs the current emoji icons)
- Whether to change the 720px container width
- Whether to merge any sections
- Whether to change section ordering
- Whether to add visualization (sparklines, bars)
- Anything that would require new data the bot doesn't currently produce

---

## End of handoff

Brad will paste this entire document plus the contents of `billing/bot/email-v2.mjs` into your context. You have everything you need to make a thoughtful, brand-true polish pass. Bring it.
