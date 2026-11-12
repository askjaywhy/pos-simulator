import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-007 regression: refunds only for APPROVED transactions, recorded, and capped at the original amount.
const API = 'http://localhost:3001/api';

async function pay(request, card, amount) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).transaction_id;
}

const refund = (request, id, amount) =>
  request.post(`${API}/transactions/${id}/refund`, amount === undefined ? {} : { data: { amount } });

test.describe('Refunds (DEF-007)', () => {
  test('a DECLINED transaction cannot be refunded (422)', async ({ request }) => {
    const id = await pay(request, '4000000000009987', 30.0);
    const res = await refund(request, id);
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toBe('Only APPROVED transactions can be refunded');
  });

  test('a full refund works once, then 409', async ({ request }) => {
    const id = await pay(request, '378282246310005', 40.0);
    const first = await refund(request, id);
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'REFUNDED', amount: 40, remaining_amount: 0 });

    const second = await refund(request, id);
    expect(second.status()).toBe(409);
    expect(await second.json()).toMatchObject({ remaining_amount: 0 });
  });

  test('partial refunds are recorded and capped at the original amount', async ({ request }) => {
    const id = await pay(request, '4111111111111111', 75.5);

    const a = await refund(request, id, 25.5);
    expect(a.status()).toBe(200);
    expect(await a.json()).toMatchObject({ status: 'PARTIALLY_REFUNDED', remaining_amount: 50 });

    const b = await refund(request, id, '50.00');
    expect(b.status()).toBe(200);
    expect(await b.json()).toMatchObject({ status: 'REFUNDED', remaining_amount: 0 });

    expect((await refund(request, id, 0.01)).status()).toBe(409);

    const list = await (await request.get(`${API}/transactions/${id}/refunds`)).json();
    expect(list.refunds).toHaveLength(2);
    expect(list.total_refunded).toBe(75.5);
    expect(list.remaining_amount).toBe(0);
  });

  test('a refund larger than the original is rejected (409)', async ({ request }) => {
    const id = await pay(request, '4111111111111111', 20.0);
    const res = await refund(request, id, 20.01);
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ remaining_amount: 20 });
  });

  test('an invalid refund amount is rejected (400)', async ({ request }) => {
    const id = await pay(request, '4111111111111111', 20.0);
    const res = await refund(request, id, -1);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/^Invalid amount/);
  });

  test('refund of an unknown transaction returns 404', async ({ request }) => {
    expect((await refund(request, '00000000-0000-0000-0000-000000000000')).status()).toBe(404);
  });

  test('two concurrent full refunds: exactly one succeeds', async ({ request }) => {
    const id = await pay(request, '4111111111111111', 15.0);
    const statuses = (await Promise.all([refund(request, id), refund(request, id)])).map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 409]);

    const list = await (await request.get(`${API}/transactions/${id}/refunds`)).json();
    expect(list.total_refunded).toBe(15);
  });
});
