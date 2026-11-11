import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('节点最近操作（最小版）', () => {
  it('返回本节点最近操作，limit 受限；未登录 401，陌生节点 404', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const node = await createNode(ctx, cookie);

    const res = await ctx.app.request(
      `/api/v1/nodes/${node.id}/audit?limit=5`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ action: string; nodeId: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries[0]?.action).toBe('node.create');
    expect(body.entries.every((entry) => entry.nodeId === node.id)).toBe(true);

    const capped = await ctx.app.request(
      `/api/v1/nodes/${node.id}/audit?limit=999`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(capped.status).toBe(200);
    expect(((await capped.json()) as { entries: unknown[] }).entries.length).toBeLessThanOrEqual(20);

    const unauthorized = await ctx.app.request(`/api/v1/nodes/${node.id}/audit`, {}, ctx.env);
    expect(unauthorized.status).toBe(401);

    const missing = await ctx.app.request(
      '/api/v1/nodes/nd_missing/audit',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(missing.status).toBe(404);
  });
});
