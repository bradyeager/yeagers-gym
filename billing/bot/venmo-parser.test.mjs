import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseVenmoEmail, reconcile} from './billing.mjs';

const message = (body, {name = 'Laci James', amount = 100, date = 'Mon, 28 Sep 2026 15:13:19 +0000', mimeType = 'text/html'} = {}) => ({
  id: 'fixture',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [{name: 'Subject', value: `${name} paid you $${amount}.00`}, {name: 'Date', value: date}],
    parts: [{mimeType: 'text/plain', body: {data: ''}}, {mimeType, body: {data: Buffer.from(body).toString('base64url')}}],
  },
});

// Receipt HTML excerpts preserve source text/tag order; styling, links, images
// and transaction IDs are removed. Empty text/plain matches both real emails.
for (const fixture of [
  {file: 'laci-emoji.html', name: 'Laci James', amount: 100, memo: '🏃', date: 'Mon, 28 Sep 2026 15:13:19 +0000'},
  {file: 'michelle-emoji.html', name: 'Michelle DeLorenzo', amount: 70, memo: '🏋️', date: 'Mon, 28 Sep 2026 02:09:18 +0000'},
]) {
  test(`${fixture.name}: emoji memo survives receipt metadata and UTC date boundary`, async () => {
    const html = await fs.readFile(new URL(`./fixtures/venmo/${fixture.file}`, import.meta.url), 'utf8');
    const result = parseVenmoEmail(message(html, fixture));
    assert.equal(result.note, fixture.memo);
    assert.equal(result.noteDate, null);
    assert.equal(result.amount, fixture.amount);
    assert.equal(result.sender_display_name, fixture.name);
  });
}

const receipt = memo => `<p>Laci James paid you</p><div>$</div><div>100</div><div>00</div>${memo}<p>See transaction</p><p>Money credited to your Venmo account.</p><h2>Transaction details</h2><h3>Date</h3><p>Sep 27, 2026</p>`;

test('empty memo cannot become transaction date with or without a transaction button', () => {
  for (const body of [receipt(''), receipt('').replace('<p>See transaction</p>', ''), receipt('').replace(/<p>See transaction<\/p><p>Money credited[^<]*<\/p>/, '')]) {
    const result = parseVenmoEmail(message(body));
    assert.equal(result.note, '');
    assert.equal(result.noteDate, null);
  }
});

test('legitimate text, numeric date, combined dates and routing memo remain unchanged', () => {
  for (const memo of ['9.28', '9/15 &amp; 9/23', 'Training 9/28', 'rachael', '9/29+', 'Thank You']) {
    const result = parseVenmoEmail(message(receipt(`<p>${memo}</p>`)));
    assert.equal(result.note, memo.replace('&amp;', '&'));
  }
  assert.equal(parseVenmoEmail(message(receipt('<p>9.28</p>'))).noteDate.toISOString().slice(0, 10), '2026-09-28');
  assert.equal(parseVenmoEmail(message(receipt('<p>9/15 &amp; 9/23</p>'))).noteDate.toISOString().slice(0, 10), '2026-09-15');
  assert.equal(parseVenmoEmail(message(receipt('<p>rachael</p>'))).noteDate, null);
});

test('text/plain emoji memo is preserved before metadata', () => {
  const result = parseVenmoEmail(message('Laci James paid you\n$\n100\n00\n🏃\nSee transaction\nTransaction details\nDate\nSep 27, 2026', {mimeType: 'text/plain'}));
  assert.equal(result.note, '🏃');
  assert.equal(result.noteDate, null);
});

test('emoji-leading multiline memo retains the date and cannot settle another day', () => {
  const result = parseVenmoEmail(message(receipt('<p>💪<br>9/27</p>').replace('<div>100</div>', '<div>70</div>'), {amount: 70}));
  assert.equal(result.note, '💪\n9/27');
  assert.equal(result.noteDate.toISOString().slice(0, 10), '2026-09-27');
  const clients = [{vagaro_name: 'Lacey James', venmo_display_names: ['Laci James'], venmo_handle: '', default_price: 70, acceptable_prices: [], pays_cash: false, prepaid: false, note_keywords: [], notes: ''}];
  const appointments = [{date: new Date('2026-09-28T17:00:00Z'), client_name: 'Lacey James', summary: 'Lacey James - 1:1', unidentified: false}];
  const {results, allocations} = reconcile(appointments, [result], clients, [], [], []);
  assert.notEqual(results[0].status, 'PAID_VENMO');
  assert.equal(allocations[0].sessions.length, 0);
  assert.equal(allocations[0].remainder, 70);
});

test('multiline date-first and numeric continuation memos remain intact', () => {
  const result = parseVenmoEmail(message(receipt('<p>9/27<br>💪<br>70</p>')));
  assert.equal(result.note, '9/27\n💪\n70');
  assert.equal(result.noteDate.toISOString().slice(0, 10), '2026-09-27');
});

test('split decimal amount prefix does not hide HTML or plain-text emoji memo', () => {
  const bodies = [
    [receipt('<p>💪</p>').replace('<div>100</div>', '<div>100</div><span>.</span>'), 'text/html'],
    ['Laci James paid you\n$\n100\n.\n00\n💪\nSee transaction\nDate\nSep 27, 2026', 'text/plain'],
  ];
  for (const [body, mimeType] of bodies) {
    const result = parseVenmoEmail(message(body, {mimeType}));
    assert.equal(result.note, '💪');
    assert.equal(result.noteDate, null);
  }
});

test('memo date beyond the former scan limit is retained before metadata', () => {
  const memo = ['💪', ...Array(16).fill('training'), '9/27'];
  const result = parseVenmoEmail(message(receipt(`<p>${memo.join('<br>')}</p>`)));
  assert.equal(result.note, memo.join('\n'));
  assert.equal(result.noteDate.toISOString().slice(0, 10), '2026-09-27');
});

test('long first memo line retains its following session date', () => {
  const memo = ['training '.repeat(20).trim(), '9/27'];
  const result = parseVenmoEmail(message(receipt(`<p>${memo.join('<br>')}</p>`)));
  assert.equal(result.note, memo.join('\n'));
  assert.equal(result.noteDate.toISOString().slice(0, 10), '2026-09-27');
});
