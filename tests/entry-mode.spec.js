import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// Mock SDK phase 1, item 1 + 3: opt-in entry_mode on /process.
//   chip        DE22 051, 9F39 05, contact trace
//   contactless DE22 071, 9F39 07, 9F66 TTQ, contactless (C-2/C-3 style) trace
//   fallback    DE22 801, no DE55, magnetic-stripe trace
//   swipe       chip card swiped -> TERMINATED ERR_CHIP_CARD_SWIPED
// Without entry_mode nothing changes (no DE22, bitmap 7038000002C08200).
const API = 'http://localhost:3001/api';
const VISA = '4111111111111111';

async function pay(request, extra = {}, card = VISA, amount = 75) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount, ...extra },
  });
  return res;
}
async function payOk(request, extra, card, amount) {
  const res = await pay(request, extra, card, amount);
  expect(res.status()).toBe(200);
  return res.json();
}
const iso = async (request, id) => (await request.get(`${API}/transactions/${id}/iso8583`)).json();
const trace = async (request, id) => (await request.get(`${API}/transactions/${id}/apdu-trace`)).json();

test.beforeEach(async ({ request }) => { await request.delete(`${API}/terminal/config`); });

test.describe('entry_mode', () => {
  test('no entry_mode: no DE22, no 9F39, default bitmap, no entry_mode key', async ({ request }) => {
    const tx = await payOk(request);
    expect(tx).not.toHaveProperty('entry_mode');
    expect(tx.iso8583.fields).not.toHaveProperty('22');
    expect(tx.emv.tags['9F39'].value).toBe('');
    expect((await iso(request, tx.transaction_id)).iso8583.bitmap).toBe('7038000002C08200');
    expect((await trace(request, tx.transaction_id)).interface).toBe('contact');
  });

  test('unsupported entry_mode -> 400', async ({ request }) => {
    const res = await pay(request, { entry_mode: 'nfc' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('Unsupported entry_mode');
  });

  test('chip: DE22 051, 9F39 05, bitmap adds DE22, same contact trace', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'chip' });
    expect(tx).toMatchObject({ status: 'APPROVED', entry_mode: 'chip' });
    expect(tx.iso8583.fields['22'].value).toBe('051');
    expect(tx.emv.tags['9F39'].value).toBe('05');
    expect((await iso(request, tx.transaction_id)).iso8583.bitmap).toBe('7038040002C08200');
    const t = await trace(request, tx.transaction_id);
    expect(t).toMatchObject({ interface: 'contact', entry_mode: 'chip' });
    expect(t.steps.some((s) => s.name === '2nd Generate AC')).toBe(true);
  });

  test('chip: 0110 echo is unchanged (no DE22)', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'chip' });
    expect(tx.iso8583_response.fields).not.toHaveProperty('22');
  });

  test('contactless: DE22 071, 9F39 07, 9F66 TTQ in DE55, TSI 0000', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'contactless' }, '5555555555554444');
    expect(tx).toMatchObject({ status: 'APPROVED', entry_mode: 'contactless' });
    expect(tx.iso8583.fields['22'].value).toBe('071');
    expect(tx.emv.tags['9F39'].value).toBe('07');
    expect(tx.emv.tags['9F66'].value).toBe('36004000');
    expect(tx.emv.tags['9B'].value).toBe('0000');
    expect(tx.iso8583.fields['55'].value).toContain('9F660436004000');
  });

  test('contactless trace: PPSE, GPO carries the ARQC, no 2nd GENERATE AC', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'contactless' }, '5555555555554444');
    const t = await trace(request, tx.transaction_id);
    expect(t).toMatchObject({ interface: 'contactless', kernel: 'C-2' });
    expect(t.steps.filter((s) => s.type === 'APDU').map((s) => s.name))
      .toEqual(['Select PPSE', 'Select application', 'Get processing options', 'Read record']);
    expect(t.steps[1].c_apdu).toBe('00A404000E325041592E5359532E444446303100'); // 2PAY.SYS.DDF01
    const gpo = t.steps.find((s) => s.name === 'Get processing options');
    expect(gpo.c_apdu).toContain('8321' + '36004000'); // PDOL data starts with the TTQ
    expect(gpo.r_apdu).toContain('9F2701' + '80');
    expect(t.summary).toMatchObject({ tsi: '0000', cid_first: '80', cid_final: null });
    expect(t.de55_check.ok).toBe(true);
  });

  test('contactless kernel per scheme (Visa C-3)', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'contactless' });
    expect((await trace(request, tx.transaction_id)).kernel).toBe('C-3');
  });

  test('contactless at or under the CVM limit: no CVM; above: online PIN (TVR byte 3 bit 3)', async ({ request }) => {
    const low = await payOk(request, { entry_mode: 'contactless' }, VISA, 100);
    expect((await trace(request, low.transaction_id)).summary.cvm_results).toBe('3F0000');
    const high = await payOk(request, { entry_mode: 'contactless' }, VISA, 100.01);
    const t = await trace(request, high.transaction_id);
    expect(t.summary.cvm_results).toBe('420300');
    expect(t.summary.tvr).toBe('0000048000');
    expect(high.emv.tags['95'].value).toBe('0000048000');
  });

  test('contactless decline keeps the host code', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'contactless' }, '4000000000000002');
    expect(tx).toMatchObject({ status: 'DECLINED', response_code: '51' });
  });

  test('fallback: DE22 801, no DE55 in 0100 or 0110, emv null, approved', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'fallback' });
    expect(tx).toMatchObject({ status: 'APPROVED', response_code: '00', entry_mode: 'fallback', emv: null });
    expect(tx.iso8583.fields['22'].value).toBe('801');
    expect(tx.iso8583.fields).not.toHaveProperty('55');
    expect(tx.iso8583_response.fields).not.toHaveProperty('55');
    expect((await iso(request, tx.transaction_id)).iso8583.bitmap).toBe('7038040002C08000');
    const t = await trace(request, tx.transaction_id);
    expect(t.interface).toBe('magstripe');
    expect(t.steps.filter((s) => s.type === 'APDU')).toHaveLength(0);
    expect(t.steps.filter((s) => /ICC power-on failed/.test(s.name))).toHaveLength(3);
    expect(t.summary.tvr).toBeNull();
    expect(t.de55_check).toBeNull();
  });

  test('swipe of a chip card is refused: TERMINATED, ERR_CHIP_CARD_SWIPED, no host messages', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'swipe' });
    expect(tx).toMatchObject({ status: 'TERMINATED', response_code: null, sdk_error: 'ERR_CHIP_CARD_SWIPED', iso8583: null, iso8583_response: null, emv: null });
    expect(tx.decline_reason).toContain('insert the card');
  });

  test('entry_mode is case-insensitive', async ({ request }) => {
    const tx = await payOk(request, { entry_mode: 'Contactless' });
    expect(tx.entry_mode).toBe('contactless');
  });

  test('fallback / contactless transactions can be refunded and reversed like chip', async ({ request }) => {
    const a = await payOk(request, { entry_mode: 'fallback' });
    expect((await request.post(`${API}/transactions/${a.transaction_id}/refund`)).status()).toBe(200);
    const b = await payOk(request, { entry_mode: 'contactless' });
    const rev = await request.post(`${API}/transactions/${b.transaction_id}/reversal`);
    expect(rev.status()).toBe(200);
    expect((await rev.json()).iso8583.mti).toBe('0400');
  });
});
