import { bytesToB64Url, b64UrlToBytes, stringToBytes } from './encoding';
import { misconfigured } from './errors';

/**
 * 敏感字段加密（节点 token / 可选 secrets）。
 * AES-GCM，密钥 = SHA-256(MASTER_ENC_KEY)，输出 base64url(iv).base64url(ciphertext)。
 *
 * A-11：新密文带 `enc:v2:<keyId>:` 前缀（keyId = MASTER_ENC_KEY_ID，默认 k1），
 * 旧的无前缀行继续兼容。前缀的价值：轮换 MASTER_ENC_KEY 后可以用 SQL
 * `LIKE 'enc:v2:<旧id>:%'` 精确找出还没被重加密的行（见 docs/backup.md §8），
 * 解密时先试当前钥、失败再试 MASTER_ENC_KEY_PREVIOUS（轮换窗口）。
 */

/** 当前密钥 id 的缺省值；轮换时建议显式递增（k1 → k2 …） */
export const DEFAULT_ENC_KEY_ID = 'k1';

/** A-11：v2 密文前缀，`enc:v2:<keyId>:` */
const V2_PREFIX_RE = /^enc:v2:([^:]+):/;

export interface EncKeyOptions {
  /** 写入侧：密钥 id（缺省 k1）；用于 v2 前缀 */
  keyId?: string;
  /** 解密侧：轮换窗口内的旧钥（先试当前钥，失败再试旧钥） */
  previousKey?: string;
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw misconfigured('MASTER_ENC_KEY 未配置（需 ≥16 字符）');
  }
  const digest = await crypto.subtle.digest('SHA-256', stringToBytes(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(
  secret: string,
  plaintext: string,
  options: EncKeyOptions = {},
): Promise<string> {
  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    stringToBytes(plaintext),
  );
  const body = `${bytesToB64Url(iv)}.${bytesToB64Url(new Uint8Array(cipher))}`;
  const keyId = options.keyId ?? DEFAULT_ENC_KEY_ID;
  return `enc:v2:${keyId}:${body}`;
}

async function decryptWith(
  secret: string,
  body: string,
): Promise<string> {
  const [ivPart, dataPart] = body.split('.');
  if (!ivPart || !dataPart) throw misconfigured('加密字段格式错误');
  const key = await importAesKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64UrlToBytes(ivPart) as unknown as BufferSource },
    key,
    b64UrlToBytes(dataPart) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

export async function decryptSecret(
  secret: string,
  payload: string,
  options: EncKeyOptions = {},
): Promise<string> {
  // v2 前缀剥掉（keyId 已体现在行内，解密按「先当前钥后旧钥」尝试；
  // GCM 认证失败即密钥不符，无假阳性的风险）
  let body = payload;
  const match = V2_PREFIX_RE.exec(payload);
  if (match) body = payload.slice(match[0].length);
  try {
    return await decryptWith(secret, body);
  } catch {
    if (options.previousKey) {
      try {
        return await decryptWith(options.previousKey, body);
      } catch {
        // 落到统一错误
      }
    }
    const keyId = match ? match[1] : '<无前缀（旧格式）>';
    throw misconfigured(
      `加密字段解密失败（keyId=${keyId}）：当前密钥不匹配${
        options.previousKey ? '，旧钥也不匹配' : '，且未配置 MASTER_ENC_KEY_PREVIOUS（若刚轮换过密钥请先配置旧钥）'
      }`,
    );
  }
}

/** 生成节点 token（32 字节随机，base64url） */
export function newNodeToken(): string {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 生成一次性幂等键 */
export function newIdempotencyKey(): string {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(12)));
}
