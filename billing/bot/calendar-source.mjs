import ical from 'node-ical';
import {createHash} from 'node:crypto';

export const billableCalendarService = summary => /personal training|semi[-\s]?private/i.test(summary || '');
const cancelled = ev => ['CANCELLED', 'CANCELED', 'DELETED'].includes(String(ev.status || '').toUpperCase());
const iso = value => value instanceof Date && !Number.isNaN(+value) ? value.toISOString() : null;
const clean = value => String(value || '').replace(/https?:\/\/\S+|mailto:\S+|[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 300);

// Only explicit name fields count. A service title or receipt is not identity.
export function calendarIdentity(ev) {
  const names = new Set();
  const summary = String(ev.summary || '').trim();
  const description = String(ev.description || '');
  const name = "([A-Z][a-zA-Z'\\-]+(?:\\s[A-Z][a-zA-Z'\\-]+)+)";
  for (const re of [new RegExp('^'+name+'\\s*[—–:-]'), new RegExp('(?:with|w/)\\s+'+name, 'i')]) {
    const match = summary.match(re); if (match) names.add(match[1].trim());
  }
  const labelled = description.match(new RegExp('(?:^|\\n)\\s*(?:Client|Customer):\\s*'+name, 'i'));
  if (labelled) names.add(labelled[1].trim());
  for (const attendee of [ev.attendee].flat().filter(Boolean)) {
    const cn = attendee.params?.CN;
    if (cn && new RegExp('^'+name+'$').test(cn)) names.add(cn.trim());
  }
  return [...names];
}

// node-ical 0.20 keys exceptions by UTC day, losing multiple same-day exceptions.
// Reject unsupported/ambiguous input before parsing instead of silently billing it.
function validateRaw(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const billableUids = new Set(blocks.filter(b=>/personal training|semi[-\s]?private/i.test(b)).map(b=>b.match(/^UID:(.*)$/m)?.[1]?.trim()));
  const exceptionDays = new Set();
  const masters = new Set();
  for (const block of blocks) {
    if (!billableUids.has(block.match(/^UID:(.*)$/m)?.[1]?.trim())) continue;
    if (/^RDATE[;:]/m.test(block) || /RANGE=THISANDFUTURE/i.test(block)) throw new Error('Unsupported calendar recurrence range/additional dates; review source');
    for (const field of block.match(/^(?:DTSTART|RECURRENCE-ID|EXDATE)[^\r\n]*/gm) || []) {
      if (!/TZID=/.test(field) && !/\d{8}T\d{6}Z(?:,|$)/.test(field)) throw new Error('Calendar requires explicit timezone on timed appointments');
      const tz = field.match(/TZID=([^;:]+)/)?.[1]?.replaceAll('"', '');
      if (tz) {
        try {new Intl.DateTimeFormat('en', {timeZone: tz});}
        catch {throw new Error('Calendar timezone is not supported; review source');}
      }
    }
    const uid = block.match(/^UID:(.*)$/m)?.[1]?.trim();
    if (!uid || /https?:\/\//i.test(uid)) throw new Error('Calendar UID missing or unsafe for provenance');
    const rid = block.match(/^RECURRENCE-ID[^:]*:(.*)$/m)?.[1]?.trim();
    if (!rid) {
      if (masters.has(uid)) throw new Error('Duplicate calendar masters require source review');
      masters.add(uid);
    }
    if (rid) {
      const parsed = Object.values(ical.sync.parseICS('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+block+'\r\nEND:VCALENDAR')).find(e=>e.type==='VEVENT');
      const key = uid+'|'+iso(parsed?.recurrenceid)?.slice(0,10);
      if (exceptionDays.has(key)) throw new Error('Multiple calendar exceptions per UID/day require review');
      exceptionDays.add(key);
    }
  }
}

export function parseCalendarSource(raw, {start, end, capturedAt = new Date(), runId = null, repositorySha = null} = {}) {
  if (!(start instanceof Date) || !(end instanceof Date) || !(start <= end)) throw new Error('Invalid calendar window');
  validateRaw(raw);
  // rrule 2.8/node-ical 0.20 TZID expansion depends on the host timezone.
  // The workflow pins UTC. Other hosts fail closed rather than shift appointments.
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC') throw new Error('Calendar expansion requires TZ=UTC');
  const events = ical.sync.parseICS(raw);
  const appointments = [], records = [];
  const emit = (master, occurrence, original) => {
    if (cancelled(master) || cancelled(occurrence) || !billableCalendarService(occurrence.summary)) return;
    const date = occurrence.start;
    if (!iso(date)) throw new Error('Calendar appointment has invalid start');
    if (date < start || date > end) return;
    const identities = calendarIdentity(occurrence);
    const source = {uid: master.uid, recurrence_id: iso(original), start: iso(date), end: iso(occurrence.end),
      timezone: occurrence.start?.tz || occurrence.calendar_timezone || 'UTC', status: occurrence.status || null,
      sequence: occurrence.sequence ?? null, last_modified: iso(occurrence.lastmodified),
      summary: clean(occurrence.summary), identities: identities.map(clean)};
    appointments.push({date, summary: source.summary, description: '', client_name: identities.length === 1 ? identities[0] : null,
      attendance_proven: false, checkout_proven: false,
      calendar_source: source, calendar_review: identities.length > 1 ? 'Conflicting explicit calendar identities'
        : occurrence.status && String(occurrence.status).toUpperCase() !== 'CONFIRMED' ? 'Calendar appointment status requires review' : null});
  };
  for (const ev of Object.values(events)) {
    if (ev.type !== 'VEVENT') continue;
    const exceptions = Object.values(ev.recurrences || {});
    if (!billableCalendarService(ev.summary) && !exceptions.some(e=>billableCalendarService(e.summary))) continue;
    if (!ev.uid) throw new Error('Calendar appointment missing UID');
    const inWindow = date => date instanceof Date && date >= start && date <= end;
    const dates = ev.rrule ? ev.rrule.between(start, end, true) : [];
    if (!inWindow(ev.start) && !dates.length && !exceptions.some(e=>inWindow(e.start)||inWindow(e.recurrenceid))) continue;
    records.push({uid: ev.uid, start: iso(ev.start), end: iso(ev.end), timezone: ev.start?.tz || 'UTC',
      status: ev.status || null, sequence: ev.sequence ?? null, last_modified: iso(ev.lastmodified), summary: clean(ev.summary), identities: calendarIdentity(ev).map(clean),
      recurrence_rule: ev.rrule?.toString() || null, exclusions: Object.values(ev.exdate || {}).map(iso),
      exceptions: exceptions.map(e=>({recurrence_id: iso(e.recurrenceid), start: iso(e.start), end: iso(e.end), status: e.status || null,
        timezone: e.start?.tz || 'UTC', sequence: e.sequence ?? null, last_modified: iso(e.lastmodified),
        summary: clean(e.summary), identities: calendarIdentity(e).map(clean)}))});
    if (cancelled(ev)) continue;
    if (!ev.rrule) {emit(ev, ev, ev.recurrenceid || null);continue;}
    const overridden = new Set(exceptions.map(e=>iso(e.recurrenceid)));
    const excluded = new Set(Object.values(ev.exdate || {}).map(iso));
    for (const date of dates) {
      if (overridden.has(iso(date)) || excluded.has(iso(date))) continue;
      const duration = ev.end instanceof Date ? +ev.end - +ev.start : 0;
      emit(ev, {...ev, start: date, end: new Date(+date+duration), calendar_timezone: ev.start?.tz || 'UTC'}, date);
    }
    // Explicit overrides are inspected independently: moved INTO or OUT OF the
    // window must not depend on the old recurrence falling inside the window.
    for (const exception of exceptions) emit(ev, {...ev, ...exception}, exception.recurrenceid);
  }
  appointments.sort((a,b)=>a.date-b.date || a.calendar_source.uid.localeCompare(b.calendar_source.uid));
  return {appointments, snapshot: {version: 1, parser: 'node-ical@0.20.1/rrule@2.8.1',
    captured_at: iso(capturedAt), run_id: runId, repository_sha: repositorySha,
    source_sha256: createHash('sha256').update(raw).digest('hex'),
    window_start: iso(start), window_end: iso(end), records,
    occurrences: appointments.map(a=>({...a.calendar_source, client_name: a.client_name, calendar_review: a.calendar_review,
      attendance_proven: false, checkout_proven: false}))}};
}
