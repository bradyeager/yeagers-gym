// Verify signature, then durably create immutable raw events. Never update originals.
export const config = { api: { bodyParser: false } };
const MAX_BODY = 1024 * 1024;
const BUDGET_MS = 7500;
const REQUEST_MS = 1400;
const transient = status => status === 408 || status === 429 || status >= 500;
class Conflict extends Error {}
async function bounded(work, ms) {
 const controller = new AbortController();
 let timer;
 try {
  return await Promise.race([work(controller.signal), new Promise((_,reject)=>{
   timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},ms);
  })]);
 } finally { clearTimeout(timer); }
}
async function readRawBody(req) {
 const chunks=[]; let bytes=0;
 for await(const chunk of req) {
  const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  bytes+=data.length;
  if(bytes>MAX_BODY) throw new Error('body_too_large');
  chunks.push(data);
 }
 return Buffer.concat(chunks).toString('utf8');
}
export async function persistEvent(id, raw, {fetchFn=fetch, token=process.env.GITHUB_TOKEN, budgetMs=BUDGET_MS, requestMs=REQUEST_MS, now=Date.now, random=Math.random, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 if(!token) throw new Error('configuration');
 const deadline=now()+budgetMs;
 const url=`https://api.github.com/repos/bradyeager/yeagers-gym/contents/billing/vagaro-events/${id}.json`;
 const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'yg-vagaro-webhook'};
 const request=async(method)=> {
  const remaining=deadline-now();
  if(remaining<=0) throw new Error('budget');
  return bounded(async signal=>{
   const response=await fetchFn(method==='GET'?`${url}?ref=main`:url,{
    method,headers:{...headers,'Content-Type':'application/json'},signal,
    ...(method==='PUT'?{body:JSON.stringify({message:`vagaro: ${id}`,content:Buffer.from(raw).toString('base64'),branch:'main'})}:{})
   });
   // Include body consumption in timeout; errors never log response content.
   const data=response.status===200 && method==='GET'?await response.json():null;
   return {status:response.status,data,retryAfter:response.headers?.get?.("retry-after")};
  },Math.min(requestMs,remaining));
 };
 let attempted=false;
 let retry=false;
 let retryAfter=null;
 for(let attempt=0;attempt<4 && now()<deadline;attempt++) {
  if(retry) {
   const base=Math.min(1200,150*2**(attempt-1));
   const jitter=base/2+Math.max(0,Math.min(1,random()))*base/2;
   const numeric=retryAfter!=null && /^\d+(?:\.\d+)?$/.test(retryAfter)?Number(retryAfter)*1000:null;
   const serverDelay=numeric ?? (retryAfter?Math.max(0,Date.parse(retryAfter)-now()):0);
   const delay=Math.max(jitter,Number.isFinite(serverDelay)?serverDelay:0);
   // Never shorten Retry-After to squeeze another request into our budget.
   if(delay>=deadline-now()) throw new Error("unconfirmed");
   await sleep(delay);
  }
  retry=false; retryAfter=null;
  try {
   const head=await request('GET');
   if(head.status===200) {
    if(head.data?.encoding!=='base64' || typeof head.data.content!=='string') throw new Error('unconfirmed');
    if(Buffer.from(head.data.content,'base64').toString('utf8')!==raw) throw new Conflict('immutable_conflict');
    return {status:attempted?'confirmed':'exists'};
   }
   if(head.status!==404) {if(transient(head.status)) {retry=true;retryAfter=head.retryAfter;continue;}throw new Error('read_failed');}
   attempted=true;
   const put=await request('PUT');
   // Every success, race or ambiguous response is confirmed by GET next.
   retry=![200,201].includes(put.status); retryAfter=put.retryAfter;
   if(![200,201,409,422].includes(put.status) && !transient(put.status)) throw new Error('write_failed');
  } catch(error) {
   retry=true;
   if(error instanceof Conflict) throw error;
   if(['configuration','read_failed','write_failed'].includes(error.message)) throw error;
  }
 }
 throw new Error('unconfirmed');
}
export default async function handler(req,res) {
 if(req.method==='GET') return res.status(200).json({ok:true,service:'yg-vagaro-webhook',phase:2,time:new Date().toISOString()});
 if(req.method!=='POST') return res.status(405).json({error:'method not allowed'});
 const expected=process.env.VAGARO_VERIFICATION_TOKEN;
 if(!expected || req.headers['x-vagaro-signature']!==expected) return res.status(401).json({error:'invalid or missing signature'});
 const deadline=Date.now()+BUDGET_MS;
 let raw;
 try {raw=await bounded(()=>readRawBody(req),Math.min(1000,BUDGET_MS));}
 catch(error){return res.status(error.message==='body_too_large'?413:error.message==='timeout'?408:400).json({error:'bad body'});}
 let envelope;
 try {envelope=JSON.parse(raw);} catch {return res.status(400).json({error:'bad JSON'});}
 if(typeof envelope?.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.id)) return res.status(400).json({error:'invalid envelope id'});
 try {
  const result=await persistEvent(envelope.id,raw,{budgetMs:Math.max(1,deadline-Date.now())});
  return res.status(200).json({received:true,persisted:true,status:result.status});
 } catch(error) {
  // Fixed codes only: no bodies, IDs, response content or credentials in logs.
  console.error('webhook persistence unconfirmed');
  return res.status(error instanceof Conflict?409:503).json({received:true,persisted:false,error:error instanceof Conflict?'immutable_conflict':'persist_failed'});
 }
}
