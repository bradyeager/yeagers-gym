# YG To-Do — Source of Truth
Generated: 2026-04-27
Method: read-only audit against repo at `/home/user/yeagers-gym`

## DONE

- **#1 Brevo form ID swap on quiz.html**: `quiz.html:910` loads `./brevo.js`; `quiz.html:1127-1149` calls `submitToBrevo()` / `brevoSubmit({ listIds: [BREVO_LISTS.ALL_LEADS, BREVO_LISTS.QUIZ_COMPLETIONS] })`. No ConvertKit/Kit/FormKit/Sendinblue references remain.

- **#2 Brevo form ID swap on tools-macro.html**: `tools-macro.html:1218` loads `./brevo.js`; `tools-macro.html:1558-1565` uses `submitToBrevo()` / `brevoSubmit({ listIds: [BREVO_LISTS.ALL_LEADS, BREVO_LISTS.LEAD_MAGNETS] })`. *Stale comment-only nit:* `tools-macro.html:1547` still reads `// EMAIL GATE + KIT INTEGRATION`. Functionally Brevo; rename for hygiene if desired.

- **#4 Custom domain CNAME**: `CNAME` exists, contents = `yeagersgym.com`.

- **#5 Strip Perplexity attribution tags**: `grep -rni "perplexity" *.html` → 0 matches.

- **#9 Schema markup LocalBusiness JSON-LD on homepage**: `index.html:32` contains `<script type="application/ld+json">` with `@type: LocalBusiness`, name, full PostalAddress (3090 Monarch St., San Diego, CA 92123), email, url, priceRange `$70-$199`, sameAs Instagram.

- **#13 Website folder location**: `pwd` = `/home/user/yeagers-gym` — no `OneDrive` segment in path.

## STILL NEEDED

- **#6 Brand color migration v1 → v2**: 16 retained `#1EC8B0` / `#F0448A` literals across 9 HTML files (CLAUDE.md token-definition matches excluded). Most are inside JS string literals (chart/severity color maps) where bare `var(--…)` won't work — they need either `getComputedStyle(document.documentElement).getPropertyValue('--color-teal')` or moving the constant into a CSS variable read at runtime. The two HTML inline-style hits are easy `var()` swaps.
  - JS string literals:
    - `tools-limiter.html:2161` — `el.style.borderColor = '#F0448A'`
    - `tools-oly.html:1024` — `'Intermediate': '#1EC8B0'`
    - `tools-oly.html:1025` — `'Advanced': '#F0448A'`
    - `tools-oly.html:1512` — `el.style.borderColor = '#F0448A'`
    - `tools-strength.html:1049` — `'Intermediate': '#1EC8B0'`
    - `tools-strength.html:1050` — `'Advanced': '#F0448A'`
    - `tools-strength.html:1562` — `el.style.borderColor = '#F0448A'`
    - `tools-readiness.html:1461` — `el.style.borderColor = '#F0448A'`
    - `tools-recomp.html:2066` — `el.style.borderColor = '#F0448A'`
    - `tools-powerlifting.html:1015` — `'Intermediate': '#1EC8B0'`
    - `tools-powerlifting.html:1016` — `'Advanced': '#F0448A'`
    - `tools-powerlifting.html:1517` — `el.style.borderColor = '#F0448A'`
    - `tools-hyrox-splits.html:1376` — `gradeColor = '#1EC8B0'`
    - `tools-hyrox-splits.html:1377` — `gradeColor = '#1EC8B0'`
  - HTML inline style (trivial swap to `var(--color-teal)`):
    - `tools-macro.html:1137` — `border: 1px solid #1EC8B0` + `background: rgba(30, 200, 176, 0.06)`
    - `tools-vbt.html:1073` — same pattern as above

- **#14 CLAUDE.md @-import to Claude-HQ**: `grep -n "Claude-HQ\|@C:" CLAUDE.md` → 0 matches. The project `CLAUDE.md` (6,039 bytes) contains no import directive pointing at Claude-HQ memory.

## PARTIAL

- **#3 HYROX in nav Tools dropdown + footer**:
  - ✅ `tools.html:254-262` lists both `tools-hyrox.html` (Race Predictor) and `tools-hyrox-splits.html` (Split Analyzer) as `tool-tag--hyrox` cards.
  - ✅ Homepage testimonials and Results section (`index.html:241,323,1157,1227-1235`) reference HYROX content (Mathieu Celestin, "HYROX Data" results category).
  - ❌ **Nav dropdown:** `index.html:69-89` desktop nav has only a *Services* dropdown (in-person/remote/nutrition/peptide/recovery). "Free Tools" is a single link to `tools.html` — no Tools dropdown exists, so HYROX has no direct nav-dropdown entry. This contradicts the CLAUDE.md rule "Desktop nav has Services and Tools dropdowns."
  - ❌ **Footer:** `index.html:1469-1474` "Resources & Free Tools" column lists only `tools.html`, `velocity-trackers.html`, `quiz.html`. No direct HYROX entry.

- **#7 Testimonial attribution (full first names + sport/context + timeframe)**:
  - ✅ Full first + last name + sport/context on most: Claudia Arzillo (USAPL Powerlifter), Tonnie Dahl (SD Sr. Games Gold Medalist), Maria Alvarez (CrossFit Athlete), Robert Brower (Post-Surgical Comeback), Charlie Houck (Fat Loss / Nutrition), Abby Fleisner (IFBB Pro Bodybuilder), Mariah Yeager (Peptide-Assisted Body Composition), Mathieu Celestin (Hyrox Pro).
  - ❌ "Kerry" (`index.html:1326`, `index.html:1324` alt) — first name only, no last name, no headshot caption beyond "Kerry".
  - ❌ **No explicit timeframe byline field** (e.g., "Q1 2025", "8-week prep", "12 months") on any testimonial. Some quotes embed time references in the body ("60 pounds in 8 months", "Six months after back surgery", "three years straight"), but there's no structured `timeframe` element.

- **#8 SEO meta on every page**: Of 28 HTML files audited, 25 have all three (`<title>`, `meta name="description"`, `meta property="og:title"`). Three are incomplete:

| File | title | description | og:title |
|---|---|---|---|
| testimonial-selector.html | ✅ | ❌ | ❌ |
| tools-hyrox.html | ✅ | ✅ | ❌ |
| tools.html | ✅ | ✅ | ❌ |

  All other 25 files: ✅ ✅ ✅. (Note: `testimonial-selector.html` may be an internal/admin page — confirm intent before adding meta.)

- **#10 Accessibility baseline indicators**:
  - ✅ `index.html` has 71 occurrences of `aria-`/`role=`/`alt=` — solid landmark + alt-text density. Header/footer/nav are properly tagged with `role="banner"`, `role="contentinfo"`, `role="navigation"` and aria-labels.
  - ❌ **No skip-to-content link anywhere.** `grep -in "skip.to.content\|skip-link\|#main-content"` returned 0 matches across all `*.html`.

- **#12 Email capture on every page**: 15 of 28 pages have zero matches for `email|subscribe|signup|brevo`:
  - in-person.html, nutrition.html, recovery.html, testimonial-selector.html
  - tools-1rm.html, tools-crossfit.html, tools-hyrox.html, tools-hyrox-splits.html, tools-lv-profile.html, tools-rpe.html, tools-rpe-velocity.html, tools-vbt.html, tools-warmup.html
  - tools.html, velocity-trackers.html

  Pages with capture present: index.html (5), method.html (17), peptide-consulting.html (1), quiz.html (31), remote.html (1), tools-limiter.html (1), tools-macro.html (46), tools-oly.html (1), tools-peptide.html (1), tools-powerlifting.html (1), tools-readiness.html (1), tools-recomp.html (1), tools-strength.html (1).

  Note: many tool pages with a "1" match are matching `--webkit-` CSS rather than a real form — visual review of those still recommended. The 15 zero-match pages clearly lack any email capture.

## UNVERIFIABLE FROM THIS REPO

- **#11 Performance (Lighthouse)**: requires browser profiling. Run Lighthouse against `https://bradyeager.github.io/yeagers-gym/` (or local `npx serve . -l 3003`) for LCP / CLS / TBT scores.

- **#15 Claude-HQ repo exists locally**: this audit runs in a Linux sandbox (`/home/user`). Paths `C:/Users/brad/Claude-HQ/.git` and `~/Claude-HQ/.git` are not present here. Verify on Brad's local Windows machine and via `gh repo view bradyeager/claude-hq`.

- **#16 Memory files populated**: same — verify `C:/Users/brad/Claude-HQ/memory/*.md` on Brad's local machine.

- **#17 yeager-engine and command-center-os have CLAUDE.md**: separate repos — verify in those checkouts.

- **#18 MCP deploys (Drive, Sheets, Brevo)**: this sandbox's `~/.claude.json` has no `mcpServers` block and `~/.claude/mcp*` doesn't exist, but that's the sandbox runtime — not Brad's actual machine. Verify in Brad's real `~/.claude.json` (Windows: `%USERPROFILE%\.claude.json`).

- **#19 Real-athlete 2-week pilot**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#20 Model Council QA check on spec v3**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#21 Yeager Engine dashboard rebrand**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#22 First live weekly program via GPT pipeline**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#23 JSON output schema validation**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#24 Pipeline tracker cloud sync via Vercel KV**: verify in velocity-method.vercel.app project, yeager-engine repo, and live coaching ops.

- **#25 Home Assistant install**: check `homeassistant.local:8123` or hardware presence on local network.

- **#26 Mexico trip booked (June 22-26 Pueblo Bonito Pacifica)**: flag for manual confirmation — check Vagaro/calendar/Pueblo Bonito reservation email.

## SUMMARY

Of 26 items: **6 DONE, 2 STILL NEEDED, 5 PARTIAL, 13 UNVERIFIABLE.**

- **DONE (6):** #1, #2, #4, #5, #9, #13
- **STILL NEEDED (2):** #6, #14
- **PARTIAL (5):** #3, #7, #8, #10, #12
- **UNVERIFIABLE (13):** #11, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26

### Quick-win priorities (this repo only)
1. **#6 inline-HTML hex swaps** (2 files: tools-macro.html:1137, tools-vbt.html:1073) — 5-min fix.
2. **#10 add skip-link** (`<a href="#main-content" class="skip-link">Skip to content</a>` at top of `<body>`, plus `id="main-content"` on `<main>`) across all pages.
3. **#8 add `meta name="description"` + `og:title`** on testimonial-selector.html, tools-hyrox.html, tools.html.
4. **#3 add HYROX entry to footer Resources column** + decide on Tools nav dropdown structure (CLAUDE.md says it should exist; it does not).
5. **#12 email capture** on the 15 zero-match pages — at minimum on tools.html, velocity-trackers.html, in-person.html, nutrition.html, recovery.html.
6. **#6 JS-literal hex constants** — refactor to read CSS custom properties via `getComputedStyle(document.documentElement).getPropertyValue('--color-teal').trim()` once at top of script.
