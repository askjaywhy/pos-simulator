#!/usr/bin/env node
// PreToolUse guard for shell commands (Bash / PowerShell tools). Exit 2 = block.
//
// guard.js only sees Claude's Edit/Write tools. An agent can also change files through a
// shell command (Set-Content, >, sed -i, git checkout ...), so this hook closes that path:
//
//  1. Blocks shell commands that write to protected paths: backend/, frontend/, .claude/,
//     CLAUDE.md, .mcp.json, and visual baselines (*-snapshots/).
//  2. Blocks Playwright snapshot updates (--update-snapshots / -u) unless a human has
//     approved one by creating .claude/approve-snapshot-update. The approval is used once.
//  3. Blocks destructive git commands that rewrite the working tree or history.
//
// This is pattern matching, not a sandbox: it catches the normal ways an agent edits files
// and leaves an audit trail. Human review of every diff is still the real control.
const fs = require('fs');
const path = require('path');

const PROTECTED = [
  /(^|[\s'"=(:/])backend\//,
  /(^|[\s'"=(:/])frontend\//,
  /(^|[\s'"=(:/])\.claude\//,
  /(^|[\s'"=(:/])claude\.md\b/,
  /(^|[\s'"=(:/])\.mcp\.json\b/,
  /-snapshots\//,
];

const WRITE_VERBS = [
  /\bset-content\b/, /\badd-content\b/, /\bout-file\b/, /\bnew-item\b/, /\bremove-item\b/,
  /\bmove-item\b/, /\bcopy-item\b/, /\brename-item\b/, /\bclear-content\b/,
  /\[io\.file\]::/, /\bsc\b\s/, /\bac\b\s/,
  /\btee\b/, /\bsed\s+(-[a-z]*i|--in-place)/, /\bperl\s+-[a-z]*i/,
  /\b(rm|mv|cp|del|erase|move|copy|ren|rename|rmdir|rd|mkdir|touch|truncate|chmod)\b/,
  /\bwritefile(sync)?\b/, /\bappendfile(sync)?\b/, /\bcreatewritestream\b/, /\bunlink(sync)?\b/,
  /\bopen\([^)]*['"][wa]\+?['"]/,
  /\bgit\s+(checkout|restore|apply|am|cherry-pick|revert|merge|rebase|stash\s+pop|mv|rm)\b/,
];

const DESTRUCTIVE_GIT = /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force)|commit\s+--amend|rebase|filter-branch|update-ref)\b/;
// --update-snapshots anywhere (also catches `npm test -- --update-snapshots`), or the short
// -u flag on a playwright / npm / npx command.
function isSnapshotUpdate(cmd) {
  if (/--update-snapshots\b/.test(cmd)) return true;
  return /\b(playwright|npm|npx)\b/.test(cmd) && /\s-u(\s|=|$|;|&|\|)/.test(cmd);
}
const APPROVAL_TOKENS = /approve-snapshot-update/;

function block(msg) {
  process.stderr.write(
    `BLOCKED by shell-guard: ${msg}\n` +
    'Agents may only change tests/ and specs/, and only through the Edit/Write tools so each ' +
    'change is checked and logged. Ask the human to make this change instead.\n');
  process.exit(2);
}

function hasRedirectWrite(cmd) {
  const cleaned = cmd
    .replace(/\d?>&\d/g, ' ')
    .replace(/\d?>\s*(\$null|nul|\/dev\/null)\b/g, ' ')
    .replace(/2>>?\s*\S+/g, ' ');
  return /(^|[^-=<>])>>?\s*[^\s&=]/.test(cleaned);
}

function logEvent(root, entry) {
  try {
    fs.mkdirSync(path.join(root, 'heal-log'), { recursive: true });
    fs.appendFileSync(path.join(root, 'heal-log', 'heals.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never break the hook */ }
}

function main(event) {
  const raw = (event.tool_input && event.tool_input.command) || '';
  if (!raw) return;
  const root = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  const cmd = raw.replace(/\\/g, '/').toLowerCase();

  if (APPROVAL_TOKENS.test(cmd)) {
    block('the snapshot-update approval can only be created by the human, not by an agent.');
  }

  if (DESTRUCTIVE_GIT.test(cmd)) {
    block(`destructive git command: ${raw.trim().slice(0, 120)}`);
  }

  if (isSnapshotUpdate(cmd)) {
    const approval = path.join(root, '.claude', 'approve-snapshot-update');
    if (!fs.existsSync(approval)) {
      block('updating visual baselines needs human approval. Report which snapshots differ and ' +
        'why; the human approves with:  New-Item .claude\\approve-snapshot-update');
    }
    let note = '';
    try { note = fs.readFileSync(approval, 'utf8').trim(); fs.unlinkSync(approval); } catch { /* ignore */ }
    logEvent(root, {
      session: event.session_id || null, tool: event.tool_name, type: 'snapshot-update-approved',
      command: raw.trim().slice(0, 300), approval_note: note || null,
    });
    return;
  }

  const touchesProtected = PROTECTED.some((re) => re.test(cmd));
  if (touchesProtected && (hasRedirectWrite(cmd) || WRITE_VERBS.some((re) => re.test(cmd)))) {
    block(`shell command would modify a protected path: ${raw.trim().slice(0, 160)}`);
  }
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input || '{}'); } catch { /* fall through with empty event */ }
  main(event);
  process.exit(0);
});
