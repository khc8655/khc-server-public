import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  okResponseSchema,
} from '@khc/contracts';
import type { AppBindings } from '../types';
import { parseJsonBody } from '../lib/validate';
import { allowRequest } from '../lib/rate-limit';
import { AppError, misconfigured } from '../lib/errors';
import {
  SESSION_TTL_SEC,
  TOTP_SECRET_KEY,
  buildClearSessionCookie,
  buildSessionCookie,
  bumpSessionEpoch,
  readSessionEpoch,
  signSession,
} from '../lib/session';
import { verifyTotp } from '../lib/totp';
import { requireAuth, verifyAdminPassword } from '../middleware/auth';

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return proto === 'https' || new URL(c.req.url).protocol === 'https:';
}

function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function authRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.post('/auth/login', async (c) => {
    const allowed = await allowRequest(
      { db: c.env.DB, kv: c.env.KV },
      `login:${clientIp(c)}`,
      10,
      300,
    );
    if (!allowed) {
      throw new AppError(429, 'too_many_attempts', '尝试次数过多，请 5 分钟后再试');
    }

    const body = await parseJsonBody(c, loginRequestSchema);
    const secret = c.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
      throw misconfigured('SESSION_SECRET 未配置（需 ≥32 字节）');
    }

    const ok = await verifyAdminPassword(c.env, body.password);
    if (!ok) throw new AppError(401, 'invalid_credentials', '口令错误');

    const settings = c.get('settings');
    if (!settings) throw misconfigured('设置仓储未注入，无法完成登录校验');
    const now = Math.floor(Date.now() / 1000);

    // TOTP 已启用时必须校验二次验证码；缺失/错误与口令错误合并为同一 401（避免枚举、零回显）。
    // 未启用时不做任何额外校验，行为与改造前完全一致。
    const stored = await settings.getValue(TOTP_SECRET_KEY);
    if (typeof stored === 'string' && stored.length > 0) {
      const valid = body.totp ? await verifyTotp(stored, body.totp, now) : false;
      if (!valid) throw new AppError(401, 'invalid_credentials', '口令错误');
    }

    const epoch = await readSessionEpoch(settings);
    const expiresAt = now + SESSION_TTL_SEC;
    const token = await signSession(secret, {
      sub: 'admin',
      iat: now,
      exp: expiresAt,
      ver: epoch,
    });
    c.header('set-cookie', buildSessionCookie(token, SESSION_TTL_SEC, isSecureRequest(c)));

    return c.json(
      loginResponseSchema.parse({ ok: true, user: { name: 'admin' }, expiresAt }),
    );
  });

  router.post('/auth/logout', (c) => {
    c.header('set-cookie', buildClearSessionCookie(isSecureRequest(c)));
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  /** 显式「全部登出」：递增会话版本号，撤销全部既有会话（含当前会话） */
  router.post('/auth/logout-all', requireAuth, async (c) => {
    const settings = c.get('settings');
    if (settings) await bumpSessionEpoch(settings);
    c.header('set-cookie', buildClearSessionCookie(isSecureRequest(c)));
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  router.get('/auth/me', requireAuth, (c) =>
    c.json(meResponseSchema.parse({ user: c.get('user') })),
  );

  return router;
}
