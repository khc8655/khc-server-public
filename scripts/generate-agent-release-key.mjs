#!/usr/bin/env node
/** 生成 Agent 发布清单签名密钥（Ed25519）。私钥只写本地，不要提交。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.env.OUT_DIR || '.khc-release-keys';
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const spki = publicKey.export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32);
const privatePath = path.join(outDir, 'agent-release-private.pem');
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
const publicRaw = raw.toString('base64');
fs.writeFileSync(path.join(outDir, 'agent-release-public.b64'), publicRaw + '\n', { mode: 0o644 });
console.log(`private: ${privatePath}`);
console.log(`public raw(base64): ${publicRaw}`);
