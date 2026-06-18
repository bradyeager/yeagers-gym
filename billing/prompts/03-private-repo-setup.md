# 03 — Migrate Billing to a Private Repo

> **When to use:** The `billing/` directory currently lives in the public
> `bradyeager/yeagers-gym` repo (GitHub Pages). That means client names,
> payment amounts, and Venmo handles are publicly visible. This prompt
> walks through moving all billing data to a new PRIVATE repo.

---

## Step 1 — Create the private repo (browser, 2 min)

1. Go to **github.com/new**
2. **Repository name:** `yeagers-gym-billing`
3. **Visibility:** Private  ← critical
4. **Initialize:** Add a README → Create repository

---

## Step 2 — Copy billing files (terminal, Brad runs this or asks Claude)

```bash
# Clone both repos side by side
git clone git@github.com:bradyeager/yeagers-gym.git       # if not already local
git clone git@github.com:bradyeager/yeagers-gym-billing.git

# Copy everything under billing/ into the new repo
rsync -av yeagers-gym/billing/   yeagers-gym-billing/billing/
rsync -av yeagers-gym/.github/workflows/weekly-billing.yml   yeagers-gym-billing/.github/workflows/
rsync -av yeagers-gym/.github/workflows/monthly-summary.yml  yeagers-gym-billing/.github/workflows/

# The billing bot needs package.json + lock file to install
# These are already inside billing/bot/ so they copy above.

cd yeagers-gym-billing
git add .
git commit -m "Initial billing migration from public yeagers-gym repo"
git push
```

---

## Step 3 — Add secrets to the new private repo

In **github.com/bradyeager/yeagers-gym-billing/settings/secrets/actions**,
add every secret from the old repo:

| Secret name | Where to get it |
|---|---|
| `VAGARO_ICAL_URL` | Vagaro → Settings → Calendar Sync → iCal URL |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials |
| `GOOGLE_REFRESH_TOKEN` | OAuth Playground (see SETUP.md) |
| `GOOGLE_TOKEN_EXPIRES` | Date you last issued the refresh token + ~180 days |
| `BREVO_API_KEY` | Brevo → SMTP & API → API Keys |

---

## Step 4 — Update the workflow `GITHUB_OWNER` / `GITHUB_REPO` (if needed)

In `billing/bot/lib.mjs`, the GitHub owner/repo constants default to
`bradyeager / yeagers-gym`. The tap-to-action buttons in the email
(Log as cash, Wasn't trained) use these to build GitHub URLs. After
migration, update the defaults:

```js
export const GITHUB_OWNER = process.env.GITHUB_OWNER || "bradyeager";
export const GITHUB_REPO  = process.env.GITHUB_REPO  || "yeagers-gym-billing";  // ← change this
```

OR set `GITHUB_OWNER` and `GITHUB_REPO` as Actions secrets/env vars in
the new repo's workflow so the code doesn't need to change.

In the new workflow, add to the `env:` block:
```yaml
GITHUB_OWNER: bradyeager
GITHUB_REPO: yeagers-gym-billing
```

---

## Step 5 — Verify the new repo runs correctly

1. Push your changes.
2. In the new private repo: **Actions → Weekly billing → Run workflow**
   with `dry_run: true`.
3. Check the log. If it reads calendar + payments + sends dry-run email → success.

---

## Step 6 — Remove billing from the public repo

**Only after Step 5 confirms the private repo works:**

```bash
cd yeagers-gym
git rm -r billing/ .claude/commands/move.md .claude/commands/vagaro-prompt.md
git rm .github/workflows/weekly-billing.yml .github/workflows/monthly-summary.yml
git commit -m "Remove billing data (moved to private repo)"
git push
```

---

## What stays in the public repo

- All website HTML/CSS/JS files
- `assets/`
- `CLAUDE.md`, `base.css`, `style.css`
- Nothing from `billing/`

---

## Notes

- The `matched-payments.json` ledger is the bot's memory. Make sure it
  copies cleanly — it has 40+ backfill entries that prevent double-billing.
- The slash commands (`.claude/commands/`) reference `billing/` paths. After
  migration, open a Claude Code session in the new private repo — they'll
  work there natively.
- The `claude-billing-intake.yml` workflow should also live in the private repo.
