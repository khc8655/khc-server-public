/**
 * 双模式预检路由（docs/dual-mode.md §6）。
 *
 * GET /api/v1/nodes/:id/mode —— 只读：D1 配置 + Agent `/state`（3s）派生 3 态。
 * 不写 D1 / 不更新 last_seen_at / 不写 audit；节点不可达仍 200（mode=unknown）。
 *
 * 应用知识全部在适配器 `status().modeImpact`；本路由只做通用汇总：
 * - 从配置里读取「是否启用组网」得到期望模式（唯一真源，缺省视为启用）；
 * - 任一应用 rev > appliedRev 即为未应用配置；
 * - 把 `/state` 所有适配器的 modeImpact 交给 lib/mode.ts。
 */
import { Hono } from 'hono';
import {
  agentStateSchema,
  nodeModeSchema,
  type AgentState,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import type { AppConfigRecord } from '../domain/repos';
import { requireAuth } from '../middleware/auth';
import { nodeToken, requireNode } from './helpers';
import { nowSec } from '../lib/ids';
import { collectModeImpacts, deriveNodeMode } from '../lib/mode';
import { desiredMode } from '../lib/node-summary';

const AGENT_TIMEOUT_MS = 3000;

function configDirty(configs: AppConfigRecord[]): boolean {
  return configs.some((record) => (record.rev ?? 0) > (record.appliedRev ?? 0));
}

export function modeRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use('/nodes', requireAuth);
  router.use('/nodes/*', requireAuth);

  router.get('/nodes/:id/mode', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const token = await nodeToken(c.env, node);

    let state: AgentState | null = null;
    let reachable = false;
    try {
      const response = await deps.agent.call(node, token, 'GET', '/state', undefined, {
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      if (response.status < 400) {
        reachable = true;
        const parsed = agentStateSchema.safeParse(response.body);
        state = parsed.success ? parsed.data : null;
      }
    } catch {
      // 节点不可达：仍返回 200，mode=unknown，由 UI 展示离线态。
      reachable = false;
    }

    const configs = await deps.apps.listByNode(node.id);

    const derivation = deriveNodeMode({
      desired: desiredMode(configs),
      reachable,
      impacts: collectModeImpacts(state?.adapters),
      configDirty: configDirty(configs),
      basePath: `/hubs/${encodeURIComponent(node.id)}`,
    });

    c.header('Cache-Control', 'no-store');
    return c.json(
      nodeModeSchema.parse({
        nodeId: node.id,
        ...derivation,
        checkedAt: nowSec(),
      }),
    );
  });

  return router;
}
