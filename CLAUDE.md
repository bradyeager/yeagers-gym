# CLAUDE.md — Yeager's Gym Website

## Project
Static website for Yeager's Gym — a data-driven strength coaching brand in San Diego specializing in velocity-based training (VBT). Serves competitive powerlifters, CrossFit/Hyrox athletes, and longevity-focused clients.

Brand tagline: "Coached by Data. Built on Strength."
Contact: brad@yeagersgym.com

## Tech Stack
- Static HTML/CSS/JS — no frameworks, no build tools, no bundlers
- `base.css` + `style.css` for all styles
- Vanilla JS inline in each HTML file
- Local dev server: `npx serve . -l 3003 --no-clipboard` (no --single flag)
- Deployed via GitHub Pages: https://bradyeager.github.io/yeagers-gym/
- yeagersgym.com is NOT live yet — GitHub Pages URL is the live site

## File Structure
- `index.html` — SPA homepage with hash-routed pages (home, about, services, remote, vbt, results, contact)
- Standalone pages: `in-person.html`, `remote.html`, `nutrition.html`, `peptide-consulting.html`, `recovery.html`, `velocity-trackers.html`, `quiz.html`
- Tool pages: `tools-vbt.html`, `tools-crossfit.html`, `tools-macro.html`, `tools-peptide.html`, `tools-1rm.html`, `tools-warmup.html`, `tools-lv-profile.html`, `tools-rpe.html`, `tools-rpe-velocity.html`
- Assets in `assets/` — images, logos, PDFs

## Critical Rules

### 1. Section Label Centering
Every `<p class="section-label">` MUST render centered. The CSS uses `display: block; width: 100%; text-align: center !important;` on `.section-label`. IMPORTANT: `base.css` sets `max-width: 72ch` on `p, li, figcaption` — this breaks centering. Always add `max-width: none` when overriding. Do NOT put section-labels inside flex containers without ensuring the label spans full width. If you add a new section-label, visually verify it renders centered.

### 2. Nav CTA Is Always Teal
The nav bar button is `class="btn btn-nav-cta"` on every page. NEVER use `btn-pink` or `btn-primary` for the nav CTA. Text: "Book Your FREE Session!"

### 3. CTAs Are Standalone Sections
Bottom-of-page CTAs are full-width `<section>` elements — NOT inside bordered boxes. Pattern:
```html
<section style="padding: var(--space-8) 0 var(--space-6); text-align: center;">
  <div class="container">
    <p class="section-label" style="color: var(--color-pink); text-align: center;">Get Started</p>
    <h2>Headline here</h2>
    <p>Subtext here</p>
    <a href="https://www.vagaro.com/tmoxgj" class="btn btn-primary">Button Text</a>
  </div>
</section>
```

### 4. Navigation Consistency
All standalone pages must use identical nav structure. Desktop nav has Services and Tools dropdowns. Mobile nav includes color-coded links (Peptide Consulting = teal, Peptide Calculator = purple, Quiz = pink). Copy nav from any existing standalone page when creating new ones.

### 5. Visual Verification
Before declaring any visual change complete, render the page and check it. Font sizes, colors, centering, and spacing issues are the most common failures on this project.

## Design Tokens
```
--color-teal: #1EC8B0        (brand, data, trust, nav CTA)
--color-pink: #F0448A        (pop, urgency, action CTAs)
--color-purple: #9B6FD4      (tertiary accent)
--font-display: JetBrains Mono  (headings, labels, nav, buttons)
--font-body: Inter              (body copy, hero headlines)
```

### Color Usage
- Pink for "Get Started" labels and primary action CTAs
- Teal for data-related accents, section labels, nav CTA button
- Purple for tertiary accents (peptide content, quiz links)
- Hero headlines use colored spans: `<span style="color: var(--color-teal);">word</span>`
- Glow-line dividers (`<hr class="glow-line">`) between major sections
- Dark theme only — no light mode, no light backgrounds

## Booking & Contact
- All booking links: https://www.vagaro.com/tmoxgj
- Email: brad@yeagersgym.com
- Address: 3090 Monarch St., San Diego, CA 92123
- Instagram: @YeagersGym
- No phone number on the site

## Pricing
- In-person: $70–$170 (varies by group size and duration)
- Remote coaching: $60/month
- Nutrition: $199 (90-min consultation + 3-month follow-up)
- Peptide initial: $199/60 min
- Peptide follow-up: $99/45 min

## CTA Button Text
- Gym/coaching pages: "Book Your FREE Session!" or "Book a Free Session"
- Peptide pages: "Book a Consultation"
- Nutrition pages: "Book a Consultation!"
- Always include "!" at the end

## Do NOT Do
- NEVER add Perplexity attribution tags, data attributes, or HTML comments crediting any AI tool. These are an E-E-A-T risk. Strip them if found.
- Do not use generic gym copy ("transform your body", "unlock your potential"). The brand voice is technical, direct, and data-driven.
- Do not introduce CSS frameworks (Bootstrap, Tailwind) — this is a hand-built site.
- Do not create multi-file structures for tools that should be single-file HTML.
- Do not guess at testimonial attribution — ask if unsure.
- Do not add light backgrounds or break the dark aesthetic.

## Do Not Change Without Asking
1. Color scheme (teal/pink/purple on dark)
2. JetBrains Mono for display type
3. Dark theme — no light mode
4. Hero image choice
5. Section label centering approach (display: block + width: 100%)

## Code Rules
- IMPORTANT: I am not a developer. Explain technical steps clearly when needed.
- Prefer simple, working solutions over clever abstractions.
- For standalone tools (leaderboards, gym TV displays): single-file HTML with inline CSS and JS.
- Use `addEventListener` instead of inline `onclick` when JS involves dynamic content or complex quoting.
- For Python scripts: avoid f-strings with nested quotes (known bug source — use string concatenation).
- Always test changes before declaring done.

## Git
- Repo: `bradyeager/yeagers-gym`
- Branch: `main` — always push to main
- Commit messages should describe what changed, not how

## Communication
- Be direct, no fluff. Execution > explanation.
- If something is broken, say so and fix it.
- Outputs should be clean and machine-readable for downstream use in multi-LLM workflows.
- When in doubt, ask — don't assume.
