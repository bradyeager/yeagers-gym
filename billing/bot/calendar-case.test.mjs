import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseCalendarSource} from './calendar-source.mjs';
const options={start:new Date('2026-10-02T07:00:00Z'),end:new Date('2026-10-03T04:19:41Z'),capturedAt:new Date('2026-10-04T00:00:00Z')};
const event=(...lines)=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const cal=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n');
const booked=(...extra)=>event('UID:Case-Sensitive-Token','DTSTART:20261002T160000Z','SUMMARY:Peggy Happ - Personal Training',...extra);
const modes=[s=>s,s=>s.toLowerCase(),s=>s[0]+s.slice(1).toLowerCase()];
const variant=(raw,mode)=>raw.replace(/^([A-Z-]+)(?=[;:])/gm,(_,name)=>mode(name))
 .replace(/;(TZID|LANGUAGE|CN|RANGE|VALUE)=/g,(_,name)=>';'+mode(name)+'=')
 .replace(/^(begin|end):([A-Z]+)$/gmi,(_,name,value)=>name+':'+mode(value));

test('upper/lower/mixed SUMMARY cannot bypass floating or all-day validation',()=>{
 for(const mode of modes) for(const dt of ['DTSTART:20261002T160000','DTSTART;VALUE=DATE:20261002']) {
  const raw=cal(event('UID:fixture',dt,mode('SUMMARY')+':Personal Training'));
  assert.throws(()=>parseCalendarSource(raw,options),/explicit timezone/);
 }
});
test('all structural name casing preserves appointments, identity, UID value and source digest',()=>{
 const raw=cal(booked('ATTENDEE;CN=Peggy Happ:mailto:test@example.invalid'));
 const expected=parseCalendarSource(raw,options).appointments;
 for(const mode of modes) {
  const input=variant(raw,mode);const result=parseCalendarSource(input,options);
  assert.deepEqual(result.appointments,expected);
  assert.equal(result.snapshot.source_sha256,createHash('sha256').update(input).digest('hex'));
 }
});
test('mixed date, TZID and EXDATE names retain every precise excluded instant',()=>{
 const raw=cal(event('UID:Escaped\\,Case-Token','DTSTART;TZID=America/Los_Angeles:20261002T090000','RRULE:FREQ=HOURLY;COUNT=3','EXDATE;TZID=America/Los_Angeles:20261002T090000,20261002T100000','SUMMARY:Personal Training'));
 for(const mode of modes) {
  const result=parseCalendarSource(variant(raw,mode),options);
  assert.deepEqual(result.appointments.map(a=>a.date.toISOString()),['2026-10-02T18:00:00.000Z']);
  assert.equal(result.snapshot.records[0].exclusions.length,2);
 }
});
test('mixed unsupported recurrence property and RANGE parameter names fail closed',()=>{
 for(const mode of modes) {
  for(const rule of ['RDATE:20261002T170000Z','EXRULE:FREQ=HOURLY;COUNT=1']) assert.throws(()=>parseCalendarSource(variant(cal(booked(rule)),mode),options),/Unsupported/);
  const override=event('UID:Case-Sensitive-Token','RECURRENCE-ID;RANGE=THISANDFUTURE:20261002T160000Z','DTSTART:20261002T170000Z','SUMMARY:Personal Training');
  assert.throws(()=>parseCalendarSource(variant(cal(booked(),override),mode),options),/Unsupported/);
 }
});
test('mixed recurrence-ID/status names preserve cancelled exception and moved occurrence',()=>{
 for(const mode of modes) {
  const master=booked();
  const cancelled=event('UID:Case-Sensitive-Token','RECURRENCE-ID:20261002T160000Z','DTSTART:20261002T160000Z','STATUS:CANCELLED');
  assert.equal(parseCalendarSource(variant(cal(master,cancelled),mode),options).appointments.length,0);
  const moved=event('UID:Case-Sensitive-Token','RECURRENCE-ID:20261002T160000Z','DTSTART:20261002T180000Z');
  const result=parseCalendarSource(variant(cal(master,moved),mode),options);
  assert.deepEqual(result.appointments.map(a=>a.date.toISOString()),['2026-10-02T18:00:00.000Z']);
 }
});
test('quoted parameter colons/semicolons and folded text retain decoded service and values',()=>{
 const raw=cal(event('uid:MiXeD-Uid-Value','dtstart;tzid="America/Los_Angeles":20261002T090000','summary;language=en;x-note="https://Synthetic.invalid/a;b":Peggy Happ - Personal \r\n Training'));
 const result=parseCalendarSource(raw,options);
 assert.equal(result.appointments[0].client_name,'Peggy Happ');
 assert.equal(result.appointments[0].date.toISOString(),'2026-10-02T16:00:00.000Z');
 assert.equal(result.appointments[0].calendar_source.uid,'sha256:'+createHash('sha256').update('MiXeD-Uid-Value').digest('hex'));
 assert.ok(!JSON.stringify(result).includes('Synthetic.invalid'));
});
test('mixed names cannot bypass unsafe UID or unknown timezone guards',()=>{
 for(const mode of modes) {
  assert.throws(()=>parseCalendarSource(variant(cal(event('UID:https://private.invalid/token','DTSTART:20261002T160000Z','SUMMARY:Personal Training')),mode),options),/unsafe/);
  assert.throws(()=>parseCalendarSource(variant(cal(event('UID:zone','DTSTART;TZID=Invalid/Calendar:20261002T090000','SUMMARY:Personal Training')),mode),options),/timezone is not supported/);
 }
});
test('mixed names keep unrelated all-day description reminders outside billable validation',()=>{
 for(const mode of modes) {
  const reminder=event('UID:reminder','DTSTART;VALUE=DATE:20261002','SUMMARY:Buy supplies','DESCRIPTION:Ask about personal training');
  assert.equal(parseCalendarSource(variant(cal(booked(),reminder),mode),options).appointments.length,1);
 }
});
test('parameterized UID objects remain unsupported rather than collapsing to one stringified hash',()=>{
 for(const mode of modes) {
  const raw=cal(event('UID;X-ORIGIN=fixture:private-one','DTSTART:20261002T160000Z','SUMMARY:Personal Training'));
  assert.throws(()=>parseCalendarSource(variant(raw,mode),options),/UID missing or unsafe/);
 }
});
