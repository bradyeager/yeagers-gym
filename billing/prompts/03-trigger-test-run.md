# 03 — Trigger a billing-email test run (Claude for Chrome)

> **What this is for.** When you push a change to `billing/` and want to fire
> the workflow without leaving the browser. Paste this into a fresh Claude for
> Chrome session. Total clicks for Brad: one (the explicit OK).

---

**You are Claude for Chrome running in Brad's browser. Brad is signed into
GitHub.** Your only task: trigger the `weekly-billing.yml` workflow once with
the `command-center` email template selected. **Do not submit the form without
Brad's explicit per-trigger OK.**

## Steps

1. Navigate to:
   https://github.com/bradyeager/yeagers-gym/actions/workflows/weekly-billing.yml

2. Click the **Run workflow** button (top right, above the runs list — it opens a
   small form, not a new page).

3. Fill the form. Default values shown — only one needs changing:
   - **Use workflow from**: `main` *(default — leave)*
   - **Dry run (print email, do not send)**: leave unchecked
   - **Days of history to reconcile**: leave `8`
   - **Email template**: ⚠️ **change `default` → `command-center`**

4. Read the filled form back to Brad in one line:

   > "About to trigger weekly-billing.yml on `main` — dry_run=false,
   > lookback=8, email_style=command-center. Hit Run?"

5. **Wait for Brad's explicit OK.** Don't click anything until he confirms.

6. On his OK, click the green **Run workflow** button at the bottom of the form.

7. The page refreshes and shows a new run at the top of the runs list,
   status **Queued** or **In progress**. Copy the run's URL and give it back
   to Brad in one line:

   > "Triggered. Run: https://github.com/bradyeager/yeagers-gym/actions/runs/<id>
   > — takes ~90s. Email will land at brad@bradyeager.com."

You're done. Don't wait for the run to finish — Brad's other session will
poll it and summarize the result.

## Failure cases

- **No Run workflow button visible** → workflow lacks `workflow_dispatch`. Stop, tell Brad.
- **Email template dropdown doesn't include `command-center`** → workflow file
  hasn't picked up the latest change. Stop, tell Brad to recheck `main`.
- **GitHub asks for 2FA or re-auth** → stop, Brad handles it manually, re-paste this prompt.
- **Anything else surprising in the UI** → stop, describe what you see, don't improvise.

## Safety rules

- Never submit the form without an explicit OK in this session.
- Never trigger any workflow other than `weekly-billing.yml`.
- Never change `dry_run` to `true` unless Brad asks (it suppresses the email).
- If Brad pastes this prompt twice in one session, ask which run he wants — don't
  fire both.
