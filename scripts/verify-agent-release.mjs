#!/usr/bin/env node
/**
 * Agent 发布一致性校验（批次 G，走查卡点 1 的防回归）。
 *
 * 背景：线上下发的 Agent 包托管在 apps/web/public/agent/（随 Worker assets 部署），
 * 发布清单（AGENT_RELEASE_MANIFEST，Ed25519 签名）指向其中的 url+sha256。
 * 曾经的漂移：agent 源码修复后 VERSION 未 bump、包未重打 → 线上一直发旧包。
 *
 * 三种模式（可组合）：
 *   node scripts/verify-agent-release.mjs --repo
 *       仓库核对：agent/khc 的 VERSION 与 public/agent 内对应包一致
 *       （包 sha256 与伴生 .sha256 一致、包内 khc/util.py 版本 == 文件名 == 仓库 VERSION）。
 *   node scripts/verify-agent-release.mjs --diff <base-ref>
 *       变更规则（CI 用）：
 *       规则 1：agent 运行代码（khc/ adapters/ 入口脚本）变更 ⇒ VERSION 必须同时变更；
 *       规则 2：VERSION 变更 ⇒ apps/web/public/agent/khc-agent-<新版本>.tar.gz 必须已出包入库
 *       （公开版仓库无发布产物时跳过：产物被 .gitignore 排除，由私有发版流程注入）。
 *   node scripts/verify-agent-release.mjs --archive <tar.gz> [--manifest <json> --pubkey <base64>]
 *       单包校验：哈希/版本/（可选）签名清单匹配。
 *
 * 签名清单随部署发布（ADR-0011）：`apps/web/public/agent/release-manifest.json`
 * 入库并随 assets 上线；`--repo` 会用 Agent 包内置公钥验签并核对当前包 sha256，
 * 线上最终一致性再由部署后的 GET /api/v1/agent/releases 核对，
 * 见 docs/engineering/release.md §7。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AGENT_DIR = path.join(REPO_ROOT, 'agent');
const PKG_DIR = path.join(REPO_ROOT, 'apps/web/public/agent');
const MANIFEST_FILE = path.join(PKG_DIR, 'release-manifest.json');

export const VERSION_RE = /^[ \t]*VERSION[ \t]*=[ \t]*["']([^"']+)["']/m;
/** 视为"运行代码变更、必须 bump 版本"的 agent 路径（tests 与纯文档不算） */
export const RUNTIME_CODE_RE =
  /^(agent\/khc\/|agent\/adapters\/|agent\/khc_agent\.py$|agent\/(install|uninstall|package)\.sh$|agent\/khc-agent\.service$)/;

export function readRepoVersion() {
  for (const relative of ['khc/util.py', 'khc/__init__.py']) {
    const text = fs.readFileSync(path.join(AGENT_DIR, relative), 'utf8');
    const match = VERSION_RE.exec(text);
    if (match) return match[1];
  }
  throw new Error('无法从 agent/khc 读出 VERSION');
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 从 tar.gz 读包内声明的 VERSION（兼容 khc/util.py 与 khc/__init__.py 两种布局） */
export function readPackageVersion(archive) {
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error(`无法列出包内容：${list.stderr}`);
  const entry = list.stdout.split('\n').find((line) => /^[\w.-]+\/khc\/(util|__init__)\.py$/.test(line.trim()));
  if (!entry) throw new Error('包内缺少 khc/(util|__init__).py');
  const text = spawnSync('tar', ['-xzOf', archive, entry.trim()], { encoding: 'utf8' });
  if (text.status !== 0) throw new Error(`无法读取包内 ${entry.trim()}：${text.stderr}`);
  const match = VERSION_RE.exec(text.stdout);
  if (!match) throw new Error(`包内 ${entry.trim()} 未声明 VERSION 字面量`);
  return match[1];
}

/** 单包校验；返回问题列表（空 = 通过） */
export function checkArchive(archive) {
  const problems = [];
  const file = path.resolve(archive);
  if (!fs.existsSync(file)) return [`包不存在：${archive}`];
  const name = path.basename(file);
  const nameMatch = /^khc-agent-(.+)\.tar\.gz$/.exec(name);
  if (!nameMatch) return [`包文件名不符合 khc-agent-<version>.tar.gz：${name}`];
  const expectedVersion = nameMatch[1];
  let actualSha;
  try {
    actualSha = sha256File(file);
  } catch (error) {
    return [`读取包失败：${error.message}`];
  }
  const sidecar = `${file}.sha256`;
  if (fs.existsSync(sidecar)) {
    const declared = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (declared && declared.toLowerCase() !== actualSha) {
      problems.push(`伴生 .sha256 声明 ${declared} 与实际 ${actualSha} 不一致`);
    }
  } else {
    problems.push(`缺少伴生校验文件 ${sidecar}`);
  }
  let packagedVersion;
  try {
    packagedVersion = readPackageVersion(file);
  } catch (error) {
    return [...problems, error.message];
  }
  if (packagedVersion !== expectedVersion) {
    problems.push(
      `包内 VERSION=${packagedVersion} 与文件名版本 ${expectedVersion} 不一致（改名覆盖是发布漂移的典型来源）`,
    );
  }
  return problems;
}

/** 打包清单：与 agent/package.sh 的 cp -R 列表保持一致 */
const PACKAGED_ITEMS = [
  'khc',
  'adapters',
  'recipes',
  'khc_agent.py',
  'install.sh',
  'uninstall.sh',
  'khc-agent.service',
  'README.md',
];
const SOURCE_FILE_RE = /\.(py|sh|json|md|service)$/;

/** 递归列出仓库 agent/ 下随包发布的源码文件（相对 agent/ 的路径 → 内容） */
function repoSources() {
  const files = new Map();
  const walk = (relative) => {
    const full = path.join(AGENT_DIR, relative);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) {
        if (name === '__pycache__' || name.startsWith('._')) continue;
        walk(`${relative}/${name}`);
      }
      return;
    }
    if (!SOURCE_FILE_RE.test(relative)) return;
    files.set(relative, fs.readFileSync(full, 'utf8'));
  };
  for (const item of PACKAGED_ITEMS) {
    if (fs.existsSync(path.join(AGENT_DIR, item))) walk(item);
  }
  return files;
}

/**
 * 包内源码 vs 仓库源码：--repo 之前只核对 VERSION 与 sha256，改了 agent/khc/*.py
 * 却没重打包时旧包仍自洽全绿；这里逐文件比对，杜绝"代码修了线上跑旧包"。
 * 返回问题列表（空 = 通过）。
 */
export function checkPackagedSources(archive) {
  const problems = [];
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  if (list.status !== 0) return [`无法列出包内容：${list.stderr}`];

  const packaged = new Map();
  for (const raw of list.stdout.split('\n')) {
    const entry = raw.trim();
    if (!entry || entry.endsWith('/')) continue;
    const parts = entry.split('/');
    if (parts.length < 2) continue;
    const relative = parts.slice(1).join('/');
    if (
      !SOURCE_FILE_RE.test(relative) ||
      relative.includes('__pycache__') ||
      path.basename(relative).startsWith('._')
    ) {
      continue;
    }
    const content = spawnSync('tar', ['-xzOf', archive, entry], { encoding: 'utf8' });
    if (content.status !== 0) {
      problems.push(`无法读取包内 ${entry}：${content.stderr}`);
      continue;
    }
    packaged.set(relative, content.stdout);
  }
  if (packaged.size === 0) return ['包内未发现任何 Agent 源码文件'];

  const sources = repoSources();
  const drifted = [];
  for (const [relative, content] of packaged) {
    if (!sources.has(relative)) {
      drifted.push(`包内 ${relative} 在仓库 agent/ 中不存在（残留文件？）`);
    } else if (sources.get(relative) !== content) {
      drifted.push(`agent/${relative} 与包内内容不一致（源码改了但包没重打）`);
    }
  }
  for (const relative of sources.keys()) {
    if (!packaged.has(relative)) drifted.push(`仓库 agent/${relative} 未打进包`);
  }
  if (drifted.length > 0) {
    problems.push(...drifted.slice(0, 10));
    if (drifted.length > 10) problems.push(`…另有 ${drifted.length - 10} 个文件不一致`);
  }
  return problems;
}

/** 清单校验：签名 + 清单条目与实际包一致；返回问题列表 */
export function checkManifest(manifestFile, pubkeyB64, archive) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return [`清单不是合法 JSON：${error.message}`];
  }
  if (!manifest?.payload?.releases || typeof manifest.signature !== 'string') {
    return ['清单缺少 payload.releases / signature'];
  }
  const canonical = (value) =>
    value === null || typeof value !== 'object'
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  const signature = Buffer.from(manifest.signature, 'base64');
  const verified = (() => {
    try {
      // pubkey 是 raw 32 字节（base64），拼 Ed25519 SPKI 头后构造公钥
      const raw = Buffer.from(pubkeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
      return crypto.verify(
        null,
        Buffer.from(canonical(manifest.payload)),
        crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }),
        signature,
      );
    } catch {
      return false;
    }
  })();
  if (!verified) return ['清单签名校验失败（公钥或签名不匹配）'];
  const actualSha = sha256File(path.resolve(archive));
  const matched = manifest.payload.releases.some(
    (release) => release.sha256?.toLowerCase() === actualSha,
  );
  if (!matched) {
    problems.push(
      `包 sha256 ${actualSha} 不在签名清单内（清单条目：${manifest.payload.releases
        .map((r) => `${r.version}:${(r.sha256 ?? '').slice(0, 12)}…`)
        .join(', ')}）`,
    );
  }
  return problems;
}

/** 从 Agent 包内置公钥读取发布公钥（与 Worker `AGENT_RELEASE_PUBKEY` 同值）。 */
export function readBuiltinPubkey() {
  const text = fs.readFileSync(path.join(AGENT_DIR, 'khc/release_verify.py'), 'utf8');
  const match = /RELEASE_PUBKEY_B64\s*=\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error('无法从 agent/khc/release_verify.py 读出 RELEASE_PUBKEY_B64');
  return match[1];
}

/** 校验随部署发布的签名清单：必须存在、验签通过且包含当前包 sha256；返回问题列表 */
export function checkCommittedManifest(manifestFile, pubkeyB64, archive) {
  if (!fs.existsSync(manifestFile)) {
    return [
      '缺少随部署发布的签名清单 apps/web/public/agent/release-manifest.json',
      '（发版后需用 scripts/sign-agent-release.mjs 重新签名并入库，否则线上清单会漂移）',
    ];
  }
  return checkManifest(manifestFile, pubkeyB64, archive);
}

/**
 * 变更规则评估（纯函数，便于测试）；返回问题列表。
 *
 * `releaseArtifactsPresent`：仓库是否承载发布产物（签名清单或当前版本包）。
 * 公开版仓库把 tar.gz/清单排除在版本控制之外，由私有发版流程注入；此时
 * 只能校验「运行代码变更必须 bump VERSION」，不能要求公开库提交二进制产物。
 */
export function evaluateDiff(
  changedFiles,
  versionLineChanges,
  repoVersion,
  packageExists,
  releaseArtifactsPresent = true,
) {
  const runtimeChanged = changedFiles.filter((file) => RUNTIME_CODE_RE.test(file));
  const versionChanged = versionLineChanges.some((line) => /^[+-][ \t]*VERSION[ \t]*=/.test(line));
  if (runtimeChanged.length > 0 && !versionChanged) {
    return [
      'Agent 运行代码有变更但 VERSION 未 bump：',
      ...runtimeChanged.map((file) => `  - ${file}`),
      '修复不会随包发布（线上会继续跑旧包）。请在 agent/khc/util.py bump VERSION，并用 scripts/build-agent-release.sh 重新出包。',
    ];
  }
  if (versionChanged && releaseArtifactsPresent && !packageExists) {
    return [
      `VERSION 已更新为 ${repoVersion}，但 apps/web/public/agent/khc-agent-${repoVersion}.tar.gz 不存在：`,
      '请运行 scripts/build-agent-release.sh 出包（产物入库后随 Worker assets 部署）。',
    ];
  }
  return [];
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(problems) {
  for (const line of problems) console.error(`ERROR: ${line}`);
  process.exit(1);
}

/** main-guard：被 vitest 导入时只暴露函数，不执行 CLI */
function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
}

const problems = [];

if (isMain() && arg('archive')) {
  problems.push(...checkArchive(arg('archive')));
  if (arg('manifest')) {
    if (!arg('pubkey')) fail(['--manifest 需要 --pubkey <base64 Ed25519 公钥>']);
    problems.push(...checkManifest(arg('manifest'), arg('pubkey'), arg('archive')));
  }
}

if (isMain() && arg('diff')) {
  const base = arg('diff');
  // push 事件的 github.event.before 可能是全零 SHA（首次推送/强制覆盖），
  // workflow_dispatch 传 HEAD~1；这些情况下先确认 commit 存在，再取 merge-base。
  let diffBase = base;
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
  } catch {
    diffBase = 'HEAD~1';
  }
  let mergeBase = null;
  try {
    mergeBase = git(['merge-base', 'HEAD', diffBase]).trim();
  } catch {
    // 公开库首次提交没有 HEAD~1 可比较：明确跳过，而不是伪造通过。
    console.log(`SKIP: 首个提交没有可比基线（${diffBase}），跳过 Agent 运行代码变更规则`);
  }
  if (mergeBase) {
    const files = git(['diff', '--name-only', mergeBase, 'HEAD'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const versionLineChanges = files
      .filter((file) => file === 'agent/khc/util.py' || file === 'agent/khc/__init__.py')
      .flatMap((file) =>
        git(['diff', mergeBase, 'HEAD', '--', file])
          .split('\n')
          .filter((line) => /^[+-]/.test(line)),
      );
    const repoVersion = readRepoVersion();
    const packageExists = fs.existsSync(path.join(PKG_DIR, `khc-agent-${repoVersion}.tar.gz`));
    // 公开版仓库没有签名清单/发布包：只校验 VERSION bump，不要求提交被 .gitignore 排除的产物。
    const releaseArtifactsPresent = packageExists || fs.existsSync(MANIFEST_FILE);
    problems.push(
      ...evaluateDiff(files, versionLineChanges, repoVersion, packageExists, releaseArtifactsPresent),
    );
  }
}

if (isMain() && (hasFlag('repo') || process.argv.length <= 2)) {
  const repoVersion = readRepoVersion();
  const archive = path.join(PKG_DIR, `khc-agent-${repoVersion}.tar.gz`);
  // 公开版仓库不提交发布产物（tar.gz / 签名清单）：二者由私有发版流程生成并注入。
  // 这里必须显式跳过并打印原因，不能伪造验签通过。
  if (!fs.existsSync(archive) && !fs.existsSync(MANIFEST_FILE)) {
    console.log(
      'SKIP: apps/web/public/agent/ 无发布产物（公开版），跳过 Agent 包/签名清单校验；' +
        '发版时由私有流程用发布私钥生成并注入。',
    );
  } else {
    const repoProblems = fs.existsSync(archive)
      ? checkArchive(archive)
      : [`仓库 agent VERSION=${repoVersion}，但 public/agent 缺少对应包：请出包`];
    if (repoProblems.length > 0) {
      problems.push(`仓库内 Agent 包与 VERSION 漂移：`, ...repoProblems);
    } else {
      console.log(`OK: khc-agent-${repoVersion}.tar.gz 与仓库 VERSION 一致 (sha256 ${sha256File(archive).slice(0, 12)}…)`);
      const manifestProblems = checkCommittedManifest(MANIFEST_FILE, readBuiltinPubkey(), archive);
      if (manifestProblems.length > 0) {
        problems.push(`随部署发布的签名清单无效/与当前包不一致：`, ...manifestProblems);
      } else {
        console.log(`OK: release-manifest.json 签名有效且包含当前包 sha256`);
      }
      const sourceProblems = checkPackagedSources(archive);
      if (sourceProblems.length > 0) {
        problems.push(`包内 Agent 源码与仓库 agent/ 漂移：`, ...sourceProblems);
      } else {
        console.log(`OK: 包内 Agent 源码与仓库 agent/ 一致`);
      }
    }
  }
}

if (isMain()) {
  if (problems.length > 0) fail(problems);
  process.exit(0);
}
