/**
 * 应用清单（apps/manifests/<id>/）一致性校验。
 *
 * 背景：应用脚本是**资产**，由面板存进 D1 后随安装请求下发到节点以应用用户身份执行。
 * 仓库里 review 过的是 install.sh / uninstall.sh（以及可选的 upgrade.sh），但真正下发的是
 * manifest.json 里的 scripts 内联正文。两者一旦漂移，线上跑的就可能不是 review 过的代码；
 * sha256 又是节点侧校验的唯一依据。所以三者必须逐字节相等。
 *
 * 本脚本只管「文件与脚本」，不管清单 schema：schema 校验只有一个来源（packages/contracts），
 * 由 scripts/test/app-manifests.test.ts 用 appManifestAnyDefinitionSchema 逐个解析。
 *
 * 检查项（每个 apps/manifests/<id>/）：
 *   1. 文件齐全：manifest.json / install.sh / uninstall.sh（upgrade.sh 可选）
 *   2. manifest.json 是 {id, manifest} 对象，id 与目录名一致
 *   3. scripts.<action> 与磁盘脚本逐字节相等；磁盘有 upgrade.sh 才允许声明 scripts.upgrade，反之亦然
 *   4. sha256.<action> 与脚本内容相等
 *   5. 每个脚本 bash -n 语法通过
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

const ID_RE = /^[a-z][a-z0-9-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACTIONS = ['install', 'uninstall', 'upgrade'];

function checkManifestShape(dir, id, root) {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    bad(dir, 'manifest.json 顶层必须是对象');
    return null;
  }
  if (root.id !== id) bad(dir, `id=${JSON.stringify(root.id)} 与目录名不一致`);
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 48) {
    bad(dir, `目录名不是合法应用 id（小写字母开头 slug，≤48）：${id}`);
  }
  const m = root.manifest;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    bad(dir, 'manifest 必须是对象');
    return null;
  }
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

  // 磁盘上有哪些脚本：install / uninstall 必有，upgrade 可选
  const disk = {};
  for (const name of ACTIONS) {
    const file = `${name}.sh`;
    const p = path.join(abs, file);
    if (!fs.existsSync(p)) continue;
    disk[name] = fs.readFileSync(p, 'utf8');
    checkSyntax(dir, file, p);
  }

  if (SYNC) {
    const scripts = { ...(m.scripts || {}) };
    const shas = { ...(m.sha256 || {}) };
    let changed = false;
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
    // 磁盘上没有的脚本不回填，也不留旧值（例如删掉 upgrade.sh 后同步移除）
    for (const name of ACTIONS) {
      if (!(name in disk) && (name in scripts || name in shas)) {
        delete scripts[name];
        delete shas[name];
        changed = true;
      }
    }
    if (changed) {
      const ordered = (obj) => Object.fromEntries(ACTIONS.filter((n) => n in obj).map((n) => [n, obj[n]]));
      m.scripts = ordered(scripts);
      m.sha256 = ordered(shas);
      fs.writeFileSync(manifestPath, `${JSON.stringify(root, null, 2)}\n`);
      console.log(`SYNC: ${dir}/manifest.json 已按磁盘脚本回填 scripts + sha256`);
      return;
    }
    console.log(`OK(no change): ${dir}`);
    return;
  }

  if (!m.scripts || typeof m.scripts !== 'object' || Array.isArray(m.scripts)) {
    bad(dir, 'manifest.scripts 必须是对象');
    return;
  }
  for (const name of ACTIONS) {
    const file = `${name}.sh`;
    const declared = name in m.scripts;
    if (name in disk) {
      checkScriptPair(dir, m, name, file, disk[name]);
    } else if (declared) {
      bad(dir, `manifest.scripts.${name} 已声明但磁盘缺少 ${file}`);
    }
  }
  for (const key of Object.keys(m.scripts)) {
    if (!ACTIONS.includes(key)) bad(dir, `manifest.scripts 含未知脚本 ${key}`);
  }
  if (m.sha256 && typeof m.sha256 === 'object') {
    for (const key of Object.keys(m.sha256)) {
      if (!(key in m.scripts)) bad(dir, `manifest.sha256.${key} 没有对应的 scripts.${key}`);
    }
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
