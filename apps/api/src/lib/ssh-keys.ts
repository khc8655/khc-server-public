/**
 * SSH 公钥规范化与指纹（P4 全局公钥库）。
 *
 * 只接受 OpenSSH 单行公钥；不解析私钥、不做任何网络/文件操作。
 * 指纹算法与 `ssh-keygen -lf` 一致：`SHA256:` + base64(sha256(blob))（去掉尾部 `=`）。
 */

const KEY_TYPE_PATTERN =
  'ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\\.com';
const PUBLIC_KEY_RE = new RegExp(`^(${KEY_TYPE_PATTERN})\\s+([A-Za-z0-9+/]+={0,2})(?:\\s+(.*))?$`);

export interface NormalizedSshKey {
  publicKey: string;
  fingerprint: string;
  comment: string | null;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobKeyType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const length =
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  if (length === 0 || length > bytes.length - 4 || length > 128) return null;
  let text = '';
  for (let i = 4; i < 4 + length; i += 1) text += String.fromCharCode(bytes[i]!);
  return /^[\x21-\x7e]+$/.test(text) ? text : null;
}

/** 校验并规范化公钥，指纹在 Worker 侧计算（与 Agent 侧同算法）。 */
export async function normalizeSshPublicKey(raw: string): Promise<NormalizedSshKey> {
  const match = PUBLIC_KEY_RE.exec(raw.trim());
  if (!match) throw new Error('公钥格式非法（需要 OpenSSH 单行公钥）');
  const type = match[1]!;
  const blob = match[2]!;
  const comment = match[3]?.trim() ? match[3]!.trim() : null;

  const bytes = base64ToBytes(blob);
  if (blobKeyType(bytes) !== type) throw new Error('公钥类型与内容不一致');

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint =
    'SHA256:' +
    btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/=+$/, '');

  return {
    publicKey: `${type} ${blob}${comment ? ` ${comment}` : ''}`,
    fingerprint,
    comment,
  };
}
