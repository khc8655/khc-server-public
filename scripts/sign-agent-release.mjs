#!/usr/bin/env node
/**
 * 签名 Agent 发布清单（Ed25519）。
 *
 * 用法：
 *   node scripts/sign-agent-release.mjs \
 *     --key .khc-release-keys/agent-release-private.pem \
 *     --version 0.1.0 --url https://.../khc-agent-0.1.0.tar.gz \
 *     --sha256 <64hex> --out release-manifest.json
 *
 * 输出 {payload, signature}，签名对象为 payload 的 canonical JSON（key 递归排序）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const keyPath = arg('key');
const version = arg('version');
const url = arg('url');
const sha256 = arg('sha256');
const out = arg('out', 'release-manifest.json');
if (!keyPath || !version || !url || !sha256 || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
  console.error('用法: --key <pem> --version <v> --url <https> --sha256 <64hex> [--out manifest.json]');
  process.exit(2);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const publicKey = crypto.createPublicKey(privateKey);
const spki = publicKey.export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32);
const payload = {
  version: 1,
  generatedAt: Math.floor(Date.now() / 1000),
  releases: [{ version, url, sha256: sha256.toLowerCase() }],
};
const signature = crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64');
fs.writeFileSync(out, JSON.stringify({ payload, signature }, null, 2) + '\n', { mode: 0o644 });
console.log(`manifest: ${out}`);
console.log(`public raw(base64): ${raw.toString('base64')}`);
