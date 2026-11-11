import { Hono } from 'hono';
import { liveTicketRequestSchema, liveTicketResponseSchema } from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { newId, nowSec } from '../lib/ids';
import { badRequest } from '../lib/errors';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { nodeToken, requireNode } from './helpers';

const TICKET_TTL_SECONDS = 60;
/** snap 票覆盖一轮 10 分钟快照轮询上限并留余量，避免每 10 秒换票放大 Worker 请求 */
const SNAP_TICKET_TTL_SECONDS = 15 * 60;
const LIVE_PATH = '/_live/';
const SNAPSHOT_PATH = '/_live/snapshot';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacHex(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 6.4a 观测层票据（当前 v3 架构）：用节点 token 做 HMAC，票 60 秒、一次性。
 * 说明：v0.5r 拆分 Service Token 后，这里可替换为 Ed25519（Hub 只存公钥），
 * 票据声明/首消息/scope 不变，见 docs/live-observation.md。
 */
export function liveRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/nodes/*/live-ticket', requireAuth);

  router.post('/nodes/:id/live-ticket', async (c) => {
    c.header('Cache-Control', 'no-store');
    const node = await requireNode(deps, c.req.param('id'));
    const body = await parseJsonBody(c, liveTicketRequestSchema);
    if (body.origin && !/^https?:\/\//i.test(body.origin)) {
      throw badRequest('origin 必须是 http(s) 地址', { origin: body.origin });
    }
    const token = await nodeToken(c.env, node);
    const ttl = body.scope === 'snap' ? SNAP_TICKET_TTL_SECONDS : TICKET_TTL_SECONDS;
    const expiresAt = nowSec() + ttl;
    const payload = {
      v: 1,
      n: node.id,
      s: body.scope,
      e: expiresAt,
      j: newId('jti'),
      o: body.origin ?? null,
    };
    const payloadB64 = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const ticket = `${payloadB64}.${await hmacHex(token, payloadB64)}`;
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'live.ticket',
      detail: { scope: body.scope, origin: body.origin ?? null, expiresAt },
    });
    return c.json(
      liveTicketResponseSchema.parse({
        ticket,
        expiresAt,
        livePath: LIVE_PATH,
        ...(body.scope === 'snap' ? { snapshotPath: SNAPSHOT_PATH } : {}),
      }),
    );
  });

  return router;
}
