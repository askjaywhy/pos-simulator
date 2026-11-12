const { test, expect } = require('@playwright/test');
const { TEST_EXP } = require('./support/cards.js');

const baseURL = 'http://localhost:3001/api';

// Helper function for API requests
async function apiRequest(method, endpoint, body = null) {
  const url = `${baseURL}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  return { status: response.status, data: await response.json() };
}

// EMV Tags Tests
test.describe('EMV Tags', () => {
  test('should get EMV tags reference', async () => {
    const { status, data } = await apiRequest('GET', '/emv-tags');
    expect(status).toBe(200);
    expect(data).toHaveProperty('tags');
    expect(data).toHaveProperty('total');
    expect(data.total).toBeGreaterThan(0);
  });

  test('should verify standard EMV tags present', async () => {
    const { data } = await apiRequest('GET', '/emv-tags');
    const standardTags = ['9F06', '9F26', '95', '9B'];

    standardTags.forEach(tag => {
      expect(data.tags).toHaveProperty(tag);
    });
  });

  test('should check EMV tag attributes', async () => {
    const { data } = await apiRequest('GET', '/emv-tags');
    const tag = data.tags['9F06'];

    expect(tag).toHaveProperty('name');
    expect(tag).toHaveProperty('category');
    expect(tag.name).toBeTruthy();
    expect(tag.category).toBeTruthy();
  });
});

// ISO 8583 Fields Tests
test.describe('ISO 8583 Fields', () => {
  test('should get ISO 8583 fields reference', async () => {
    const { status, data } = await apiRequest('GET', '/iso8583-fields');
    expect(status).toBe(200);
    expect(data).toHaveProperty('fields');
    expect(data).toHaveProperty('total');
    expect(data.total).toBeGreaterThan(0);
  });

  test('should verify standard ISO 8583 fields present', async () => {
    const { data } = await apiRequest('GET', '/iso8583-fields');
    const standardFields = ['0', '2', '4', '11', '39'];

    standardFields.forEach(field => {
      expect(data.fields).toHaveProperty(field);
    });
  });

  test('should check ISO 8583 field attributes', async () => {
    const { data } = await apiRequest('GET', '/iso8583-fields');
    const field = data.fields['0'];

    expect(field).toHaveProperty('name');
    expect(field).toHaveProperty('type');
    expect(field).toHaveProperty('length');
    expect(field.name).toBeTruthy();
  });
});

// Transaction Processing Tests
test.describe('Transaction Processing', () => {
  test('should approve valid transaction', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.status).toBe('APPROVED');
    expect(data.response_code).toBe('00');
    expect(data.transaction_id).toBeTruthy();
    expect(data.auth_code).toBeTruthy();
  });

  test('should include EMV data in response', async () => {
    const { data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });

    expect(data.emv).toBeTruthy();
    expect(data.emv.tags).toBeTruthy();
    expect(data.emv.tlv_hex).toBeTruthy();
    expect(Object.keys(data.emv.tags).length).toBeGreaterThan(0);
  });

  test('should include ISO 8583 data in response', async () => {
    const { data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });

    expect(data.iso8583).toBeTruthy();
    expect(data.iso8583.mti).toBe('0100');
    expect(data.iso8583.fields).toBeTruthy();
    expect(data.iso8583.hex_message).toBeTruthy();
  });

  test('should decline insufficient funds', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4000000000000002',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 50.00
    });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.status).toBe('DECLINED');
    expect(data.response_code).toBe('51');
    expect(data.decline_reason).toBe('Insufficient Funds');
  });

  test('should decline lost card', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4000000000009987',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 50.00
    });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.status).toBe('DECLINED');
    expect(data.response_code).toBe('41');
    expect(data.decline_reason).toBe('Lost Card');
  });

  test('should validate Luhn checksum', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '1234567890123456',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 50.00
    });

    expect(status).toBe(400);
    expect(data.error).toContain('Luhn');
  });

  test('should validate expiration format', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: '12-25',
      cvv: '123',
      amount: 50.00
    });

    expect(status).toBe(400);
    expect(data.error).toContain('expiration');
  });

  test('should require all fields', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111'
    });

    expect(status).toBe(400);
    expect(data.error).toBeTruthy();
  });
});

// Transaction Data Retrieval Tests
test.describe('Transaction Data Retrieval', () => {
  let transactionId;

  test.beforeAll(async () => {
    const { data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });
    transactionId = data.transaction_id;
  });

  test('should get transaction EMV data', async () => {
    const { status, data } = await apiRequest('GET', `/transactions/${transactionId}/emv`);
    expect(status).toBe(200);
    expect(data.transaction_id).toBe(transactionId);
    expect(data.emv).toBeTruthy();
    expect(data.emv.tags).toBeTruthy();
  });

  test('should get transaction ISO 8583 data', async () => {
    const { status, data } = await apiRequest('GET', `/transactions/${transactionId}/iso8583`);
    expect(status).toBe(200);
    expect(data.transaction_id).toBe(transactionId);
    expect(data.iso8583).toBeTruthy();
    expect(data.iso8583.mti).toBeTruthy();
  });

  test('should return 404 for nonexistent transaction', async () => {
    const { status } = await apiRequest('GET', '/transactions/nonexistent-id');
    expect(status).toBe(404);
  });
});

// API Endpoint Tests
test.describe('API Endpoints', () => {
  test('health check should work', async () => {
    const { status, data } = await apiRequest('GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('healthy');
  });

  test('should get test cards', async () => {
    const { status, data } = await apiRequest('GET', '/test-cards');
    expect(status).toBe(200);
    expect(data.cards).toBeTruthy();
    expect(Array.isArray(data.cards)).toBe(true);
    expect(data.cards.length).toBeGreaterThan(0);
  });

  test('should get transaction history', async () => {
    const { status, data } = await apiRequest('GET', '/transactions/history');
    expect(status).toBe(200);
    expect(data.transactions).toBeTruthy();
    expect(Array.isArray(data.transactions)).toBe(true);
  });
});

// Edge Cases Tests
test.describe('Edge Cases', () => {
  test('STAN should be unique across transactions', async () => {
    const stans = new Set();

    for (let i = 0; i < 5; i++) {
      const { data } = await apiRequest('POST', '/transactions/process', {
        card_number: '4111111111111111',
        exp_date: TEST_EXP,
        cvv: '123',
        // 2-decimal amount: the API rejects more decimals since DEF-006
        amount: Math.floor(Math.random() * 9999 + 1) / 100
      });

      const isoFields = data.iso8583.fields;
      const stan = isoFields['11']?.value;
      expect(stan).toBeTruthy();
      expect(stans.has(stan)).toBe(false);
      stans.add(stan);
    }
  });

  test('should handle large amounts', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 999999.99
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.amount).toBe(999999.99);
  });

  test('should handle small amounts', async () => {
    const { status, data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 0.01
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.amount).toBe(0.01);
  });

  test('hex values should be valid format', async () => {
    const { data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });

    const hexRegex = /^[0-9A-F]+$/i;
    expect(hexRegex.test(data.emv.tlv_hex)).toBe(true);
    expect(hexRegex.test(data.iso8583.hex_message)).toBe(true);
  });

  test('MTI should be valid format', async () => {
    const { data } = await apiRequest('POST', '/transactions/process', {
      card_number: '4111111111111111',
      exp_date: TEST_EXP,
      cvv: '123',
      amount: 99.99
    });

    expect(data.iso8583.mti).toMatch(/^\d{4}$/);
    expect(data.iso8583.mti).toBe('0100');
  });
});
