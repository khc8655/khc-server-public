import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../types';
import {
  D1_BOOKMARK_COOKIE,
  buildD1BookmarkCookie,
  isValidD1Bookmark,
  readD1BookmarkCookie,
  runWithD1Session,
} from '../lib/d1-session';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

function hasD1BookmarkSetCookie(res: Response): boolean {
  const prefix = `${D1_BOOKMARK_COOKIE}=`;
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie().some((cookie) => cookie.startsWith(prefix));
  }
  const raw = res.headers.get('set-cookie');
  if (!raw) return false;
  return raw.split(/,\s*(?=[^;]+=)/).some((cookie) => cookie.trimStart().startsWith(prefix));
}

function isSecureRequest(c: Context<AppBindings>): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'https' || c.req.url.startsWith('https://');
}

function appendSetCookie(c: Context<AppBindings>, cookie: string): void {
  const res = c.res;
  if (!res) return;
  try {
    res.headers.append('Set-Cookie', cookie);
  } catch {
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', cookie);
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/**
 * 为每个 /api/* 请求开启独立的 D1 读副本会话并维护 khc_d1bm 读己之写书签：
 * - 带合法 khc_d1bm 时从该 bookmark 起步（保障单浏览器顺序一致）；
 * - 否则 GET/HEAD 走 first-unconstrained（就近副本），写请求走 first-primary（主库）。
 */
export const d1Session = createMiddleware<AppBindings>(async (c, next) => {
  const db = c.env?.DB;
  if (!db || typeof db.withSession !== 'function') {
    return next();
  }

  const bookmark = readD1BookmarkCookie(c.req.header('cookie'));
  const fallbackConstraint: D1SessionConstraint = READ_ONLY_METHODS.has(
    c.req.method.toUpperCase(),
  )
    ? 'first-unconstrained'
    : 'first-primary';

  let session: D1DatabaseSession;
  if (bookmark) {
    try {
      session = db.withSession(bookmark);
    } catch {
      session = db.withSession(fallbackConstraint);
    }
  } else {
    session = db.withSession(fallbackConstraint);
  }

  try {
    await runWithD1Session(session, () => next());
  } finally {
    let nextBookmark: string | null = null;
    try {
      nextBookmark = session.getBookmark();
    } catch {
      nextBookmark = null;
    }
    if (isValidD1Bookmark(nextBookmark) && c.res && !hasD1BookmarkSetCookie(c.res)) {
      appendSetCookie(c, buildD1BookmarkCookie(nextBookmark, isSecureRequest(c)));
    }
  }
});
