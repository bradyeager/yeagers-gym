# Chrome prompt — Create the private billing repo (browser steps only)

Paste this into a fresh Claude for Chrome session. Brad is signed in to
GitHub as **bradyeager**. This prompt handles ONLY the browser parts of
the private-repo migration. The file-copy step requires terminal access
and will be done in a separate Claude Code session afterward.

---

You are Claude in Brad's Chrome browser. He is logged into GitHub as
**bradyeager**. Goal: create a new private repository for billing data
and seed its Actions secrets.

### Step 1 — Create the private repo
Navigate to: **https://github.com/new**

Fill in:
- **Owner:** bradyeager
- **Repository name:** `yeagers-gym-billing`
- **Description:** `Private billing reconciliation for Yeager's Gym (Vagaro + Venmo + email)`
- **Visibility:** **Private** ← this is the whole point; do NOT leave it on Public
- **Initialize this repository with:** check **"Add a README file"**
- Add .gitignore: **None**
- License: **None**

Click **Create repository**.

Report back: "Created bradyeager/yeagers-gym-billing as Private ✓"

### Step 2 — Open the new repo's Secrets page
Navigate to: **https://github.com/bradyeager/yeagers-gym-billing/settings/secrets/actions**

You should see "Repository secrets" — empty list.

### Step 3 — Ask Brad to walk you through adding secrets
There are 6 secrets to copy from the OLD repo. Open this URL in a new
tab to see the names (values won't be visible — GitHub hides them after
they're set):
**https://github.com/bradyeager/yeagers-gym/settings/secrets/actions**

The 6 secret names are:
1. `VAGARO_ICAL_URL`
2. `GOOGLE_CLIENT_ID`
3. `GOOGLE_CLIENT_SECRET`
4. `GOOGLE_REFRESH_TOKEN`
5. `GOOGLE_TOKEN_EXPIRES`
6. `BREVO_API_KEY`

Tell Brad:
> "GitHub hides secret values after you save them — I can't copy them
> across automatically. For each of these 6 secrets, please paste the
> value into the chat and I'll add it to the new repo. Start with
> VAGARO_ICAL_URL — paste the value here."

Then for each secret Brad pastes:
1. Go back to **https://github.com/bradyeager/yeagers-gym-billing/settings/secrets/actions**
2. Click **"New repository secret"**
3. Name: the secret name (exactly as listed above, all caps with underscores)
4. Secret: paste the value Brad gave you
5. Click **Add secret**
6. Confirm to Brad: "Added [SECRET_NAME] ✓"
7. Ask for the next one.

If Brad doesn't know where to find a secret value:
- `VAGARO_ICAL_URL` — Vagaro → Settings → Calendar Sync → iCal URL,
  or in Google Calendar → Settings → his synced calendar → "Secret address in iCal format"
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client ID for the billing bot → "Show Client Secret"
- `GOOGLE_REFRESH_TOKEN` — has to be regenerated via OAuth Playground (see billing/SETUP.md in the public repo). NOT recoverable from the old secret.
- `GOOGLE_TOKEN_EXPIRES` — Brad sets this himself; format `YYYY-MM-DD` (180 days after issuing the refresh token)
- `BREVO_API_KEY` — Brevo dashboard → SMTP & API → API Keys

### Step 4 — Add one extra config secret
After the 6 secrets are in, add ONE more so the email's GitHub buttons
point to the new repo:

- **Name:** `GITHUB_REPO`
- **Value:** `yeagers-gym-billing`

(Without this, the "Log as cash" buttons in the Friday email would still
link to the old public repo.)

### Step 5 — Confirm the final list
Refresh **https://github.com/bradyeager/yeagers-gym-billing/settings/secrets/actions**
and read the list back to Brad. There should be 7 secrets:

```
BREVO_API_KEY
GITHUB_REPO
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_TOKEN_EXPIRES
VAGARO_ICAL_URL
```

### Step 6 — Done with browser work
Tell Brad:
> "Browser part complete. The new private repo exists with all secrets.
> The next step (copying billing files into the new repo + removing
> them from the public repo) needs a Claude Code session on your
> computer — I'll hand off there."

DO NOT try to upload files or edit code through the browser UI — that's
the Claude Code job, not yours.
