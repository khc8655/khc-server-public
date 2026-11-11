#!/usr/bin/env node
/**
 * 旧 Agent 包退役（ADR-0013「产物留存策略」）。
 *
 * 背景：每改一次 Agent 运行时代码就出一个包，13 天累积到 18 个包 / 3.3MB 全部入库并
 * 随每次部署全量上传 assets。历史包对升级没有价值（升级只往新版本走），但会持续放大仓库
 * 与每次部署的体积，也让"当前该发哪个包"越来越难看。
 *
 * 策略：保留「清单指向的版本 + 当前 VERSION」再加最近 N-1 个，其余删除（含 .sha256）。
 * 清单指向的包永远不会被删 —— 删掉它等于让线上安装/升级失效。
 *
 * 用法：
 *   node scripts/prune-agent-packages.mjs            # 执行删除
 *   node scripts/prune-agent-packages.mjs --check    # 只检查，超限 exit 1（CI/verify.sh 用）
 *   node scripts/prune-agent-packages.mjs --keep 4   # 调整保留数量（默认 3，含当前）
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareSemver } from './lib/release.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG_DIR = path.join(ROOT, 'apps/web/public/agent');
const MANIFEST_FILE = path.join(PKG_DIR, 'release-manifest.json');
const AGENT_UTIL = path.join(ROOT, 'agent/khc/util.py');

function readAgentVersion() {
  const text = fs.readFileSync(AGENT_UTIL, 'utf8');
  const m = /^[ \t]*VERSION[ \t]*=[ \t]*["']([^"']+)["']/m.exec(text);
  if (!m) throw new Error('无法从 agent/khc/util.py 读取 VERSION');
  return m[1];
}

/**
 * 清单里登记的所有版本（结构：{ payload: { releases: [{ version, url, sha256 }] }, signature }）。
 * 这些版本必须保留 —— 删掉清单指向的包等于让线上安装/升级 404。
 */
function readManifestVersions() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const releases = manifest?.payload?.releases;
    if (!Array.isArray(releases)) return [];
    return releases
      .map((r) => r?.version)
      .filter((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/** 扫描目录里已入库的包版本 */
function listPackages() {
  if (!fs.existsSync(PKG_DIR)) return [];
  return fs
    .readdirSync(PKG_DIR)
    .map((name) => /^khc-agent-(.+)\.tar\.gz$/.exec(name))
    .filter(Boolean)
    .map((m) => m[1]);
}

function parseArgs(argv) {
  const keepIndex = argv.indexOf('--keep');
  const keep = keepIndex >= 0 ? Number(argv[keepIndex + 1]) : 3;
  return {
    check: argv.includes('--check'),
    keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 3,
  };
}

function main() {
  const { check, keep } = parseArgs(process.argv.slice(2));
  const all = listPackages();
  const current = readAgentVersion();
  const manifestVersions = readManifestVersions();

  if (all.length === 0) {
    console.log('OK: 没有 Agent 包需要处理');
    return 0;
  }

  // 必留集合：当前版本 + 清单登记的版本
  const pinned = new Set([current, ...manifestVersions].filter(Boolean));

  // 其余按 semver 降序，补足到 keep 个
  const candidates = all.filter((v) => !pinned.has(v)).sort((a, b) => compareSemver(b, a));
  const keepFromCandidates = Math.max(0, keep - pinned.size);
  const keepSet = new Set([...pinned, ...candidates.slice(0, keepFromCandidates)]);
  const removeSet = all.filter((v) => !keepSet.has(v));

  console.log(
    `仓库 VERSION=${current}，清单版本=${manifestVersions.join(',') || '<无>'}，` +
      `现存 ${all.length} 个包，保留 ${keepSet.size} 个，待退役 ${removeSet.length} 个`,
  );

  if (removeSet.length === 0) {
    console.log('OK: Agent 包留存符合策略');
    return 0;
  }

  if (check) {
    console.error(
      `ERROR: Agent 包数量超限（保留上限 ${keep}）。需退役：${removeSet.join(', ')}\n` +
        '  修复：node scripts/prune-agent-packages.mjs',
    );
    return 1;
  }

  // 安全护栏：绝不允许删掉当前版本或清单指向的包
  for (const version of removeSet) {
    if (pinned.has(version)) {
      console.error(`ERROR: 内部错误，拒绝删除受保护版本 ${version}`);
      return 1;
    }
  }

  for (const version of removeSet) {
    for (const suffix of ['.tar.gz', '.tar.gz.sha256']) {
      const file = path.join(PKG_DIR, `khc-agent-${version}${suffix}`);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        console.log(`  已退役 ${path.basename(file)}`);
      }
    }
  }
  console.log(`OK: 已退役 ${removeSet.length} 个历史包，保留 ${keepSet.size} 个`);
  return 0;
}

process.exit(main());
