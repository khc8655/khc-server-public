#!/usr/bin/env node
/**
 * 生成 ADMIN_PW_HASH（与 apps/api/src/lib/password.ts 的 pbkdf2 格式一致）
 *
 * 用法：
 *   node scripts/hash-password.mjs 'your-strong-password'
 *   # 或交互输入（不回显）
 *   node scripts/hash-password.mjs
 *
 * 输出形如：pbkdf2$100000$<salt>$<hash>
 * 把该值配置为 Cloudflare Worker 的 Secret `ADMIN_PW_HASH`。
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ITERATIONS = 100_000;

function toB64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${ITERATIONS}$${toB64Url(salt)}$${toB64Url(new Uint8Array(bits))}`;
}

async function readPassword() {
  const cliPassword = process.argv[2];
  if (cliPassword) return cliPassword;
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question('输入管理员口令（将生成哈希）：');
    return value;
  } finally {
    rl.close();
  }
}

const password = await readPassword();
if (!password || password.trim().length < 8) {
  console.error('口令不能为空，且建议至少 8 位。');
  process.exit(1);
}
console.log(await hashPassword(password));
