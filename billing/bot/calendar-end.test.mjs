import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCalendarSource} from './calendar-source.mjs';
const options={start:new Date('2026-10-02T07:00:00Z'),end:new Date('2026-10-03T04:19:41Z')};
const event=(...lines)=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const cal=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n');
const master=(...extra)=>event('UID:end-fixture','DTSTART;TZID=America/Los_Angeles:20260925T090000','RRULE:FREQ=WEEKLY;COUNT=2','SUMMARY:Personal Training',...extra);
test('floating end fails before a recurring source can emit a negative or shifted duration',()=>{
 for(const name of ['DTEND','dtend','Dtend']) assert.throws(()=>parseCalendarSource(cal(master(name+':20260925T100000')),options),/explicit timezone/);
});
test('all-day and unknown-timezone ends fail closed in a billable UID group',()=>{
 for(const end of ['DTEND;VALUE=DATE:20260925','dtend;tzid=Invalid/Calendar:20260925T100000']) {
  assert.throws(()=>parseCalendarSource(cal(master(end)),options),/explicit timezone|timezone is not supported/);
 }
});
test('valid UTC and TZID ends preserve a one-hour recurring duration for every field casing',()=>{
 for(const name of ['DTEND','dtend','Dtend']) for(const field of [name+':20260925T170000Z',name+';tzid="America/Los_Angeles":20260925T100000']) {
  const result=parseCalendarSource(cal(master(field)),options);
  assert.equal(result.appointments.length,1);
  assert.equal(result.appointments[0].calendar_source.start,'2026-10-02T16:00:00.000Z');
  assert.equal(result.appointments[0].calendar_source.end,'2026-10-02T17:00:00.000Z');
 }
});
test('floating exception end is validated even when its service title is inherited',()=>{
 const override=event('UID:end-fixture','RECURRENCE-ID;TZID=America/Los_Angeles:20261002T090000','DTSTART:20261002T180000Z','dtend:20261002T190000');
 assert.throws(()=>parseCalendarSource(cal(master('DTEND:20260925T170000Z'),override),options),/explicit timezone/);
});
test('nonbillable reminders with floating ends do not contaminate billable validation',()=>{
 const reminder=event('UID:reminder','DTSTART;VALUE=DATE:20261002','dtend:20261002T100000','SUMMARY:Buy supplies','DESCRIPTION:Ask about personal training');
 const result=parseCalendarSource(cal(master('DTEND:20260925T170000Z'),reminder),options);
 assert.equal(result.appointments.length,1);assert.equal(result.snapshot.records.length,1);
});
test('omitted end keeps the previously supported zero-duration representation',()=>{
 const result=parseCalendarSource(cal(master()),options);
 assert.equal(result.appointments[0].calendar_source.end,result.appointments[0].calendar_source.start);
});
