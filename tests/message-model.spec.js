import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';
import { EMVTransaction, localStamp, nextStan, retrievalRef } from '../backend/emv-iso8583.js';

// Message model: 0100 request fields, 0110 response, 0200 refund, 0400 reversal,
// DE49/5F2A from currency, local DE12/13, sequential STAN, scheme AIDs.
const API = 'http://localhost:3001/api';
const VISA = '4111111111111111';

async function pay(request, overrides = {}) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: VISA, exp_date: TEST_EXP, cvv: '123', amount: 10.0, ...overrides },
  });
  return res;
}

test.describe('0100 request fields (unit)', () => {
  test('DE3 000000, DE41 terminal id, DE42 merchant id padded to 15, DE49 from currency', () => {
    const tx = new EMVTransaction('t1', VISA, 10, 'visa', 'contact', { currency: 'gbp', merchantId: 'SHOP1' });
    const { fields } = tx.getISO8583Data();
    expect(fields['3'].value).toBe('000000');
    expect(fields['41'].value).toBe('TERM0001');
    expect(fields['42'].value).toBe('SHOP1          ');
    expect(fields['49'].value).toBe('826');
    expect(tx.emvTags.getTag('5F2A').value).toBe('0826');
  });

  test('DE12/DE13 and tags 9A/9F21 use local time', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5); // local Jan 2 03:04:05
    const tx = new EMVTransaction('t2', VISA, 10, 'visa', 'contact', { now });
    const { fields } = tx.getISO8583Data();
    expect(fields['12'].value).toBe('030405');
    expect(fields['13'].value).toBe('0102');
    expect(tx.emvTags.getTag('9A').value).toBe('260102');
    expect(tx.emvTags.getTag('9F21').value).toBe('030405');
    expect(localStamp(now)).toEqual({ hhmmss: '030405', mmdd: '0102', yymmdd: '260102' });
  });

  test('STAN is sequential', () => {
    const a = Number(nextStan());
    const b = Number(nextStan());
    expect(b).toBe(a === 999999 ? 1 : a + 1);
  });

  test('retrieval reference is 12 uppercase alphanumerics from the id', () => {
    expect(retrievalRef('3f2b9c1a-77de-4c1e-9a0b-1234567890ab')).toBe('3F2B9C1A77DE');
  });
});

test.describe('0110 authorization response (API)', () => {
  test('approval: MTI 0110, echoes DE2/3/4/11/41/42/49, DE38 from auth code, DE39 00, 8A in DE55', async ({ request }) => {
    const tx = await (await pay(request, { amount: 12.34 })).json();
    const req = tx.iso8583.fields;
    const rsp = tx.iso8583_response;
    expect(rsp.mti).toBe('0110');
    expect(rsp.hex_message.startsWith('0110' + rsp.hex_message.slice(4, 20))).toBeTruthy();
    for (const de of ['2', '3', '4', '11', '41', '42', '49']) {
      expect(rsp.fields[de].value, `DE${de}`).toBe(req[de].value);
    }
    expect(rsp.fields['2'].value).toBe('411111******1111');
    expect(rsp.fields['38'].value).toBe(tx.auth_code.slice(-6));
    expect(rsp.fields['39'].value).toBe('00');
    expect(rsp.fields['55'].value).toBe('8A023030');
  });

  test('decline: DE39 51, no DE38', async ({ request }) => {
    const tx = await (await pay(request, { card_number: '4000000000000002' })).json();
    expect(tx.iso8583_response.fields['39'].value).toBe('51');
    expect(tx.iso8583_response.fields['38']).toBeUndefined();
    expect(tx.iso8583_response.fields['55'].value).toBe('8A023531');
  });

  test('stored 0110 is returned by GET /transactions/:id/iso8583', async ({ request }) => {
    const tx = await (await pay(request)).json();
    const stored = await (await request.get(`${API}/transactions/${tx.transaction_id}/iso8583`)).json();
    const { mti, fields, hex_message } = stored.response;
    expect({ mti, fields, hex_message }).toEqual(tx.iso8583_response);
    expect(stored.response.bitmap).toBe(hex_message.slice(4, 20));
  });

  test('consecutive transactions get consecutive STANs', async ({ request }) => {
    const a = Number((await (await pay(request)).json()).iso8583.fields['11'].value);
    const b = Number((await (await pay(request)).json()).iso8583.fields['11'].value);
    expect(b).toBe(a === 999999 ? 1 : a + 1);
  });
});

test.describe('Currency (DE49, tag 5F2A)', () => {
  for (const [alpha, numeric] of [['USD', '840'], ['EUR', '978'], ['cad', '124']]) {
    test(`${alpha} → DE49 ${numeric}`, async ({ request }) => {
      const tx = await (await pay(request, { currency: alpha })).json();
      expect(tx.currency).toBe(alpha.toUpperCase());
      expect(tx.iso8583.fields['49'].value).toBe(numeric);
      expect(tx.emv.tags['5F2A'].value).toBe('0' + numeric);
    });
  }

  test('unsupported currency is rejected with 400', async ({ request }) => {
    const res = await pay(request, { currency: 'JPY' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/^Unsupported currency/);
  });
});

test.describe('Scheme data', () => {
  test('Discover gets the Discover AID', async ({ request }) => {
    const body = await (await request.get(`${API}/field55/inspect?scheme=discover`)).json();
    expect(body.emv.tags['9F06'].value).toBe('A0000001523010');
  });

  test('9F06 is named as the terminal AID', async ({ request }) => {
    const body = await (await request.get(`${API}/emv-tags`)).json();
    expect(body.tags['9F06'].name).toBe('Application Identifier (AID) - terminal');
  });
});

test.describe('0200 refund and 0400 reversal', () => {
  test('refund builds a 0200: DE3 200000, DE4 refund amount, DE37 links to the original', async ({ request }) => {
    const tx = await (await pay(request, { amount: 40 })).json();
    const rf = await (await request.post(`${API}/transactions/${tx.transaction_id}/refund`, { data: { amount: 15.25 } })).json();
    expect(rf.iso8583.mti).toBe('0200');
    expect(rf.iso8583.fields['3'].value).toBe('200000');
    expect(rf.iso8583.fields['4'].value).toBe('000000001525');
    expect(rf.iso8583.fields['2'].value).toBe('411111******1111');
    expect(rf.iso8583.fields['37'].value).toBe(retrievalRef(tx.transaction_id));
    expect(rf.iso8583.fields['11'].value).not.toBe(tx.iso8583.fields['11'].value);
    const list = await (await request.get(`${API}/transactions/${tx.transaction_id}/refunds`)).json();
    expect(list.refunds[0].iso8583).toEqual(rf.iso8583);
  });

  test('reversal builds a 0400, sets REVERSED, then blocks refund and a second reversal', async ({ request }) => {
    const tx = await (await pay(request, { amount: 22 })).json();
    const rv = await request.post(`${API}/transactions/${tx.transaction_id}/reversal`);
    expect(rv.status()).toBe(200);
    const body = await rv.json();
    expect(body.status).toBe('REVERSED');
    expect(body.amount).toBe(22);
    expect(body.iso8583.mti).toBe('0400');
    expect(body.iso8583.fields['4'].value).toBe('000000002200');
    expect((await (await request.get(`${API}/transactions/${tx.transaction_id}`)).json()).status).toBe('REVERSED');
    expect((await request.post(`${API}/transactions/${tx.transaction_id}/refund`)).status()).toBe(422);
    expect((await request.post(`${API}/transactions/${tx.transaction_id}/reversal`)).status()).toBe(422);
  });

  test('declined transaction cannot be reversed (422); refunded one cannot (409); unknown id 404', async ({ request }) => {
    const declined = await (await pay(request, { card_number: '4000000000000002' })).json();
    expect((await request.post(`${API}/transactions/${declined.transaction_id}/reversal`)).status()).toBe(422);
    const tx = await (await pay(request, { amount: 30 })).json();
    await request.post(`${API}/transactions/${tx.transaction_id}/refund`, { data: { amount: 5 } });
    expect((await request.post(`${API}/transactions/${tx.transaction_id}/reversal`)).status()).toBe(409);
    expect((await request.post(`${API}/transactions/00000000-0000-0000-0000-000000000000/reversal`)).status()).toBe(404);
  });
});
