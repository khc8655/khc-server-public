import { AsyncLocalStorage } from 'node:async_hooks';
import { SESSION_TTL_SEC, parseCookie } from './session';

export const D1_BOOKMARK_COOKIE = 'khc_d1bm';
export const D1_BOOKMARK_MAX_AGE_SEC = SESSION_TTL_SEC;

const D1_BOOKMARK_RE = /^[A-Za-z0-9._~:+/=-]{1,256}$/;

const sessionStorage = new AsyncLocalStorage<D1DatabaseSession>();

/** 在单个请求的异步上下文内绑定 D1 会话，避免污染 isolate 单例。 */
export function runWithD1Session<T>(session: D1DatabaseSession, fn: () => T): T {
  return sessionStorage.run(session, fn);
}

/** 读取当前请求绑定的 D1 会话；无请求上下文时返回 undefined。 */
export function currentD1Session(): D1DatabaseSession | undefined {
  return sessionStorage.getStore();
}

/** 校验 D1 bookmark 令牌格式，拒绝约束关键词、空白与 Cookie 控制字符。 */
export function isValidD1Bookmark(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== 'first-primary' &&
    value !== 'first-unconstrained' &&
    D1_BOOKMARK_RE.test(value)
  );
}

/** 从请求 Cookie 头读取并校验 khc_d1bm；缺失或畸形时返回 null。 */
export function readD1BookmarkCookie(cookieHeader: string | undefined): string | null {
  const raw = parseCookie(cookieHeader, D1_BOOKMARK_COOKIE);
  return isValidD1Bookmark(raw) ? raw : null;
}

/** 构造 khc_d1bm Set-Cookie 头：固定 Path=/api、无 Domain，防干扰静态资源缓存。 */
export function buildD1BookmarkCookie(
  bookmark: string,
  secure: boolean,
  maxAgeSec: number = D1_BOOKMARK_MAX_AGE_SEC,
): string {
  if (!isValidD1Bookmark(bookmark)) {
    throw new Error('invalid d1 bookmark');
  }
  const parts = [
    `${D1_BOOKMARK_COOKIE}=${bookmark}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

interface SessionWithOptionalExec extends D1DatabaseSession {
  exec?(query: string): Promise<D1ExecResult>;
}

/**
 * 包装原生 D1Database：prepare / batch / exec 在请求内自动路由到当前 AsyncLocalStorage
 * 会话；无会话上下文时直走 rawDb。withSession 与其余属性仍直连 rawDb，保证所有仓储无需改动。
 */
export function createSessionAwareD1<T extends D1Database | undefined>(rawDb: T): T {
  if (!rawDb || (typeof rawDb !== 'object' && typeof rawDb !== 'function')) {
    return rawDb;
  }
  return new Proxy(rawDb, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const active = currentD1Session();
          return (active ?? target).prepare(query);
        };
      }
      if (prop === 'batch') {
        return <R = unknown>(statements: D1PreparedStatement[]) => {
          const active = currentD1Session();
          return (active ?? target).batch<R>(statements);
        };
      }
      if (prop === 'exec') {
        return (query: string) => {
          const active = currentD1Session() as SessionWithOptionalExec | undefined;
          if (active && typeof active.exec === 'function') {
            return active.exec(query);
          }
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as T;
}
