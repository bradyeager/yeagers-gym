# Weekly delivery safety

Production uses three ordered steps: prepare without sending, commit/push the
weekly log and matched-payment ledger, then claim and attempt delivery.
`npm start` cannot directly send a production weekly report. Dry runs remain
read-only for the ledger and preview logs go in ignored `.delivery/`.

`billing/outbox/weekly-schedule-ical-YYYY-MM-DD.json` is the durable claim for a
Pacific Friday. The key does not change with run number, lookback, or template.
The first supported outbox period is 2026-10-02; earlier periods may already
have been sent without a marker. Explicit historical periods remain dry-run-only.

Non-dry preparation and claims are blocked before the existing Saturday 04:17
UTC cutoff for their Pacific Friday (21:17 PDT / 20:17 PST). An early Friday
manual run cannot consume the evening report identity. Late runs remain eligible.

A newly created and read-confirmed `pending` record permits one provider attempt.
Any existing record blocks another automatic attempt. An `accepted` record means
Brevo returned a successful acceptance response, not that the email was delivered.
The record stores hashes and metadata, not email bodies or recipient addresses.

Crashes, provider response loss, and failed acceptance recording leave a blocking
record. Inspect Actions, the outbox and provider evidence before any separately
authorized recovery. Never delete a marker or reset pending state to bypass the
guard. No automated resend or claim expiration exists. The design can suppress an
email that was never sent; it does not claim exactly-once delivery.

Incoming raw event/outbox commits can be rebased during snapshot persistence.
Other incoming billing changes block sending so stale prepared evidence cannot
overwrite manual corrections. Existing production log files are never replaced;
a failed run that persisted a log can therefore require review before another
preparation attempt. A conflicting correction also blocks acceptance-state writes
through GitHub's exact-SHA update requirement.

Preparation and delivery errors fail Actions and do not dispatch separate failure
emails that could bypass this guard. The provider request is not retried and has
a 30-second timeout. The GitHub state requests have 10-second timeouts.

Tests: `npm test` in this directory. Fixtures use mocked providers/stores and
isolated local Git remotes; they send no email and touch no production ledger.
