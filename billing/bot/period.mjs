import {fmtDateIsoPacific} from './lib.mjs';
const DAY=86400000;
function shift(iso,days){return new Date(Date.parse(`${iso}T12:00:00Z`)+days*DAY).toISOString().slice(0,10);}
function midnight(iso){
 // Resolve the Pacific offset on this date rather than assuming fixed PDT/PST.
 const base=Date.parse(`${iso}T00:00:00Z`);
 let result=base;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<3;i++){
  const p=Object.fromEntries(formatter.formatToParts(new Date(result)).map(x=>[x.type,x.value]));
  const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  result+=base-represented;
 }
 return new Date(result);
}
export function appointmentWindow({now=new Date(),days=5,periodEnd='',pacificWeek=false}={}){
 if(!Number.isInteger(Number(days)) || Number(days)<1 || Number(days)>31)throw new Error('Invalid appointment lookback');
 if(!pacificWeek && !periodEnd)return {start:new Date(now.getTime()-Number(days)*DAY),end:now};
 let friday=periodEnd;
 if(friday){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(friday) || shift(friday,0)!==friday || new Date(`${friday}T12:00:00Z`).getUTCDay()!==5)throw new Error('BILLING_PERIOD_END must be a valid Pacific Friday YYYY-MM-DD');
 }else{
  const today=fmtDateIsoPacific(now);const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();friday=shift(today,-((weekday+2)%7));
 }
 const start=midnight(shift(friday,1-Number(days)));
 const end=new Date(Math.min(midnight(shift(friday,1)).getTime()-1,now.getTime()));
 if(start>end)throw new Error('Billing period is in the future');
 return {start,end,periodEnd:friday};
}

// Receipt search and log naming remain execution-relative. Historical periods
// must not send or update a ledger until all evidence windows are anchored.
export function assertPeriodRerunConfig({periodEnd="",dryRun=false}={}) {
 if(periodEnd && !dryRun) throw new Error("Explicit BILLING_PERIOD_END is dry-run-only; historical receipt search and log identity are not anchored");
}
