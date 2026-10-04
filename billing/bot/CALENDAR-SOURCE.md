# Calendar identity and recurrence reliability

Production iCal records retain a SHA-256 key of the decoded UID and original recurrence ID, actual start/end,
source timezone/status and explicit customer identity. A recurring roster supplies
candidate names and prices; it cannot replace a source customer or invent attendees.
Unidentified, conflicting, tentative and multiple same-customer/day occurrences
remain review and cannot consume receipts. Distinct UIDs remain distinct.

EXDATE and RECURRENCE-ID cancellations/moves are applied before the final window
filter, including moves entering from outside the window. CANCELLED, CANCELED and
DELETED source records do not become attended-session or debt records. A stale
mirror that still says CONFIRMED cannot establish a vendor deletion by itself.
Attendance/chargeable cancellation entitlement requires separate evidence.

The workflow pins TZ=UTC because the installed node-ical/rrule versions depend on
host timezone for recurrence expansion. Floating appointment times, unsupported
RDATE/EXRULE/THISANDFUTURE ranges, duplicate masters and same-UTC-day exception collisions
fail closed for review. No dependency or GitHub permission change is required.
Raw EXDATE instants retain full precision, including several exclusions on one
UTC day. Exclusions and overrides also apply when no RRULE is present.

Future weekly logs save an immutable `YYYY-MM-DD-calendar-source.json` beside the
log, before delivery through the existing snapshot/commit workflow. It contains
the input digest, capture time, run/repository SHA, parser versions, relevant
normalized event/exception facts and emitted occurrences. Private calendar URLs,
raw descriptions, attendee emails, secrets and unrelated events are omitted.
Snapshot version2 declares `uid_encoding=sha256-decoded-uid`; every persisted UID
is a stable hash, including email-shaped and opaque values. Raw decoded UIDs stay
internal for recurrence/exclusion grouping and original same-time ordering.
Billable validation uses parsed SUMMARY only, grouping related exceptions by UID;
unrelated description text cannot make a reminder a billing appointment.
This reproduces the normalized source decisions; it is not a raw private ICS
archive. Original source bytes can only be compared if separately available.

Calendar records explicitly have `attendance_proven=false` and
`checkout_proven=false`. A known, nonconflicting historical receipt can still
match; this is a financial allocation, not attendance or Vagaro checkout proof.
Booking-only missing-payment rows are review, not confirmed debt. Roster prepaid
flags are historical configuration, not new payment/checkout evidence.

Historical accepted reports, receipts and ledger records are not rewritten by
this repair. Corrections require separate source-linked adjudication. A displayed
Vagaro amount of zero or empty Transaction List does not negate external receipts
or establish a free session. DOM block IDs and UI times must not be promoted to
permanent IDs or UTC instants without verification.

Offline tests: `TZ=UTC node --test` in `billing/bot` (on Windows set the process
environment TZ to UTC). Synthetic fixtures exercise explicit UTC/TZID dates;
they do not assign a timezone to browser observations.
