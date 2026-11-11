import { Hono } from 'hono';
import {
  createTunnelRequestSchema,
  okResponseSchema,
  tunnelListResponseSchema,
  tunnelResponseSchema,
  updateTunnelRequestSchema,
  type Tunnel,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import type { TunnelRecord } from '../domain/repos';
import { conflict, misconfigured, notFound } from '../lib/errors';
import { encryptSecret } from '../lib/crypto';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';

/**
 * PR1：全局隧道配置（面板只存「域名 / 源站端口 / Token」）。
 * - 不调用 Cloudflare API 做 Tunnel CRUD；CNAME/隧道本身由主人在 CF 侧维护；
 * - Token 只写不读：响应只回 hasToken；
 * - 节点通过 tunnelId 引用；删除隧道前先解除节点引用（避免安装命令失效）。
 */

function sanitize(tunnel: TunnelRecord): Tunnel {
  return {
    id: tunnel.id,
    name: tunnel.name,
    hostname: tunnel.hostname,
    originPort: tunnel.originPort,
    hasToken: Boolean(tunnel.tokenEnc),
    createdAt: tunnel.createdAt,
    updatedAt: tunnel.updatedAt,
  };
}

export function tunnelRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/tunnels', requireAuth);
  router.use('/tunnels/*', requireAuth);

  router.get('/tunnels', async (c) => {
    const tunnels = await deps.tunnels.list();
    return c.json(tunnelListResponseSchema.parse({ tunnels: tunnels.map(sanitize) }));
  });

  router.post('/tunnels', async (c) => {
    if (!c.env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
    const body = await parseJsonBody(c, createTunnelRequestSchema);
    const existing = await deps.tunnels.list();
    if (existing.some((tunnel) => tunnel.hostname === body.hostname)) {
      throw conflict(`域名 ${body.hostname} 已被其他隧道使用`);
    }
    const tunnel = await deps.tunnels.create({
      name: body.name,
      hostname: body.hostname,
      originPort: body.originPort,
      tokenEnc: await encryptSecret(c.env.MASTER_ENC_KEY, body.token, {
        keyId: c.env.MASTER_ENC_KEY_ID,
      }),
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'tunnel.create',
      detail: { tunnelId: tunnel.id, hostname: tunnel.hostname, originPort: tunnel.originPort },
    });
    return c.json(tunnelResponseSchema.parse({ tunnel: sanitize(tunnel) }), 201);
  });

  router.patch('/tunnels/:id', async (c) => {
    if (!c.env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateTunnelRequestSchema);
    const current = await deps.tunnels.get(id);
    if (!current) throw notFound('隧道配置不存在');
    if (body.hostname && body.hostname !== current.hostname) {
      const existing = await deps.tunnels.list();
      if (existing.some((tunnel) => tunnel.id !== id && tunnel.hostname === body.hostname)) {
        throw conflict(`域名 ${body.hostname} 已被其他隧道使用`);
      }
    }
    const tunnel = await deps.tunnels.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
      ...(body.originPort !== undefined ? { originPort: body.originPort } : {}),
      ...(body.token !== undefined
        ? {
            tokenEnc: await encryptSecret(c.env.MASTER_ENC_KEY, body.token, {
              keyId: c.env.MASTER_ENC_KEY_ID,
            }),
          }
        : {}),
    });
    if (!tunnel) throw notFound('隧道配置不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'tunnel.update',
      detail: { tunnelId: id, tokenRotated: body.token !== undefined },
    });
    return c.json(tunnelResponseSchema.parse({ tunnel: sanitize(tunnel) }));
  });

  router.delete('/tunnels/:id', async (c) => {
    const id = c.req.param('id');
    const current = await deps.tunnels.get(id);
    if (!current) throw notFound('隧道配置不存在');
    const nodes = await deps.nodes.list();
    const usedBy = nodes.filter((node) => node.tunnelId === id);
    if (usedBy.length > 0) {
      throw conflict(
        `该隧道仍被节点引用（${usedBy.map((node) => node.name).join('、')}），请先修改节点接入方式`,
      );
    }
    await deps.tunnels.remove(id);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'tunnel.delete',
      detail: { tunnelId: id },
    });
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  return router;
}
