# CLAUDE.md — Michelle's Muscle Mission Handoff

> **For Claude Code:** This is a working, deployed single-page web app. Read this entire doc before touching anything. The user (Brad Yeager) prefers surgical patches over rewrites and wants you to confirm a plan before making changes.

---

## 1. What this is

**App name:** Michelle's Muscle Mission — "The Both-At-Once Project"
**Client:** Michelle, 44F, RN, ~125 lb, 5 weeks postpartum
**Program:** 10-week glutes & core training plan (May 4, 2026 → July 13, 2026)
**Coach:** Brad Yeager (yeagersgym.com)
**Goal:** Track three layers of progress simultaneously — performance (lifts), body composition (Hume scans), and aesthetic (photos + measurements).

**Live URL:** https://yeagersgym.com/michelle/
**Demo URL (no Supabase writes):** https://yeagersgym.com/michelle/?demo=1

---

## 2. Tech stack & constraints

- **Single HTML file:** `michelle/index.html` (~2514 lines, all inline)
- **Vanilla JS** — no framework, no build step, no bundler
- **CDN libs:** Chart.js, QRCode, canvas-confetti, jsPDF
- **Supabase** REST API via `fetch()` (project ref `bxyiefzzqcgmnmjvnaax`)
- **Hosting:** GitHub Pages on `bradyeager/yeagers-gym` (default branch `main`, CNAME → yeagersgym.com)

### Hard rules from Brad
1. **Everything stays inline.** No separate JS/CSS files. No build step.
2. **`node --check` the inline script after every edit.** Use the snippet under "Deploy pattern" below.
3. **Surgical patches only.** Don't rewrite working sections.
4. **Show your plan before acting.** Brad wants Situation → Options → Recommendation → Execution.
5. **Brand colors:** teal `#48C4CC`, pink `#EF3295`, charcoal `#0F1620`. Don't drift.
6. **Never modify files in unexpected locations.** Work in `/tmp/yeagers-gym/` (the cloned repo).

---

## 3. Repo layout

```
yeagers-gym/                          # GitHub Pages root
├── CNAME                             # yeagersgym.com
├── index.html                        # Yeager's Gym landing page
├── lisa/                             # Sister app for client Lisa
│   └── index.html
└── michelle/
    ├── index.html                    # ← THIS APP (~2514 lines)
    ├── CLAUDE.md                     # ← this file
    └── assets/
        ├── michelle-photo.jpeg       # Header avatar (392×445, 52KB)
        └── yeagers-logo.jpeg         # Used only on splash deck slide 1
```

---

## 4. Deploy pattern (Brad's established workflow)

```bash
cd /tmp/yeagers-gym && git pull origin main

# ... make edits via `edit` tool to michelle/index.html ...

# Extract longest <script> block (the app) and parse-check
python3 -c "import re; html=open('michelle/index.html').read(); \
  scripts=re.findall(r'<script>(.*?)</script>', html, re.DOTALL); \
  open('/tmp/app.js','w').write(max(scripts, key=len))"
node --check /tmp/app.js   # must pass before commit

git add michelle/index.html
git commit -m "<concise message>"
git push origin main       # auth via api_credentials=["github"]

sleep 55                    # GH Pages build time
gh api repos/bradyeager/yeagers-gym/pages/builds --jq '.[0]'
```

---

## 5. Data model

### CLIENT (line ~775)
The single source of truth for program parameters.

```js
const CLIENT = {
  name: "Michelle",
  title: "Michelle's Muscle Mission",
  subtitle: "The Ass & Abs Agenda",
  goal: "Glutes & Core",
  url: "yeagersgym.com/michelle",
  startDate: "2026-05-04",
  endDate: "2026-07-13",
  weeks: 10,
  checkpointWeeks: [0, 2, 4, 6, 8, 10],   // Hume scan dropdown options
  sessionsPerWeek: 2,
  primaryLifts: ["Back Squat", "Hip Thrust", "Chin-Up", "Deadlift", "Bench Press", "Strict Press"],
  coreLifts: ["Weighted Plank", "Hollow Rock"],
  liftUnits: { "Back Squat": "weight_reps", ... },  // weight_reps | weight_seconds | reps_only
  baselines: {            // ACTUAL May 1, 2026 numbers from Michelle
    "Hip Thrust": 225, "Back Squat": 125, "Chin-Up": 110,
    "Deadlift": 125, "Bench Press": 75, "Strict Press": 65
  },
  goals: {                // Week 10 targets
    "Hip Thrust": 325, "Back Squat": 150, "Deadlift": 175,
    "Chin-Up": "bodyweight", "Bench Press": 85, "Strict Press": 85
  },
  startingBodyweight: 125,
  strengthTests: [
    { name: "...", unit: "lb", week0: 125, week10Goal: 150, lowerIsBetter: false },
    ...
  ],
  glutesGoalInches: 1,
  buildScoreWeights: { adherence: 0.40, strength: 0.30, body: 0.30 },
  buildScoreActivationDays: 7
};
```

### STATE (line ~830)
Holds in-memory data loaded from Supabase / localStorage cache.
Keys: `sessions`, `sets`, `measurements`, `bodyMeasurements`, `fitnessTests`, `photos`, `checklist`, `prefs`.

---

## 6. Supabase

**Project ref:** `bxyiefzzqcgmnmjvnaax`
**URL:** `https://bxyiefzzqcgmnmjvnaax.supabase.co`
**Auth:** anon key embedded inline (line ~825). RLS allows anon insert/select/update/delete.

### Tables
- `sessions` — workout sessions
- `sets` — individual sets within sessions
- `measurements` — Hume body comp scans
- `body_measurements` — tape measurements (waist/hip/thigh/glute/etc.)
- `fitness_tests` — strength + core test results
- `photos` — Supabase Storage URLs + metadata
- `timeline_checklist` — per-week task completion
- `athlete_preferences` — frequency mode (maintain/build), nudge prefs

### Storage bucket
`michelle-progress` (public). RLS allows anon CRUD.
Upload flow: `ensureStorageReady()` (line ~1895) does silent GET probe → `uploadToStorage()` POST.

---

## 7. App structure (5 tabs)

| Tab | Hero headline | Tagline | Purpose |
|---|---|---|---|
| **Mission** | "The Ass & Abs Agenda" | "Your 10-Week Newbie-Gains Window" | Mission statement, primary lift cards, conundrum, plan, this-week, stats, checklist, QR |
| **Performance** | "The Heavy Math" | "Volume In · Curves Out" | Strength/core test logging, progress charts |
| **Body Comp** | "The Scale Tells Lies" | "Hume Tells the Truth" | Hume scan log, bodyweight chart, body measurements |
| **Aesthetic** | "The Glow-Up, Documented" | "See It Happen · 10 Weeks of Evidence" | Biweekly photos, comparison view |
| **Scorecard** | "The Effort Audit" | "Are You Actually Doing the Thing???" | Build score, adherence stats, splash deck export, PDF export |

### Mission tab section order (locked)
1. nudge-container
2. Tab hero (teal headline + pink tagline)
3. Mission card (3 pillars + day counter)
4. Primary lifts grid (6 cards + Glutes goal)
5. The Conundrum (science, scannable)
6. The Plan ("Once a week maintains. Twice a week builds.")
7. This Week adherence
8. Stat tiles (streak / `N/20` sessions / days to checkpoint)
9. Checklist
10. QR card (teal 1.5px border)

---

## 8. Key code locations

| Feature | Approx. line |
|---|---|
| Header markup | 487-510 |
| Tab panel definitions | 525, 624, 654, 680, 713 |
| CLIENT data | 775-805 |
| STATE init | 830 |
| `initAssets` (photo loader) | 935-955 |
| `ensureStorageReady` | 1895-1919 |
| `uploadToStorage` | 1920+ |
| `renderStrengthTests` | 1659+ |
| `renderStatTiles` (sessions cap N/20) | 1145+ |
| Splash deck slides | 2185+ |
| PDF export | 2290-2330 |
| Hume modal | 1654+ |

---

## 9. What's deployed right now

**Latest commit on main:** `5e74a11` (May 1, 2026)
> Final audit: real baselines, week-10 checkpoint, dead CSS removed

### Recent commit history (this session)
- `5e74a11` — Final audit (baselines + week-10 + dead CSS removed)
- `4258457` — Final tab heros + 10-week conversion + Bench Press as 6th primary lift
- `1953c42` — Lisa-pattern transplant (per-tab heros, lifts grid, teal QR border, sessions cap N/16)
- `a888322` — Mission tab reorder (Mission → Conundrum → Plan → This Week → tiles → checklist → QR)
- `5545b80` — Replaced Yeager's Gym logo with Michelle's headshot in header
- `28d405f` — 36px header avatar, null-safe Strict Press, silent storage probe
- `8943a98` — Photo upload zero-touch UX, mobile camera capture
- `c92a032` — Mission tab restructure + 325 lb Hip Thrust goal

---

## 10. Brand voice

Brad uses a sales-style report format: **Situation → Options → Recommendation → Execution steps.** Concise bullets. Decisive. No fluff. No emoji unless asked.

In-app copy: confident, direct, slightly playful. Examples:
- "Once a week maintains. Twice a week builds."
- "The Scale Tells Lies / Hume Tells the Truth"
- "Are You Actually Doing the Thing???"

---

## 11. Known open threads (for Claude to pick up)

1. **`michelle-muscle-mission.pplx.app`** — abandoned earlier deploy, still live. Brad needs to unpublish from his app preview UI manually.
2. **Hume integration "workaround"** — Brad mentioned Claude (you) discovered a workaround for getting data out of Hume. Hume data is currently entered manually via the Hume modal. If you have an API/scrape path, that's a known wishlist item.
3. **Photo upload tested** — works end-to-end against Supabase Storage (200 OK). Mobile camera capture verified (`capture=environment`).
4. **Splash deck logo** — `LOGO_DATA_URI` (line ~975) still points to `assets/yeagers-logo.jpeg` and renders only on splash slide 1. Header uses Michelle's photo. This is intentional.

---

## 12. Verified clean state at handoff

- Live site: zero JS errors, no `null` / `undefined` / `NaN` in rendered UI
- All 5 tabs render in demo + live mode
- `node --check` passes on the inline script
- All week-8 → week-10 references converted
- Real baselines in place (no more 75-85 placeholders)
- Dead CSS purged (`.biweekly-pill*`, `.profile-card`, `.profile-info`, `.profile-name`, `.profile-meta`, `.header-logo`)
- Dead JS purged (`goalDisp` unused var)

---

## 13. How Brad wants you to work

1. **Read this doc first.** Then read `michelle/index.html` end-to-end before changing anything substantial.
2. **Plan before action.** Use Situation → Options → Recommendation → Execution. Get approval.
3. **Surgical edits.** Use `edit` with anchored `old_string`. Don't rewrite.
4. **Always `node --check`** the inline script after editing JS.
5. **Test in demo mode** (`?demo=1`) before pushing to production.
6. **Commit messages should be concise** and explain the "why," not just the "what."

Welcome to the project. Brad's a great collaborator — fast, decisive, and clear about what he wants.
