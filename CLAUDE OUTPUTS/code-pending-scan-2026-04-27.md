# Code Pending Scan — 2026-04-27

Inventory of loose ends across repos. Sandbox could only reach `yeagers-gym`; run `scan-repos.ps1` (in this folder) on your Windows box to extend the scan to every repo under `C:\Users\brad\` and OneDrive.

---

## yeagers-gym (`/home/user/yeagers-gym`, branch `claude/scan-repos-status-2jIaE`)

### Most actionable

- [ ] **Decide what to do with `origin/claude/automate-venmo-billing-pR6HL`** — 7 days old, 8 commits ahead of `main`, not merged. This is the autonomous billing bot (Vagaro iCal + Gmail + Brevo, weekly Friday run, monthly revenue summary, YG-styled emails). Either merge it, open a PR, or delete the branch if abandoned.
  - Top commits:
    - `cdd2e18` Clarify forwarded Venmo emails are supported in OAuth step
    - `fb5a568` Fix Step 1: Vagaro doesn't expose outbound iCal feeds
    - `1eff168` Add email preview (synthetic data) + tighten amount-match threshold
    - `fbc5fdb` YG-styled billing emails, action buttons, monthly revenue summary
    - `afabafc` Add billing/bot/lib.mjs — shared helpers for weekly + monthly bots
    - `261ebe2` Build autonomous billing bot (GitHub Actions + Vagaro iCal + Gmail + Brevo)
    - `1144d8e` Switch weekly billing run to Friday 10 AM via calendar reminder
    - `e845265` Add weekly billing automation for Vagaro/Venmo reconciliation

- [ ] **Decide what to do with `origin/claude/push-to-github-qpdQc`** — 3 weeks old, 20 commits ahead of `main`, not merged. Contains a lot of visual/branding work (testimonials, brand colors to logo, VBT page, tool nav across pages, section-label centering fixes). Some of this may have already landed via other paths — diff against `main` before merging to avoid undoing newer work. If superseded, delete.
  - Likely-important commits to spot-check:
    - `551917a` Replace placeholder testimonials with real athlete testimonials
    - `5f36d95` Add testimonial selector tool with athlete headshots
    - `1e7df76` Update brand colors to match logo: teal #48C4CC, pink #EF3295
    - `c87412a` Standardize all CTAs to final-cta format with glow-line dividers
    - `4dcc43a` / `e2c64bd` Tool nav across pages
    - `98d21f6` Add 5 VBT calculator widgets

### Clean

- [x] Working tree clean — no uncommitted changes
- [x] No untracked files
- [x] No TODO / FIXME / XXX / HACK markers in source files
- [x] No half-finished functions (no `pass` / `NotImplementedError` / `throw "not implemented"` stubs)
- [x] No files modified in last 30 days that weren't committed
- [x] Local branch `claude/scan-repos-status-2jIaE` is even with `main`
- [x] No local unmerged branches

---

## Other repos (`C:\Users\brad\`, OneDrive\Yeager Docs)

Not reachable from this sandbox. Run `scan-repos.ps1` locally — it will append a section per repo to a fresh copy of this file.
