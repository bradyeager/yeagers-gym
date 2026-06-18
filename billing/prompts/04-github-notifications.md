# 04 — Verify GitHub Failure Notifications

> **What this does:** confirms that GitHub emails Brad when the weekly billing
> workflow fails, so a broken run never goes unnoticed until Friday rolls around
> and the inbox is empty.

---

## Default behavior (no action usually required)

GitHub automatically emails the **repo owner** when a workflow run on a
**watched branch** (`main`) fails. If Brad created the repo, notifications
are on by default. This prompt is a quick sanity check.

---

## Check 1 — Notification settings (browser, 2 min)

1. Go to **github.com/settings/notifications**
2. Under **GitHub Actions** → confirm **Email** is checked for
   "Failed workflows only" or "All activity" (either works; "Failed only"
   is cleaner).
3. Confirm the notification email address shown at the top is `brad@bradyeager.com`
   (or wherever you want alerts).

If it was off → turn it on → Save.

---

## Check 2 — Watch status on the repo

1. Go to **github.com/bradyeager/yeagers-gym**
2. Top-right: **Watch** button → ensure it says "Unwatch" (meaning you're watching)
   OR the dropdown shows "All Activity" or "Custom → Workflows".
3. If it says "Watch" (not watching) → click → select **"All Activity"** or
   **"Custom"** → enable **"Workflow runs"**.

---

## Bonus: add a Slack/SMS fallback (optional, not required)

If email isn't reliable enough, add this block to `weekly-billing.yml`
after the last step (fires only on failure):

```yaml
      - name: Notify on failure
        if: failure()
        run: |
          curl -X POST "${{ secrets.SLACK_WEBHOOK_URL }}" \
            -H 'Content-type: application/json' \
            --data '{"text":"⚠️ Weekly billing run FAILED. Check https://github.com/bradyeager/yeagers-gym/actions"}'
```

Then add `SLACK_WEBHOOK_URL` as a repo secret (Slack → your workspace →
Incoming Webhooks → Add New Webhook).

---

## Verification: deliberately break + confirm you get the email

The cleanest test: in `weekly-billing.yml`, temporarily break it (add a
typo to the `run:` command), push, wait for the failure email, then revert.
Takes ~3 minutes total and proves the pipeline end-to-end.

**Do NOT do this on a Friday.**
