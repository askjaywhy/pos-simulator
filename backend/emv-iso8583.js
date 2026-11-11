// emv-iso8583.js
// EMV + ISO 8583 with realistic TLV, scheme-flavored sample data

const EMV_TAGS = {
  '9F06': { name: 'Application Dedicated File (AID)', category: 'Application' },
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
    if (fieldNumber > 0 && fieldNumber < 64) {
      const byteIndex = Math.floor((fieldNumber - 1) / 8);
      const bitIndex = 7 - ((fieldNumber - 1) % 8);
      const byteArray = this.bitmap.split('');
      const byteValue = parseInt(byteArray[byteIndex] + byteArray[byteIndex + 1], 16);
      const newValue = byteValue | (1 << bitIndex);
      const hex = newValue.toString(16).padStart(2, '0').toUpperCase();
      byteArray[byteIndex] = hex.charAt(0);
      byteArray[byteIndex + 1] = hex.charAt(1);
      this.bitmap = byteArray.join('');
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
    interfaceType = 'contact'   // <-- DEFAULT VALUE ONLY
  ) {
    this.transactionId = transactionId;
    this.cardNumber = cardNumber;
    this.amount = amount;
    this.scheme = scheme.toLowerCase();
    this.interfaceType = interfaceType.toLowerCase();  // <-- VALID
    this.stan = this.generateSTAN();
    this.emvTags = new EMVTags();
    this.iso8583Message = new ISO8583Message();
    this.buildTransaction();
  }

  generateSTAN() {
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  }

  buildTransaction() {
    // ISO 8583 core fields
    this.iso8583Message.setField('2', this.cardNumber);
    this.iso8583Message.setField(
      '4',
      Math.floor(this.amount * 100).toString().padStart(12, '0')
    );
    this.iso8583Message.setField('11', this.stan);
    this.iso8583Message.setField('39', '00'); // Approved
    this.iso8583Message.setField(
      '12',
      new Date().toISOString().substring(11, 19).replace(/:/g, '')
    );
    this.iso8583Message.setField(
      '13',
      new Date().toISOString().substring(5, 10).replace('-', '')
    );
    this.iso8583Message.setField('49', '840'); // USD

    // Scheme-flavored EMV values
    const now = new Date();
    const dateYYMMDD = now.toISOString().substring(2, 10).replace(/-/g, '');
    const timeHHMMSS = now.toISOString().substring(11, 19).replace(/:/g, '');

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
      case 'visa':
      default:
        aid = 'A0000000031010';      // Visa AID (sample)
        appVersion = '008C';         // Sample version
        usageControl = 'F800';       // Sample usage control
        break;
    }

    // EMV tags
    this.emvTags.addTag('9F06', {
      name: 'Application Dedicated File (AID)',
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

  // DEF-002: write the authorization decision into the message: DE39 and EMV tag 8A
  // (Authorisation Response Code, an2, so '51' is stored as ASCII hex 3531), then rebuild DE55.
  // Interim fix: in a real flow DE39/8A belong in the 0110 response; the simulator only builds a 0100.
  setAuthorizationResult(responseCode) {
    const code = String(responseCode == null ? '' : responseCode).padStart(2, '0').slice(0, 2);
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

  getISO8583Data() {
    const fields = {};
    const fieldDefs = this.iso8583Message.getFields();

    // DEF-003: never emit the full PAN. Everything returned here is also what gets stored.
    const outFields = { ...this.iso8583Message.fields };
    if (outFields['2']) outFields['2'] = maskPan(outFields['2']);

    for (const [fieldNum, fieldDef] of Object.entries(fieldDefs)) {
      const fieldNumInt = parseInt(fieldNum, 10);
      if ([2, 4, 11, 12, 13, 39, 49, 55].includes(fieldNumInt)) {
        fields[fieldNum] = {
          name: fieldDef.name,
          value: outFields[fieldNum] || '',
          type: fieldDef.type
        };
      }
    }

    return {
      mti: this.iso8583Message.mti,
      bitmap: this.iso8583Message.getBitmap(),
      fields: fields,
      hex_message: this.iso8583Message.toHex(outFields)
    };
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

module.exports = {
  EMVTags,
  ISO8583Message,
  EMVTransaction,
  maskPan,
  buildTLV,
  decodeTLV,
  prettyPrintTLV,
  jsonToTLV
};
