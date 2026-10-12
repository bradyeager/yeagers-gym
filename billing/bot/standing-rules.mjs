import {readFileSync} from 'node:fs';
import {fmtDateIsoPacific, cancellationMatches} from './lib.mjs';
export const standingRules = JSON.parse(readFileSync(new URL('../standing-rules.json', import.meta.url),'utf8'));
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
export function prepaidForAppointment(client,date) {
 const period=Object.entries(standingRules.prepaid_periods).find(([name])=>same(name,client.vagaro_name))?.[1];
 const day=fmtDateIsoPacific(date);
 return Boolean(client.prepaid && (!period || (day>=period.start && day<=period.end)));
}
export function applyStandingRules(appointments,cancellations=[]) {
 const out=appointments.map(a=>same(a.client_name,standingRules.michelle_second_weekly_session_free) || same(a.client_name,standingRules.katelin_monday.client) || standingRules.unclassified_excess.some(r=>same(r.client,a.client_name)) ? {...a} : a);
 const groups=new Map();
 for(const a of out) {
  const day=fmtDateIsoPacific(a.date);const weekday=new Date(day+'T12:00:00Z').getUTCDay();
  const reference=standingRules.reference_only_receipts.find(r=>same(r.client,a.client_name)&&r.unapplied_to===day);
  if(reference)a.standing_reference=`Unapplied reference only: Monday ${reference.receipt_date} $${reference.amount}, memo ${reference.memo}, transaction ${reference.transaction_id}; NOT coverage for this appointment`;
  const excess=standingRules.unclassified_excess.find(r=>same(r.client,a.client_name)&&r.date===day);
  if(excess)a.standing_reference=`Received $${excess.received}; documented service $${excess.documented_service}; extra $${excess.amount} unclassified. No tip, credit, allocation or rate change authorized`;
  if(same(a.client_name,standingRules.katelin_monday.client) && weekday===1) a.standing_price=standingRules.katelin_monday.price;
  if(!same(a.client_name,standingRules.michelle_second_weekly_session_free))continue;
  // Pacific Monday anchors the weekly ordinal; cancellation history is not a session.
  if(cancellations.some(c=>cancellationMatches(c,a.date,a.client_name)))continue;
  const week=new Date(Date.parse(day+'T12:00:00Z')-((weekday+6)%7)*86400000).toISOString().slice(0,10);
  if(!groups.has(week))groups.set(week,[]);groups.get(week).push(a);
 }
 for(const group of groups.values()) {
  // Ambiguous mirror identity/order cannot establish which session is second.
  if(group.some(a=>a.calendar_review||a.unidentified))continue;
  group.sort((a,b)=>a.date-b.date);
  if(group[1] && +group[0].date!==+group[1].date)group[1].standing_free=true;
 }
 return out;
}
export const sessionPrice=(a,c)=>a.standing_price ?? a.vagaroAmount ?? a.price_override ?? c.default_price;
