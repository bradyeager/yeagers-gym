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
