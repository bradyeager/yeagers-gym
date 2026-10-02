// Durable weekly email claim. No automatic retry after a provider attempt.
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {sendBrevoEmail} from './lib.mjs';
export const hash = value=>createHash('sha256').update(value).digest('hex');
export function deliveryIdentity(periodEnd) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd || '') || new Date(`${periodEnd}T12:00:00Z`).toISOString().slice(0,10)!==periodEnd || new Date(`${periodEnd}T12:00:00Z`).getUTCDay()!==5) throw new Error('Delivery requires a valid Pacific Friday');
 // Earlier periods may already have been emailed without an outbox marker.
 if(periodEnd<'2026-10-02') throw new Error('Pre-outbox billing period cannot be sent automatically');
 return `weekly-schedule-ical-${periodEnd}`;
}
export function githubDeliveryStore({token=process.env.GITHUB_TOKEN,fetchFn=fetch}={}) {
 if(!token)throw new Error('Durable delivery token unavailable');
 const request=async(id,method,body)=>{
  const url=`https://api.github.com/repos/bradyeager/yeagers-gym/contents/billing/outbox/${id}.json${method==='GET'?'?ref=main':''}`;
  const response=await fetchFn(url,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},signal:AbortSignal.timeout(10000),...(body?{body:JSON.stringify(body)}:{})});
  if(method==='GET' && response.status===404)return null;
  if(!response.ok)throw new Error(`Delivery store ${method} unconfirmed (${response.status})`);
  return response.json();
 };
 const read=async(id)=>{
  const file=await request(id,'GET');if(!file)return null;
  if(file.encoding!=='base64' || !file.sha)throw new Error('Delivery record unreadable');
  return {sha:file.sha,record:JSON.parse(Buffer.from(file.content,'base64').toString('utf8'))};
 };
 const put=async(id,record,sha)=>request(id,'PUT',{message:`billing delivery state: ${id}`,branch:'main',content:Buffer.from(JSON.stringify(record,null,2)+'\n').toString('base64'),...(sha?{sha}:{})});
 return {read,create:(id,record)=>put(id,record),update:(id,record,sha)=>put(id,record,sha)};
}
export function assertDeliveryCutoff(periodEnd, now = new Date()) {
 deliveryIdentity(periodEnd);
 // Existing cron: Saturday 04:17 UTC. This is Friday 21:17 PDT /
 // 20:17 PST; keep that policy rather than assuming a fixed local hour.
 const cutoff = new Date(Date.parse(`${periodEnd}T04:17:00Z`) + 86400000);
 if(!Number.isFinite(new Date(now).getTime()) || new Date(now) < cutoff) throw new Error("Weekly delivery cannot be claimed before the scheduled Friday cutoff");
 return cutoff;
}
export async function assertNoPriorDelivery(periodEnd,store,{now=new Date()}={}) {
 const id=deliveryIdentity(periodEnd);
 assertDeliveryCutoff(periodEnd,now);
 if(await store.read(id))throw new Error('Weekly delivery already claimed; no automatic resend');
 return id;
}
// Shared atomic claim/attempt logic; cadence-specific eligibility stays in wrappers.
export async function claimAndSendReport(id,payload,{store,send,nonce=randomUUID(),now=()=>new Date().toISOString()}={}) {
 if(await store.read(id))throw new Error("Report delivery already claimed; no automatic resend");
 const pending={version:1,id,state:'pending',nonce,createdAt:now(),payloadHash:hash(JSON.stringify(payload)),snapshotSha:payload.snapshotSha || null,runId:process.env.GITHUB_RUN_ID || null};
 // A crash before/after create leaves either no provider attempt or a blocking
 // pending record. An ambiguous create response never permits sending.
 await store.create(id,pending);
 const confirmed=await store.read(id);
 if(!confirmed || confirmed.record.nonce!==nonce || confirmed.record.state!=='pending' || confirmed.record.payloadHash!==pending.payloadHash)throw new Error('Report claim unconfirmed; no send');
 // Exactly one attempt in this invocation. Errors/timeouts leave pending.
 const receipt=await send(payload);
 if(!receipt || receipt.status<200 || receipt.status>=300)throw new Error('Provider acceptance unconfirmed; pending claim retained');
 const accepted={...pending,state:'accepted',acceptedAt:now(),providerStatus:receipt.status,providerMessageIdHash:receipt.messageId?hash(receipt.messageId):null};
 // Only replace our own pending claim using its exact SHA. If a human changed
 // it or the update response is lost, do not send again or overwrite corrections.
 await store.update(id,accepted,confirmed.sha);
 const saved=await store.read(id);
 if(!saved || saved.record.nonce!==nonce || saved.record.state!=='accepted')throw new Error('Provider may have accepted; durable acceptance unconfirmed; no resend');
 return accepted;
}
export async function deliverWeekly(payload,options={}) {
 const now=options.now || (()=>new Date().toISOString());
 assertDeliveryCutoff(payload.periodEnd,now());
 return claimAndSendReport(deliveryIdentity(payload.periodEnd),payload,{...options,now});
}
async function main(){
 if(!/^[a-f0-9]{40}$/.test(process.env.BILLING_SNAPSHOT_SHA || ""))throw new Error("Durable billing snapshot unconfirmed");
 const payload=JSON.parse(await fs.readFile(new URL('./.delivery/weekly.json',import.meta.url),'utf8'));
 payload.snapshotSha=process.env.BILLING_SNAPSHOT_SHA;
 if(!process.env.BREVO_API_KEY)throw new Error('Provider configuration unavailable');
 await deliverWeekly(payload,{store:githubDeliveryStore(),send:p=>sendBrevoEmail({...p,apiKey:process.env.BREVO_API_KEY,signal:AbortSignal.timeout(30000)})});
 console.log('Weekly provider acceptance recorded; delivery itself is not confirmed');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Weekly delivery blocked or uncertain; inspect durable outbox and Actions; do not rerun sending automatically');process.exitCode=1;});
