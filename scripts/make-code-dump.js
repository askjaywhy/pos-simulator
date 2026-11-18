#!/usr/bin/env node
// make-code-dump.js - builds POS_Simulator_Code.md (source snapshot for the Claude Project).
//
// Usage (from the repo root):
//   node scripts/make-code-dump.js                 -> %USERPROFILE%\pos-handoff\POS_Simulator_Code.md
//   node scripts/make-code-dump.js <output-file>
//
// Includes every file git knows about (tracked + untracked-but-not-ignored, so on-hold work such
// as lab/soap is included). Excludes: node_modules, test-results, playwright-report, heal-log,
// _to_delete, target, lockfiles, binaries/images, POS_Simulator_Status.md, and the top-level docs
// that live as separate Project files (README.md, ARCHITECTURE.txt, SETUP_GUIDE.md).
// The output goes outside the repo by default so it never gets committed.

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const out = path.resolve(process.argv[2] || path.join(os.homedir(), 'pos-handoff', 'POS_Simulator_Code.md'));

const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
const head = git('rev-parse --short HEAD')[0];
const dirty = git('status --porcelain').length > 0;
const files = [...new Set([...git('ls-files'), ...git('ls-files --others --exclude-standard')])].sort();

const EXCLUDE_DIRS = /(^|\/)(node_modules|test-results|playwright-report|heal-log|_to_delete|target|\.git)(\/|$)/;
const EXCLUDE_FILES = new Set(['README.md', 'ARCHITECTURE.txt', 'SETUP_GUIDE.md', 'POS_Simulator_Status.md']);
const EXCLUDE_EXT = /\.(png|jpe?g|gif|ico|webp|pdf|zip|tgz|gz|jar|class|exe|dll|woff2?|ttf|mp4|docx|xlsx)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const MAX_BYTES = 300 * 1024;

const LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.json': 'json', '.md': 'markdown', '.html': 'html', '.css': 'css',
  '.ps1': 'powershell', '.bat': 'bat', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml', '.java': 'java',
  '.xml': 'xml', '.sql': 'sql', '.py': 'python', '.feature': 'gherkin', '.properties': 'properties', '.txt': 'text'
};

const included = [];
const skipped = [];
for (const f of files) {
  const full = path.join(root, f);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  if (EXCLUDE_DIRS.test(f) || LOCKFILE.test(f) || EXCLUDE_EXT.test(f) || (EXCLUDE_FILES.has(f))) continue;
  const size = fs.statSync(full).size;
  if (size > MAX_BYTES) { skipped.push(`${f} (${Math.round(size / 1024)} KB, too large)`); continue; }
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) { skipped.push(`${f} (binary)`); continue; }
  included.push({ f, text: buf.toString('utf8').replace(/\r\n/g, '\n') });
}

const fence = (text) => (text.includes('```') ? '````' : '```');
const today = new Date().toISOString().slice(0, 10);
let md = `# POS Simulator — Source Code Snapshot\n\n`;
md += `Generated ${today} from ${root} (HEAD ${head}${dirty ? ' + uncommitted work' : ''}). `;
md += `Excludes node_modules, test-results, playwright-report, heal-log, _to_delete, target, lockfiles, binaries, POS_Simulator_Status.md. `;
md += `Top-level docs (README, ARCHITECTURE, SETUP_GUIDE) are separate project files.\n\n`;
md += `Note: lab credentials (poslab, PosLab#2026, dummy HEC token) are local Docker defaults, not real secrets.\n\n`;
if (skipped.length) md += `Skipped: ${skipped.map((s) => '`' + s + '`').join(', ')}\n\n`;
md += `## File index\n\n${included.map(({ f }) => `- \`${f}\``).join('\n')}\n\n`;
for (const { f, text } of included) {
  const lang = LANG[path.extname(f).toLowerCase()] || '';
  const fn = fence(text);
  md += `## ${f}\n\n${fn}${lang}\n${text.replace(/\n$/, '')}\n${fn}\n\n`;
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(`Wrote ${out}`);
console.log(`  HEAD ${head}${dirty ? ' (+ uncommitted)' : ''}, ${included.length} files, ${Math.round(Buffer.byteLength(md) / 1024)} KB`);
if (skipped.length) console.log(`  Skipped: ${skipped.join('; ')}`);
