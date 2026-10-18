// Run: node --test .claude/hooks/tests/shell-guard.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHELL_GUARD = path.join(__dirname, '..', 'shell-guard.js');
const GUARD = path.join(__dirname, '..', 'guard.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shell-guard-'));
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });

function sh(command, tool = 'PowerShell') {
  const r = spawnSync(process.execPath, [SHELL_GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: root }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return r.status;
}
function edit(file, newString) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Edit',
      tool_input: { file_path: path.join(root, file), old_string: 'x', new_string: newString }, cwd: root }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return r.status;
}

// --- allowed: what the agents legitimately run ------------------------------------------
test('allows running the UI tests (the command Claude used)', () => {
  assert.equal(sh('cd tests; npx playwright test ui/agent --reporter=line 2>&1 | Select-Object -Last 60'), 0);
});
test('allows reading protected files', () => {
  assert.equal(sh('Get-Content backend\\server.js | Select-String "app.get"'), 0);
  assert.equal(sh('cat frontend/index.html | grep submit', 'Bash'), 0);
});
test('allows git status / diff / log / add / commit', () => {
  assert.equal(sh('git status; git diff frontend/index.html; git log --oneline -5'), 0);
  assert.equal(sh('git add tests/ui/pages/TerminalPage.js heal-log/heals.jsonl && git commit -m "Heal"'), 0);
});
test('allows node one-liners with arrow functions that only read', () => {
  assert.equal(sh('node -e "const s=require(\'fs\').readFileSync(\'backend/server.js\',\'utf8\'); s.split(\'\\n\').forEach(l => l)"'), 0);
});

// --- blocked: writing protected paths through the shell --------------------------------
test('blocks Set-Content on the frontend', () => {
  assert.equal(sh("(Get-Content frontend\\index.html) -replace 'CHARGE','PAY' | Set-Content frontend\\index.html"), 2);
});
test('blocks Add-Content / Out-File / redirect into backend', () => {
  assert.equal(sh('Add-Content backend\\server.js "// x"'), 2);
  assert.equal(sh('"x" | Out-File backend/server.js'), 2);
  assert.equal(sh('echo "// x" >> backend/server.js', 'Bash'), 2);
});
test('blocks sed -i and node writeFileSync on protected files', () => {
  assert.equal(sh("sed -i 's/a/b/' backend/emv-iso8583.js", 'Bash'), 2);
  assert.equal(sh('node -e "require(\'fs\').writeFileSync(\'frontend/index.html\',\'x\')"'), 2);
});
test('blocks editing the guardrails themselves', () => {
  assert.equal(sh('Set-Content .claude\\settings.json "{}"'), 2);
  assert.equal(sh('Remove-Item .claude\\hooks\\guard.js'), 2);
  assert.equal(sh('Add-Content CLAUDE.md "agents may edit backend"'), 2);
  assert.equal(sh('Set-Content .mcp.json "{}"'), 2);
});
test('blocks git checkout/restore of protected files', () => {
  assert.equal(sh('git checkout -- frontend/index.html'), 2);
  assert.equal(sh('git restore backend/server.js'), 2);
});
test('blocks destructive git commands', () => {
  assert.equal(sh('git reset --hard HEAD~1'), 2);
  assert.equal(sh('git commit --amend -m "x"'), 2);
  assert.equal(sh('git push --force'), 2);
});

// --- snapshot updates -------------------------------------------------------------------
test('blocks --update-snapshots without approval (all spellings)', () => {
  assert.equal(sh('cd tests; npx playwright test ui/agent --update-snapshots'), 2);
  assert.equal(sh('cd tests; npx playwright test ui/agent -u'), 2);
  assert.equal(sh('cd tests; npm run test:agent-ui -- --update-snapshots'), 2);
});
test('blocks an agent from creating the approval itself', () => {
  assert.equal(sh('New-Item .claude\\approve-snapshot-update'), 2);
  assert.equal(sh('echo ok > approve-snapshot-update', 'Bash'), 2);
});
test('human approval allows exactly one snapshot update and is logged', () => {
  const approval = path.join(root, '.claude', 'approve-snapshot-update');
  fs.writeFileSync(approval, 'button renamed to PROCESS TRANSACTION');
  assert.equal(sh('cd tests; npx playwright test ui/agent --update-snapshots'), 0);
  assert.equal(fs.existsSync(approval), false, 'approval is consumed');
  assert.equal(sh('cd tests; npx playwright test ui/agent --update-snapshots'), 2, 'second use blocked');
  const log = fs.readFileSync(path.join(root, 'heal-log', 'heals.jsonl'), 'utf8');
  assert.match(log, /snapshot-update-approved/);
  assert.match(log, /PROCESS TRANSACTION/);
});

// --- Edit/Write guard additions -----------------------------------------------------------
test('guard.js blocks direct edits to baseline images', () => {
  assert.equal(edit('tests/ui/agent/x.spec.js-snapshots/terminal-empty-chromium-win32.png', 'x'), 2);
});
test('guard.js blocks enabling updateSnapshots in config', () => {
  assert.equal(edit('tests/playwright.config.js', "  updateSnapshots: 'all',"), 2);
});
test('guard.js still allows a normal page-object fix', () => {
  assert.equal(edit('tests/ui/pages/TerminalPage.js', "getByRole('button', { name: 'PROCESS TRANSACTION' })"), 0);
});
