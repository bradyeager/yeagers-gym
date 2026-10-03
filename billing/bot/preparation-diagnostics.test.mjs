import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoPriorDelivery, preparationFailureDiagnostic} from './delivery.mjs';

const period = '2026-10-02';
const now = new Date('2026-10-03T09:52:03Z');
for (const state of ['accepted', 'pending', 'https://secret.invalid/token']) {
 test(`prior claim diagnostic is bounded: ${state === 'accepted' || state === 'pending' ? state : 'unknown'}`, async () => {
  let reads = 0;
  const store = {read: async id => { reads++; assert.equal(id, 'weekly-schedule-ical-2026-10-02'); return {record:{state,nonce:'PRIVATE',providerMessageId:'PRIVATE'}}; }};
  await assert.rejects(assertNoPriorDelivery(period,store,{now}), error => {
   assert.equal(error.message,'Weekly delivery already claimed; no automatic resend');
   assert.equal(preparationFailureDiagnostic(error), `Weekly preparation blocked: prior claim (${['accepted','pending'].includes(state) ? state : 'unknown'}); no automatic resend`);
   return true;
  });
  assert.equal(reads,1);
 });
}
test('store failure cannot masquerade as confirmed prior-claim rejection', async () => {
 const error = new Error('Weekly delivery already claimed; https://secret.invalid/token');
 error.claimState = 'accepted';
 await assert.rejects(assertNoPriorDelivery(period,{read:async()=>{throw error;}},{now}), e=>{
  assert.equal(e,error);
  assert.equal(preparationFailureDiagnostic(e),'Weekly preparation failed: cause unclassified; no email dispatched. Inspect Actions and outbox before retrying.');
  return true;
 });
});
test('absent claim permits preparation without a diagnostic failure', async () => {
 assert.equal(await assertNoPriorDelivery(period,{read:async()=>null},{now}),'weekly-schedule-ical-2026-10-02');
});
test('invalid cutoff fails before store read and stays unclassified', async () => {
 let reads=0;
 await assert.rejects(assertNoPriorDelivery(period,{read:async()=>{reads++;}},{now:new Date('2026-10-03T04:16:00Z')}),error=>{
  assert.match(preparationFailureDiagnostic(error),/cause unclassified/);
  return true;
 });
 assert.equal(reads,0);
});
