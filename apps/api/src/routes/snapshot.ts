import { Hono } from 'hono';
import { agentSnapshotSchema, type NodeSnapshotResponse } from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { nowSec } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { HubUnreachableError, formatRouteErrors } from '../lib/node-client';
import { nodeToken, requireNode } from './helpers';

/**
 * 无域名节点的快照转发：浏览器 → Worker → Agent `/snapshot`。
 * - 每个页面打开/每 10 秒 1 次 Worker 请求（不可避免：浏览器无法直连裸 IP）；
 * - 2 秒内同节点的并发/连续请求尽量共享同一 Agent 调用；内存 Map 为单 isolate，
 *   跨 isolate / 冷启动不共享，属**尽力而为**，不承诺多标签页不放大 Agent 采集；
 *   Worker 请求数始终按标签页计。
 */
const SNAPSHOT_TIMEOUT_MS = 5_000;
const DEDUPE_MS = 2_000;

interface DedupeEntry {
  at: number;
  promise: Promise<NodeSnapshotResponse>;
}

export function snapshotRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  const inflight = new Map<string, DedupeEntry>();
  router.use('/nodes/*/snapshot', requireAuth);

  router.get('/nodes/:id/snapshot', async (c) => {
    c.header('Cache-Control', 'no-store');
    const node = await requireNode(deps, c.req.param('id'));
    const token = await nodeToken(c.env, node);

    const now = Date.now();
    // 过期的去重条目顺手清理（Map 大小受节点数约束，不会无限增长）。
    for (const [id, entry] of inflight) {
      if (now - entry.at > DEDUPE_MS * 5) inflight.delete(id);
    }
    const existing = inflight.get(node.id);
    if (existing && now - existing.at < DEDUPE_MS) {
      const result = await existing.promise;
      return c.json({ ...result, cached: true });
    }

    const entry: DedupeEntry = {
      at: now,
      promise: callSnapshot(deps, node, token),
    };
    inflight.set(node.id, entry);
    const result = await entry.promise;
    return c.json(result);
  });

  return router;
}

async function callSnapshot(
  deps: AppDeps,
  node: Awaited<ReturnType<typeof requireNode>>,
  token: string,
): Promise<NodeSnapshotResponse> {
  try {
    const response = await deps.agent.call(node, token, 'GET', '/snapshot', undefined, {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const parsed = agentSnapshotSchema.safeParse(response.body);
    if (!parsed.success) {
      const agentMessage = (
        response.body as { error?: { message?: string } } | null
      )?.error?.message;
      const error =
        response.status === 401 || response.status === 403
          ? `Agent 鉴权失败（HTTP ${response.status}${agentMessage ? `：${agentMessage}` : ''}）`
          : response.status === 426
            ? `Agent 拒绝服务：版本协商失败${agentMessage ? `（${agentMessage}）` : ''}`
            : `Agent /snapshot 返回格式不合法（HTTP ${response.status}）`;
      return {
        reachable:
          response.status !== 401 && response.status !== 403 && response.status !== 426,
        route: response.route,
        via: response.via,
        snapshot: null,
        error,
      };
    }
    // 租约最多每分钟落一次库：10s 轮询不放大 D1 写（打开工作区时的 /state 已刷新过）。
    const seenAt = nowSec();
    if (node.lastSeenAt === null || seenAt - node.lastSeenAt >= 60) {
      await deps.nodes.update(node.id, { lastSeenAt: seenAt });
    }
    return {
      reachable: true,
      route: response.route,
      via: response.via,
      snapshot: parsed.data,
      error: null,
    };
  } catch (error) {
    if (error instanceof HubUnreachableError) {
      return {
        reachable: false,
        route: null,
        via: null,
        snapshot: null,
        error: formatRouteErrors(error),
      };
    }
    throw error;
  }
}
