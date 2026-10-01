import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import handler, {persistEvent} from './api/vagaro-webhook.js';
const raw=id=>JSON.stringify({id,type:'canary-fixture'});
function store(){const files=new Map();let puts=0;return {files,get puts(){return puts;},fetchFn:async(url,opts)=>{
 const id=new URL(url).pathname.split('/').at(-1);
 if(opts.method==='GET') return files.has(id)?{status:200,json:async()=>({encoding:'base64',content:Buffer.from(files.get(id)).toString('base64')})}:{status:404};
 puts++;if(files.has(id))return {status:422}; files.set(id,Buffer.from(JSON.parse(opts.body).content,'base64').toString());return {status:201};
}};}
const options=s=>({fetchFn:s.fetchFn,token:'fixture-only'});
test('create is read-confirmed, duplicate leaves one immutable file',async()=>{const s=store();assert.equal((await persistEvent('a',raw('a'),options(s))).status,'confirmed');assert.equal((await persistEvent('a',raw('a'),options(s))).status,'exists');assert.equal(s.files.size,1);assert.equal(s.puts,1);});
test('same-ID concurrency confirms one file; different IDs both persist',async()=>{const s=store();await Promise.all([persistEvent('a',raw('a'),options(s)),persistEvent('a',raw('a'),options(s)),persistEvent('b',raw('b'),options(s))]);assert.equal(s.files.size,2);});
test('lost PUT response is recovered by read before write',async()=>{const s=store();const fetchFn=async(u,o)=>{const result=await s.fetchFn(u,o);if(o.method==='PUT')throw new Error('lost response');return result;};await persistEvent('a',raw('a'),{token:'fixture',fetchFn});assert.equal(s.puts,1);});
test('500/503 retries read before writing and eventually confirms',async()=>{const s=store();let count=0;const fetchFn=async(u,o)=>{count++;if(count===1)return{status:503};if(count===3)return{status:500};return s.fetchFn(u,o);};await persistEvent('a',raw('a'),{token:'fixture',fetchFn});assert.equal(s.files.size,1);});
test('conflicting ID preserves original, including concurrency',async()=>{const s=store();const outcomes=await Promise.allSettled([persistEvent('a',raw('a'),options(s)),persistEvent('a','{"id":"a","different":true}',options(s))]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(s.files.get('a.json'),raw('a'));assert.equal(s.files.size,1);});
function req(body,signature='fixture'){const r=Readable.from([body]);r.method='POST';r.headers={'x-vagaro-signature':signature};return r;}
function res(){return{code:0,payload:null,status(code){this.code=code;return this;},json(p){this.payload=p;return this;}};}
test('wrong signature gives 401 with zero GitHub calls',async()=>{process.env.VAGARO_VERIFICATION_TOKEN='fixture';let calls=0;const original=global.fetch;global.fetch=async()=>{calls++;throw new Error();};try{const r=res();await handler(req(raw('a'),'wrong'),r);assert.equal(r.code,401);assert.equal(calls,0);}finally{global.fetch=original;}});
test('exhausted persistence gives non-2xx and fixed error only',async()=>{process.env.VAGARO_VERIFICATION_TOKEN='fixture';process.env.GITHUB_TOKEN='fixture';const original=global.fetch;global.fetch=async()=>({status:503});try{const r=res();await handler(req(raw('a')),r);assert.equal(r.code,503);assert.equal(r.payload.persisted,false);}finally{global.fetch=original;}});
test('timeouts are bounded even when fetch ignores abort',async()=>{const start=Date.now();await assert.rejects(persistEvent('a',raw('a'),{token:'fixture',fetchFn:()=>new Promise(()=>{}),budgetMs:60,requestMs:20}));assert.ok(Date.now()-start<300);});
test('invalid IDs and excessive body reject without GitHub calls',async()=>{process.env.VAGARO_VERIFICATION_TOKEN='fixture';const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw new Error();};try{for(const id of ['a/b','a.b',1,'', 'a'.repeat(129)]){const r=res();await handler(req(JSON.stringify({id})),r);assert.equal(r.code,400);}const r=res();await handler(req('a'.repeat(1024*1024+1)),r);assert.equal(r.code,413);assert.equal(calls,0);}finally{global.fetch=original;}});

test('deterministic exponential jitter separates transient requests',async()=>{
 let clock=0;const delays=[];let calls=0;const s=store();
 const fetchFn=async(u,o)=>{calls++;return calls<=2?{status:503}:s.fetchFn(u,o);};
 await persistEvent('a',raw('a'),{token:'fixture',fetchFn,now:()=>clock,random:()=>0,sleep:async ms=>{delays.push(ms);clock+=ms;}});
 assert.deepEqual(delays,[75,150]);assert.equal(s.files.size,1);
});
test('Retry-After seconds and HTTP-date respected within deadline',async()=>{
 for(const value of ['1',new Date(2000).toUTCString()]){
  let clock=0;let calls=0;const delays=[];const s=store();
  const fetchFn=async(u,o)=>++calls===1?{status:429,headers:{get:()=>value}}:s.fetchFn(u,o);
  await persistEvent('a',raw('a'),{token:'fixture',fetchFn,now:()=>clock,random:()=>1,sleep:async ms=>{delays.push(ms);clock+=ms;}});
  assert.equal(delays[0],value==='1'?1000:2000);
 }
});
test('Retry-After beyond overall budget fails without retrying early',async()=>{
 let calls=0;let sleeps=0;
 await assert.rejects(persistEvent('a',raw('a'),{token:'fixture',budgetMs:7500,now:()=>0,fetchFn:async()=>{calls++;return{status:503,headers:{get:()=> '10'}};},sleep:async()=>{sleeps++;}}),/unconfirmed/);
 assert.equal(calls,1);assert.equal(sleeps,0);
});

test('different IDs recover from branch-tip 409 contention',async()=>{
 const s=store();let raced=false;const fetchFn=async(u,o)=>{if(o.method==='PUT' && !raced){raced=true;return{status:409};}return s.fetchFn(u,o);};
 await Promise.all(['a','b'].map(id=>persistEvent(id,raw(id),{token:'fixture',fetchFn,random:()=>0,sleep:async()=>{}})));assert.equal(s.files.size,2);
});
test('ambiguous PUT with delayed visibility confirms without overwriting',async()=>{
 const s=store();let hide=0;const fetchFn=async(u,o)=>{if(o.method==='GET' && hide-->0)return{status:503};const r=await s.fetchFn(u,o);if(o.method==='PUT'){hide=1;throw new Error('lost response');}return r;};
 await persistEvent('a',raw('a'),{token:'fixture',fetchFn,sleep:async()=>{}});assert.equal(s.puts,1);
});
test('legacy CRLF event bytes match only identical immutable raw content',async()=>{
 const s=store();const legacy='{\r\n"id":"a"\r\n}';s.files.set('a.json',legacy);
 await persistEvent('a',legacy,options(s));await assert.rejects(persistEvent('a',legacy.replaceAll('\r',''),options(s)),/immutable_conflict/);assert.equal(s.puts,0);
});
test('final PUT can persist but return uncertainty; safe redelivery confirms it',async()=>{
 const s=store();let calls=0;const fetchFn=async(u,o)=>{calls++;if(calls<4 && o.method==='GET')return{status:503};return s.fetchFn(u,o);};
 await assert.rejects(persistEvent('a',raw('a'),{token:'fixture',fetchFn,sleep:async()=>{}}),/unconfirmed/);assert.equal(s.files.size,1);
 await persistEvent('a',raw('a'),options(s));assert.equal(s.puts,1);
});
test('missing verification token and malformed JSON never touch GitHub',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw new Error();};
 try{delete process.env.VAGARO_VERIFICATION_TOKEN;let r=res();await handler(req(raw('a')),r);assert.equal(r.code,401);process.env.VAGARO_VERIFICATION_TOKEN='fixture';r=res();await handler(req('{'),r);assert.equal(r.code,400);assert.equal(calls,0);}finally{global.fetch=original;}
});
test('exact size boundary accepts body, larger body rejects; slow body is transient 408',async()=>{
 process.env.VAGARO_VERIFICATION_TOKEN='fixture';process.env.GITHUB_TOKEN='fixture';const original=global.fetch;const s=store();global.fetch=s.fetchFn;
 try{
  const prefix='{"id":"boundary","padding":"',suffix='"}';const body=prefix+'x'.repeat(1024*1024-Buffer.byteLength(prefix+suffix))+suffix;let r=res();await handler(req(body),r);assert.equal(r.code,200);assert.equal(s.files.size,1);
  r=res();await handler(req(body+' '),r);assert.equal(r.code,413);
  const slow={method:'POST',headers:{'x-vagaro-signature':'fixture'},[Symbol.asyncIterator](){return{next:()=>new Promise(()=>{})};}};r=res();await handler(slow,r);assert.equal(r.code,408);
 }finally{global.fetch=original;}
});
