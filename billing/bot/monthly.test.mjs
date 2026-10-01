import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeeklyLog, readWeeklyLogs, assertWeeklyLogCounts } from './lib.mjs';
import { totalsFromLogs, buildEmail } from './monthly.mjs';
const log = rows => parseWeeklyLog(`## Appointments (${rows.length})\n${rows.join('\n')}\n## Summary\n- paid_venmo: 2\n## Venmo payments received (1)\n- 2026-09-01 | Example | $500 | PAID_VENMO`);
test('current checkout and legacy rows retain allocated receipts separately', () => {
 const parsed=log(['- Mon, 9/21, 9:00 AM | A | $45 | checkout $45 | PAID_VENMO (matched "A", $50, note: "session")','- Mon, 9/21, 10:00 AM | B | $70 | PAID_VENMO (matched "B", $70)','- Mon, 9/21, 11:00 AM | C | $70 | checkout $70 | PAID_CASH']);
 assert.equal(parsed.appointments.length,parsed.declaredCount);
 assert.equal(parsed.appointments[0].checkoutAmount,45); assert.equal(parsed.appointments[0].paidAmount,50);
 assert.equal(parsed.appointments[1].checkoutAmount,null);
 const t=totalsFromLogs([{parsed}]); assert.equal(t.venmo_revenue,120); assert.equal(t.cash_revenue,70); assert.equal(t.sessions,3);
});
test('later paid replaces unpaid and review shortfalls are excluded', () => {
 const earlier=log(['- Mon, 9/21, 9:00 AM | A | $45 | UNPAID']);
 const later=log(['- Mon, 9/21, 9:00 AM | A | $45 | checkout $45 | PAID_VENMO (matched "A", $50)','- Mon, 9/21, 10:00 AM | B | $45 | NEEDS_REVIEW (matched "B", $25)']);
 const t=totalsFromLogs([{parsed:earlier},{parsed:later}]); assert.equal(t.sessions,2); assert.equal(t.unpaid_outstanding,0); assert.equal(t.paid_venmo_count,1); assert.equal(t.needs_review_count,1);
 const {html}=buildEmail({totals:t,monthLabel:'September',weekCount:2,start:new Date('2026-09-01'),end:new Date('2026-09-30')}); assert.match(html,/Partial coverage/); assert.match(html,/not a full-month receipt or 1099-K total/); assert.doesNotMatch(html,/reported to IRS/);
});
test('September appointment counts match declared rows',async()=>{
 const logs=await readWeeklyLogs(fileURLToPath(new URL('../logs/',import.meta.url)),{start:new Date('2026-09-01'),end:new Date('2026-10-01')});
 for(const {parsed} of logs) assert.equal(parsed.appointments.length,parsed.declaredCount);
 console.log(JSON.stringify({logs:logs.length,rows:logs.reduce((n,l)=>n+l.parsed.appointments.length,0),totals:totalsFromLogs(logs)}));
});

test("monthly normal summary fails closed on dropped rows, missing counts and status drift",()=>{
 const valid=parseWeeklyLog("## Appointments (1)\n- Mon, 9/21, 9:00 AM | A | $45 | checkout $45 | PAID_VENMO (matched A, $50)\n## Summary\n- paid_venmo: 1");
 assert.doesNotThrow(()=>assertWeeklyLogCounts(valid));
 assert.throws(()=>assertWeeklyLogCounts({...valid,declaredCount:2}),/count mismatch/);
 assert.throws(()=>assertWeeklyLogCounts({...valid,declaredCount:null}),/count mismatch/);
 assert.throws(()=>assertWeeklyLogCounts({...valid,summary:{paid_venmo:0}}),/status count/);
 assert.throws(()=>assertWeeklyLogCounts({...valid,appointments:[{status:"FUTURE_FORMAT"}]}),/unsupported/);
});

test("September headline reconciles all status categories without reclassifying money",async()=>{
 const logs=await readWeeklyLogs(fileURLToPath(new URL("../logs/",import.meta.url)),{start:new Date("2026-09-01"),end:new Date("2026-10-01")});
 const totals=totalsFromLogs(logs);
 assert.deepEqual(totals.row_status_counts,{PAID_VENMO:34,UNIDENTIFIED_SLOT:28,CASH_PENDING:10,NEEDS_REVIEW:18,PAID_PREPAID:9,UNPAID:11});
 assert.equal(Object.values(totals.row_status_counts).reduce((n,c)=>n+c,0),110);
 assert.equal(totals.total_revenue,2715);assert.equal(totals.unpaid_outstanding,735);
 const {html}=buildEmail({totals,monthLabel:"September",weekCount:3,start:new Date("2026-09-01"),end:new Date("2026-09-30")});
 for(const label of ["Unique log rows","Prepaid","Cash pending","Unidentified slots","Unknown","Cancelled"])assert.ok(html.includes(label),label);
 assert.match(html,/not all confirmed attended sessions/);assert.match(html,/later receipts are not reconciled here/);assert.doesNotMatch(html,/>Sessions</);
});
