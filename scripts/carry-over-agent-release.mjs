#!/usr/bin/env node
/**
 * 发版前把「线上当前版本（N-1）」取回来，和本次新包一起打进 assets（ADR-0019）。
 *
 * 为什么需要：公开仓库不入库发布产物，CI/本机每次只构建当前版本；不发这一步，
 * 每次部署后线上就只剩最新一版包，面板无法回滚到上一版。
 *
 * 安全边界（这是本脚本的核心，不是附带说明）：
 *   1. 取回的字节**只信签名**——先用内置公钥验证线上清单的 Ed25519 签名，
 *      签名不过就当整次 carry-over 失败；
 *   2. sha256 只在验签之后做**二次一致性校验**（防传输损坏），不作为信任来源；
 *   3. 不做任何"从 HTTPS 下载所以可信"的假设。
 *
 * 失败策略：fail-open。拿不到清单 / 验签失败 / 404 / sha 不符一律返回
 * `{ok:false}` 并 exit 0——部署继续，但调用方必须把 WARN 打到日志与 job summary，
 * 明确写出「本次发版不含 N-1，面板回滚将不可用」。可用性优先，但不能静默。
 *
 * 用法：
 *   node scripts/carry-over-agent-release.mjs \
 *     --origin https://panel.example.com \
 *     --dest apps/web/public/agent \
 *     --new-version 0.1.41 \
 *     [--summary "$GITHUB_STEP_SUMMARY"]
 *
 * stdout：一行 JSON（供 shell 解析）：{"ok":true,"previous":{version,url,sha256}}
 *         或 {"ok":false,"previous":null,"reason":"..."}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  selectPreviousRelease,
  sha256,
  verifyManifestSignature,
} from './lib/agent-manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 内置发布公钥（与 Agent、Worker 同值）；直接读文件，避免 import CLI 脚本的副作用。 */
export function readBuiltinPubkey() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'agent/khc/release_verify.py'), 'utf8');
  const match = /RELEASE_PUBKEY_B64\s*=\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error('无法从 agent/khc/release_verify.py 读出 RELEASE_PUBKEY_B64');
  return match[1];
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function warn(message) {
  console.error(`WARN: ${message}`);
}

/** job summary（CI 有 GITHUB_STEP_SUMMARY 时才写；本地传空则跳过） */
function appendSummary(summaryPath, lines) {
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
  } catch {
    // summary 写失败不影响发版
  }
}

function degradedMessage(reason) {
  return `本次发版不含 N-1（${reason}），面板回滚将不可用`;
}

/**
 * 取回上一版；任何失败都返回 ok:false，不抛出（fail-open）。
 * `fetchImpl` 可注入，便于单测模拟 404 / 验签失败 / sha 不符。
 */
export async function carryOverPrevious({
  origin,
  destDir,
  newVersion,
  pubkeyB64,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const base = String(origin ?? '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, previous: null, reason: '未提供发布源 origin' };
  if (!newVersion) return { ok: false, previous: null, reason: '未提供本次构建版本' };

  const manifestUrl = `${base}/agent/release-manifest.json`;
  let response;
  try {
    response = await fetchImpl(manifestUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    return { ok: false, previous: null, reason: `读取线上清单失败：${error.message}` };
  }
  if (!response || !response.ok) {
    return { ok: false, previous: null, reason: `读取线上清单返回 HTTP ${response?.status ?? '?'}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(await response.text());
  } catch (error) {
    return { ok: false, previous: null, reason: `线上清单不是合法 JSON：${error.message}` };
  }
  // 信任边界：先验签，再谈其它。
  if (!verifyManifestSignature(manifest, pubkeyB64)) {
    return { ok: false, previous: null, reason: '线上清单验签失败（公钥或签名不匹配）' };
  }
  const previous = selectPreviousRelease(manifest.payload, newVersion);
  if (!previous) {
    return { ok: true, previous: null, reason: `线上已是 ${newVersion}，无需取回 N-1` };
  }

  let archive;
  try {
    const download = await fetchImpl(previous.url);
    if (!download || !download.ok) {
      return { ok: false, previous: null, reason: `下载上一版包返回 HTTP ${download?.status ?? '?'}` };
    }
    archive = Buffer.from(await download.arrayBuffer());
  } catch (error) {
    return { ok: false, previous: null, reason: `下载上一版包失败：${error.message}` };
  }
  const actual = sha256(archive);
  if (actual !== previous.sha256) {
    return {
      ok: false,
      previous: null,
      reason: `上一版包 sha256 与签名清单不一致（清单 ${previous.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
    };
  }

  fs.mkdirSync(destDir, { recursive: true });
  const baseName = `khc-agent-${previous.version}.tar.gz`;
  fs.writeFileSync(path.join(destDir, baseName), archive);
  fs.writeFileSync(path.join(destDir, `${baseName}.sha256`), `${actual}  ${baseName}\n`, {
    encoding: 'utf8',
  });
  return { ok: true, previous, reason: `已取回 ${previous.version}（${baseName}，sha 已核对）`, now: now() };
}

async function main() {
  const origin = arg('origin', process.env.CARRY_OVER_FROM ?? '');
  const destDir = path.resolve(arg('dest', path.join(REPO_ROOT, 'apps/web/public/agent')));
  const newVersion = arg('new-version', '');
  const summaryPath = arg('summary', '');

  if (!origin || !newVersion) {
    console.error('用法: --origin <https://面板入口> --dest <目录> --new-version <x.y.z> [--summary <path>]');
    process.exit(2);
  }

  let pubkeyB64;
  try {
    pubkeyB64 = readBuiltinPubkey();
  } catch (error) {
    const reason = `无法读取内置发布公钥：${error.message}`;
    warn(degradedMessage(reason));
    appendSummary(summaryPath, [`### ⚠️ Agent N-1 未随本次发版提供`, '', degradedMessage(reason), '']);
    console.log(JSON.stringify({ ok: false, previous: null, reason }));
    return 0;
  }

  const result = await carryOverPrevious({ origin, destDir, newVersion, pubkeyB64 });
  if (result.ok && result.previous) {
    // 进度信息走 stderr：stdout 只留一行 JSON 给 shell 解析。
    console.error(`[carry-over] ${result.reason}`);
  } else if (result.ok) {
    console.error(`[carry-over] ${result.reason}（单条清单）`);
  } else {
    warn(degradedMessage(result.reason));
    appendSummary(summaryPath, [
      '### ⚠️ Agent N-1 未随本次发版提供',
      '',
      `- 原因：${result.reason}`,
      `- 影响：${degradedMessage(result.reason)}`,
      '- 处置：查 CI 日志的这一行；修复后重新发版即可恢复回滚能力。',
      '',
    ]);
  }
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
