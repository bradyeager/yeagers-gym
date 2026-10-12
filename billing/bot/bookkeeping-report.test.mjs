import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEmail, buildCheckoutPrompt} from './billing.mjs';
import {buildEmailV2} from './email-v2.mjs';

const now = new Date('2026-10-10T10:36:38Z');
const paid = status => ({status, appt:{date:new Date('2026-10-07T14:00:00Z'),client_name:'Fixture Client'},
  roster:{vagaro_name:'Fixture Client',default_price:70}, payment:{amount:70,sender_display_name:'Fixture Payer'},
  checkoutAmount:50,expectedPrice:70});

test('report retires executable browser/Cash instructions for every matched tender class', () => {
  for (const status of ['PAID_VENMO','PAID_CASH','PAID_PREPAID']) {
    const {html}=buildEmail({results:[paid(status)],unmatchedPayments:[],now});
    assert.match(html,/Native bookkeeping verification/);
    assert.match(html,/actual external payment method once/);
    assert.doesNotMatch(html,/Claude for Chrome|Cash field|ADJUST TOTAL|use Vagaro.s shown amount|document.querySelector/);
    assert.doesNotMatch(buildCheckoutPrompt([paid(status)],now),/enter \$50|change the total|work backwards/i);
  }
});

test('missing source identity is UNKNOWN, not an apparent zero intake finding', () => {
  const unknown={status:'NEEDS_REVIEW',appt:{date:new Date('2026-10-07T14:00:00Z'),
    client_name:null,calendar_source:{uid:'sha256:fixture'},unidentified:true},roster:null,note:'Calendar customer unidentified'};
  const {html}=buildEmail({results:[unknown],unmatchedPayments:[],now});
  assert.match(html,/incomplete identity coverage/);
  assert.match(html,/>UNKNOWN<\/div>/);
  assert.doesNotMatch(html,/Venmo Collected This Week/);
  assert.match(html,/not zero revenue/);
});

test('complete named matches retain factual matched amount without asserting native completion', () => {
  const {html}=buildEmail({results:[paid('PAID_VENMO')],unmatchedPayments:[],now});
  assert.match(html,/Matched Venmo Payments/);
  assert.match(html,/>\$70<\/div>/);
  assert.match(html,/do not establish native settlement or attendance/);
  assert.match(html,/Already-settled transactions are skipped/);
});

test('scheduled command-center path retires handoff and qualifies missing identity in hero/preheader', () => {
  const unknown={status:'NEEDS_REVIEW',appt:{date:new Date('2026-10-07T14:00:00Z'),
    client_name:null,calendar_source:{uid:'sha256:fixture'},unidentified:true},roster:null,note:'Calendar customer unidentified'};
  for (const results of [[unknown], ...['PAID_VENMO','PAID_CASH','PAID_PREPAID'].map(s=>[paid(s)])]) {
    const {html,preheader}=buildEmailV2({results,unmatchedPayments:[],now,windowStart:new Date('2026-10-05T07:00:00Z'),
      checkoutPrompt:buildCheckoutPrompt(results,now)});
    assert.match(html,/Native bookkeeping verification/);
    assert.doesNotMatch(html,/Claude for Chrome|The Playbook|Cash field|ADJUST TOTAL|Copy-Paste Payload/);
    if(results[0]===unknown) {
      assert.match(html,/>UNKNOWN<\/div>/);
      assert.match(preheader,/UNKNOWN matched Venmo \(incomplete identity coverage\)/);
    }
  }
});
