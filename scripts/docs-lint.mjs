#!/usr/bin/env node
/**
 * 文档规则检查（规则见 AGENTS.md §5）。
 *
 * 默认只告警（exit 0），`--strict` 时有问题即 exit 1。
 * 检查：体积上限、状态块、CHANGELOG 条目、现行文档的相对链接与索引登记、
 * 现行文档不得用链接指向归档区。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

const LIMITS = { 'AGENTS.md': 100, 'docs/README.md': 80, 'CHANGELOG.md': 400 };
const DEFAULT_LIMIT = 400;
/** 超过默认上限的现行文档白名单：路径 → [上限, 原因] */
const OVERSIZE = {
  'docs/design-v3.md': [460, '冻结契约全集，拆分会让契约散落多处'],
  'docs/ui-redesign/ui-guidelines.md': [440, 'UI 规范全集，§8 组件与交互约束需要集中'],
};
const STATUS_MAX = 200;
const CHANGELOG_ENTRY_MAX = 160;
/** 从这个版本起（含 Unreleased）CHANGELOG 条目必须一行；更早的段保持原样 */
const CHANGELOG_STRICT_AFTER = '0.12.3';

const problems = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const EXCLUDED_DIRS = ['docs/archive/', 'docs/verification/', 'docs/plans/'];
const isAdr = (p) => p.startsWith('docs/engineering/adr/ADR-');
const currentDocs = [
  ...walk('docs').filter((p) => !EXCLUDED_DIRS.some((d) => p.startsWith(d))),
  'docs/plans/backlog.md',
  'agent/README.md',
  'agent/adapters/host_ops/README.md',
];

// 1. 体积上限
for (const [file, limit] of Object.entries(LIMITS)) {
  const n = lineCount(read(file));
  if (n > limit) problems.push(`${file}: ${n} 行，超过上限 ${limit}`);
}
for (const file of currentDocs) {
  if (file in LIMITS || isAdr(file)) continue;
  const [limit] = OVERSIZE[file] ?? [DEFAULT_LIMIT];
  const n = lineCount(read(file));
  if (n > limit) problems.push(`${file}: ${n} 行，超过上限 ${limit}`);
}

// 2. 状态块（ADR 用自己的「- 状态」格式，不检查）
for (const file of [...currentDocs, 'AGENTS.md'].filter((p) => !isAdr(p) && p !== 'AGENTS.md')) {
  const head = read(file).split('\n').slice(0, 5);
  const status = head.find((l) => l.startsWith('> 状态：'));
  if (!status) problems.push(`${file}: 缺少状态块（标题下一行 \`> 状态：…\`）`);
  else if ([...status].length > STATUS_MAX) {
    problems.push(`${file}: 状态块 ${[...status].length} 字符，超过 ${STATUS_MAX}`);
  }
}

// 3. 相对链接必须存在；现行文档不得用链接指向归档区
const LINK = /\]\(([^)\s#]+)(#[^)]*)?\)/g;
for (const file of [...currentDocs, 'AGENTS.md', 'README.md', 'CONTRIBUTING.md']) {
  const text = read(file);
  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const resolved = rel(path.resolve(path.dirname(path.join(ROOT, file)), target));
    if (!fs.existsSync(path.join(ROOT, resolved))) problems.push(`${file}: 链接目标不存在 ${target}`);
    else if (resolved.startsWith('docs/archive/') && !isAdr(file)) {
      problems.push(`${file}: 现行文档不得链接归档区 ${target}`);
    }
  }
}

// 4. 现行文档必须登记在 docs/README.md
const index = read('docs/README.md');
for (const file of currentDocs) {
  if (file === 'docs/README.md' || isAdr(file)) continue;
  if (file === 'docs/engineering/adr/README.md') {
    if (!index.includes('docs/engineering/adr/')) problems.push('docs/README.md: 未登记 docs/engineering/adr/');
    continue;
  }
  if (file === 'docs/host-ops-async.md' && index.includes('host-ops-async.md')) continue;
  if (!index.includes(`\`${file}\``)) problems.push(`docs/README.md: 未登记现行文档 ${file}`);
}

// 5. CHANGELOG：新版本段的条目必须一行且不超长
const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
let strict = false;
for (const [i, line] of read('CHANGELOG.md').split('\n').entries()) {
  const heading = line.match(/^## \[([^\]]+)\]/);
  if (heading) {
    const v = heading[1];
    strict = v === 'Unreleased' || (/^\d+\.\d+\.\d+$/.test(v) && cmp(v, CHANGELOG_STRICT_AFTER) > 0);
    continue;
  }
  if (!strict) continue;
  if (/^\s{2,}\S/.test(line)) problems.push(`CHANGELOG.md:${i + 1}: 条目必须一行，不要换行续写`);
  if (line.startsWith('- ') && [...line].length > CHANGELOG_ENTRY_MAX) {
    problems.push(`CHANGELOG.md:${i + 1}: 条目 ${[...line].length} 字符，超过 ${CHANGELOG_ENTRY_MAX}`);
  }
}

if (problems.length === 0) {
  console.log(`OK: 文档规则检查通过（${currentDocs.length} 份现行文档）`);
} else {
  for (const p of problems) console.log(`${STRICT ? 'ERROR' : 'WARN'}: ${p}`);
  console.log(`共 ${problems.length} 项${STRICT ? '' : '（告警模式，不阻断；--strict 时失败）'}`);
  if (STRICT) process.exit(1);
}
