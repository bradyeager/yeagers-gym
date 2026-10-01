import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appointmentWindow} from './period.mjs';
test('Friday evening and delayed Saturday anchor the same Pacific Monday-Friday',()=>{
 const timely=appointmentWindow({now:new Date('2026-09-26T04:17:00Z'),pacificWeek:true});
 const late=appointmentWindow({now:new Date('2026-09-26T19:00:00Z'),pacificWeek:true});
 assert.equal(timely.start.toISOString(),'2026-09-21T07:00:00.000Z');
 assert.equal(late.start.toISOString(),timely.start.toISOString());
 assert.equal(late.end.toISOString(),'2026-09-26T06:59:59.999Z');
 assert.equal(timely.end.toISOString(),'2026-09-26T04:17:00.000Z');
});
test('explicit Friday reruns have deterministic periods; winter offset handled',()=>{
 const a=appointmentWindow({now:new Date('2026-12-08'),periodEnd:'2026-12-04'});
 const b=appointmentWindow({now:new Date('2026-12-10'),periodEnd:'2026-12-04'});
 assert.deepEqual(a,b);assert.equal(a.start.toISOString(),'2026-11-30T08:00:00.000Z');assert.equal(a.end.toISOString(),'2026-12-05T07:59:59.999Z');
 assert.throws(()=>appointmentWindow({periodEnd:'2026-09-26'}),/Friday/);assert.throws(()=>appointmentWindow({periodEnd:'2026-02-30'}));
});
test('workflow defaults use five appointment days and independent payment search',async()=>{
 const yml=await fs.readFile(new URL('../../.github/workflows/weekly-billing.yml',import.meta.url),'utf8');
 assert.match(yml,/lookback_days \|\| '5'/);assert.doesNotMatch(yml,/lookback_days \|\| '8'/);assert.match(yml,/BILLING_PACIFIC_WEEK: "true"/);assert.match(yml,/cron: "17 4 \* \* 6"/);
 const source=await fs.readFile(new URL('./billing.mjs',import.meta.url),'utf8');assert.match(source,/PAYMENT_LOOKBACK_DAYS = "21"/);
});
