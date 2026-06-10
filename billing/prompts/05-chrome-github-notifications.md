# Chrome prompt — Turn on GitHub failure notifications

Paste this into a fresh Claude for Chrome session. Brad is signed in to
GitHub in the browser. The goal is to make sure GitHub emails him when
the weekly billing run breaks.

---

You are Claude in Brad's Chrome browser. He is logged into GitHub as
**bradyeager**. Notifications go to **brad@bradyeager.com**.

Your job, in order:

### 1. Open notification settings
Navigate to: **https://github.com/settings/notifications**

### 2. Check the "Actions" section
Scroll to the section titled **"Actions"** (about halfway down).

It should be set to:
- **Email** ✓ checked
- Either **"Only notifications for failed workflows"** OR **"Send notifications for all workflow runs"**

If Email is unchecked → check it.
If it's set to something like "Web only" → change to include Email.
The "Only failed" option is preferred (less noise).

Click **Save** if you changed anything.

### 3. Confirm the email address
At the top of the same page, under **"Default notifications email"**,
confirm it shows **brad@bradyeager.com**. If it's a different address,
tell Brad which one and ask if he wants to change it.

### 4. Make sure he's watching the repo
Navigate to: **https://github.com/bradyeager/yeagers-gym**

Top-right corner, find the **Watch** button. Click the dropdown arrow
next to it.

If it currently shows **"Watching"** with "All Activity" or "Custom",
you're good — note it and move on.

If it shows **"Not watching"**:
- Click the dropdown
- Choose **"Custom"**
- Check the **"Workflow runs"** box
- Click **Apply**

(Custom + Workflow runs is the minimum needed for failure emails.)

### 5. Report back
Tell Brad in 2–3 lines what's now set, e.g.:
> "Notifications email: brad@bradyeager.com ✓
> Actions emails: enabled, 'failed only' ✓
> Repo watch: Custom → Workflow runs ✓
> You'll get an email if the Friday billing run breaks."

If anything looks different from these steps (GitHub changed the UI),
**stop and tell Brad what you see** instead of guessing.
