import { Hono } from 'hono';
import {
  putSettingRequestSchema,
  settingKeySchema,
  settingsListResponseSchema,
  totpSetupResponseSchema,
  totpCodeRequestSchema,
  okResponseSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import type { SettingsRepo } from '../domain/repos';
import { AppError, conflict, notFound } from '../lib/errors';
import { parseJsonBody, parseParams } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from '../lib/totp';
import { TOTP_PENDING_KEY, TOTP_SECRET_KEY, bumpSessionEpoch } from '../lib/session';

async function readSecret(settings: SettingsRepo, key: string): Promise<string | null> {
  const value = await settings.getValue(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function settingsRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/settings', requireAuth);
  router.use('/settings/*', requireAuth);

  // 只返回键与更新时间，绝不回显值
  router.get('/settings', async (c) => {
    return c.json(settingsListResponseSchema.parse({ settings: await deps.settings.list() }));
  });

  router.put('/settings/:key', async (c) => {
    const key = parseParams(c.req.param('key'), settingKeySchema);
    const body = await parseJsonBody(c, putSettingRequestSchema);
    const setting = await deps.settings.put(key, body.value);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'setting.put',
      detail: { key },
    });
    return c.json({ setting });
  });

  router.delete('/settings/:key', async (c) => {
    const key = parseParams(c.req.param('key'), settingKeySchema);
    const removed = await deps.settings.remove(key);
    if (!removed) throw notFound('设置不存在');
    await deps.audit.log({ actor: c.get('user').name, action: 'setting.delete', detail: { key } });
    return c.json({ ok: true });
  });

  // ---- TOTP 二次验证管理（§3.4）----
  // app.ts 的 /api/v1/* 默认鉴权已覆盖这些路径，这里显式再加一层（纵深防御）。
  // 除 setup 成功响应外，任何响应/日志/审计都不回显 secret 或验证码。

  /** 未启用时生成一次性 secret + otpauth URI；待确认密钥加密落在 settings */
  router.get('/auth/totp/setup', requireAuth, async (c) => {
    if (await readSecret(deps.settings, TOTP_SECRET_KEY)) {
      throw conflict('TOTP 已启用，请先禁用后再重新设置');
    }
    const secret = generateTotpSecret();
    await deps.settings.put(TOTP_PENDING_KEY, secret);
    return c.json(
      totpSetupResponseSchema.parse({
        secret,
        otpauthUri: buildOtpauthUri(secret, 'khc-server', 'admin'),
      }),
    );
  });

  /** 校验 6 位验证码后把 secret 转正写入 auth.totp_secret，并递增会话版本 */
  router.post('/auth/totp/enable', requireAuth, async (c) => {
    if (await readSecret(deps.settings, TOTP_SECRET_KEY)) throw conflict('TOTP 已启用');
    const body = await parseJsonBody(c, totpCodeRequestSchema);
    const pending = await readSecret(deps.settings, TOTP_PENDING_KEY);
    if (!pending) throw new AppError(400, 'totp_setup_required', '请先获取设置密钥');
    if (!(await verifyTotp(pending, body.code))) {
      throw new AppError(401, 'invalid_credentials', '验证码错误');
    }
    await deps.settings.put(TOTP_SECRET_KEY, pending);
    await deps.settings.remove(TOTP_PENDING_KEY);
    await bumpSessionEpoch(deps.settings);
    await deps.audit.log({ actor: c.get('user').name, action: 'auth.totp.enable' });
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  /** 校验当前验证码后清除 TOTP 设置，并递增会话版本 */
  router.post('/auth/totp/disable', requireAuth, async (c) => {
    const current = await readSecret(deps.settings, TOTP_SECRET_KEY);
    if (!current) throw new AppError(400, 'totp_not_enabled', 'TOTP 未启用');
    const body = await parseJsonBody(c, totpCodeRequestSchema);
    if (!(await verifyTotp(current, body.code))) {
      throw new AppError(401, 'invalid_credentials', '验证码错误');
    }
    await deps.settings.remove(TOTP_SECRET_KEY);
    await deps.settings.remove(TOTP_PENDING_KEY);
    await bumpSessionEpoch(deps.settings);
    await deps.audit.log({ actor: c.get('user').name, action: 'auth.totp.disable' });
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  return router;
}
