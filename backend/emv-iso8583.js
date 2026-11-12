// emv-iso8583.js
// EMV + ISO 8583 with realistic TLV, scheme-flavored sample data

const EMV_TAGS = {
  '9F06': { name: 'Application Identifier (AID) - terminal', category: 'Application' },
  '5F2A': { name: 'Transaction Currency Code', category: 'Transaction' },
  '9F26': { name: 'Application Cryptogram', category: 'Cryptography' },
  '95':   { name: 'Terminal Verification Results (TVR)', category: 'Security' },
  '9B':   { name: 'Transaction Status Information (TSI)', category: 'Security' },
  '9F27': { name: 'Cryptogram Information Data', category: 'Cryptography' },
  '9F10': { name: 'Issuer Application Data (IAD)', category: 'Application' },
  '9F37': { name: 'Unpredictable Number', category: 'Security' },
  '9F02': { name: 'Amount, Authorised', category: 'Transaction' },
  '9F1A': { name: 'Terminal Country Code', category: 'Terminal' },
  '9C':   { name: 'Transaction Type', category: 'Transaction' },
  '9A':   { name: 'Transaction Date', category: 'Transaction' },
  '9F21': { name: 'Transaction Time', category: 'Transaction' },
  '84':   { name: 'Dedicated File Name', category: 'Application' },
  '9F34': { name: 'CVM Results', category: 'Security' },
  '9F35': { name: 'Terminal Type', category: 'Terminal' },
  '9F1E': { name: 'IFD Serial Number', category: 'Terminal' },
  '9F39': { name: 'POS Entry Mode', category: 'Terminal' },
  '9F33': { name: 'Terminal Capabilities', category: 'Terminal' },
  '9F1D': { name: 'Terminal Risk Management Data', category: 'Terminal' },
  '5F20': { name: 'Cardholder Name', category: 'Card' },
  '8A':   { name: 'Authorisation Response Code', category: 'Response' },
  '9F08': { name: 'Application Version Number', category: 'Application' },
  '9F07': { name: 'Application Usage Control', category: 'Application' }
};

const ISO8583_FIELDS = {
  '0':   { name: 'Message Type Indicator (MTI)', type: 'numeric', length: 4, category: 'Control' },
  '1':   { name: 'Bitmap', type: 'binary', length: 8, category: 'Control' },
  '2':   { name: 'Primary Account Number (PAN)', type: 'numeric', length: 19, category: 'Card' },
  '3':   { name: 'Processing Code', type: 'numeric', length: 6, category: 'Transaction' },
  '4':   { name: 'Amount, Transaction', type: 'numeric', length: 12, category: 'Transaction' },
  '11':  { name: 'System Trace Audit Number (STAN)', type: 'numeric', length: 6, category: 'Transaction' },
  '12':  { name: 'Time, Transaction (hhmmss)', type: 'numeric', length: 6, category: 'Transaction' },
  '13':  { name: 'Date, Transaction (MMDD)', type: 'numeric', length: 4, category: 'Transaction' },
  '37':  { name: 'Retrieval Reference Number', type: 'alphanumeric', length: 12, category: 'Transaction' },
  '38':  { name: 'Authorization Identification Response', type: 'alphanumeric', length: 6, category: 'Response' },
  '39':  { name: 'Response Code', type: 'numeric', length: 2, category: 'Response' },
  '41':  { name: 'Card Acceptor Terminal Identification', type: 'alphanumeric', length: 8, category: 'Terminal' },
  '42':  { name: 'Card Acceptor Identification Code', type: 'alphanumeric', length: 15, category: 'Merchant' },
  '49':  { name: 'Currency Code, Transaction', type: 'numeric', length: 3, category: 'Transaction' },
  '52':  { name: 'PIN Data', type: 'binary', length: 8, category: 'Security' },
  '55':  { name: 'Integrated Circuit Card (ICC) Data', type: 'binary', length: 255, category: 'Security' },
  '61':  { name: 'Point of Service (POS) Data', type: 'alphanumeric', length: 8, category: 'Terminal' },
  '62':  { name: 'Card Issuer\'s Network Identification Code', type: 'alphanumeric', length: 255, category: 'Card' },
  '63':  { name: 'POS Data Code', type: 'alphanumeric', length: 255, category: 'Terminal' },
  '95':  { name: 'Terminal Verification Results', type: 'binary', length: 5, category: 'Security' },
  '99':  { name: 'Transaction PIN Data', type: 'binary', length: 8, category: 'Security' },
  '100': { name: 'Receiving Institution Identification Code', type: 'numeric', length: 11, category: 'Institutional' },
  '102': { name: 'Account Identification 1', type: 'alphanumeric', length: 28, category: 'Account' },
  '103': { name: 'Account Identification 2', type: 'alphanumeric', length: 28, category: 'Account' }
};

// ------------------------
// PAN truncation (PCI DSS Req. 3.4: show at most first 6 / last 4)
// ------------------------

// DEF-003: the full PAN stays inside the message object; everything that leaves it
// (API response, hex_message, SQLite) carries the truncated form, e.g. 411111******1111.
function maskPan(pan) {
  const digits = String(pan || '');
  if (digits.length < 13) return '*'.repeat(digits.length);
  return digits.slice(0, 6) + '*'.repeat(digits.length - 10) + digits.slice(-4);
}

// ------------------------
// Card expiry (DEF-005)
// ------------------------

// "Now" for authorization. SIM_NOW pins it for tests (any Date-parsable value,
// e.g. 2028-12-31T23:59:59Z); otherwise the real clock. An invalid SIM_NOW is ignored.
function simNow() {
  const pinned = process.env.SIM_NOW;
  if (pinned) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

// A card with expiry MM/YY is valid through the last day of that month (20YY).
// Compared in UTC, like DE12/13. Expects a format- and month-validated "MM/YY".
function isCardExpired(expMMYY, now = simNow()) {
  const [mm, yy] = String(expMMYY).split('/').map(Number);
  const expMonthIndex = (2000 + yy) * 12 + (mm - 1);
  const nowMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return nowMonthIndex > expMonthIndex;
}

// ------------------------
// Message helpers
// ------------------------

// DE49 / tag 5F2A: ISO 4217 numeric codes. Only 2-decimal currencies, because DE4 is built
// as amount * 100 (a 0-decimal currency such as JPY would need a different exponent).
const CURRENCIES = { USD: '840', EUR: '978', GBP: '826', CAD: '124', AUD: '036', MXN: '484' };

function currencyNumeric(code) {
  if (typeof code !== 'string') return null;
  return CURRENCIES[code.trim().toUpperCase()] || null;
}

// DE11: sequential STAN per backend process, 000001-999999, then wraps to 000001.
let stanCounter = 0;
function nextStan() {
  stanCounter = (stanCounter % 999999) + 1;
  return String(stanCounter).padStart(6, '0');
}

// DE12/DE13 and tags 9A/9F21 are the terminal's LOCAL date/time (the server's time zone).
function localStamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  const yy = p(now.getFullYear() % 100);
  const mm = p(now.getMonth() + 1);
  const dd = p(now.getDate());
  const hhmmss = p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  return { hhmmss, mmdd: mm + dd, yymmdd: yy + mm + dd };
}

// DE37: retrieval reference number (an12) derived from a transaction id, like the lab SOAP service.
function retrievalRef(transactionId) {
  return String(transactionId || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 12).toUpperCase().padEnd(12, '0');
}

const fixedAn = (v, len) => String(v == null ? '' : v).slice(0, len).padEnd(len, ' ');

// ------------------------
// TLV Utilities
// ------------------------

// Encoder: JSON {tag: valueHex} -> TLV hex
function buildTLV(tag, valueHex) {
  const cleanTag = tag.toUpperCase();
  const cleanValue = (valueHex || '').toUpperCase();
  const valueBytes = cleanValue.length / 2;

  let lengthHex;
  if (valueBytes < 128) {
    lengthHex = valueBytes.toString(16).padStart(2, '0').toUpperCase();
  } else {
    const len = valueBytes.toString(16).toUpperCase();
    lengthHex = '81' + len.padStart(2, '0');
  }

  return cleanTag + lengthHex + cleanValue;
}

// Decoder: TLV hex -> { tag: valueHex }
function decodeTLV(hex) {
  const result = {};
  let i = 0;

  while (i < hex.length) {
    // TAG
    let tag = hex.substring(i, i + 2);
    i += 2;

    if ((parseInt(tag, 16) & 0x1F) === 0x1F) {
      tag += hex.substring(i, i + 2);
      i += 2;
    }

    // LENGTH
    let lengthByte = hex.substring(i, i + 2);
    i += 2;

    let length = parseInt(lengthByte, 16);

    if (lengthByte === '81') {
      const nextByte = hex.substring(i, i + 2);
      i += 2;
      length = parseInt(nextByte, 16);
    }

    // VALUE
    const value = hex.substring(i, i + length * 2);
    i += length * 2;

    result[tag.toUpperCase()] = value.toUpperCase();
  }

  return result;
}

// Pretty printer: TLV hex -> { tag: { name, category, value } }
function prettyPrintTLV(hex) {
  const decoded = decodeTLV(hex);
  const pretty = {};

  for (const [tag, value] of Object.entries(decoded)) {
    const def = EMV_TAGS[tag] || { name: 'Unknown Tag', category: 'Unknown' };
    pretty[tag] = {
      name: def.name,
      category: def.category,
      value: value
    };
  }

  return pretty;
}

// Reverse encoder: JSON { tag: valueHex } -> TLV hex
function jsonToTLV(json) {
  let hex = '';
  for (const [tag, valueHex] of Object.entries(json)) {
    hex += buildTLV(tag, valueHex);
  }
  return hex;
}

// ------------------------
// EMVTags
// ------------------------

class EMVTags {
  constructor() {
    this.tags = {};
    this.initializeTags();
  }

  initializeTags() {
    Object.assign(this.tags, EMV_TAGS);
  }

  addTag(tagNumber, tagData) {
    this.tags[tagNumber] = tagData;
  }

  getTag(tagNumber) {
    return this.tags[tagNumber];
  }

  getAll() {
    return this.tags;
  }

  getTLVHex() {
    let hex = '';
    for (const [tag, data] of Object.entries(this.tags)) {
      const valueHex = (data.value || '').toUpperCase();
      if (!valueHex) continue;
      hex += buildTLV(tag, valueHex);
    }
    return hex;
  }

  decodeTLV() {
    return decodeTLV(this.getTLVHex());
  }

  prettyPrint() {
    return prettyPrintTLV(this.getTLVHex());
  }

  toJSON() {
    const result = {};
    for (const [tag, data] of Object.entries(this.tags)) {
      result[tag] = {
        name: data.name,
        value: data.value || '',
        category: data.category
      };
    }
    return result;
  }

  fromJSON(json) {
    for (const [tag, valueHex] of Object.entries(json)) {
      if (!this.tags[tag]) {
        this.tags[tag] = {
          name: 'Custom Tag',
          category: 'Custom',
          value: valueHex
        };
      } else {
        this.tags[tag].value = valueHex;
      }
    }
  }
}

// ------------------------
// ISO8583Message
// ------------------------

class ISO8583Message {
  constructor() {
    this.mti = '0100'; // Payment Request
    this.bitmap = '0000000000000000';
    this.fields = {};
    this.fieldDefinitions = {};
    Object.assign(this.fieldDefinitions, ISO8583_FIELDS);
  }

  setMTI(mti) {
    this.mti = mti;
  }

  setField(fieldNumber, value) {
    this.fields[fieldNumber] = value;
    this.setBitmapBit(parseInt(fieldNumber, 10));
  }

  setBitmapBit(fieldNumber) {
    // DEF-008: the primary bitmap is 8 bytes held as 16 hex characters, so byte N lives at
    // hex characters 2N and 2N+1. (The old code read characters N and N+1, which misplaced
    // every bit from DE9 up.) Bit 1 flags a secondary bitmap and is never set here, and
    // DE65-128 are not supported, so only DE2-DE64 are marked.
    if (fieldNumber >= 2 && fieldNumber <= 64) {
      const byteIndex = Math.floor((fieldNumber - 1) / 8);
      const bitIndex = 7 - ((fieldNumber - 1) % 8);
      const pos = byteIndex * 2;
      const byteValue = parseInt(this.bitmap.substr(pos, 2), 16) | (1 << bitIndex);
      this.bitmap = this.bitmap.slice(0, pos)
        + byteValue.toString(16).padStart(2, '0').toUpperCase()
        + this.bitmap.slice(pos + 2);
    }
  }

  getBitmap() {
    return this.bitmap;
  }

  getFields() {
    return this.fieldDefinitions;
  }

  toHex(fields = this.fields) {
    let hex = this.mti + this.bitmap;
    for (const [field, value] of Object.entries(fields)) {
      const str = value.toString();
      hex += Buffer.from(str, 'utf8').toString('hex').toUpperCase();
    }
    return hex;
  }

  toJSON() {
    return {
      mti: this.mti,
      bitmap: this.bitmap,
      fields: this.fields
    };
  }
}

// ------------------------
// EMVTransaction
// ------------------------

class EMVTransaction {
  constructor(
    transactionId,
    cardNumber,
    amount,
    scheme = 'visa',
    interfaceType = 'contact',
    options = {}
  ) {
    this.transactionId = transactionId;
    this.cardNumber = cardNumber;
    this.amount = amount;
    this.scheme = scheme.toLowerCase();
    this.interfaceType = interfaceType.toLowerCase();
    this.currency = currencyNumeric(options.currency || 'USD') || '840';
    this.merchantId = options.merchantId || 'MERCHANT01';
    this.terminalId = options.terminalId || 'TERM0001';
    this.now = options.now || new Date();
    this.authIdResponse = null;
    this.stan = this.generateSTAN();
    this.emvTags = new EMVTags();
    this.iso8583Message = new ISO8583Message();
    this.buildTransaction();
  }

  generateSTAN() {
    return nextStan();
  }

  buildTransaction() {
    const stamp = localStamp(this.now);

    // ISO 8583 core fields (0100 authorization request)
    this.iso8583Message.setField('2', this.cardNumber);
    this.iso8583Message.setField('3', '000000'); // purchase, default accounts
    this.iso8583Message.setField(
      '4',
      // DEF-001: round, don't floor. 19.99 * 100 = 1998.9999999999998 in binary floating point.
      Math.round(Number(this.amount) * 100).toString().padStart(12, '0')
    );
    this.iso8583Message.setField('11', this.stan);
    this.iso8583Message.setField('12', stamp.hhmmss); // local time
    this.iso8583Message.setField('13', stamp.mmdd);   // local date
    // DE39 in the 0100 is kept for backward compatibility (DEF-002 tests); the real
    // response code is in the 0110 (getResponseISO8583Data).
    this.iso8583Message.setField('39', '00');
    this.iso8583Message.setField('41', fixedAn(this.terminalId, 8));
    this.iso8583Message.setField('42', fixedAn(this.merchantId, 15));
    this.iso8583Message.setField('49', this.currency);

    // Scheme-flavored EMV values
    const dateYYMMDD = stamp.yymmdd;
    const timeHHMMSS = stamp.hhmmss;

    let aid;
    let appVersion;
    let usageControl;

    switch (this.scheme) {
      case 'mastercard':
        aid = 'A0000000041010';      // Mastercard AID (sample)
        appVersion = '0002';         // Sample version
        usageControl = 'F840';       // Sample usage control
        break;
      case 'amex':
        aid = 'A00000002501';        // Amex AID (sample)
        appVersion = '0001';
        usageControl = 'F800';
        break;
      case 'discover':
        aid = 'A0000001523010';      // Discover AID (sample)
        appVersion = '0001';
        usageControl = 'F800';
        break;
      case 'visa':
      default:
        aid = 'A0000000031010';      // Visa AID (sample)
        appVersion = '008C';         // Sample version
        usageControl = 'F800';       // Sample usage control
        break;
    }

    // EMV tags
    this.emvTags.addTag('9F06', {
      name: 'Application Identifier (AID) - terminal',
      category: 'Application',
      value: aid
    });
    this.emvTags.addTag('9F08', {
      name: 'Application Version Number',
      category: 'Application',
      value: appVersion
    });
    this.emvTags.addTag('9F07', {
      name: 'Application Usage Control',
      category: 'Application',
      value: usageControl
    });
    this.emvTags.addTag('9F26', {
      name: 'Application Cryptogram',
      category: 'Cryptography',
      value: 'ABCDEF0123456789'
    });
    this.emvTags.addTag('95', {
      name: 'Terminal Verification Results (TVR)',
      category: 'Security',
      value: '0000000000'
    });
    this.emvTags.addTag('9B', {
      name: 'Transaction Status Information (TSI)',
      category: 'Security',
      value: '0000'
    });
    this.emvTags.addTag('9F37', {
      name: 'Unpredictable Number',
      category: 'Security',
      value: '11223344'
    });
    this.emvTags.addTag('9F10', {
      name: 'Issuer Application Data (IAD)',
      category: 'Application',
      value: '06010A03A00000'
    });
    this.emvTags.addTag('9F1A', {
      name: 'Terminal Country Code',
      category: 'Terminal',
      value: '0840'
    });
    this.emvTags.addTag('5F2A', {
      name: 'Transaction Currency Code',
      category: 'Transaction',
      value: '0' + this.currency
    });
    this.emvTags.addTag('9C', {
      name: 'Transaction Type',
      category: 'Transaction',
      value: '00' // Purchase
    });
    this.emvTags.addTag('9A', {
      name: 'Transaction Date',
      category: 'Transaction',
      value: dateYYMMDD
    });
    this.emvTags.addTag('9F21', {
      name: 'Transaction Time',
      category: 'Transaction',
      value: timeHHMMSS
    });

    // Field 55: EMV TLV
    const tlvHex = this.emvTags.getTLVHex();
    this.iso8583Message.setField('55', tlvHex);
  }

  // DEF-002: write the authorization decision: DE39 and EMV tag 8A (Authorisation Response Code,
  // an2, so '51' is stored as ASCII hex 3531). The 0100 keeps them for backward compatibility;
  // the 0110 from getResponseISO8583Data() is where they properly belong.
  // authCode (approvals only) becomes DE38 in the 0110: its last 6 characters.
  setAuthorizationResult(responseCode, authCode = null) {
    const code = String(responseCode == null ? '' : responseCode).padStart(2, '0').slice(0, 2);
    this.responseCode = code;
    this.authIdResponse = authCode ? String(authCode).slice(-6) : null;
    this.iso8583Message.setField('39', code);
    this.emvTags.addTag('8A', {
      name: 'Authorisation Response Code',
      category: 'Response',
      value: Buffer.from(code, 'ascii').toString('hex').toUpperCase()
    });
    this.iso8583Message.setField('55', this.emvTags.getTLVHex());
  }

  getEMVData() {
    return {
      scheme: this.scheme,
      tags: this.emvTags.toJSON(),
      tlv_hex: this.emvTags.getTLVHex(),
      decoded: this.emvTags.decodeTLV(),
      pretty: this.emvTags.prettyPrint()
    };
  }

  // The 0100 authorization request, as returned and stored.
  getISO8583Data() {
    return messageData(this.iso8583Message);
  }

  // The 0110 authorization response: echoes DE2/3/4/11/12/13/41/42/49, adds DE38 (approvals)
  // and DE39, and carries the issuer's tag 8A in DE55.
  getResponseISO8583Data() {
    const req = this.iso8583Message.fields;
    const msg = new ISO8583Message();
    msg.setMTI('0110');
    for (const de of ['2', '3', '4', '11', '12', '13']) msg.setField(de, req[de]);
    if (this.authIdResponse) msg.setField('38', this.authIdResponse);
    msg.setField('39', this.responseCode || req['39']);
    for (const de of ['41', '42', '49']) msg.setField(de, req[de]);
    const tag8A = this.emvTags.getTag('8A');
    if (tag8A && tag8A.value) msg.setField('55', buildTLV('8A', tag8A.value));
    return messageData(msg);
  }

  getField55Pretty() {
    const tlvHex = this.iso8583Message.fields['55'] || '';
    return {
      tlv_hex: tlvHex,
      decoded: decodeTLV(tlvHex),
      pretty: prettyPrintTLV(tlvHex)
    };
  }

  setField55FromJSON(json) {
    this.emvTags.fromJSON(json);
    const tlvHex = this.emvTags.getTLVHex();
    this.iso8583Message.setField('55', tlvHex);
  }

  generateTLVHex() {
    return this.emvTags.getTLVHex();
  }
}

// Returned/stored form of a message. DEF-003: DE2 is truncated (first 6 / last 4) in the
// fields and in hex_message; the full PAN never leaves the message object.
function messageData(message) {
  const fieldDefs = message.getFields();
  const outFields = { ...message.fields };
  if (outFields['2'] && /^\d+$/.test(outFields['2'])) outFields['2'] = maskPan(outFields['2']);

  const fields = {};
  for (const fieldNum of Object.keys(outFields).sort((a, b) => a - b)) {
    const def = fieldDefs[fieldNum] || { name: 'Field ' + fieldNum, type: 'unknown' };
    fields[fieldNum] = { name: def.name, value: outFields[fieldNum] || '', type: def.type };
  }

  return {
    mti: message.mti,
    bitmap: message.getBitmap(),
    fields,
    hex_message: message.toHex(outFields)
  };
}

// Follow-up messages for a stored transaction: 0200 (refund, DE3 200000) and 0400 (reversal,
// DE3 000000). originalFields is the stored 0100 field map ({ '2': { value }, ... }); its DE2
// is already truncated, so the follow-up never sees a full PAN. DE37 links to the original.
function buildFollowUpMessage({ mti, processingCode, amountMinor, originalTransactionId, originalFields, now = new Date() }) {
  const value = (de) => (originalFields && originalFields[de] ? originalFields[de].value : undefined);
  const stamp = localStamp(now);
  const msg = new ISO8583Message();
  msg.setMTI(mti);
  if (value('2')) msg.setField('2', value('2'));
  msg.setField('3', processingCode);
  msg.setField('4', String(amountMinor).padStart(12, '0'));
  msg.setField('11', nextStan());
  msg.setField('12', stamp.hhmmss);
  msg.setField('13', stamp.mmdd);
  msg.setField('37', retrievalRef(originalTransactionId));
  for (const de of ['41', '42', '49']) if (value(de)) msg.setField(de, value(de));
  return messageData(msg);
}

module.exports = {
  EMVTags,
  ISO8583Message,
  EMVTransaction,
  maskPan,
  isCardExpired,
  simNow,
  currencyNumeric,
  CURRENCIES,
  nextStan,
  localStamp,
  retrievalRef,
  buildFollowUpMessage,
  buildTLV,
  decodeTLV,
  prettyPrintTLV,
  jsonToTLV
};
