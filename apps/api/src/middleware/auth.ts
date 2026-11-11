import { createMiddleware } from 'hono/factory';
import type { AppBindings, Env } from '../types';
import { misconfigured, unauthorized } from '../lib/errors';
import { timingSafeEqualString, verifyPassword } from '../lib/password';
import {
  SESSION_COOKIE,
  parseCookie,
  readSessionEpoch,
  verifySession,
} from '../lib/session';

/** 校验管理员口令：生产用 pbkdf2 哈希；仅 development 允许明文 ADMIN_PASSWORD */
export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  if (env.ADMIN_PW_HASH) return verifyPassword(password, env.ADMIN_PW_HASH);
  if (env.ENVIRONMENT === 'development' && env.ADMIN_PASSWORD) {
    return timingSafeEqualString(password, env.ADMIN_PASSWORD);
  }
  throw misconfigured('ADMIN_PW_HASH 未配置');
}

/** 受保护路由：校验签名 Cookie 会话 + 会话版本（auth.session_epoch） */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const secret = c.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw misconfigured('SESSION_SECRET 未配置（需 ≥32 字节）');
  }
  const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE);
  if (!token) throw unauthorized();
  const settings = c.get('settings');
  const epoch = settings ? await readSessionEpoch(settings) : 0;
  const session = await verifySession(secret, token, epoch);
  if (!session) throw unauthorized('会话已过期，请重新登录');
  c.set('user', { name: session.sub });
  await next();
});
