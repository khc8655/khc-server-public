import { b64UrlToBytes, bytesToB64Url, stringToBytes } from './encoding';

const DEFAULT_ITERATIONS = 100_000;
const KEY_BITS = 256;

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    stringToBytes(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** 生成 `pbkdf2$<iters>$<salt>$<hash>` 格式口令哈希 */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${bytesToB64Url(salt)}$${bytesToB64Url(hash)}`;
}

/** 恒定时间比较两个字节数组 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** 恒定时间比较两个字符串 */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(stringToBytes(a), stringToBytes(b));
}

/** 校验口令；格式非法或哈希不匹配均返回 false */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64UrlToBytes(parts[2] ?? '');
    expected = b64UrlToBytes(parts[3] ?? '');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length !== 32) return false;
  const actual = await deriveBits(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}
