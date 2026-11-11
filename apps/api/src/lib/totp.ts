/**
 * TOTP（RFC 6238）：HMAC-SHA1 + base32 secret，30s 步长，6 位数字，±1 步容差。
 * 仅使用 Web Crypto 与运行时内置能力，无第三方依赖。
 * 密钥/验证码永不进入日志、审计或错误响应（唯一合法下发是 /auth/totp/setup 成功响应）。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** 允许前后各 1 个时间步（30s），容忍客户端/服务端时钟轻微偏差 */
export const TOTP_WINDOW = 1;

/** base32 编码（RFC 4648，大写、无 padding） */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
    // 只保留尚未消费的低 bits 位，避免 buffer 累积到 32 位溢出
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/** base32 解码；含非法字符时返回空数组（调用方据此拒绝） */
export function base32Decode(input: string): Uint8Array {
  const clean = input.trim().toUpperCase().replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return new Uint8Array(0);
    buffer = (buffer << 5) | idx;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

/** 生成随机 base32 secret（默认 20 字节 = 160 bit，与 Google Authenticator 兼容） */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function counterAt(timeSec: number): number {
  return Math.floor(timeSec / TOTP_PERIOD);
}

/** counter 编码为 64-bit 大端字节（counter 为负时调用方已跳过） */
function counterBytes(counter: number): Uint8Array {
  const msg = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    msg[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return msg;
}

async function hmacSha1(key: Uint8Array, counter: number): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes(counter));
  return new Uint8Array(signature);
}

/** RFC 4226 动态截断 → N 位十进制字符串（左侧补零） */
function truncate(hmac: Uint8Array, digits: number): string {
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String((binary >>> 0) % 10 ** digits).padStart(digits, '0');
}

/** 计算指定 Unix 秒所在时间步的 6 位验证码（可用于验证 / 测试向量） */
export async function totpAt(secret: string, timeSec: number): Promise<string> {
  const key = base32Decode(secret);
  if (key.length === 0) return '';
  const hmac = await hmacSha1(key, counterAt(timeSec));
  return truncate(hmac, TOTP_DIGITS);
}

/** 恒定时间比较两个等长字符串（不因前缀命中提前返回） */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 校验 6 位验证码；按 current、current-1、current+1 三个时间步比对，
 * 每个候选都用恒定时间比较。任何非法输入一律 false（不抛异常、不回显）。
 */
export async function verifyTotp(
  secret: string,
  code: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  window: number = TOTP_WINDOW,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  if (key.length === 0) return false;
  const counter = counterAt(nowSec);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = counter + delta;
    if (candidate < 0) continue;
    const hmac = await hmacSha1(key, candidate);
    if (constantTimeEqual(truncate(hmac, TOTP_DIGITS), code)) return true;
  }
  return false;
}

/** 生成 otpauth:// URI（供 Authenticator App 扫码） */
export function buildOtpauthUri(
  secret: string,
  issuer = 'khc-server',
  account = 'admin',
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
