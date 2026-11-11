import type { SettingsRepo } from '../domain/repos';
import { b64UrlToBytes, bytesToB64Url, bytesToString, stringToBytes } from './encoding';

export const SESSION_COOKIE = 'khc_sess';
export const SESSION_TTL_SEC = 8 * 60 * 60;

/** settings 表中的键（全部复用现有 settings 加密表，不新增表/迁移） */
export const SESSION_EPOCH_KEY = 'auth.session_epoch';
export const TOTP_SECRET_KEY = 'auth.totp_secret';
export const TOTP_PENDING_KEY = 'auth.totp_pending';

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  /** 会话版本号（= auth.session_epoch）；旧 token 无此字段时按 0 处理 */
  ver?: number;
}

/** 读取当前会话版本号；未配置或值非法一律按 0（部署前旧会话仍可用） */
export async function readSessionEpoch(settings: SettingsRepo): Promise<number> {
  const value = await settings.getValue(SESSION_EPOCH_KEY);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 递增会话版本号（撤销全部既有会话）；返回新版本号 */
export async function bumpSessionEpoch(settings: SettingsRepo): Promise<number> {
  const next = (await readSessionEpoch(settings)) + 1;
  await settings.put(SESSION_EPOCH_KEY, next);
  return next;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    stringToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** 生成 `base64url(payload).base64url(hmac)` 会话 token */
export async function signSession(
  secret: string,
  payload: SessionPayload,
): Promise<string> {
  const body = bytesToB64Url(stringToBytes(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), stringToBytes(body));
  return `${body}.${bytesToB64Url(new Uint8Array(signature))}`;
}

/**
 * 校验签名、过期时间与会话版本；失败返回 null（不抛异常）。
 * currentEpoch 由调用方从 settings 读取后传入；缺省 0 以兼容既有二元调用与旧 token。
 */
export async function verifySession(
  secret: string,
  token: string,
  currentEpoch = 0,
): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64UrlToBytes(signature),
      stringToBytes(body),
    );
    if (!ok) return null;
    const parsed = JSON.parse(bytesToString(b64UrlToBytes(body))) as Partial<SessionPayload>;
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    const ver = typeof parsed.ver === 'number' && Number.isFinite(parsed.ver) ? parsed.ver : 0;
    if (ver !== currentEpoch) return null;
    return { sub: parsed.sub, iat: parsed.iat ?? 0, exp: parsed.exp, ver };
  } catch {
    return null;
  }
}

/** 从 Cookie 请求头中读取指定名称的值 */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function buildSessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie(secure: boolean): string {
  return buildSessionCookie('', 0, secure);
}
