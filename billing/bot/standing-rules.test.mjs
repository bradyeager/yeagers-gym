import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcile} from './billing.mjs';
import {applyStandingRules,prepaidForAppointment,standingRules} from './standing-rules.mjs';
import {loadClients} from './lib.mjs';
import {fileURLToPath} from 'node:url';
import {loadCancellations, cancellationMatches} from './lib.mjs';
import {parseCalendarSource} from './calendar-source.mjs';
import {loadCalendarEmailIdentities} from './calendar-email-identities.mjs';
const client=(name,extra={})=>({vagaro_name:name,default_price:70,acceptable_prices:[],venmo_display_names:[name],prepaid:false,pays_cash:false,...extra});
const appt=(name,day,extra={})=>({client_name:name,date:new Date(day+'T17:00:00Z'),...extra});

test('exact Monday identity only; similar names and Wednesday keep their approved prices',()=>{
 const a=applyStandingRules([appt('Katelin Lowther','2026-10-12'),appt('Caitlin Lowther','2026-10-12'),
 appt('Kate Lowther','2026-10-12'),appt('Katelin Lowther','2026-10-14')]);
 assert.equal(a[0].standing_price,25);assert.ok(a.slice(1).every(x=>x.standing_price===undefined));
});

test('published scoped cancellation affects exact Katelin time only, preserving participants and later session',async()=>{
 const cancellations=await loadCancellations(fileURLToPath(new URL('../../',import.meta.url)));
 const c=cancellations.find(c=>c.date==='2026-10-12'&&c.name==='Katelin Lowther');
 assert.equal(c.time_pacific,'09:00');
 assert.equal(cancellationMatches(c,new Date('2026-10-12T16:00:00Z'),'Katelin Lowther'),true);
 assert.equal(cancellationMatches(c,new Date('2026-10-12T17:00:00Z'),'Katelin Lowther'),false);
 assert.equal(cancellationMatches(c,new Date('2026-10-12T16:00:00Z'),'Anna Cessna'),false);
 const n='Katelin Lowther';const a=[appt(n,'2026-10-12',{date:new Date('2026-10-12T16:00:00Z')}),
 appt(n,'2026-10-12',{date:new Date('2026-10-12T17:00:00Z')})];
 const r=reconcile(a,[],[client(n,{default_price:45})],[],cancellations);
 assert.equal(r.results[0].status,'CANCELLED');assert.notEqual(r.results[1].status,'CANCELLED');
});

test('cancelled first Michelle slot does not remove a separate later first session from weekly ordinal',()=>{
 const n='michelle Delorenza';const a=[appt(n,'2026-10-12',{date:new Date('2026-10-12T16:00:00Z')}),
 appt(n,'2026-10-12',{date:new Date('2026-10-12T17:00:00Z')}),appt(n,'2026-10-14')];
 const r=applyStandingRules(a,[{date:'2026-10-12',name:n,time_pacific:'09:00'}]);
 assert.ok(!r[0].standing_free&&!r[1].standing_free);assert.equal(r[2].standing_free,true);
});

test('PR33 approved source identity loader and parser remain available with standing rules',async()=>{
 const clients=await loadClients(fileURLToPath(new URL('../clients.csv',import.meta.url)));
 const map=await loadCalendarEmailIdentities(fileURLToPath(new URL('../calendar-email-identities.json',import.meta.url)),clients);
 assert.equal(map['30d162377f2880328b46500c44359edfa16bd028f343f7518f4da2ff00e20d33'][0],'Anna Cessna');
 assert.equal(typeof parseCalendarSource,'function');
});
test('Michelle second distinct session is free; future attendance remains unproved and other weeks reset',()=>{
 const c=client('michelle Delorenza');const a=[appt(c.vagaro_name,'2026-10-06'),appt(c.vagaro_name,'2026-10-07'),appt(c.vagaro_name,'2026-10-13')];
 const r=reconcile(a,[],[c],[]);
 assert.deepEqual(r.results.map(x=>x.status),['UNPAID','PAID_PREPAID','UNPAID']);assert.equal(r.results[1].checkoutAmount,0);assert.equal(r.results[1].standingFree,true);assert.equal(r.newMatches.length,0);assert.ok(a.every(x=>!x.standing_free&&!x.attendance_proven));
});
test('cancelled first session and ambiguous duplicate do not manufacture a free session',()=>{
 const n='michelle Delorenza';const a=[appt(n,'2026-10-06'),appt(n,'2026-10-07')];
 assert.ok(applyStandingRules(a,[{date:'2026-10-06',name:n}]).every(x=>!x.standing_free));
 assert.ok(applyStandingRules([a[0],{...a[1],calendar_review:'duplicate'}]).every(x=>!x.standing_free));
});
test('Robert prepaid is scoped to 2026 Pacific date, not 2027',()=>{
 const c=client('Robert Brower',{prepaid:true});assert.equal(prepaidForAppointment(c,new Date('2027-01-01T07:59:59Z')),true);assert.equal(prepaidForAppointment(c,new Date('2027-01-01T08:00:00Z')),false);
 const r=reconcile([appt(c.vagaro_name,'2027-01-04')],[],[c],[]);assert.equal(r.results[0].status,'UNPAID');
});
test('Katelin Monday $25 matches Monday only; Wednesday pair remains $50 with unapplied reference note',()=>{
 const n='Katelin Lowther',c=client(n,{default_price:45,acceptable_prices:[45,50],venmo_display_names:['katie lowther']});
 const payments=[{gmail_id:'fixture-only',sender_display_name:'katie lowther',amount:25,note:'9.28',noteDate:new Date('2026-09-28T12:00:00Z'),date:new Date('2026-09-28T18:00:00Z')}];
 const r=reconcile([appt(n,'2026-09-28',{price_override:45}),appt(n,'2026-09-30',{price_override:50})],payments,[c],[]);
 assert.equal(r.results[0].expectedPrice,25);assert.equal(r.results[0].status,'PAID_VENMO');assert.equal(r.results[1].expectedPrice,50);assert.notEqual(r.results[1].status,'PAID_VENMO');assert.match(r.results[1].note,/Unapplied reference only.*NOT coverage/);
});
test('Dina extra $10 remains reference classification and does not alter configured price or records',()=>{
 const n='Dina Bates';const r=reconcile([appt(n,'2026-09-29',{price_override:70})],[],[client(n)],[]);
 assert.equal(r.results[0].expectedPrice,70);assert.match(r.results[0].note,/extra \$10 unclassified/);assert.equal(r.newMatches.length,0);assert.equal(standingRules.attendance_confirmation.future_bookings_confirmed,false);
});
test('free session never overwrites an existing derived allocation',()=>{
 const n='michelle Delorenza',c=client(n),prior=[{gmail_id:'prior-fixture',matched_to:{date:'2026-10-07',client:n,status:'PAID_VENMO'},payment:{sender:n,amount:70,date:'2026-10-07',note:'10/7'}}];
 const before=JSON.stringify(prior);const r=reconcile([appt(n,'2026-10-06'),appt(n,'2026-10-07')],[],[c],[],[],prior);
 assert.equal(r.results[1].status,'NEEDS_REVIEW');assert.match(r.results[1].note,/preserve allocation/);assert.equal(JSON.stringify(prior),before);assert.equal(r.newMatches.length,0);
});
test('first-session ledger on adjacent day does not hold the free second session',()=>{
 const n='michelle Delorenza',c=client(n),prior=[{gmail_id:'first-prior',matched_to:{date:'2026-10-06',client:n,status:'PAID_VENMO'},payment:{sender:n,amount:70,date:'2026-10-06',note:'10/6'}}];
 const r=reconcile([appt(n,'2026-10-06'),appt(n,'2026-10-07')],[],[c],[],[],prior);
 assert.equal(r.results[0].status,'PAID_VENMO');assert.equal(r.results[1].standingFree,true);assert.equal(r.results[1].checkoutAmount,0);assert.equal(r.newMatches.length,0);
});
test('real operational Robert roster respects scoped prepayment',async()=>{
 const clients=await loadClients(fileURLToPath(new URL('../clients.csv',import.meta.url)));
 const c=clients.find(c=>c.vagaro_name==='Robert Brower');assert.equal(c.prepaid,true);
 assert.equal(reconcile([appt(c.vagaro_name,'2026-10-06')],[],clients,[]).results[0].status,'PAID_PREPAID');
 assert.notEqual(reconcile([appt(c.vagaro_name,'2027-01-05')],[],clients,[]).results[0].status,'PAID_PREPAID');
});
test('Monday standing price does not accept an old group price as settled new coverage',()=>{
 const n='Katelin Lowther',c=client(n,{default_price:45,acceptable_prices:[45,50],venmo_display_names:['katie lowther']});
 const p={gmail_id:'old-price-fixture',sender_display_name:'katie lowther',amount:45,note:'10/5',noteDate:new Date('2026-10-05T12:00:00Z'),date:new Date('2026-10-05T18:00:00Z')};
 const r=reconcile([appt(n,'2026-10-05',{vagaroAmount:45})],[p],[c],[]);
 assert.equal(r.results[0].expectedPrice,25);assert.equal(r.results[0].status,'NEEDS_REVIEW');assert.notEqual(r.results[0].checkoutAmount,45);
});
test('new Monday rule preserves historical derived payment and checkout attribution',()=>{
 const n='Katelin Lowther',c=client(n,{default_price:45,acceptable_prices:[45,50]});
 const prior=[{gmail_id:'historical-fixture',matched_to:{date:'2026-09-28',client:n,status:'PAID_VENMO'},payment:{sender:n,amount:45,date:'2026-09-28',note:'9/28'}}];
 const before=JSON.stringify(prior);const r=reconcile([appt(n,'2026-09-28',{price_override:45})],[],[c],[],[],prior);
 assert.equal(r.results[0].payment.amount,45);assert.equal(r.results[0].checkoutAmount,45);assert.match(r.results[0].note,/Historical allocation retained/);assert.equal(r.newMatches.length,0);assert.equal(JSON.stringify(prior),before);
});
