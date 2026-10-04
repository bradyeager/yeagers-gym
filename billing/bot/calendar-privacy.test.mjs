import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCalendarSource} from './calendar-source.mjs';
const event=(...lines)=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const cal=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n');
const options={start:new Date('2026-10-02T07:00:00Z'),end:new Date('2026-10-03T04:19:41Z')};
const booked=(uid,...extra)=>event('UID:'+uid,'DTSTART:20261002T160000Z','SUMMARY:60 Mins - 1:1 Personal Training',...extra);

test('description, UID, location and attendee keywords cannot bill unrelated all-day reminders',()=>{
 const valid=booked('valid');
 for(const field of ['DESCRIPTION:Ask about personal training','LOCATION:Personal training room','ATTENDEE;CN=Personal Training:mailto:test@example.invalid']) {
  const reminder=event('UID:personal training reminder','DTSTART;VALUE=DATE:20261002','SUMMARY:Buy supplies',field);
  const result=parseCalendarSource(cal(valid,reminder),options);
  assert.equal(result.appointments.length,1);assert.equal(result.snapshot.records.length,1);
 }
});
test('folded and parameterized SUMMARY still applies billable validation',()=>{
 for(const summary of ['SUMMARY:60 Mins - 1:1 Personal \r\n Training','SUMMARY;LANGUAGE=en:60 Mins - 1:1 Personal Training']) {
  assert.throws(()=>parseCalendarSource(cal(event('UID:billable-all-day','DTSTART;VALUE=DATE:20261002',summary)),options),/explicit timezone/);
 }
});
test('billable exception activates validation for its otherwise nonbillable series',()=>{
 const master=event('UID:changing-series','DTSTART:20261002T160000','SUMMARY:Placeholder');
 const exception=event('UID:changing-series','RECURRENCE-ID:20261002T160000Z','DTSTART:20261002T170000Z','SUMMARY:Personal Training');
 assert.throws(()=>parseCalendarSource(cal(master,exception),options),/explicit timezone/);
});
test('parameterized SUMMARY uses decoded text for service, customer and sanitized title',()=>{
 const raw=cal(event('UID:parameterized-title','DTSTART:20261002T160000Z','SUMMARY;LANGUAGE=en:Peggy Happ - Personal Training'));
 const result=parseCalendarSource(raw,options);
 assert.equal(result.appointments.length,1);assert.equal(result.appointments[0].client_name,'Peggy Happ');
 assert.equal(result.appointments[0].summary,'Peggy Happ - Personal Training');
});
test('email and opaque UIDs are stable hashed provenance, never raw serialized fields',()=>{
 for(const uid of ['synthetic.customer@example.invalid','OPAQUE_PRIVATE_ACCESS_TOKEN_FIXTURE','mailto:fixture@example.invalid']) {
  const raw=cal(booked(uid));
  const first=parseCalendarSource(raw,options);const second=parseCalendarSource(raw,options);
  assert.equal(first.snapshot.version,2);assert.equal(first.snapshot.uid_encoding,'sha256-decoded-uid');
  assert.match(first.snapshot.records[0].uid,/^sha256:[a-f0-9]{64}$/);
  assert.equal(first.snapshot.records[0].uid,first.appointments[0].calendar_source.uid);
  assert.equal(first.snapshot.records[0].uid,second.snapshot.records[0].uid);
  assert.equal(JSON.stringify(first).includes(uid),false);
 }
});
test('hashed provenance preserves distinct keys and original same-time UID ordering',()=>{
 const raw=cal(booked('z-token'),booked('a-token'),booked('m-token'));
 const first=parseCalendarSource(raw,options);
 const individual=['a-token','m-token','z-token'].map(uid=>parseCalendarSource(cal(booked(uid)),options).appointments[0].calendar_source.uid);
 assert.deepEqual(first.appointments.map(a=>a.calendar_source.uid),individual);
 assert.equal(new Set(individual).size,3);
});
test('opaque UID recurrence, move and exclusion grouping stays internal and intact',()=>{
 const uid='OPAQUE_PRIVATE_RECURRENCE_TOKEN';
 const master=booked(uid,'RRULE:FREQ=HOURLY;COUNT=3','EXDATE:20261002T160000Z');
 const exception=event('UID:'+uid,'RECURRENCE-ID:20261002T170000Z','DTSTART:20261002T180000Z','STATUS:CANCELLED');
 const result=parseCalendarSource(cal(master,exception),options);
 assert.deepEqual(result.appointments.map(a=>a.date.toISOString()),['2026-10-02T18:00:00.000Z']);
 assert.equal(result.snapshot.records[0].exceptions.length,1);
 assert.equal(JSON.stringify(result).includes(uid),false);
});
