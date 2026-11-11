import { describe, expect, it } from 'vitest';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

function decodePayload(ticket: string): Record<string, unknown> {
  const body = ticket.split('.')[0] ?? '';
  const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function verifyHmac(token: string, ticket: string): Promise<boolean> {
  const [body, sig] = ticket.split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = new Uint8Array((sig ?? '').match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}

describe('6.4a：观测层票据', () => {
  it('签发 60 秒、一次性票据，并用节点 token 可验签', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id, token } = await createNode(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/live-ticket`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ scope: 'live', origin: 'https://console.example.com' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresAt: number; livePath: string };
    expect(body.livePath).toBe('/_live/');
    const payload = decodePayload(body.ticket);
    expect(payload.n).toBe(id);
    expect(payload.s).toBe('live');
    expect(payload.o).toBe('https://console.example.com');
    expect(typeof payload.j).toBe('string');
    expect(await verifyHmac(token, body.ticket)).toBe(true);
    expect(body.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
  });

  it('nudge scope 与非法 scope', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const nudge = await ctx.app.request(
      `/api/v1/nodes/${id}/live-ticket`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ scope: 'nudge' }) },
      ctx.env,
    );
    expect(nudge.status).toBe(200);
    expect(decodePayload(((await nudge.json()) as { ticket: string }).ticket).s).toBe('nudge');

    const bad = await ctx.app.request(
      `/api/v1/nodes/${id}/live-ticket`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ scope: 'write' }) },
      ctx.env,
    );
    expect(bad.status).toBe(400);
  });

  it('snap 票 15 分钟可复用，并返回浏览器直连快照路径', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/live-ticket`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ scope: 'snap', origin: 'https://console.example.com' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresAt: number; snapshotPath?: string };
    expect(body.snapshotPath).toBe('/_live/snapshot');
    expect(body.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(15 * 60);
    expect(body.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60);
  });

  it('未登录 / 节点不存在', async () => {
    const ctx = makeTestContext();
    const anon = await ctx.app.request(
      '/api/v1/nodes/nd_missing/live-ticket',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      ctx.env,
    );
    expect(anon.status).toBe(401);
    const cookie = await loginAsAdmin(ctx);
    const missing = await ctx.app.request(
      '/api/v1/nodes/nd_missing/live-ticket',
      { method: 'POST', headers: authHeaders(cookie), body: '{}' },
      ctx.env,
    );
    expect(missing.status).toBe(404);
  });
});
