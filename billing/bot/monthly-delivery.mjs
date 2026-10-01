// Monthly reports use distinct durable identities and the reviewed shared claim.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {claimAndSendReport,githubDeliveryStore} from './delivery.mjs';
import {sendBrevoEmail} from './lib.mjs';
export function monthlyIdentity(period) {
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period || ''))throw new Error('Monthly period must be YYYY-MM');
 return `monthly-${period}`;
}
export function assertMonthlyDeliveryConfig({period,offset=-1,dryRun=false,now=new Date()}={}) {
 const id=monthlyIdentity(period);
 if(!Number.isInteger(Number(offset)))throw new Error('Monthly offset must be an integer');
 if(dryRun)return id;
 const time=new Date(now);
 if(!Number.isFinite(time.getTime()))throw new Error('Monthly clock invalid');
 const previous=new Date(Date.UTC(time.getUTCFullYear(),time.getUTCMonth()-1,1)).toISOString().slice(0,7);
 if(Number(offset)!==-1 || period!==previous)throw new Error('Historical/current monthly overrides are dry-run-only');
 // September was already sent before monthly claims existed. This independent
 // cutoff prevents replay even if its historical evidence marker is unavailable.
 if(period<'2026-10')throw new Error('Pre-outbox monthly period already handled; no automatic replay');
 const [year,month]=period.split('-').map(Number);
 const cutoff=new Date(Date.UTC(year,month,1,17));
 if(time<cutoff)throw new Error('Monthly claim blocked before the existing first-of-month 17:00 UTC schedule');
 return id;
}
export async function assertNoPriorMonthlyDelivery(period,store,options={}) {
 const id=assertMonthlyDeliveryConfig({period,...options});
 if(await store.read(id))throw new Error('Monthly delivery already claimed; no automatic resend');
 return id;
}
export async function deliverMonthly(payload,options={}) {
 const now=options.now || (()=>new Date().toISOString());
 const id=assertMonthlyDeliveryConfig({period:payload.period,offset:payload.monthOffset,now:now()});
 return claimAndSendReport(id,payload,{...options,now});
}
async function main(){
 const payload=JSON.parse(await fs.readFile(new URL('./.delivery/monthly.json',import.meta.url),'utf8'));
 if(!/^[a-f0-9]{40}$/.test(payload.snapshotSha || ''))throw new Error('Committed monthly evidence unconfirmed');
 if(!process.env.BREVO_API_KEY)throw new Error('Provider configuration unavailable');
 await deliverMonthly(payload,{store:githubDeliveryStore(),send:p=>sendBrevoEmail({...p,apiKey:process.env.BREVO_API_KEY,signal:AbortSignal.timeout(30000)})});
 console.log('Monthly provider acceptance recorded; delivery itself is not confirmed');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Monthly delivery blocked or uncertain; inspect outbox and provider evidence; no automatic resend');process.exitCode=1;});
