#!/usr/bin/env node
/**
 * 应用清单（apps/manifests/<id>/）一致性校验。
 *
 * 背景：应用脚本是**资产**，由面板存进 D1 后随安装请求下发到节点以应用用户身份执行。
 * 仓库里 review 过的是 install.sh / uninstall.sh，但真正下发的是 manifest.json 里的
 * scripts 内联正文。两者一旦漂移，线上跑的就可能不是 review 过的代码；sha256 又是
 * 节点侧校验的唯一依据。所以三者必须逐字节相等。
 *
 * 检查项（每个 apps/manifests/<id>/）：
 *   1. 三个文件齐全：manifest.json / install.sh / uninstall.sh
 *   2. manifest.json 结构合法（字段口径与 packages/contracts 的 appManifest 契约一致：
 *      未知字段拒绝，参数 key 小写字母开头，脚本 64KB 上限，runtime.mode 二选一）
 *   3. id 与目录名一致
 *   4. scripts.install / scripts.uninstall 与磁盘脚本逐字节相等
 *   5. sha256 与脚本内容相等
 *   6. 两个脚本 bash -n 语法通过
 *
 * 用法：
 *   node scripts/verify-app-manifests.mjs           # 校验，有问题 exit 1
 *   node scripts/verify-app-manifests.mjs --sync    # 从磁盘脚本回填 scripts + sha256
 *
 * --sync 只改 manifest.json 的 scripts 与 sha256 两个字段，其余内容原样保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'apps/manifests';
const SYNC = process.argv.includes('--sync');
const SCRIPT_LIMIT = 64 * 1024;

const problems = [];
const bad = (dir, msg) => problems.push(`${dir}: ${msg}`);

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 契约里的字面量，改契约时这里要跟着改（口径 drift 由本脚本第 2 项暴露）。 */
const MANIFEST_KEYS = ['name', 'version', 'runtime', 'params', 'scripts', 'sha256', 'writes'];
const RUNTIME_KEYS = ['mode', 'user', 'linger'];
const PARAM_KEYS = ['key', 'type', 'label', 'default', 'min', 'max', 'maxLength', 'pattern', 'secret'];
const PARAM_TYPES = ['string', 'integer', 'boolean'];
const RUNTIME_MODES = ['root', 'create'];

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ID_RE = /^[a-z][a-z0-9-]*$/;
const USER_RE = /^[a-z][a-z0-9_-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

function checkUnknown(dir, obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) bad(dir, `${where} 含未知字段 ${k}（契约 .strict() 会拒绝）`);
  }
}

function checkManifestShape(dir, id, root) {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    bad(dir, 'manifest.json 顶层必须是对象');
    return null;
  }
  checkUnknown(dir, root, ['id', 'manifest', 'enabled'], '顶层');
  if (root.id !== id) bad(dir, `id=${JSON.stringify(root.id)} 与目录名不一致`);
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 48) {
    bad(dir, `目录名不是合法应用 id（小写字母开头 slug，≤48）：${id}`);
  }
  if (typeof root.enabled !== 'boolean') bad(dir, 'enabled 必须是布尔值');

  const m = root.manifest;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    bad(dir, 'manifest 必须是对象');
    return null;
  }
  checkUnknown(dir, m, MANIFEST_KEYS, 'manifest');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 64) {
    bad(dir, 'manifest.name 必填，≤64 字符');
  }
  if (typeof m.version !== 'string' || !m.version.trim() || m.version.length > 32) {
    bad(dir, 'manifest.version 必填，≤32 字符');
  }

  const rt = m.runtime;
  if (typeof rt !== 'object' || rt === null) bad(dir, 'manifest.runtime 必填');
  else {
    checkUnknown(dir, rt, RUNTIME_KEYS, 'manifest.runtime');
    if (!RUNTIME_MODES.includes(rt.mode)) bad(dir, `runtime.mode 必须是 ${RUNTIME_MODES.join('|')}`);
    if (rt.user !== undefined) {
      if (typeof rt.user !== 'string' || !USER_RE.test(rt.user) || rt.user.length > 32) {
        bad(dir, 'runtime.user 必须是合法 POSIX 用户名（≤32，小写字母开头）');
      }
    }
    if (rt.linger !== undefined && typeof rt.linger !== 'boolean') bad(dir, 'runtime.linger 必须是布尔值');
    // create 模式要在节点上建同名系统账号，必须给出确定的用户名
    if (rt.mode === 'create' && !rt.user) bad(dir, 'runtime.mode=create 时必须指定 runtime.user');
  }

  if (!Array.isArray(m.params)) bad(dir, 'manifest.params 必须是数组');
  else {
    if (m.params.length > 32) bad(dir, 'params 最多 32 项');
    const seen = new Set();
    for (const [i, p] of m.params.entries()) {
      const at = `params[${i}]`;
      if (typeof p !== 'object' || p === null) {
        bad(dir, `${at} 必须是对象`);
        continue;
      }
      checkUnknown(dir, p, PARAM_KEYS, at);
      if (typeof p.key !== 'string' || !KEY_RE.test(p.key) || p.key.length > 32) {
        bad(dir, `${at}.key 必须匹配 ${KEY_RE}（≤32）`);
      } else if (seen.has(p.key)) {
        bad(dir, `${at}.key 重复：${p.key}`);
      } else seen.add(p.key);
      if (!PARAM_TYPES.includes(p.type)) bad(dir, `${at}.type 必须是 ${PARAM_TYPES.join('|')}`);
      if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 64)) {
        bad(dir, `${at}.label ≤64 字符`);
      }
      if (p.default !== undefined && !['string', 'number', 'boolean'].includes(typeof p.default)) {
        bad(dir, `${at}.default 只能是 string/number/boolean`);
      }
      for (const k of ['min', 'max']) {
        if (p[k] !== undefined && !Number.isInteger(p[k])) bad(dir, `${at}.${k} 必须是整数`);
      }
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) bad(dir, `${at}.min 不能大于 max`);
      if (p.maxLength !== undefined && !(Number.isInteger(p.maxLength) && p.maxLength > 0)) {
        bad(dir, `${at}.maxLength 必须是正整数`);
      }
      if (p.pattern !== undefined) {
        if (typeof p.pattern !== 'string' || p.pattern.length > 256) bad(dir, `${at}.pattern ≤256 字符`);
        else {
          try {
            new RegExp(p.pattern);
          } catch {
            bad(dir, `${at}.pattern 不是合法正则：${p.pattern}`);
          }
        }
      }
      if (p.secret !== undefined && typeof p.secret !== 'boolean') bad(dir, `${at}.secret 必须是布尔值`);
    }
  }

  if (!Array.isArray(m.writes)) bad(dir, 'manifest.writes 必须是数组');
  else if (m.writes.length > 32) bad(dir, 'writes 最多 32 项');

  return m;
}

function checkScriptPair(dir, m, name, file, diskText) {
  const inline = m.scripts && m.scripts[name];
  if (typeof inline !== 'string' || inline.length === 0) {
    bad(dir, `manifest.scripts.${name} 缺失`);
    return;
  }
  if (inline.length > SCRIPT_LIMIT) {
    bad(dir, `scripts.${name} 超过 64KB 上限（${inline.length} 字节）`);
  }
  if (inline !== diskText) {
    bad(dir, `scripts.${name} 与 ${file} 不一致（下发内容不是磁盘上 review 过的脚本）`);
  }
  const declared = m.sha256 && m.sha256[name];
  if (typeof declared !== 'string' || !HEX64.test(declared)) {
    bad(dir, `manifest.sha256.${name} 必须是 64 位小写 hex`);
  } else if (declared !== sha256(diskText)) {
    bad(dir, `sha256.${name} 与 ${file} 实际哈希不一致（节点侧校验会失败）`);
  }
  if (inline !== diskText && declared !== sha256(diskText)) {
    // 两条都错时给一条可执行的提示，避免只看到两行现象
    bad(dir, `修法：node scripts/verify-app-manifests.mjs --sync 后重新提交`);
  }
}

function checkSyntax(dir, file, abs) {
  const r = spawnSync('bash', ['-n', abs], { encoding: 'utf8' });
  if (r.error) {
    bad(dir, `无法执行 bash -n（${r.error.message}）`);
    return;
  }
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim().split('\n').slice(0, 3).join(' / ');
    bad(dir, `${file} 语法错误：${msg}`);
  }
}

function verifyDir(id) {
  const dir = `${BASE}/${id}`;
  const abs = path.join(ROOT, dir);
  for (const f of ['manifest.json', 'install.sh', 'uninstall.sh']) {
    if (!fs.existsSync(path.join(abs, f))) bad(dir, `缺少 ${f}`);
  }
  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;

  let root;
  try {
    root = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    bad(dir, `manifest.json 不是合法 JSON：${e.message}`);
    return;
  }

  const m = checkManifestShape(dir, id, root);
  if (!m) return;

  const files = { install: 'install.sh', uninstall: 'uninstall.sh' };
  const disk = {};
  for (const [name, file] of Object.entries(files)) {
    const p = path.join(abs, file);
    if (!fs.existsSync(p)) continue;
    disk[name] = fs.readFileSync(p, 'utf8');
    checkSyntax(dir, file, p);
  }

  if (SYNC) {
    let changed = false;
    const scripts = { ...(m.scripts || {}) };
    const shas = { ...(m.sha256 || {}) };
    for (const [name, text] of Object.entries(disk)) {
      if (scripts[name] !== text) {
        scripts[name] = text;
        changed = true;
      }
      const want = sha256(text);
      if (shas[name] !== want) {
        shas[name] = want;
        changed = true;
      }
    }
    if (changed) {
      m.scripts = { install: scripts.install, uninstall: scripts.uninstall };
      m.sha256 = { install: shas.install, uninstall: shas.uninstall };
      fs.writeFileSync(manifestPath, `${JSON.stringify(root, null, 2)}\n`);
      console.log(`SYNC: ${dir}/manifest.json 已按磁盘脚本回填 scripts + sha256`);
      return;
    }
    console.log(`OK(no change): ${dir}`);
    return;
  }

  for (const [name, file] of Object.entries(files)) {
    if (!(name in disk)) continue;
    if (!m.scripts || typeof m.scripts !== 'object') {
      bad(dir, 'manifest.scripts 必须是对象');
      break;
    }
    checkScriptPair(dir, m, name, file, disk[name]);
  }
  if (m.sha256 && typeof m.sha256 === 'object') {
    checkUnknown(dir, m.sha256, ['install', 'uninstall'], 'manifest.sha256');
  }
  if (m.scripts && typeof m.scripts === 'object') {
    checkUnknown(dir, m.scripts, ['install', 'uninstall'], 'manifest.scripts');
  }
}

function main() {
  const baseAbs = path.join(ROOT, BASE);
  if (!fs.existsSync(baseAbs)) {
    console.log(`SKIP: ${BASE}/ 不存在（还没有应用清单）`);
    return;
  }
  const dirs = fs
    .readdirSync(baseAbs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) {
    console.log(`SKIP: ${BASE}/ 下没有应用清单`);
    return;
  }
  for (const id of dirs) verifyDir(id);

  if (problems.length > 0) {
    console.error(`应用清单校验失败（${problems.length} 项）：`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (!SYNC) console.log(`OK: ${dirs.length} 份应用清单一致（${dirs.join(', ')}）`);
}

main();
