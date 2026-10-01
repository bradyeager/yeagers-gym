import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {deliverWeekly,deliveryIdentity,assertNoPriorDelivery,assertDeliveryCutoff} from './delivery.mjs';
const fixtureNow=()=>"2026-10-03T04:17:00.000Z";
const deliver=(payload,options)=>deliverWeekly(payload,{now:fixtureNow,...options});
const payload={periodEnd:'2026-10-02',subject:'fixture',html:'fixture'};
function memory(){let current=null;let version=0;return {async read(){return current?{sha:String(version),record:structuredClone(current)}:null;},async create(id,r){if(current)throw new Error('race');current=structuredClone(r);version++;},async update(id,r,sha){if(String(version)!==sha)throw new Error('correction conflict');current=structuredClone(r);version++;},get record(){return current;},correct(){current={...current,state:'human-review'};version++;}};}
test('durable claim before single provider attempt; accepted state blocks rerun',async()=>{
 const store=memory();let sends=0;
 await deliver(payload,{store,send:async()=>{sends++;assert.equal(store.record.state,'pending');return{status:201,messageId:'fixture'};}});
 assert.equal(store.record.state,'accepted');await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/already claimed/);assert.equal(sends,1);
});
test('crash after intent, before send, blocks automatic rerun',async()=>{
 const store=memory();let reads=0;const original=store.read;
 store.read=async()=>{if(++reads===2)throw new Error('crash');return original();};
 await assert.rejects(deliver(payload,{store,send:async()=>assert.fail('must not send')}),/crash/);
 store.read=original;await assert.rejects(assertNoPriorDelivery(payload.periodEnd,store,{now:fixtureNow()}),/claimed/);assert.equal(store.record.state,'pending');
});
test('provider accepted but receipt commit failed cannot send twice',async()=>{
 const store=memory();let sends=0;store.update=async()=>{throw new Error('commit failed');};
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;return{status:201,messageId:'fixture'};}}),/commit failed/);
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,1);assert.equal(store.record.state,'pending');
});
test('provider timeout/response loss remains uncertain and blocks resend',async()=>{
 const store=memory();let sends=0;
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;throw new Error('response lost');}}));
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}),/claimed/);assert.equal(sends,1);
});
test('concurrent claimants attempt provider once; human correction is preserved',async()=>{
 const store=memory();let sends=0;
 const results=await Promise.allSettled([deliver(payload,{store,nonce:'a',send:async()=>{sends++;return{status:201};}}),deliver(payload,{store,nonce:'b',send:async()=>{sends++;return{status:201};}})]);
 assert.equal(sends,1);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const corrected=memory();await assert.rejects(deliver(payload,{store:corrected,send:async()=>{corrected.correct();return{status:201};}}),/correction conflict/);assert.equal(corrected.record.state,'human-review');
});
test('ambiguous claim creation never permits a provider attempt',async()=>{
 const store=memory();const create=store.create;store.create=async(id,r)=>{await create(id,r);throw new Error('lost create response');};let sends=0;
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}));assert.equal(sends,0);assert.equal(store.record.state,'pending');
});
test('lost acceptance write response remains blocking even if write persisted',async()=>{
 const store=memory();const update=store.update;store.update=async(...args)=>{await update(...args);throw new Error('lost response');};let sends=0;
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;return{status:201};}}));
 await assert.rejects(deliver(payload,{store,send:async()=>{sends++;}}));assert.equal(sends,1);assert.equal(store.record.state,'accepted');
});
test('pre-outbox historical periods are never automatically emailed',()=>{assert.throws(()=>deliveryIdentity('2026-09-25'),/Pre-outbox/);assert.equal(deliveryIdentity('2026-10-02'),'weekly-schedule-ical-2026-10-02');});
test('workflow persists data before guarded dispatch and blocks remote evidence changes',async()=>{
 const workflow=await fs.readFile(new URL('../../.github/workflows/weekly-billing.yml',import.meta.url),'utf8');
 assert.ok(workflow.indexOf('git push origin HEAD:main')<workflow.indexOf('run: node delivery.mjs'));
 assert.match(workflow,/Billing evidence changed remotely; delivery blocked/);
 assert.match(workflow,/BILLING_SNAPSHOT_SHA=/);
 const source=await fs.readFile(new URL('./billing.mjs',import.meta.url),'utf8');const main=source.slice(source.indexOf('async function main() {'));
 assert.match(main,/dryRun: true/);assert.doesNotMatch(main.slice(main.indexOf("const payload =")),/dryRun: DRY_RUN ===/);assert.ok(main.indexOf('assertNoPriorDelivery')<main.indexOf('saveMatchedLedger'));
});

test('existing production log and human corrections are never overwritten',async()=>{
 const {mkdtemp,readdir,readFile,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {writeLog}=await import('./billing.mjs');const dir=await mkdtemp(join(tmpdir(),'billing-log-fixture-'));
 const args={appointments:[],payments:[],results:[],unmatchedPayments:[],logsDir:dir,dryRun:false};
 const {file}=await writeLog(args);await writeFile(file,'human correction');await assert.rejects(writeLog(args),{code:'EEXIST'});assert.equal(await readFile(file,'utf8'),'human correction');assert.equal((await readdir(dir)).length,1);
});

test('real snapshot script preserves raw events and blocks concurrent human ledger changes',async()=>{
 const {execFileSync,spawnSync}=await import('node:child_process');const {mkdtemp,mkdir,writeFile,readFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const workflow=await readFile(new URL('../../.github/workflows/weekly-billing.yml',import.meta.url),'utf8');
 const section=workflow.slice(workflow.indexOf('      - name: Persist weekly log'),workflow.indexOf('      - name: Claim weekly delivery'));
 const script=section.slice(section.indexOf('        run: |')+'        run: |'.length).trimStart().split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const bash=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'bash';
 for(const kind of ['raw','human']){
  const root=await mkdtemp(join(tmpdir(),'billing-snapshot-fixture-'));const remote=join(root,'remote.git'),checkout=join(root,'checkout'),writer=join(root,'writer');
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:'pipe'}).trim();
  git(root,'init','--bare',remote);await mkdir(checkout);git(checkout,'init','-b','main');git(checkout,'config','user.name','Fixture');git(checkout,'config','user.email','fixture@example.invalid');
  await mkdir(join(checkout,'billing','logs'),{recursive:true});await writeFile(join(checkout,'billing','matched-payments.json'),'[]');git(checkout,'add','billing');git(checkout,'commit','-m','fixture initial');git(checkout,'remote','add','origin',remote);git(checkout,'push','-u','origin','main');git(root,'clone','--branch','main',remote,writer);git(writer,'config','user.name','Fixture');git(writer,'config','user.email','fixture@example.invalid');
  if(kind==='raw'){await mkdir(join(writer,'billing','vagaro-events'),{recursive:true});await writeFile(join(writer,'billing','vagaro-events','fixture.json'),'{}');}else await writeFile(join(writer,'billing','matched-payments.json'),'["human correction"]');
  git(writer,'add','billing');git(writer,'commit','-m','fixture remote change');git(writer,'push','origin','main');
  await writeFile(join(checkout,'billing','logs','fixture.md'),'prepared fixture');await writeFile(join(checkout,'billing','matched-payments.json'),'["prepared receipt"]');
  const environment=join(root,'environment.txt');const result=spawnSync(bash,['-e','-c',script],{cwd:checkout,encoding:'utf8',env:{...process.env,GITHUB_ENV:environment.replaceAll('\\','/')}});
  if(kind==='raw'){
   assert.equal(result.status,0,result.stderr);assert.match(await readFile(environment,'utf8'),/BILLING_SNAPSHOT_SHA=[a-f0-9]{40}/);
   assert.equal(git(remote,'show','main:billing/vagaro-events/fixture.json'),'{}');assert.equal(git(remote,'show','main:billing/matched-payments.json'),'["prepared receipt"]');
  }else{
   assert.notEqual(result.status,0);assert.match(result.stdout,/delivery blocked/);assert.equal(git(remote,'show','main:billing/matched-payments.json'),'["human correction"]');await assert.rejects(readFile(environment),{code:'ENOENT'});
  }
 }
});

test('early Friday cannot read/create a claim or attempt provider delivery',async()=>{
 for(const now of ['2026-10-02T17:00:00Z','2026-10-03T04:16:59Z']) {
  let reads=0,creates=0,sends=0;
  const store={read:async()=>{reads++;return null;},create:async()=>{creates++;}};
  await assert.rejects(deliverWeekly(payload,{store,now:()=>now,send:async()=>{sends++;}}),/before the scheduled Friday cutoff/);
  assert.equal(reads,0);assert.equal(creates,0);assert.equal(sends,0);
 }
});
test('scheduled cutoff follows existing UTC cron across Pacific DST',()=>{
 assert.equal(assertDeliveryCutoff('2026-10-02','2026-10-02T21:17:00-07:00').toISOString(),'2026-10-03T04:17:00.000Z');
 assert.throws(()=>assertDeliveryCutoff('2026-10-02','2026-10-02T21:16:59-07:00'),/cutoff/);
 assert.equal(assertDeliveryCutoff('2026-11-06','2026-11-06T20:17:00-08:00').toISOString(),'2026-11-07T04:17:00.000Z');
 assert.throws(()=>assertDeliveryCutoff('2026-11-06','2026-11-06T20:16:59-08:00'),/cutoff/);
});
test('late Saturday and a prior completed period remain eligible but existing claims block',async()=>{
 for(const now of ['2026-10-03T19:00:00Z','2026-10-09T17:00:00Z']) {
  const store=memory();let sends=0;
  await deliverWeekly(payload,{store,now:()=>now,send:async()=>{sends++;return{status:201};}});
  await assert.rejects(deliverWeekly(payload,{store,now:()=>now,send:async()=>{sends++;}}),/claimed/);
  assert.equal(sends,1);
 }
});
