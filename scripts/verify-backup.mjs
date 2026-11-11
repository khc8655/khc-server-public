#!/usr/bin/env node
/**
 * 灾备回放前的备份自检（R7 / G-02）。
 *
 * 用法：
 *   node scripts/verify-backup.mjs <db-dump.sql|export.json> [--key-id k1] [--sample 5]
 *
 * 环境变量（可选，提供后做真实解密抽样）：
 *   MASTER_ENC_KEY           当前主密钥（≥16 字符）
 *   MASTER_ENC_KEY_PREVIOUS  轮换窗口内的旧钥
 *
 * 做的事：
 *   1. 扫描 dump 里的 `enc:v2:<keyId>:` 密文，按 keyId 计数；
 *   2. 与期望 keyId（--key-id / MASTER_ENC_KEY_ID / k1）比对，不一致直接失败；
 *   3. 提供密钥时抽样解密，验证「密钥 == keyId」确实能解开（不会输出明文）。
 *
 * 退出码：0 通过；1 校验失败；2 用法/读取错误。
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const V2_RE = /enc:v2:([A-Za-z0-9._-]+):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;

function usage(message) {
  if (message) console.error(`错误：${message}`);
  console.error(
    '用法：node scripts/verify-backup.mjs <db-dump.sql|export.json> [--key-id k1] [--sample 5]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { file: '', keyId: process.env.MASTER_ENC_KEY_ID || 'k1', sample: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--key-id') {
      args.keyId = argv[++index] ?? usage('--key-id 缺少值');
    } else if (item === '--sample') {
      const raw = argv[++index];
      const value = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(value) || value < 0) usage('--sample 需要非负整数');
      args.sample = value;
    } else if (item.startsWith('-')) {
      usage(`未知参数 ${item}`);
    } else if (!args.file) {
      args.file = item;
    } else {
      usage(`多余参数 ${item}`);
    }
  }
  if (!args.file) usage('缺少备份文件路径');
  return args;
}

function aesKey(secret) {
  if (!secret || secret.length < 16) usage('MASTER_ENC_KEY 需 ≥16 字符');
  return createHash('sha256').update(secret, 'utf8').digest();
}

function decrypt(payload, secret) {
  const key = aesKey(secret);
  const iv = Buffer.from(payload.iv, 'base64url');
  const cipher = Buffer.from(payload.body, 'base64url');
  if (iv.length !== 12 || cipher.length < 16) throw new Error('密文格式错误');
  const tag = cipher.subarray(cipher.length - 16);
  const data = cipher.subarray(0, cipher.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let text;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (error) {
    usage(`读取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const payloads = [];
  const byKeyId = new Map();
  for (const match of text.matchAll(V2_RE)) {
    const [, keyId, iv, body] = match;
    payloads.push({ keyId, iv, body });
    byKeyId.set(keyId, (byKeyId.get(keyId) ?? 0) + 1);
  }

  console.log(`文件：${args.file}`);
  console.log(`期望 keyId：${args.keyId}`);
  if (payloads.length === 0) {
    console.log('结果：未发现 enc:v2 密文（应用级导出不含加密字段，属正常）');
    return;
  }
  console.log(`密文字段：${payloads.length} 条`);
  for (const [keyId, count] of [...byKeyId.entries()].sort()) {
    console.log(`  - keyId=${keyId}：${count} 条`);
  }

  const unexpected = [...byKeyId.keys()].filter((keyId) => keyId !== args.keyId);
  if (unexpected.length > 0) {
    console.error(
      `结果：失败，dump 含非当前 keyId（${unexpected.join('、')}）。请先确认 MASTER_ENC_KEY_ID/PREVIOUS 或重加密。`,
    );
    process.exit(1);
  }

  const secret = process.env.MASTER_ENC_KEY;
  if (!secret) {
    console.log('结果：通过（未提供 MASTER_ENC_KEY，跳过解密抽样）');
    return;
  }
  const previous = process.env.MASTER_ENC_KEY_PREVIOUS;
  for (const payload of payloads.slice(0, args.sample)) {
    try {
      decrypt(payload, secret);
    } catch {
      if (previous) {
        try {
          decrypt(payload, previous);
          console.log(`抽样：keyId=${payload.keyId} 需用 MASTER_ENC_KEY_PREVIOUS 解开（轮换窗口内）`);
          continue;
        } catch {
          // 落到失败
        }
      }
      console.error(
        `结果：失败，抽样密文无法用当前密钥解开（keyId=${payload.keyId}）。恢复前先修复密钥托管。`,
      );
      process.exit(1);
    }
  }
  console.log(`结果：通过（抽样 ${Math.min(args.sample, payloads.length)} 条解密成功）`);
}

main();
