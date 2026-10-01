import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hash,githubDeliveryStore} from './delivery.mjs';
import {monthlyIdentity,assertMonthlyDeliveryConfig,deliverMonthly} from './monthly-delivery.mjs';
import {prepareMonthlySummary} from './monthly.mjs';
const payload={period:'2026-10',monthOffset:-1,snapshotSha:'a'.repeat(40),subject:'fixture',html:'fixture'};
const fixedNow=()=> '2026-11-01T17:00:00.000Z';
const deliver=(p,options)=>deliverMonthly(p,{now:fixedNow,...options});
function memory(){let record=null,version=0;return {reads:0,creates:0,updates:0,async read(){this.reads++;return record?{sha:String(version),record:structuredClone(record)}:null;},async create(id,r){this.creates++;if(record)throw new Error('atomic create conflict');record=structuredClone(r);version++;},async update(id,r,sha){this.updates++;if(String(version)!==sha)throw new Error('human correction conflict');record=structuredClone(r);version++;},get record(){return record;},correct(){record={...record,state:'human-review'};version++;}};}
test('monthly identity is distinct and one confirmed claim permits one provider attempt',async()=>{
 assert.equal(monthlyIdentity('2026-10'),'monthly-2026-10');assert.throws(()=>monthlyIdentity('2026-13'));
 const store=memory();let sends=0;await deliver(payload,{store,send:async()=>{sends++;assert.equal(store.record.state,'pending');return{status:201,messageId:'fixture'};}});
 assert.equal(store.record.id,'monthly-2026-10');assert.equal(store.record.snapshotSha,payload.snapshotSha);assert.equal(store.record.state,'accepted');
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,1);
});
test('crash after monthly claim before provider attempt blocks retry',async()=>{
 const store=memory(),read=store.read.bind(store);let reads=0,sends=0;
 store.read=async()=>{if(++reads===2)throw new Error('crash after claim');return read();};
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/crash after claim/);
 store.read=read;await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,0);assert.equal(store.record.state,'pending');
});
test('monthly provider acceptance with failed receipt write stays blocked',async()=>{
 const store=memory();let sends=0;store.update=async()=>{throw new Error('receipt write failed');};
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;return{status:201};}}),/receipt write failed/);
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,1);assert.equal(store.record.state,'pending');
});
test('lost monthly provider response is uncertain, never retried automatically',async()=>{
 const store=memory();let sends=0;await assert.rejects(deliver(payload,{store,send:async()=>{sends++;throw new Error('lost response');}}));
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,1);
});
test('concurrent monthly claimants have one attempt; human correction remains intact',async()=>{
 const store=memory();let sends=0;const send=async()=>{sends++;return{status:201};};
 const outcomes=await Promise.allSettled([deliver(payload,{store,send,nonce:'a'}),deliver(payload,{store,send,nonce:'b'})]);assert.equal(sends,1);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const corrected=memory();await assert.rejects(deliver(payload,{store:corrected,send:async()=>{corrected.correct();return{status:201};}}),/human correction/);assert.equal(corrected.record.state,'human-review');
});
test('ambiguous monthly create and accepted update responses remain blocking',async()=>{
 for(const phase of ['create','update']){
  const store=memory();const original=store[phase].bind(store);store[phase]=async(...args)=>{await original(...args);throw new Error('response lost');};let sends=0;
  await assert.rejects(deliver(payload,{store,send:async()=>{sends++;return{status:201};}}));
  await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,phase==='create'?0:1);
 }
});
test('September marker records existing verified send rather than a new acceptance',async()=>{
 const record=JSON.parse(await fs.readFile(new URL('../outbox/monthly-2026-09.json',import.meta.url),'utf8'));
 assert.equal(record.id,'monthly-2026-09');assert.equal(record.state,'accepted');assert.equal(record.evidence.kind,'historical-confirmed-send');assert.equal(record.evidence.githubRunId,'36929860159');assert.equal(record.evidence.gmailMessageId,'1a0f966ae002a007');assert.equal(record.providerMessageIdHash,hash('<202610012137.69932889144@smtp-relay.mailin.fr>'));assert.equal(record.payloadHash,null);
 const store=memory();let sends=0;await assert.rejects(deliver({...payload,period:'2026-09'},{store,now:()=> '2026-10-01T22:00:00Z',send:async()=>{sends++;}}),/no automatic replay/);assert.equal(store.creates,0);assert.equal(sends,0);
});
test('historical/current overrides and early first-of-month claims are dry-run-only',()=>{
 assert.doesNotThrow(()=>assertMonthlyDeliveryConfig({period:'2026-08',offset:-2,dryRun:true,now:'2026-10-01'}));
 assert.doesNotThrow(()=>assertMonthlyDeliveryConfig({period:'2026-10',offset:0,dryRun:true,now:'2026-10-01'}));
 assert.throws(()=>assertMonthlyDeliveryConfig({period:'2026-08',offset:-2,now:'2026-10-01'}),/dry-run-only/);
 assert.throws(()=>assertMonthlyDeliveryConfig({period:'2026-10',offset:0,now:'2026-10-01'}),/dry-run-only/);
 assert.throws(()=>assertMonthlyDeliveryConfig({period:'2026-10',now:'2026-11-01T16:59:59Z'}),/before/);
 assert.doesNotThrow(()=>assertMonthlyDeliveryConfig({period:'2026-10',now:'2026-11-01T17:00:00Z'}));
});
test('historical September dry preview reads shadow data but writes no claim or payload',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'monthly-shadow-fixture-')),outputDir=path.join(root,'output'),store=memory();let previews=0;
 const result=await prepareMonthlySummary({offset:-2,now:new Date('2026-11-01T22:00:00Z'),dryRun:true,store,logsDir:fileURLToPath(new URL('../logs/',import.meta.url)),outputDir,preview:async p=>{previews++;assert.equal(p.dryRun,true);assert.match(p.html,/Unique log rows/);assert.match(p.subject,/September 2026/);}});
 assert.equal(result.totals.total_revenue,2715);assert.equal(result.totals.unpaid_outstanding,735);assert.equal(result.prepared,false);assert.equal(store.reads,0);assert.equal(store.creates,0);assert.equal(previews,1);await assert.rejects(fs.stat(outputDir),{code:'ENOENT'});
});
test('monthly prepare produces payload from committed fixture logs without provider or ledger writes',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'monthly-prepare-fixture-')),logsDir=path.join(root,'logs'),outputDir=path.join(root,'output');await fs.mkdir(logsDir);await fs.writeFile(path.join(logsDir,'2026-10-30.md'),'## Appointments (1)\n- Fri, 10/30, 9:00 AM | Fixture | $70 | PAID_VENMO (matched Fixture, $70)\n## Summary\n- paid_venmo: 1\n');
 const store=memory();let previews=0;const result=await prepareMonthlySummary({offset:-1,now:new Date(fixedNow()),dryRun:false,store,sourceSha:payload.snapshotSha,logsDir,outputDir,preview:async()=>{previews++;}});
 assert.equal(result.prepared,true);assert.equal(store.creates,0);assert.equal(previews,0);const prepared=JSON.parse(await fs.readFile(path.join(outputDir,'monthly.json'),'utf8'));assert.equal(prepared.period,'2026-10');assert.equal(prepared.snapshotSha,payload.snapshotSha);assert.match(prepared.html,/Unique log rows/);assert.deepEqual(await fs.readdir(root),['logs','output']);
});
test('claimed monthly period blocks preparation before reading missing logs or writing payload',async()=>{
 const store=memory();await store.create('monthly-2026-10',{state:'pending'});
 await assert.rejects(prepareMonthlySummary({offset:-1,now:new Date(fixedNow()),dryRun:false,store,sourceSha:payload.snapshotSha,logsDir:'nonexistent-fixture-path'}),/claimed/);assert.equal(store.creates,1);
});
test('workflow guards no-data/dry-run sends and has no failure-email bypass',async()=>{
 const workflow=await fs.readFile(new URL('../../.github/workflows/monthly-summary.yml',import.meta.url),'utf8');assert.match(workflow,/cron: "0 17 1 \* \*"/);assert.match(workflow,/concurrency:\s*group: monthly-summary/);assert.match(workflow,/outputs.prepared == 'true'/);assert.match(workflow,/dry_run != 'true'/);assert.ok(workflow.indexOf('run: npm run monthly')<workflow.indexOf('run: node monthly-delivery.mjs'));
 const source=await fs.readFile(new URL('./monthly.mjs',import.meta.url),'utf8');assert.doesNotMatch(source.slice(source.indexOf('async function main()')),/sendBrevoEmail/);assert.match(source,/await preview\(\{\.\.\.payload,dryRun:true\}\)/);
});

test('read-only GitHub token denial fails closed before any monthly provider attempt',async()=>{
 let writes=0,sends=0;
 const store=githubDeliveryStore({token:'fixture-only',fetchFn:async(u,o)=>{if(o.method==='GET')return{status:404,ok:false};writes++;return{status:403,ok:false};}});
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/PUT unconfirmed \(403\)/);
 assert.equal(writes,1);assert.equal(sends,0);
});
test('no-data monthly preparation does not claim or create a stale delivery payload',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'monthly-empty-fixture-')),logsDir=path.join(root,'logs'),outputDir=path.join(root,'output');await fs.mkdir(logsDir);const store=memory();
 const result=await prepareMonthlySummary({offset:-1,now:new Date(fixedNow()),dryRun:false,store,sourceSha:payload.snapshotSha,logsDir,outputDir});
 assert.equal(result.prepared,false);assert.equal(store.creates,0);await assert.rejects(fs.stat(outputDir),{code:'ENOENT'});
});
