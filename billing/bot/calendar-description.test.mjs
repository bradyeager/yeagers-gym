import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {calendarIdentity,parseCalendarSource} from './calendar-source.mjs';
import {expandSlots,buildEmail} from './billing.mjs';
import {loadCalendarEmailIdentities} from './calendar-email-identities.mjs';
const hash=e=>createHash('sha256').update(e.toLowerCase()).digest('hex');
const approved='approved@example.invalid',alias='alias@example.invalid';
const identities={[hash(approved)]:['Fixture Client'],[hash(alias)]:['Fixture Client']};
const desc=e=>'https://www.vagaro.com/merchants/googlecalendar?dt=fixture\n'+e+'\n\n';
const event=(uid,description,extra=[])=>['BEGIN:VEVENT','UID:'+uid,'DTSTART;TZID=America/Los_Angeles:20261012T090000',
 'DTEND;TZID=America/Los_Angeles:20261012T100000','SUMMARY:60 Min - 3:1 Semi-Private',
 'DESCRIPTION:'+description.replace(/\r?\n/g,'\\n'),'STATUS:CONFIRMED',...extra,'END:VEVENT'].join('\r\n');
const cal=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n');
const parse=raw=>parseCalendarSource(raw,{start:new Date('2026-10-12T07:00:00Z'),end:new Date('2026-10-13T06:59:59Z'),emailIdentities:identities});

test('description-only bridge master and occurrence resolve exact approved identity before redaction',()=>{
 const r=parse(cal(event('fixture-series',desc(approved),['RRULE:FREQ=WEEKLY;COUNT=2'])));
 assert.equal(r.snapshot.records[0].identities[0],'Fixture Client');
 assert.equal(r.appointments[0].client_name,'Fixture Client');assert.equal(r.appointments[0].description,'');
 assert.equal(r.snapshot.occurrences[0].identity_basis,'approved-description-email');
 assert.equal(r.snapshot.occurrences[0].recurrence_id,'2026-10-12T16:00:00.000Z');
 assert.equal(r.appointments[0].attendance_proven,false);assert.equal(r.appointments[0].checkout_proven,false);
 assert.doesNotMatch(JSON.stringify(r.snapshot),/approved@example|googlecalendar\?/);
 const mapped=expandSlots(r.appointments,[{day:'Monday',time:'09:00',client_name:'Fixture Client'}]);
 assert.equal(mapped[0].client_name,'Fixture Client');
 const html=buildEmail({results:[{status:'NEEDS_REVIEW',appt:mapped[0],roster:{vagaro_name:'Fixture Client'},note:'Attendance unverified'}],
 unmatchedPayments:[],now:new Date('2026-10-13T00:00:00Z')}).html;
 assert.match(html,/Fixture Client/);assert.doesNotMatch(html,/approved@example|googlecalendar\?/);
});

test('missing, untrusted and arbitrary free-text emails cannot manufacture identity',()=>{
 for(const d of ['',desc('unknown@example.invalid'),'Contact '+approved,'https://evil.invalid/merchants/googlecalendar\n'+approved]){
  const a=parse(cal(event('fixture',d))).appointments[0];assert.equal(a.client_name,null);
  assert.equal(expandSlots([a],[])[0].mapping_ambiguous,true);
 }
});

test('multiple emails, duplicate allowlist rows and explicit conflicting names remain review-only',()=>{
 const a=parse(cal(event('fixture',desc(approved)+alias))).appointments[0];assert.ok(a.calendar_review);assert.equal(a.client_name,null);
 const duplicate=parseCalendarSource(cal(event('fixture',desc(approved))),{start:new Date('2026-10-12T07:00:00Z'),end:new Date('2026-10-13T07:00:00Z'),
 emailIdentities:{[hash(approved)]:['Fixture Client','Fixture Client']}}).appointments[0];assert.ok(duplicate.calendar_review);
 const conflicting=calendarIdentity({summary:'Other Client - Personal Training',description:desc(approved)},identities);
 assert.equal(conflicting.length,2);
});

test('approved alias is exact and case insensitive; no partial-domain or local-part inference',()=>{
 assert.deepEqual(calendarIdentity({description:desc(alias.toUpperCase())},identities),['Fixture Client']);
 assert.deepEqual(calendarIdentity({description:desc('alias@other.invalid')},identities),[]);
});

test('recurrence override can clear identity without inheriting or guessing roster identity',()=>{
 const master=event('fixture-series',desc(approved),['RRULE:FREQ=WEEKLY;COUNT=2']);
 const override=event('fixture-series','',['RECURRENCE-ID;TZID=America/Los_Angeles:20261012T090000']);
 const r=parse(cal(master,override));assert.equal(r.appointments.length,1);assert.equal(r.appointments[0].client_name,null);
 assert.equal(r.snapshot.records[0].identities[0],'Fixture Client');
});

test('distinct source UID rows preserve provenance; identical UID masters reject duplication',()=>{
 const r=parse(cal(event('first',desc(approved)),event('second',desc(approved))));
 assert.equal(r.appointments.length,2);assert.notEqual(r.snapshot.occurrences[0].uid,r.snapshot.occurrences[1].uid);
 assert.throws(()=>parse(cal(event('first',desc(approved)),event('first',desc(approved)))),/Duplicate calendar masters/);
});

test('runtime allowlist rejects non-roster mappings and duplicate roster identities',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'identity-allowlist-'));const p=path.join(dir,'map.json');
 await fs.writeFile(p,JSON.stringify({version:1,mappings:[{email_sha256:hash(approved),vagaro_name:'Fixture Client',evidence:'authorized fixture'}]}));
 assert.deepEqual(await loadCalendarEmailIdentities(p,[{vagaro_name:'Fixture Client'}]),{[hash(approved)]:['Fixture Client']});
 await assert.rejects(()=>loadCalendarEmailIdentities(p,[{vagaro_name:'Another Client'}]),/exact authorized roster/);
 await assert.rejects(()=>loadCalendarEmailIdentities(p,[{vagaro_name:'Fixture Client'},{vagaro_name:'Fixture Client'}]),/exact authorized roster/);
});
