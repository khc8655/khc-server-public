import { beforeEach, describe, expect, it } from 'vitest';
import { daysLeftFromCalendarDate } from '../src/lib/node-overview';
import { HubUnreachableError } from '../src/lib/node-client';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

function utcIsoDateOffset(days: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const now = new Date(nowSec * 1000);
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return dt.toISOString().slice(0, 10);
}

describe('节点固定到期日期 expiresAt（U4）', () => {
  it('daysLeftFromCalendarDate 严格按 UTC 公历日差计算并拒绝无效日期', () => {
    const fixedNow = Math.floor(Date.UTC(2026, 10, 21, 18, 30, 0) / 1000); // 2026-11-21 UTC
    expect(daysLeftFromCalendarDate('2026-11-22', fixedNow)).toBe(1);
    expect(daysLeftFromCalendarDate('2026-11-21', fixedNow)).toBe(0);
    expect(daysLeftFromCalendarDate('2026-11-18', fixedNow)).toBe(-3);
    expect(daysLeftFromCalendarDate('2026-02-30', fixedNow)).toBeNull();
    expect(daysLeftFromCalendarDate('2026-13-01', fixedNow)).toBeNull();
    expect(daysLeftFromCalendarDate('bad-date', fixedNow)).toBeNull();
    expect(daysLeftFromCalendarDate(null, fixedNow)).toBeNull();
  });

  it('POST / PATCH /nodes 支持设置与清除 expiresAt，并拒绝 2026-02-30 等非法日期（400）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = { ...authHeaders(cookie), 'content-type': 'application/json' };

    const badCreate = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'bad-expiry',
          endpoint: 'https://bad-expiry.example.com',
          expiresAt: '2026-02-30',
        }),
      },
      ctx.env,
    );
    expect(badCreate.status).toBe(400);

    const { id } = await createNode(ctx, cookie);

    const okPatch = await ctx.app.request(
      `/api/v1/nodes/${id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expiresAt: '2026-12-31' }),
      },
      ctx.env,
    );
    expect(okPatch.status).toBe(200);
    const okBody = (await okPatch.json()) as { node: { expiresAt?: string | null } };
    expect(okBody.node.expiresAt).toBe('2026-12-31');

    const badPatch = await ctx.app.request(
      `/api/v1/nodes/${id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expiresAt: '2026/12/31' }),
      },
      ctx.env,
    );
    expect(badPatch.status).toBe(400);
    expect((await ctx.nodes.get(id))?.expiresAt).toBe('2026-12-31');

    const clearPatch = await ctx.app.request(
      `/api/v1/nodes/${id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expiresAt: null }),
      },
      ctx.env,
    );
    expect(clearPatch.status).toBe(200);
    const clearBody = (await clearPatch.json()) as { node: { expiresAt?: string | null } };
    expect(clearBody.node.expiresAt).toBeNull();
  });

  it('POST /nodes/probe 与 GET /nodes/:id/overview 在线与离线时均同源返回 expiresAt 与 expiresDaysLeft', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id } = await createNode(ctx, cookie);
    const targetDate = utcIsoDateOffset(5);
    await ctx.nodes.update(id, { expiresAt: targetDate });

    ctx.agent.handler = async () => ({
      status: 200,
      body: { host: { hostname: 'n1' }, adapters: [], ports: [] },
    });

    const probeOnline = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers },
      ctx.env,
    );
    expect(probeOnline.status).toBe(200);
    const probeOnlineBody = (await probeOnline.json()) as {
      nodes: Array<{ projection?: { expiresAt?: string | null; expiresDaysLeft?: number | null } }>;
    };
    expect(probeOnlineBody.nodes[0]?.projection?.expiresAt).toBe(targetDate);
    expect(probeOnlineBody.nodes[0]?.projection?.expiresDaysLeft).toBe(5);

    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
    };

    const probeOffline = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers },
      ctx.env,
    );
    expect(probeOffline.status).toBe(200);
    const probeOfflineBody = (await probeOffline.json()) as {
      nodes: Array<{
        reachable: boolean;
        projection?: { expiresAt?: string | null; expiresDaysLeft?: number | null };
      }>;
    };
    expect(probeOfflineBody.nodes[0]?.reachable).toBe(false);
    expect(probeOfflineBody.nodes[0]?.projection?.expiresAt).toBe(targetDate);
    expect(probeOfflineBody.nodes[0]?.projection?.expiresDaysLeft).toBe(5);

    const overviewOffline = await ctx.app.request(
      `/api/v1/nodes/${id}/overview`,
      { headers },
      ctx.env,
    );
    expect(overviewOffline.status).toBe(200);
    const overviewBody = (await overviewOffline.json()) as {
      node: { expiresAt?: string | null };
      reachable: boolean;
      overview: { expiresAt?: string | null; expiresDaysLeft?: number | null };
    };
    expect(overviewBody.reachable).toBe(false);
    expect(overviewBody.node.expiresAt).toBe(targetDate);
    expect(overviewBody.overview.expiresAt).toBe(targetDate);
    expect(overviewBody.overview.expiresDaysLeft).toBe(5);
  });
});
