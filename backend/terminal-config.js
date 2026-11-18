// terminal-config.js
// In-memory terminal profile (what a TMS would push to a device). Defaults equal the values the
// simulator had hard-coded before this module existed, so default behavior is unchanged.
// GET/PUT/DELETE /api/terminal/config; POST /api/admin/reset also restores the defaults.

const DEFAULTS = Object.freeze({
  terminal_id: 'TERM0001',          // DE41
  merchant_id: 'MERCHANT01',        // DE42 when the request omits merchant_id
  country_code: '0840',             // tag 9F1A
  terminal_type: '22',              // attended, online only
  serial_number: 'SIM-0000001',
  firmware_version: 'SIMFW 1.0.0',
  kernel_versions: Object.freeze({ contact: 'EMV L2 contact (simulated)', contactless: 'C-2/C-3/C-4/C-6 style (simulated)' }),
  aids: Object.freeze(['A0000000031010', 'A0000000041010', 'A00000002501', 'A0000001523010']),
  capk_indexes: Object.freeze(['09']), // the simulated cards use CAPK index 09
  floor_limit_minor: 0,                // TVR byte 4 bit 8 when amount >= floor limit
  contactless_cvm_limit_minor: 10000,  // above this, contactless asks for online PIN
  contactless_transaction_limit_minor: 0 // 0 = no limit; above it, contactless is refused
});

const clone = (o) => JSON.parse(JSON.stringify(o));
let current = clone(DEFAULTS);

const MAX_MINOR = 999999999999;
const isLimit = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_MINOR;
const VALIDATORS = {
  terminal_id: (v) => typeof v === 'string' && /^[\x20-\x7E]{1,8}$/.test(v) || 'must be 1-8 printable characters',
  merchant_id: (v) => typeof v === 'string' && /^[\x20-\x7E]{1,15}$/.test(v) || 'must be 1-15 printable characters',
  country_code: (v) => typeof v === 'string' && /^\d{4}$/.test(v) || 'must be 4 digits (e.g. 0840)',
  terminal_type: (v) => typeof v === 'string' && /^\d{2}$/.test(v) || 'must be 2 digits (e.g. 22)',
  serial_number: (v) => typeof v === 'string' && v.length >= 1 && v.length <= 32 || 'must be 1-32 characters',
  firmware_version: (v) => typeof v === 'string' && v.length >= 1 && v.length <= 32 || 'must be 1-32 characters',
  aids: (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' && /^([0-9A-Fa-f]{2}){5,16}$/.test(a)) || 'must be a non-empty array of AIDs (10-32 hex)',
  capk_indexes: (v) => Array.isArray(v) && v.every((c) => typeof c === 'string' && /^[0-9A-Fa-f]{2}$/.test(c)) || 'must be an array of 2-hex CAPK indexes',
  floor_limit_minor: (v) => isLimit(v) || 'must be an integer 0..999999999999 (minor units)',
  contactless_cvm_limit_minor: (v) => isLimit(v) || 'must be an integer 0..999999999999 (minor units)',
  contactless_transaction_limit_minor: (v) => isLimit(v) || 'must be an integer 0..999999999999 (minor units; 0 = no limit)'
};

function get() {
  return clone(current);
}

// Partial update. All-or-nothing: any invalid or unknown key rejects the whole patch.
function update(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'kernel_versions') { errors.push('kernel_versions is read-only'); continue; }
    const check = VALIDATORS[k];
    if (!check) { errors.push(`unknown key: ${k}`); continue; }
    const r = check(v);
    if (r !== true) errors.push(`${k} ${r}`);
  }
  if (errors.length) return { ok: false, errors };
  const next = { ...current, ...clone(patch) };
  if (patch.aids) next.aids = patch.aids.map((a) => a.toUpperCase());
  if (patch.capk_indexes) next.capk_indexes = patch.capk_indexes.map((c) => c.toUpperCase());
  current = next;
  return { ok: true, config: get() };
}

function reset() {
  current = clone(DEFAULTS);
  return get();
}

module.exports = { DEFAULTS, get, update, reset };
