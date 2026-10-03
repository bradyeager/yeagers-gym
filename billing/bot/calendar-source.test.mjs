import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCalendarSource} from './calendar-source.mjs';
import {expandSlots, reconcile, buildEmail, writeLog} from './billing.mjs';
import {buildEmailV2} from './email-v2.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadSchedule, loadScheduleOverrides, loadClients} from './lib.mjs';
import {fileURLToPath} from 'node:url';
const root = new URL('../../', import.meta.url);
const schedule=await loadSchedule(fileURLToPath(new URL('billing/schedule.csv',root)));
const overrides=await loadScheduleOverrides(fileURLToPath(new URL('billing/schedule-overrides.csv',root)));
const clients=await loadClients(fileURLToPath(new URL('billing/clients.csv',root)));
const event=(...lines)=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const cal=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n');
const base=(...extra)=>event('UID:peggy-series','DTSTART;TZID=America/Los_Angeles:20260925T073000','DTEND;TZID=America/Los_Angeles:20260925T083000','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Peggy Happ',...extra);
const parse=(raw,start='2026-10-02T07:00:00Z',end='2026-10-03T04:19:41Z')=>parseCalendarSource(raw,{start:new Date(start),end:new Date(end),capturedAt:new Date('2026-10-03T05:00:00Z'),runId:'fixture'});
const move=(start,...extra)=>event('UID:peggy-series','RECURRENCE-ID;TZID=America/Los_Angeles:20261002T073000','DTSTART:'+start,'SUMMARY:60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Peggy Happ',...extra);
const expanded=raw=>expandSlots(parse(raw).appointments,schedule,overrides);
const receipt={gmail_id:'fixture-payment',sender_display_name:'Peggy Barlow Happ',amount:70,note:'10/2',noteDate:new Date('2026-10-02T19:00:00Z'),date:new Date('2026-10-02T19:00:00Z')};
test('EXDATE removes the excluded occurrence',()=>assert.equal(parse(cal(base('EXDATE;TZID=America/Los_Angeles:20261002T073000'))).appointments.length,0));
test('EXDATE excludes DTSTART even without RRULE',()=>{
 const raw=cal(event('UID:single-excluded','DTSTART:20261002T160000Z','EXDATE:20261002T160000Z','SUMMARY:60 Mins - 1:1 Personal Training'));
 assert.equal(parse(raw).appointments.length,0);
});
test('cancellation and move overrides apply without RRULE',()=>{
 const master=event('UID:single-override','DTSTART:20261002T160000Z','SUMMARY:60 Mins - 1:1 Personal Training');
 const cancelled=event('UID:single-override','RECURRENCE-ID:20261002T160000Z','DTSTART:20261002T160000Z','STATUS:CANCELLED');
 assert.equal(parse(cal(master,cancelled)).appointments.length,0);
 const moved=event('UID:single-override','RECURRENCE-ID:20261002T160000Z','DTSTART:20261002T180000Z');
 const rows=parse(cal(master,moved)).appointments;assert.equal(rows.length,1);
 assert.equal(rows[0].date.toISOString(),'2026-10-02T18:00:00.000Z');assert.equal(rows[0].calendar_source.recurrence_id,'2026-10-02T16:00:00.000Z');
});
test('multiple same-UTC-day EXDATE instants survive comma lists and separate lines',()=>{
 for(const fields of [['EXDATE:20261002T160000Z,20261002T170000Z'],['EXDATE:20261002T160000Z','EXDATE:20261002T170000Z'],['EXDATE;TZID=America/Los_Angeles:20261002T090000,20261002T100000']]){
  const raw=cal(event('UID:hourly','DTSTART:20261002T160000Z','RRULE:FREQ=HOURLY;COUNT=3','SUMMARY:60 Mins - 1:1 Personal Training',...fields));
  const result=parse(raw);assert.deepEqual(result.appointments.map(r=>r.date.toISOString()),['2026-10-02T18:00:00.000Z']);
  assert.deepEqual(result.snapshot.records[0].exclusions,['2026-10-02T16:00:00.000Z','2026-10-02T17:00:00.000Z']);
 }
 assert.throws(()=>parse(cal(base('EXDATE:20261002T143000,20261002T153000Z'))),/explicit timezone/);
});
test('unsupported EXRULE refuses before emitting excluded bookings',()=>{
 assert.throws(()=>parse(cal(base('EXRULE:FREQ=WEEKLY;COUNT=3'))),/Unsupported/);
});
test('cancelled recurrence removes old booking without resurrecting it',()=>assert.equal(parse(cal(base(),move('20261002T143000Z','STATUS:CANCELLED'))).appointments.length,0));
test('moved recurrence emits only corrected time with original occurrence identity',()=>{
 const [row]=parse(cal(base(),move('20261002T163000Z'))).appointments;
 assert.equal(row.date.toISOString(),'2026-10-02T16:30:00.000Z');
 assert.equal(row.calendar_source.uid,'peggy-series');assert.equal(row.calendar_source.recurrence_id,'2026-10-02T14:30:00.000Z');
});
test('override moved out of window is omitted',()=>assert.equal(parse(cal(base(),move('20261003T163000Z'))).appointments.length,0));
test('override moved into window is included even with original outside window',()=>{
 const raw=cal(base(),event('UID:peggy-series','RECURRENCE-ID;TZID=America/Los_Angeles:20260925T073000','DTSTART:20261002T163000Z','SUMMARY:60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Peggy Happ'));
 const rows=parse(raw).appointments;assert.equal(rows.length,2);assert.ok(rows.some(r=>r.calendar_source.recurrence_id==='2026-09-25T14:30:00.000Z'));
});
test('master cancelled status suppresses its series',()=>assert.equal(parse(cal(base('STATUS:CANCELLED'))).appointments.length,0));
test('standalone cancelled status is omitted',()=>assert.equal(parse(cal(event('UID:cancelled','DTSTART:20261002T153000Z','STATUS:CANCELLED','SUMMARY:60 Mins - 1:1 Personal Training'))).appointments.length,0));
test('deleted Melissa/Danika and cancelled Jeanette/Katelin/Dina exact appointments are excluded without fee inference',()=>{
 for(const [uid,date,status,name] of [
  ['melissa','20260929T000000Z','DELETED','Melissa Rios'],['danika','20261001T140000Z','DELETED','Danika Elenes'],
  ['jeanette','20261002T143000Z','CANCELLED','Jeanette Davey'],['katelin','20260928T160000Z','CANCELLED','Katelin Lowther'],
  ['dina','20260928T160000Z','CANCELLED','Dina Bates'],['lacey','20261002T133000Z','DELETED','Lacey James']]){
  const parsed=parse(cal(event('UID:'+uid,'DTSTART:'+date,'STATUS:'+status,'SUMMARY:60 Min - 1:1 Personal Training','DESCRIPTION:Client: '+name)),'2026-09-28T07:00:00Z');
  assert.equal(parsed.appointments.length,0);assert.equal(parsed.snapshot.records[0].status,status);
 }
});
test('deleted recurrence override suppresses only that occurrence',()=>{
 const rows=parse(cal(base(),move('20261002T143000Z','STATUS:DELETED')),'2026-09-25T07:00:00Z','2026-10-03T04:19:41Z').appointments;
 assert.equal(rows.length,1);assert.equal(rows[0].date.toISOString(),'2026-09-25T14:30:00.000Z');
});
test('zero source amount does not become paid or free and unrelated named bookings survive tombstone',()=>{
 const raw=cal(event('UID:deleted-exact','DTSTART:20261001T140000Z','STATUS:DELETED','SUMMARY:60 Min - 1:1 Personal Training','DESCRIPTION:Client: Danika Elenes'),event('UID:tonnie-unrelated','DTSTART:20261001T160000Z','STATUS:CONFIRMED','SUMMARY:60 Min - 1:1 Personal Training','DESCRIPTION:Client: Tonnie Dahl','X-AMOUNT:0'));
 const rows=expandSlots(parse(raw,'2026-09-28T07:00:00Z').appointments,schedule,overrides);
 assert.equal(rows.length,1);assert.equal(rows[0].client_name,'Tonnie Dahl');assert.equal(rows[0].vagaroAmount,undefined);
 assert.equal(reconcile(rows,[],clients,[]).results[0].status,'NEEDS_REVIEW');
});
test('UTC/TZID dates agree and DST keeps local wall time',()=>{
 for(const dt of ['DTSTART:20261002T153000Z','DTSTART;TZID=America/Los_Angeles:20261002T083000'])assert.equal(parse(cal(event('UID:time',dt,'SUMMARY:60 Mins - 1:1 Personal Training'))).appointments[0].date.toISOString(),'2026-10-02T15:30:00.000Z');
 const rows=parse(cal(event('UID:dst','DTSTART;TZID=America/Los_Angeles:20261030T073000','RRULE:FREQ=WEEKLY;COUNT=2','SUMMARY:60 Min - 2:1 Semi-Private')),'2026-10-30T00:00:00Z','2026-11-08T00:00:00Z').appointments;
 assert.deepEqual(rows.map(r=>r.date.toISOString()),['2026-10-30T14:30:00.000Z','2026-11-06T15:30:00.000Z']);
});
test('Peggy09:30 identity survives Celestin roster conflict without payment allocation',()=>{
 const rows=expanded(cal(event('UID:peggy-current','DTSTART:20261002T163000Z','SUMMARY:60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Peggy Happ')));
 assert.equal(rows[0].client_name,'Peggy Happ');assert.deepEqual(rows[0].roster_candidates,['Celestin Mathieu']);
 const r=reconcile(rows,[receipt],clients,[]);assert.equal(r.results[0].status,'NEEDS_REVIEW');assert.equal(r.newMatches.length,0);assert.equal(r.unmatchedPayments.length,1);
});
test('paired stale07:30 and current09:30 Peggy occurrences both stay review and retain UIDs',()=>{
 const rows=expanded(cal(base(),event('UID:peggy-current','DTSTART:20261002T163000Z','SUMMARY:60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Peggy Happ')));
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.client_name==='Peggy Happ'&&r.calendar_review));
 assert.deepEqual(new Set(rows.map(r=>r.calendar_source.uid)),new Set(['peggy-series','peggy-current']));
 const r=reconcile(rows,[receipt],clients,[]);assert.ok(r.results.every(r=>r.status==='NEEDS_REVIEW'));assert.equal(r.newMatches.length,0);
});
test('distinct Friday08:30 UIDs are preserved; only one explicitly identifies Jacob',()=>{
 const rows=expanded(cal(event('UID:jacob-current','DTSTART:20261002T153000Z','SUMMARY:60 Mins - 1:1 Personal Training','ATTENDEE;CN=Jacob Bain:mailto:fixture@example.invalid'),event('UID:unnamed-old','DTSTART:20260925T153000Z','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:60 Mins - 1:1 Personal Training')));
 assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.client_name==='Jacob Bain').length,1);assert.equal(rows.filter(r=>r.client_name===null).length,1);
 assert.ok(rows.every(r=>r.calendar_review));assert.equal(new Set(rows.map(r=>r.calendar_source.uid)).size,2);
});
test('unnamed roster-time booking cannot invent Peggy/Jeanette or consume dated receipt',()=>{
 const rows=expanded(cal(event('UID:anonymous','DTSTART:20261002T143000Z','SUMMARY:60 Min - 2:1 Semi-Private')));
 assert.equal(rows.length,1);assert.equal(rows[0].client_name,null);
 const r=reconcile(rows,[receipt],clients,[]);assert.equal(r.results[0].status,'NEEDS_REVIEW');assert.equal(r.newMatches.length,0);
});
test('explicit customer survives INACTIVE slot and stays review',()=>{
 const rows=expandSlots(parse(cal(event('UID:robert','DTSTART:20260929T170000Z','SUMMARY:60 Mins - 1:1 Personal Training','DESCRIPTION:Client: Robert Brower')),'2026-09-28T07:00:00Z').appointments,schedule,overrides);
 assert.equal(rows[0].client_name,'Robert Brower');assert.ok(rows[0].calendar_review);
 assert.equal(reconcile(rows,[],clients,[]).results[0].status,'NEEDS_REVIEW');
});
test('conflicting explicit customer fields stay review',()=>{
 const rows=expanded(cal(event('UID:conflict','DTSTART:20261002T163000Z','SUMMARY:Peggy Happ - 60 Min - 2:1 Semi-Private','DESCRIPTION:Client: Celestin Mathieu')));
 assert.equal(rows[0].client_name,null);assert.match(rows[0].calendar_review,/Conflicting explicit/);
});
test('valid historical named slot still matches payment; calendar without payment is review',()=>{
 const raw=cal(event('UID:historical','DTSTART:20261001T160000Z','SUMMARY:60 Mins - 1:1 Personal Training','DESCRIPTION:Client: Tonnie Dahl'));
 const rows=expandSlots(parse(raw,'2026-09-28T07:00:00Z').appointments,schedule,overrides);
 const p={...receipt,sender_display_name:'Tonnie Dahl',note:'10/1',noteDate:new Date('2026-10-01T19:00:00Z'),date:new Date('2026-10-01T19:00:00Z')};
 assert.equal(reconcile(rows,[p],clients,[]).results[0].status,'PAID_VENMO');
 assert.equal(reconcile(rows,[],clients,[]).results[0].status,'NEEDS_REVIEW');
});
test('sanitized snapshot retains reproducible recurrence facts and digest without source URLs/emails',()=>{
 const {snapshot}=parse(cal(base('URL:https://private.invalid/calendar/secret','DESCRIPTION:Client: Peggy Happ\\nhttps://private.invalid/token fixture@example.invalid')));
 const json=JSON.stringify(snapshot);assert.match(snapshot.source_sha256,/^[a-f0-9]{64}$/);assert.equal(snapshot.run_id,'fixture');
 assert.ok(snapshot.records[0].recurrence_rule);assert.ok(!json.includes('private.invalid')&&!json.includes('example.invalid')&&!json.includes('secret'));
});
test('unsupported floating time and recurrence-range fail closed',()=>{
 assert.throws(()=>parse(cal(event('UID:floating','DTSTART:20261002T083000','SUMMARY:60 Mins - 1:1 Personal Training'))),/explicit timezone/);
 assert.throws(()=>parse(cal(base('RDATE:20261002T163000Z'))),/Unsupported/);
 assert.throws(()=>parse(cal(base(),event('UID:peggy-series','RECURRENCE-ID;RANGE=THISANDFUTURE:20261002T143000Z','DTSTART:20261002T163000Z','SUMMARY:60 Min - 2:1 Semi-Private'))),/Unsupported/);
 assert.throws(()=>parse(cal(event('UID:bad-zone','DTSTART;TZID=Invalid/Calendar:20261002T083000','SUMMARY:60 Mins - 1:1 Personal Training'))),/timezone is not supported/);
});
test('non-UTC replay host fails closed instead of shifting recurrence wall time',()=>{
 const script=`import assert from 'node:assert/strict';import {parseCalendarSource} from ${JSON.stringify(new URL('./calendar-source.mjs',import.meta.url).href)};assert.throws(()=>parseCalendarSource(${JSON.stringify(cal(base()))},{start:new Date('2026-10-02T07:00:00Z'),end:new Date('2026-10-03T04:00:00Z')}),/TZ=UTC/);`;
 assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:'America/Los_Angeles'}}));
});
test('tentative source appointment remains review even with matching roster and receipt',()=>{
 const rows=expandSlots(parse(cal(event('UID:tentative','DTSTART:20261001T160000Z','STATUS:TENTATIVE','SUMMARY:60 Mins - 1:1 Personal Training','DESCRIPTION:Client: Tonnie Dahl')),'2026-09-28T07:00:00Z').appointments,schedule,overrides);
 assert.ok(rows[0].calendar_review);assert.equal(reconcile(rows,[],clients,[]).results[0].status,'NEEDS_REVIEW');
});
test('duplicate masters and same-day exception collisions fail closed rather than lose status',()=>{
 assert.throws(()=>parse(cal(base(),base('STATUS:CANCELLED'))),/Duplicate calendar masters/);
 assert.throws(()=>parse(cal(base(),move('20261002T163000Z'),move('20261002T173000Z','STATUS:CANCELLED'))),/Multiple calendar exceptions/);
});
test('source snapshots omit unrelated dates and unsafe UID URLs fail closed',()=>{
 assert.equal(parse(cal(event('UID:old','DTSTART:20260101T153000Z','SUMMARY:60 Mins - 1:1 Personal Training'))).snapshot.records.length,0);
 assert.throws(()=>parse(cal(event('UID:https://private.invalid/token','DTSTART:20261002T153000Z','SUMMARY:60 Mins - 1:1 Personal Training'))),/unsafe/);
});
test('anonymous calendar review renders in both templates without request/checkout actions',()=>{
 const rows=expanded(cal(event('UID:anonymous','DTSTART:20261002T143000Z','SUMMARY:60 Min - 2:1 Semi-Private')));
 const r=reconcile(rows,[receipt],clients,[]);
 for(const render of [buildEmail,buildEmailV2]){
  const {html}=render({results:r.results,unmatchedPayments:r.unmatchedPayments,now:new Date('2026-10-03T04:20:00Z'),windowStart:new Date('2026-09-28T07:00:00Z')});
  assert.match(html,/unidentified calendar customer/);assert.ok(!html.includes('undefined'));assert.ok(!html.includes('account.venmo.com/pay?txn=charge'));
 }
});
test('future log persists sanitized source snapshot with occurrence IDs and refuses replacement',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-source-test-'));
 try{
  const p=parse(cal(base()));const rows=expandSlots(p.appointments,schedule,overrides);const r=reconcile(rows,[],clients,[]);
  const args={appointments:rows,payments:[],results:r.results,unmatchedPayments:[],logsDir:dir,dryRun:false,calendarSource:p.snapshot};
  const {file}=await writeLog(args);
  assert.match(await fs.readFile(file,'utf8'),/peggy-series/);
  const snapshotFile=(await fs.readdir(dir)).find(f=>f.endsWith('-calendar-source.json'));
  const saved=JSON.parse(await fs.readFile(path.join(dir,snapshotFile),'utf8'));
  assert.equal(saved.source_sha256,p.snapshot.source_sha256);assert.equal(saved.records[0].uid,'peggy-series');
  await assert.rejects(()=>writeLog(args),e=>e.code==='EEXIST');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
