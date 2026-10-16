// Run: node --test .claude/hooks/tests
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'guard.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-guard-'));
fs.mkdirSync(path.join(root, 'tests', 'ui'), { recursive: true });

function run(tool, input) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return r.status;
}
const edit = (file, o, n) => run('Edit', { file_path: path.join(root, file), old_string: o, new_string: n });

test('blocks edits to backend source', () => {
  assert.equal(edit('backend/emv-iso8583.js', 'a', 'b'), 2);
});
test('blocks edits to the frontend even via a ../ path', () => {
  assert.equal(edit('tests/../frontend/index.html', 'a', 'b'), 2);
});
test('blocks weakening a response-code assertion', () => {
  assert.equal(edit('tests/emv-iso8583.spec.js',
    "expect(res.responseCode).toBe('00');", "expect(res.responseCode).toBeDefined();"), 2);
});
test('blocks removing an assertion', () => {
  assert.equal(edit('tests/ui/payment-form-approved.spec.js', "await expect(t.status).toHaveText('APPROVED');\n", ''), 2);
});
test('blocks adding test.skip', () => {
  assert.equal(edit('tests/ui/payment-form-approved.spec.js', "test('decline',", "test.skip('decline',"), 2);
});
test('allows a page-object locator fix', () => {
  assert.equal(edit('tests/ui/pages/TerminalPage.js', "getByRole('button', { name: 'Pay' })",
    "getByRole('button', { name: 'Charge' })"), 0);
});
test('allows a brand-new spec file', () => {
  assert.equal(run('Write', { file_path: path.join(root, 'tests/ui/agent/new.spec.js'),
    content: "expect(x).toBe('00')" }), 0);
});
test('blocks overwriting a spec that drops an assertion', () => {
  const f = path.join(root, 'tests/ui/existing.spec.js');
  fs.writeFileSync(f, "await expect(amount).toHaveText('$25.00');\n");
  assert.equal(run('Write', { file_path: f, content: '// gone\n' }), 2);
});
test('allows writing a plan in specs/', () => {
  assert.equal(run('Write', { file_path: path.join(root, 'specs/sale.plan.md'), content: '# plan' }), 0);
});
