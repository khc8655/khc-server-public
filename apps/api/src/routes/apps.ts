import { Hono } from 'hono';
import {
  adapterInfoSchema,
  agentEnvelopeSchema,
  appActionRequestSchema,
  appConfigListResponseSchema,
  appConfigResponseSchema,
  appConfigSchema,
  putAppConfigRequestSchema,
  revisionListResponseSchema,
  rollbackResponseSchema,
  taskResponseSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import type { AppConfigRecord } from '../domain/repos';
import type { AppApplyError } from '@khc/contracts';
import { newIdempotencyKey } from '../lib/crypto';
import { AppError, badRequest, notFound } from '../lib/errors';
import { nowSec } from '../lib/ids';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { HubUnreachableError } from '../lib/node-client';
import { nodeToken, requireNode } from './helpers';
import { resolveSecretRefs } from '../lib/secret-refs';
import { assertSecureChannelForSecrets } from '../lib/secure-channel';
import { redactAgentEnvelope } from '../lib/redact';
import { throwAgentError } from './nodes';

/** 内置动作 + 适配器自定义动作（如 client_config / rotate_peer） */
const ACTION_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const SYNC_TIMEOUT_MS = 15_000;
const SYNC_RETRY_WINDOW_MS = 60_000;
const SYNC_RETRY_INTERVAL_MS = 750;
const TASK_TIMEOUT_MS = 5_000;

function toPublicApp(record: AppConfigRecord) {
  const { nodeId: _nodeId, secretsEnc: _secretsEnc, ...rest } = record;
  return appConfigSchema.parse(rest);
}

function unreachableMessage(error: unknown): string {
  if (error instanceof HubUnreachableError) {
    const detail = Object.entries(error.routeErrors)
      .map(([route, message]) => `${route}: ${message}`)
      .join('；');
    return detail ? `${error.message}（${detail}）` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 从 Agent 错误信封提取 code/message（D6 摘要；不含 details/凭据）。 */
function extractAgentError(body: unknown): AppApplyError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error = record.error;
  if (error && typeof error === 'object') {
    const item = error as Record<string, unknown>;
    const code = typeof item.code === 'string' && item.code ? item.code : 'agent_error';
    const message =
      typeof item.message === 'string' && item.message ? item.message : 'Agent 调用失败';
    return { code: code.slice(0, 64), message: message.slice(0, 500), at: nowSec() };
  }
  if (typeof error === 'string' && error) {
    return { code: 'agent_error', message: error.slice(0, 500), at: nowSec() };
  }
  return { code: 'agent_error', message: 'Agent 调用失败', at: nowSec() };
}

/** D6：写失败摘要不能影响主错误返回（数据库异常只告警）。 */
async function recordApplyFailure(
  deps: AppDeps,
  nodeId: string,
  app: string,
  error: AppApplyError,
): Promise<void> {
  try {
    await deps.apps.setLastApplyError(nodeId, app, error);
  } catch (writeError) {
    console.warn('[apps] failed to persist last_apply_error', writeError);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * #47：同步写动作超过 Worker 15s 窗口时，用同一 idempotencyKey 重试；
 * Agent 返回 202 inProgress 时也继续轮询，直到拿到最终结果或 60s 截止。
 *
 * 超时重试的余量设计（R-3）：Agent 侧同步动作死线 SYNC_DEADLINE_SECONDS=12s
 * （agent/khc/kernel.py），早于 Worker 单次传输预算 SYNC_TIMEOUT_MS=15s——
 * 正常情况下 Agent 会先把超 12s 的动作转成 202/inProgress 信封返回，留 ~3s
 * 余量给 HTTP 往返。因此"传输超时"只发生在网络停滞等异常下，且超时意味着
 * 请求可能已送达 Agent（写动作可能已开始执行），用同一幂等键重试是安全的
 * （Agent 侧去重）；非超时的连接层失败立即抛出，不做无谓重试。
 */
async function callWithSyncPoll(
  deps: AppDeps,
  node: Parameters<typeof nodeToken>[1],
  token: string,
  app: string,
  action: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Awaited<ReturnType<AppDeps['agent']['call']>>> {
  const deadline = Date.now() + SYNC_RETRY_WINDOW_MS;
  for (;;) {
    try {
      const response = await deps.agent.call(
        node,
        token,
        'POST',
        `/apps/${encodeURIComponent(app)}/${action}`,
        payload,
        { timeoutMs: SYNC_TIMEOUT_MS, idempotencyKey },
      );
      if (response.status !== 202) return response;
    } catch (error) {
      // R-3：超时按传输层的类型化标记（HubUnreachableError.timedOut）判定，
      // 不再匹配错误消息字符串——真实客户端 message 恒为
      // "Hub 不可达（直连与隧道均失败）"，旧字符串匹配分支实际永远不命中。
      const timeout = error instanceof HubUnreachableError && error.timedOut;
      if (!timeout || Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) {
      throw new HubUnreachableError('Agent 同步动作超过 60s 仍未返回结果', {});
    }
    await sleep(SYNC_RETRY_INTERVAL_MS);
  }
}

export function appRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use('/nodes/*', requireAuth);

  // 已安装的应用配置 + Agent 上的适配器清单
  router.get('/nodes/:id/apps', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const records = await deps.apps.listByNode(node.id);
    const token = await nodeToken(c.env, node);
    let adapters: unknown[] = [];
    let adaptersError: string | null = null;
    try {
      const response = await deps.agent.call(node, token, 'GET', '/adapters', undefined, {
        timeoutMs: 3_000,
      });
      const body = response.body as { adapters?: unknown[] } | null;
      if (Array.isArray(body?.adapters)) {
        adapters = body.adapters.filter((item) => adapterInfoSchema.safeParse(item).success);
      } else {
        adaptersError = 'Agent /adapters 返回格式不合法';
      }
    } catch (error) {
      adaptersError = unreachableMessage(error);
    }
    return c.json(
      appConfigListResponseSchema.parse({
        apps: records.map(toPublicApp),
        adapters,
        adaptersError,
      }),
    );
  });

  router.get('/nodes/:id/apps/:app', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const record = await deps.apps.get(node.id, c.req.param('app'));
    if (!record) throw notFound('该应用尚未配置');
    return c.json(appConfigResponseSchema.parse({ app: toPublicApp(record) }));
  });

  // 只写 D1 + revisions，不碰 Hub
  router.put('/nodes/:id/apps/:app', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const app = c.req.param('app');
    const body = await parseJsonBody(c, putAppConfigRequestSchema);
    const record = await deps.apps.put(node.id, app, {
      config: body.config,
      schemaVersion: body.schemaVersion,
      note: body.note,
      actor: c.get('user').name,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      app,
      action: 'app.config.put',
      detail: { rev: record.rev },
    });
    return c.json(appConfigResponseSchema.parse({ app: toPublicApp(record) }));
  });

  // 转发给 Agent：plan/apply 同步；install/uninstall 返回 taskId
  router.post('/nodes/:id/apps/:app/:action', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const app = c.req.param('app');
    const action = c.req.param('action');
    if (!ACTION_PATTERN.test(action)) throw badRequest(`不支持的动作：${action}`);

    const record = await deps.apps.get(node.id, app);
    // plan/apply/rollback/uninstall 需要已保存的配置；自定义动作（签发/检查/哈希等）
    // 允许无配置调用（适配器自行校验参数）。
    const needsConfig = ['plan', 'apply', 'rollback', 'uninstall'].includes(action);
    if (!record && needsConfig) throw notFound('该应用尚未配置');

    const body = await parseJsonBody(c, appActionRequestSchema);
    const idempotencyKey = body.idempotencyKey ?? newIdempotencyKey();
    // 含 $cert/$dnsCred 引用且存在明文候选通道时拒绝（HMAC 不提供保密性），不调用 Agent。
    assertSecureChannelForSecrets(c.env, node, record?.config, body.params);
    // 转发前解析 $cert / $dnsCred 占位符（只发生在内存；缺失即 400，不调用 Agent）
    const payload = {
      config: (await resolveSecretRefs(deps, record?.config ?? {})) as Record<string, unknown>,
      expectRev: record?.rev ?? 0,
      // D-2/T2.2：携带节点当前纪元；Agent 发现与已存纪元不一致即判定旧纪元，
      // 清除 appliedRev 基线，让节点重建/恢复后的低 rev 重新下发不再 409。
      // 旧 Agent（0.1.12）忽略未知字段，不受影响。
      ...(node.revEpoch ? { epoch: node.revEpoch } : {}),
      params: (await resolveSecretRefs(deps, body.params)) as Record<string, unknown>,
      idempotencyKey,
    };

    const token = await nodeToken(c.env, node);
    let response;
    try {
      response = await callWithSyncPoll(deps, node, token, app, action, payload, idempotencyKey);
    } catch (error) {
      if (action === 'apply') {
        await recordApplyFailure(deps, node.id, app, {
          code: error instanceof AppError ? error.code : 'hub_unreachable',
          message: unreachableMessage(error).slice(0, 500),
          at: nowSec(),
        });
      }
      // 已带错误码的 AppError（Agent 结构化错误等）原样抛出；
      // 只有网络层失败（HubUnreachableError）与其他未知错误才归类为不可达。
      if (error instanceof AppError) throw error;
      throw new HubUnreachableError(unreachableMessage(error), {});
    }
    if (response.status >= 400) {
      if (action === 'apply') {
        await recordApplyFailure(deps, node.id, app, extractAgentError(response.body));
      }
      throwAgentError(response.status, response.body);
    }

    const envelope = agentEnvelopeSchema.parse(response.body);
    // 自定义动作（如 WireGuard client_config/rotate_peer）把 cards 放在顶层；
    // 统一归一化到 result.cards，前端只认这一种形态。
    if (envelope.result?.cards === undefined) {
      const topCards = (response.body as { cards?: unknown }).cards;
      if (Array.isArray(topCards)) {
        envelope.result = { ...(envelope.result ?? {}), cards: topCards as never };
      }
    }
    // 适配器可在动作信封里返回 audit{write,target,verb,...}；核心只按信封
    // 通用记录，不认识任何具体应用/动词（避免把 host-ops 等知识写进核心）。
    const actionAudit = (response.body as { audit?: unknown }).audit;
    if (
      envelope.ok &&
      actionAudit !== null &&
      typeof actionAudit === 'object' &&
      (actionAudit as { write?: unknown }).write === true
    ) {
      const audit = actionAudit as { target?: unknown; verb?: unknown };
      await deps.audit.log({
        actor: c.get('user').name,
        nodeId: node.id,
        app,
        action: `${app}.${action}`,
        detail: {
          target: typeof audit.target === 'string' ? audit.target : '',
          verb: typeof audit.verb === 'string' ? audit.verb : '',
          ok: envelope.ok,
          error: envelope.error?.code ?? null,
        },
      });
    }

    if (action === 'apply') {
      if (!envelope.ok) {
        // 同步动作可能以 200 + ok:false 返回失败（例如 apply_failed）。
        await recordApplyFailure(deps, node.id, app, {
          code: envelope.error?.code ?? 'agent_error',
          message: (envelope.error?.message ?? 'Agent 返回 ok=false').slice(0, 500),
          at: nowSec(),
        });
      } else {
        const appliedRev = envelope.appliedRev ?? envelope.rev ?? payload.expectRev;
        await deps.apps.setAppliedRev(node.id, app, appliedRev);
        try {
          await deps.apps.setLastApplyError(node.id, app, null);
        } catch (writeError) {
          console.warn('[apps] failed to clear last_apply_error', writeError);
        }
        await deps.audit.log({
          actor: c.get('user').name,
          nodeId: node.id,
          app,
          action: 'app.apply',
          detail: { rev: appliedRev, route: response.route },
        });
      }
    }
    return c.json(redactAgentEnvelope(envelope));
  });

  router.get('/nodes/:id/tasks/:taskId', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const token = await nodeToken(c.env, node);
    const response = await deps.agent.call(
      node,
      token,
      'GET',
      `/tasks/${encodeURIComponent(c.req.param('taskId'))}`,
      undefined,
      { timeoutMs: TASK_TIMEOUT_MS },
    );
    if (response.status >= 400) throwAgentError(response.status, response.body);
    return c.json(taskResponseSchema.parse(response.body));
  });

  router.get('/nodes/:id/apps/:app/revisions', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const revisions = await deps.apps.listRevisions(node.id, c.req.param('app'));
    return c.json(
      revisionListResponseSchema.parse({
        revisions: revisions.map(({ nodeId: _nodeId, ...rest }) => rest),
      }),
    );
  });

  // 回滚 = 用旧 config 生成新 rev 再 apply
  router.post('/nodes/:id/apps/:app/rollback/:rev', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const app = c.req.param('app');
    const targetRev = Number.parseInt(c.req.param('rev'), 10);
    if (!Number.isInteger(targetRev) || targetRev < 1) throw badRequest('rev 不合法');

    const current = await deps.apps.get(node.id, app);
    const target = await deps.apps.getRevision(node.id, app, targetRev);
    if (!target) throw notFound('目标版本不存在');

    const next = await deps.apps.put(node.id, app, {
      config: target.config,
      schemaVersion: current?.schemaVersion ?? 1,
      note: `rollback to rev ${targetRev}`,
      actor: c.get('user').name,
    });

    assertSecureChannelForSecrets(c.env, node, next.config);
    const token = await nodeToken(c.env, node);
    const idempotencyKey = newIdempotencyKey();
    let response;
    try {
      response = await deps.agent.call(
        node,
        token,
        'POST',
        `/apps/${encodeURIComponent(app)}/apply`,
        {
          config: (await resolveSecretRefs(deps, next.config)) as Record<string, unknown>,
          expectRev: next.rev,
          ...(node.revEpoch ? { epoch: node.revEpoch } : {}),
          params: {},
          idempotencyKey,
        },
        { timeoutMs: SYNC_TIMEOUT_MS, idempotencyKey },
      );
    } catch (error) {
      throw new HubUnreachableError(unreachableMessage(error), {});
    }
    if (response.status >= 400) throwAgentError(response.status, response.body);

    const envelope = agentEnvelopeSchema.parse(response.body);
    const appliedRev = envelope.ok ? (envelope.appliedRev ?? next.rev) : null;
    if (appliedRev !== null) {
      await deps.apps.setAppliedRev(node.id, app, appliedRev);
      await deps.audit.log({
        actor: c.get('user').name,
        nodeId: node.id,
        app,
        action: 'app.rollback',
        detail: { to: targetRev, rev: next.rev, appliedRev },
      });
    }
    return c.json(
      rollbackResponseSchema.parse({
        ok: true,
        app: toPublicApp({ ...next, appliedRev }),
        appliedRev,
      }),
    );
  });

  return router;
}
