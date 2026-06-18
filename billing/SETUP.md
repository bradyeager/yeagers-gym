# Billing Bot — One-Time Setup

Follow these steps once. After that, the bot runs every Friday automatically and emails you an unpaid-client list with tap-to-request Venmo buttons.

**Time required:** ~60 minutes. Coffee first.

---

## Step 1 — Appointments iCal URL (via Google Calendar bridge)

Vagaro does **not** publish outbound `.ics` feeds directly. Instead, use Vagaro's Google Calendar Sync to mirror appointments into a dedicated Google Calendar, then grab *that* calendar's secret iCal URL.

This takes ~15 min. Zero code changes — the bot reads any standard iCal feed, so it doesn't matter that the URL now lives on google.com.

**Important:** use your **primary Google account** (the one that receives Venmo payment emails). That same account will be used for Gmail OAuth in Step 3, and the calendar you create below will live inside it.

### 1a. Connect Vagaro to Google Calendar
1. **First, create a dedicated Google Calendar** at https://calendar.google.com signed in as `thebradyeager@gmail.com`. Left sidebar → "Other calendars" → `+` → **Create new calendar** → Name: `Yeager's Gym Appointments` → Create. (Skip if you've already done this.)
2. Log into Vagaro Pro at https://pro.vagaro.com.
3. Navigate: **Settings → Employee Profiles → Action (next to your name) → Integrations → Sync Google Calendar**. (Confirmed location per Vagaro support, Apr 2026.)
4. Click to connect Google → sign in as `thebradyeager@gmail.com` → grant permission.
5. Enable **Sync Vagaro to Google Calendar** (one-way: Vagaro → Google).
6. If prompted to choose a target calendar: select `Yeager's Gym Appointments`. If not prompted, the sync may land in your primary calendar — that's fine for now, we can move events later if needed.
7. Wait 5–10 minutes for the initial sync. Confirm by opening https://calendar.google.com — today's appointments should appear under `Yeager's Gym Appointments`.

### 1b. Copy the secret iCal URL
1. Open https://calendar.google.com
2. Left sidebar: hover **Yeager's Gym Appointments** → three-dot menu → **Settings and sharing**.
3. Scroll to **Integrate calendar**.
4. Copy the **Secret address in iCal format** (URL ends in `/basic.ics`).
5. **Treat this URL like a password.** Anyone with it can read all your appointments.
6. Paste into your temp note. You'll save it as `VAGARO_ICAL_URL` in GitHub Secrets (Step 4).

### If your Vagaro plan doesn't expose Google Calendar Sync
Contact Vagaro support. As a last resort, fall back to the Claude-for-Chrome recipes under `prompts/`.

### Sync lag caveat
Vagaro → Google sync runs every 5–15 minutes. The bot fires at Friday 10 AM PT, so Friday-morning appointments should be mirrored before the run. Friday afternoon/evening sessions roll into next week's check (this is by design — matches the lookback window).

---

## Step 2 — Populate `clients.csv`

The bot needs to know which Venmo handle belongs to which client. Open `billing/clients.csv` and add one row per active client. Delete the example/comment lines at the top.

Example:

```csv
vagaro_name,venmo_handle,venmo_display_name,default_price,pays_cash,notes
Alice Chen,alice-chen-2021,Alice C,100,false,10-pack Jan 2026
Jordan Kim,jordan-kim,Jordan K,120,false,
Luis Ortiz,,,,true,Always pays cash
```

- `vagaro_name`: **exact** name as it appears in Vagaro appointments. Case and punctuation matter.
- `venmo_handle`: the Venmo username (no `@`). Find it by opening their profile — the URL is `venmo.com/u/<handle>`.
- `venmo_display_name`: the name shown on Venmo (for fuzzy matching).
- `default_price`: dollars, integer (e.g., `100`, not `$100.00`).
- `pays_cash`: `true` if this client always pays cash (the bot will expect a cash-log entry, not a Venmo receipt).
- `notes`: free text.

Commit this file once it's populated:

```
git add billing/clients.csv
git commit -m "Populate client roster"
git push
```

You can update this file anytime a new client starts or a handle changes.

---

## Step 3 — Set up Google OAuth for Gmail read access

The bot reads your Gmail (specifically, emails from `venmo@venmo.com`) to see who paid you. It does **not** store your Google password — it uses OAuth refresh tokens.

**Forwarded emails work.** If Venmo sends to `brad@bradyeager.com` and that address forwards to a Gmail inbox, the bot reads them from the Gmail inbox just fine. Make sure every step below uses the **Gmail account that actually receives** the (forwarded) Venmo notifications.

### 3a. Create a Google Cloud project

1. Go to https://console.cloud.google.com/
2. Click the project dropdown (top left) → **New Project** → name it `yeagers-gym-billing`.
3. Select the new project.

### 3b. Enable the Gmail API

1. Left menu → **APIs & Services** → **Library**.
2. Search **Gmail API** → click it → **Enable**.

### 3c. Configure the OAuth consent screen

1. Left menu → **APIs & Services** → **OAuth consent screen**.
2. User type: **External** → Create.
3. App name: `Yeager's Gym Billing Bot`. User support email: `brad@yeagersgym.com`. Developer contact: `brad@yeagersgym.com`. Save.
4. **Scopes** page → Add → search for `gmail.readonly` → add it → Save.
5. **Test users** page → Add the Gmail account that receives your Venmo payment emails — directly or via forwarding (e.g., if `brad@bradyeager.com` forwards to `thebradyeager@gmail.com`, add the Gmail address). → Save.
6. You can leave the app in "Testing" mode indefinitely — no publishing required.

### 3d. Create OAuth credentials

> **Important:** create a **Web application** client (not Desktop). The OAuth Playground in Step 3e sends `https://developers.google.com/oauthplayground` as the redirect URI; that URI can only be registered on a Web application client. A Desktop client will fail with `Error 400: redirect_uri_mismatch`.

1. Left menu → **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**.
2. Application type: **Web application**. Name: `billing-bot`.
3. Under **Authorized redirect URIs**, click **+ Add URI** and paste exactly: `https://developers.google.com/oauthplayground`
4. Click **Create**.
5. Copy the **Client ID** and **Client secret** from the popup. (You can also click "Download JSON" — the file contains both in plaintext.) You'll need both for Step 3e.

### 3e. Generate a refresh token

Refresh tokens are long-lived credentials the bot uses to read your Gmail without you re-authorizing each week.

Run this one-liner on your Mac (or any computer with Node 20+):

```bash
npx @google-cloud/local-auth \
  --client-id "<YOUR_CLIENT_ID>" \
  --client-secret "<YOUR_CLIENT_SECRET>" \
  --scopes "https://www.googleapis.com/auth/gmail.readonly"
```

This opens a browser, asks you to sign into the Google account that receives Venmo emails, and returns a JSON blob. Copy the `refresh_token` value.

**Alternative if the CLI approach is confusing:** use the Google OAuth Playground — https://developers.google.com/oauthplayground/. In the settings gear, check "Use your own OAuth credentials" and paste your client ID / secret. Select `https://www.googleapis.com/auth/gmail.readonly` in the scope list, authorize, then exchange the auth code for a refresh token on step 2.

Keep the **Client ID**, **Client Secret**, and **Refresh Token** — you'll paste all three into GitHub Secrets in Step 5.

---

## Step 4 — Get your Brevo API key

You already use Brevo on the site (`brevo.js`), so you have an account.

1. Log into https://app.brevo.com/
2. Top right → your avatar → **SMTP & API** → **API Keys** tab.
3. **Generate a new API key** → name it `billing-bot` → copy the key (you only see it once).

---

## Step 5 — Add all secrets to GitHub

1. Go to https://github.com/bradyeager/yeagers-gym/settings/secrets/actions
2. Click **New repository secret** and add each of these:

| Name | Value |
|---|---|
| `VAGARO_ICAL_URL` | From Step 1 |
| `GOOGLE_CLIENT_ID` | From Step 3d |
| `GOOGLE_CLIENT_SECRET` | From Step 3d |
| `GOOGLE_REFRESH_TOKEN` | From Step 3e |
<<<<<<< HEAD
=======
| `GOOGLE_TOKEN_EXPIRES` | The date the refresh token stops working, `YYYY-MM-DD` (see Step 5b) |
>>>>>>> origin/main
| `BREVO_API_KEY` | From Step 4 |

Order matters only for your sanity. Names must match exactly.

<<<<<<< HEAD
=======
### Step 5b — Stop the Google token from expiring (IMPORTANT)

Google OAuth refresh tokens behave differently depending on the app's
publishing status:

- **Testing mode (default): the token EXPIRES EVERY 7 DAYS.** The bot will
  silently stop reading Venmo emails after a week.
- **Production mode: the token does not expire** (unless unused 6 months or
  you change your Google password).

**Do this once:** Google Cloud Console → **APIs & Services → OAuth consent
screen → Publish App → Confirm.** It may warn "unverified app" — that's fine,
you're the only user reading your own Gmail. Re-issue the refresh token
(Step 3e) after publishing so you get a non-expiring one.

**Set `GOOGLE_TOKEN_EXPIRES`** to:
- A far-future date (e.g. `2030-01-01`) once you've published to Production, OR
- The issue date **+ 7 days** if you stay in Testing mode.

The weekly email shows a loud pink warning starting **14 days** before that
date, with the exact re-auth steps — so you'll never be caught off guard. When
you re-issue a token, bump this date.

>>>>>>> origin/main
---

## Step 6 — Test-run the bot

1. Go to https://github.com/bradyeager/yeagers-gym/actions
2. Pick **Weekly billing reconciliation** in the left sidebar.
3. Click **Run workflow** (top right). Set `dry_run` to **true** and click Run.
4. Wait ~1 minute. Expand the run → expand **Run billing reconciliation** step.
5. You should see the email that *would* have been sent, logged to the console. Check: appointment count looks right, payment count looks right, matching makes sense.
6. If things look off, fix `clients.csv` or check that Venmo emails are landing in the right inbox, and re-run.
7. Once it looks right, click **Run workflow** again with `dry_run` set to **false**. You should get a real email.

---

## Step 7 — Verify the schedule

Once you've seen one successful manual run, the schedule is automatic. It fires every **Friday at 17:00 UTC**:

- **Daylight saving time (roughly March–Nov):** Friday 10 AM PT ✓
- **Standard time (roughly Nov–March):** Friday 9 AM PT

If the 1-hour winter shift bothers you, open a task to split the cron into two schedules with conditional logic.

---

## When things break

- **No email arrives Friday** → check https://github.com/bradyeager/yeagers-gym/actions. If the run failed, GitHub emails you the failure. Most common causes: expired/revoked Gmail refresh token (redo Step 3e), Vagaro iCal URL changed (redo Step 1), Brevo daily email limit hit (check Brevo dashboard).
- **Wrong/missing clients in report** → edit `clients.csv`, commit, push. The next run picks it up immediately.
- **Venmo email format changed and nothing matches** → re-run with `dry_run=true` and look at the logs; the regex in `billing.mjs` may need a tweak.
- **Google OAuth token expires (rare)** → Google expires refresh tokens if unused for 6 months, or if you change your password. Regenerate via Step 3e.

## Updating the roster

Edit `billing/clients.csv` in GitHub's web UI or locally, commit, push. That's it.

## Turning off auto-runs temporarily

Comment out the `schedule:` block in `.github/workflows/weekly-billing.yml`, commit, push. You can still run manually via `workflow_dispatch`.

---

## Fallback

If this whole automation ever breaks and you need results *this Friday*, the Claude-for-Chrome recipes in `prompts/` still work as a manual fallback. See `README.md`.
