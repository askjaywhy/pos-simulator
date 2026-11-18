import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// B1/B2: the 0100's DE55 carries the tags commonly required for an online (ARQC) authorization
// (82, 9F02, 9F03, 9F27, 9F36 added), and its TVR (95) / TSI (9B) match the APDU trace at
// 1st GENERATE AC. Bitmaps are unchanged: DE55 was already present.
const API = 'http://localhost:3001/api';
const REQUIRED = ['82', '95', '9A', '9C', '5F2A', '9F02', '9F03', '9F10', '9F1A', '9F26', '9F27', '9F36', '9F37'];

async function pay(request, card, amount, extra = {}) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount, ...extra },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

const trace = async (request, id) => (await request.get(`${API}/transactions/${id}/apdu-trace`)).json();
const decode = async (request, tlv_hex) => (await (await request.post(`${API}/tools/emv-decode`, { data: { tlv_hex } })).json()).tlv_hex;
const flat = (items) => Object.fromEntries(items.map((i) => [i.tag, i.value]));

test.describe('DE55 completeness and TVR/TSI sync (B1/B2)', () => {
  for (const [brand, card] of [['Visa', '4111111111111111'], ['Mastercard', '5555555555554444'],
    ['Amex', '378282246310005'], ['Discover', '6011111111111117']]) {
    test(`${brand}: 0100 DE55 parses and has every required tag`, async ({ request }) => {
      const tx = await pay(request, card, 42.5);
      const d = await decode(request, tx.iso8583.fields['55'].value);
      expect(d.ok).toBe(true);
      const tags = Object.keys(flat(d.items));
      for (const t of REQUIRED) expect(tags, `missing ${t}`).toContain(t);
    });
  }

  test('82 / 9F02 / 9F03 / 9F27 values', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 19.99);
    expect(tx.emv.tags['82'].value).toBe('3C00');
    expect(tx.emv.tags['9F02'].value).toBe(tx.iso8583.fields['4'].value); // same n12 as DE4
    expect(tx.emv.tags['9F02'].value).toBe('000000001999');
    expect(tx.emv.tags['9F03'].value).toBe('000000000000');
    expect(tx.emv.tags['9F27'].value).toBe('80'); // ARQC: the 0100 carries the 1st GENERATE AC cryptogram
  });

  test('9F36 ATC matches the 1st GENERATE AC response in the trace', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const t = await trace(request, tx.transaction_id);
    const genAc1 = t.steps.find((s) => s.name === '1st Generate AC');
    expect(genAc1.r_apdu).toContain('9F3602' + tx.emv.tags['9F36'].value);
  });

  test('approved: DE55 TVR/TSI = trace at 1st GENERATE AC (0000008000 / E800)', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const d = flat((await decode(request, tx.iso8583.fields['55'].value)).items);
    expect(d['95']).toBe('0000008000');
    expect(d['9B']).toBe('E800');
    const t = await trace(request, tx.transaction_id);
    expect(t.summary.tvr).toBe(d['95']); // no post-online TVR bits on a clean approval
    expect(t.summary.tsi).toBe('F800'); // final TSI adds issuer authentication after the 0100
  });

  test('expired card: DE55 TVR carries "Expired application"', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 30, { exp_date: '01/20' });
    expect(tx.response_code).toBe('54');
    expect(tx.emv.tags['95'].value).toBe('0040008000');
  });

  test('pin_try_limit: DE55 TVR carries the CVM failure the issuer declined on', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75, { fault: 'pin_try_limit' });
    expect(tx.response_code).toBe('75');
    expect(tx.emv.tags['95'].value).toBe('0000A08000');
  });

  test('issuer_auth_failed: DE55 keeps the pre-online TVR; byte 5 is only in the trace', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75, { fault: 'issuer_auth_failed' });
    expect(tx.emv.tags['95'].value).toBe('0000008000');
    expect((await trace(request, tx.transaction_id)).summary.tvr).toBe('0000008040');
  });

  test('bitmap unchanged and 8A still present', async ({ request }) => {
    const tx = await pay(request, '4000000000000002', 30);
    const d = await (await request.get(`${API}/transactions/${tx.transaction_id}/iso8583`)).json();
    expect(d.iso8583.bitmap).toBe('7038000002C08200');
    expect(tx.emv.tlv_hex).toContain('8A023531');
  });

  test('/field55/inspect sample carries the same required tags', async ({ request }) => {
    const body = await (await request.get(`${API}/field55/inspect?scheme=mastercard`)).json();
    const tags = Object.keys(body.field55.decoded);
    for (const t of REQUIRED) expect(tags, `missing ${t}`).toContain(t);
    expect(body.field55.decoded['95']).toBe('0000008000');
  });

  test('/emv-tags names the new tags', async ({ request }) => {
    const { tags } = await (await request.get(`${API}/emv-tags`)).json();
    expect(tags['82'].name).toBe('Application Interchange Profile (AIP)');
    expect(tags['9F03'].name).toBe('Amount, Other');
    expect(tags['9F36'].name).toBe('Application Transaction Counter (ATC)');
  });
});
