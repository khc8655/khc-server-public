#!/usr/bin/env node
/**
 * 签名 Agent 发布清单（Ed25519）。
 *
 * 用法：
 *   node scripts/sign-agent-release.mjs \
 *     --key .khc-release-keys/agent-release-private.pem \
 *     --version 0.1.41 --url https://.../khc-agent-0.1.41.tar.gz \
 *     --sha256 <64hex> --out release-manifest.json \
 *     [--release '0.1.40|https://.../khc-agent-0.1.40.tar.gz|<64hex>']...
 *
 * `--release` 可重复，用于把「上一版（N-1）」一并写进同一份清单（ADR-0019）：
 * 一条签名同时覆盖新版本与回滚目标，Agent 侧只校验「包在该清单的 releases 里」，
 * 因此回滚不需要任何协议变更，也不会成为绕过签名的缺口。
 *
 * 顺序是硬约束：新版本必须在 releases[0]（面板按数组顺序取最新/上一版），
 * 由 scripts/lib/agent-manifest.mjs 的 buildReleasePayload 断言，写错直接失败。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildReleasePayload, canonical } from './lib/agent-manifest.mjs';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** 所有同名参数值 */
function args(name) {
  const values = [];
  process.argv.forEach((item, index) => {
    if (item === `--${name}` && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  });
  return values;
}

/** `version|url|sha256` → release 对象 */
function parseRelease(raw) {
  const parts = String(raw).split('|');
  if (parts.length !== 3) {
    console.error(`ERROR: --release 格式应为 'version|url|sha256'，实际：${raw}`);
    process.exit(2);
  }
  const [version, url, sha256] = parts;
  return { version: version.trim(), url: url.trim(), sha256: sha256.trim() };
}

const keyPath = arg('key');
const version = arg('version');
const url = arg('url');
const sha256 = arg('sha256');
const out = arg('out', 'release-manifest.json');
if (!keyPath || !version || !url || !sha256 || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
  console.error(
    "用法: --key <pem> --version <v> --url <https> --sha256 <64hex> [--release 'v|url|sha']... [--out manifest.json]",
  );
  process.exit(2);
}

const previous = args('release').map(parseRelease);

let payload;
try {
  // 关键断言：新版本必须落在 releases[0]，且版本不重复。
  payload = buildReleasePayload({ version, url, sha256 }, previous);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(2);
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const publicKey = crypto.createPublicKey(privateKey);
const spki = publicKey.export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32);
const signature = crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64');
fs.writeFileSync(out, JSON.stringify({ payload, signature }, null, 2) + '\n', { mode: 0o644 });
console.log(`manifest: ${out}（${payload.releases.length} 条：${payload.releases.map((r) => r.version).join(' → ')}）`);
console.log(`public raw(base64): ${raw.toString('base64')}`);
