import { Hono } from 'hono';
import {
  createSshKeyRequestSchema,
  sshKeyListResponseSchema,
  sshKeyResponseSchema,
  updateSshKeyRequestSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { badRequest, conflict, notFound } from '../lib/errors';
import { normalizeSshPublicKey } from '../lib/ssh-keys';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';

/**
 * 全局 SSH 公钥库（P4）。
 *
 * - 只接受公钥文本，私钥永不进入控制面；库本身不保存任何密钥材料。
 * - 指纹在 Worker 侧规范化计算，重复指纹直接 409（同一把钥匙不重复入库）。
 * - 写操作全部审计；删除不影响节点上已下发的 authorized_keys。
 */
export function sshKeyRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/ssh-keys', requireAuth);
  router.use('/ssh-keys/*', requireAuth);

  router.get('/ssh-keys', async (c) => {
    return c.json(sshKeyListResponseSchema.parse({ sshKeys: await deps.sshKeys.list() }));
  });

  router.post('/ssh-keys', async (c) => {
    const body = await parseJsonBody(c, createSshKeyRequestSchema);
    let normalized;
    try {
      normalized = await normalizeSshPublicKey(body.publicKey);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : '公钥格式非法');
    }
    const existing = await deps.sshKeys.findByFingerprint(normalized.fingerprint);
    if (existing) throw conflict(`该公钥已在库中（${existing.name}）`);

    const sshKey = await deps.sshKeys.create({
      name: body.name,
      publicKey: normalized.publicKey,
      fingerprint: normalized.fingerprint,
      comment: normalized.comment,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'sshKey.create',
      detail: { name: sshKey.name, fingerprint: sshKey.fingerprint },
    });
    return c.json(sshKeyResponseSchema.parse({ sshKey }), 201);
  });

  router.patch('/ssh-keys/:id', async (c) => {
    const body = await parseJsonBody(c, updateSshKeyRequestSchema);
    const sshKey = await deps.sshKeys.rename(c.req.param('id'), body.name);
    if (!sshKey) throw notFound('公钥不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'sshKey.update',
      detail: { name: sshKey.name, fingerprint: sshKey.fingerprint },
    });
    return c.json(sshKeyResponseSchema.parse({ sshKey }));
  });

  router.delete('/ssh-keys/:id', async (c) => {
    const removed = await deps.sshKeys.remove(c.req.param('id'));
    if (!removed) throw notFound('公钥不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'sshKey.delete',
      detail: { id: c.req.param('id') },
    });
    return c.json({ ok: true });
  });

  return router;
}
