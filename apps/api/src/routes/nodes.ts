import { Hono } from 'hono';
import {
  agentStateSchema,
  createNodeRequestSchema,
  nodeListResponseSchema,
  nodeOverviewResponseSchema,
  nodeProbeResponseSchema,
  nodeResponseSchema,
  nodeStateResponseSchema,
  nodeWithTokenResponseSchema,
  okResponseSchema,
  updateNodeRequestSchema,
  type AgentState,
  type NodeAccessMode,
  type NodeProbeApp,
  type NodeProbeItem,
  type PreferredRoute,
  type TlsProbe,
} from '@khc/contracts';
import type { AppBindings, AppDeps, Env } from '../types';
import type { AppConfigSummaryRow, AppSummaryRow, StoredNode } from '../domain/repos';
import { encryptSecret, newNodeToken } from '../lib/crypto';
import { AppError, badRequest, misconfigured, notFound } from '../lib/errors';
import { nowSec } from '../lib/ids';
import {
  collectExpiringCerts,
  projectNodeOverview,
  projectNodeProbe,
} from '../lib/node-overview';
import { summarizeAppSummaries, summarizeNodeApps } from '../lib/node-summary';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { HubUnreachableError, formatRouteErrors } from '../lib/node-client';
import { classifyTlsProbe } from '../lib/tls-probe';
import { nodeToken, requireNode, toPublicNode } from './helpers';

/**
 * §3.2 控制通道强制 TLS：production 下新建/编辑节点时，请求显式写入的
 * endpoint（必填）与 tunnelEndpoint（选填）都必须是 https://。
 *
 * - 校验放在路由层，不改 packages/contracts 的 zod（契约仍允许 http://，
 *   避免破坏共享契约与存量数据），错误码 insecure_endpoint。
 * - 仅 ENVIRONMENT=production 强制；development 与测试环境豁免。
 * - 字段以「本次请求是否显式写入」为准：undefined / null 视为未写，跳过。
 *   PATCH 存量 http 节点时只要不带 endpoint（仅改名/轮换 token/改路由等）
 *   就完全不触发校验，正常放行，响应里不带破坏性错误；一旦显式修改入口，
 *   必须按 https 迁移（§3.2 本身即向后不兼容的迁移项）。
 */
function assertProductionTls(
  env: Pick<Env, 'ENVIRONMENT'>,
  fields: { endpoint?: string; tunnelEndpoint?: string | null },
  allowInsecure = false,
): void {
  if (env.ENVIRONMENT !== 'production' || allowInsecure) return;
  const isHttps = (url: string) => /^https:\/\//i.test(url);
  const insecure: string[] = [];
  if (fields.endpoint !== undefined && !isHttps(fields.endpoint)) insecure.push('endpoint');
  if (
    fields.tunnelEndpoint !== undefined &&
    fields.tunnelEndpoint !== null &&
    !isHttps(fields.tunnelEndpoint)
  ) {
    insecure.push('tunnelEndpoint');
  }
  if (insecure.length === 0) return;
  const fieldErrors: Record<string, string> = {};
  for (const field of insecure) {
    fieldErrors[field] = '生产环境必须使用 https:// 开头的安全地址';
  }
  throw new AppError(
    400,
    'insecure_endpoint',
    `生产环境要求 ${insecure.join('、')} 使用 https:// 安全入口；请把明文 http 入口迁移到 HTTPS（可信证书直连或隧道）后再提交`,
    fieldErrors,
  );
}

/** 未显式指定接入方式时的推导：隧道引用 > endpoint 协议。 */
function deriveAccessMode(endpoint: string, tunnelId: string | null | undefined): NodeAccessMode {
  if (tunnelId) return 'tunnel';
  return /^https:\/\//i.test(endpoint) ? 'domain' : 'ip';
}

/**
 * 校验接入方式与隧道引用的一致性：
 * - tunnel：必须引用存在的隧道，endpoint 由隧道域名推导（不接受手填，避免两处真相）；
 * - ip：必须显式允许明文；
 * - domain：不允许明文。
 */
async function resolveAccess(
  deps: AppDeps,
  input: {
    endpoint: string;
    tunnelEndpoint?: string | null;
    accessMode: NodeAccessMode;
    tunnelId: string | null;
    allowInsecure: boolean;
  },
): Promise<{
  endpoint: string;
  tunnelEndpoint: string | null;
  tunnelId: string | null;
  allowInsecure: boolean;
}> {
  if (input.accessMode === 'tunnel') {
    if (!input.tunnelId) throw badRequest('隧道模式必须选择一条隧道配置', { tunnelId: '必填' });
    const tunnel = await deps.tunnels.get(input.tunnelId);
    if (!tunnel) throw badRequest('所选隧道配置不存在', { tunnelId: '不存在' });
    const derived = `https://${tunnel.hostname}`;
    return {
      endpoint: derived,
      tunnelEndpoint: derived,
      tunnelId: tunnel.id,
      allowInsecure: false,
    };
  }
  if (input.accessMode === 'ip') {
    // 是否放行由 TLS 门禁决定：显式 allowInsecure=true 才允许生产环境明文入口。
    return {
      endpoint: input.endpoint,
      tunnelEndpoint: input.tunnelEndpoint ?? null,
      tunnelId: null,
      allowInsecure: input.allowInsecure,
    };
  }
  return {
    endpoint: input.endpoint,
    tunnelEndpoint: input.tunnelEndpoint ?? null,
    tunnelId: null,
    allowInsecure: false,
  };
}

/**
 * 从 Agent /state 压出探针用的最小投影：只有适配器名 + 实装/运行布尔值。
 * 不携带任何配置、日志或 secrets；/state 结构不合法时返回空数组（不伪造状态）。
 * 本函数刻意不识别具体应用名，应用知识不扩散到核心路由。
 */
function probeApps(body: unknown): NodeProbeApp[] {
  const parsed = agentStateSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.adapters.map((adapter) => {
    const status = adapter.status ?? {};
    return {
      name: adapter.name,
      installed: typeof status.installed === 'boolean' ? status.installed : null,
      running: typeof status.running === 'boolean' ? status.running : null,
    };
  });
}

interface FetchedNodeState {
  reachable: boolean;
  route: PreferredRoute | null;
  via: 'fetch' | 'tcp' | null;
  state: AgentState | null;
  error: string | null;
  epochStale: boolean;
  tls: TlsProbe;
  lastSeenAt?: number;
}

/**
 * 调用节点 `/state` 并统一处理超时、鉴权失败、格式错误、epoch 对比与 TLS 实测。
 * 供 `GET /nodes/:id/state` 与 `GET /nodes/:id/overview` 共用，保持两处口径完全一致。
 */
async function fetchNodeState(
  env: Env,
  deps: AppDeps,
  node: StoredNode,
  opts: { force?: boolean } = {},
): Promise<FetchedNodeState> {
  const token = await nodeToken(env, node);
  // 本次实际会用的接入地址：tunnel 优先隧道地址，否则直连 endpoint。
  const probeEndpoint = node.preferredRoute === 'tunnel' ? node.tunnelEndpoint : node.endpoint;
  // ?force=1 透传给 Agent，跳过它 ops 采集的 5 秒进程内缓存。
  // 写操作成功后前端带这个参数重拉，否则会读到缓存里的旧失败计数（2026-11-16 U1）。
  const agentPath = opts.force ? '/state?force=1' : '/state';
  try {
    const response = await deps.agent.call(
      node,
      token,
      'GET',
      agentPath,
      undefined,
      // F-M1：/state 是最重的 Agent 端点（ops 收集 systemctl/ps/df 多个子进程），
      // 系统繁忙时 3s 预算必然踩线触发 fetch 超时→TCP 回退；放宽到与默认预算一致。
      { timeoutMs: 10_000 },
    );
    const parsed = agentStateSchema.safeParse(response.body);
    if (!parsed.success) {
      console.warn(
        '[state] invalid agent response',
        response.status,
        JSON.stringify(response.body).slice(0, 300),
      );
      // F-M1：401/403 是鉴权/签名类错误（token 不匹配、nonce 重放等），
      // 不得误报为"格式不合法"；附上 Agent 的错误信息便于定位。
      const agentMessage = (
        response.body as { error?: { message?: string } } | null
      )?.error?.message;
      const error =
        response.status === 401 || response.status === 403
          ? `Agent 鉴权失败（HTTP ${response.status}${agentMessage ? `：${agentMessage}` : ''}）——请核对节点 token 与面板记录是否一致，稍后重试`
          : response.status === 426
            ? `Agent 拒绝服务：版本协商失败${agentMessage ? `（${agentMessage}）` : ''}`
            : `Agent /state 返回格式不合法（HTTP ${response.status}）`;
      return {
        reachable: true,
        route: response.route,
        via: response.via,
        state: null,
        error,
        epochStale: false,
        // 拿到了响应 = TLS 握手已通过（https 时即证书有效）
        tls: classifyTlsProbe({ endpoint: probeEndpoint, reachable: true }),
      };
    }
    // 只更新轻量可达租约；运行快照不写入 D1（观测数据不进面板数据库）。
    const seenAt = nowSec();
    await deps.nodes.update(node.id, { lastSeenAt: seenAt });
    // D-2/T2.2：Agent 回传的 epoch 与节点当前 rev_epoch 不一致 = "旧纪元"
    // （Agent 记着节点重建/恢复前的 rev 基线）。下一次 apply 会自动重置 Agent
    // 基线并重新下发；旧 Agent（<0.1.13）不回传 epoch，不判定（待升级）。
    const agentEpoch = parsed.data.agent?.epoch;
    const epochStale = Boolean(agentEpoch && node.revEpoch && agentEpoch !== node.revEpoch);
    if (epochStale) {
      console.warn(
        '[state] stale rev epoch',
        node.id,
        `agent=${agentEpoch} node=${node.revEpoch}`,
      );
    }
    return {
      reachable: true,
      route: response.route,
      via: response.via,
      state: parsed.data,
      error: null,
      epochStale,
      tls: classifyTlsProbe({ endpoint: probeEndpoint, reachable: true }),
      lastSeenAt: seenAt,
    };
  } catch (error) {
    if (error instanceof HubUnreachableError) {
      const detail = formatRouteErrors(error);
      return {
        reachable: false,
        route: null,
        via: null,
        state: null,
        error: detail,
        epochStale: false,
        // 证书类失败能断言证书有问题，网络类只能说未知——不顺势报成证书故障
        tls: classifyTlsProbe({ endpoint: probeEndpoint, reachable: false, error: detail }),
      };
    }
    throw error;
  }
}

export function nodeRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use('/nodes', requireAuth);
  router.use('/nodes/*', requireAuth);

  router.get('/nodes', async (c) => {
    // 摘要优先读 app_configs.summary_json（明文、零解密）；旧行 NULL 时仓库内部兜底解密。
    // 不新增节点连接，首页请求预算不变；应用知识在 lib/node-summary.ts。
    const [nodes, summaries] = await Promise.all([deps.nodes.list(), deps.apps.listSummaries()]);
    const byNode = new Map<string, AppSummaryRow[]>();
    for (const summary of summaries) {
      const list = byNode.get(summary.nodeId);
      if (list) list.push(summary);
      else byNode.set(summary.nodeId, [summary]);
    }
    return c.json(
      nodeListResponseSchema.parse({
        nodes: nodes.map((n) => ({
          ...toPublicNode(n),
          summary: summarizeAppSummaries(byNode.get(n.id) ?? []),
        })),
      }),
    );
  });

  router.post('/nodes', async (c) => {
    const body = await parseJsonBody(c, createNodeRequestSchema);
    const accessMode = body.accessMode ?? deriveAccessMode(body.endpoint ?? '', body.tunnelId);
    if (accessMode !== 'tunnel' && !body.endpoint) {
      throw badRequest('非隧道接入必须提供 endpoint', { endpoint: '必填' });
    }
    const access = await resolveAccess(deps, {
      endpoint: body.endpoint ?? '',
      tunnelEndpoint: body.tunnelEndpoint,
      accessMode,
      tunnelId: body.tunnelId ?? null,
      allowInsecure: body.allowInsecure ?? false,
    });
    // §3.2：新建节点一律按 production 强制 TLS 校验；仅显式允许明文（IP 直连）时放行。
    assertProductionTls(
      c.env,
      { endpoint: access.endpoint, tunnelEndpoint: body.tunnelEndpoint },
      access.allowInsecure,
    );
    if (!c.env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
    const token = newNodeToken();
    const tokenEnc = await encryptSecret(c.env.MASTER_ENC_KEY, token, {
      keyId: c.env.MASTER_ENC_KEY_ID,
    });
    const node = await deps.nodes.create({
      name: body.name,
      endpoint: access.endpoint,
      tunnelEndpoint: access.tunnelEndpoint,
      liveEndpoint: body.liveEndpoint ?? null,
      domain: body.domain ?? null,
      accessMode,
      tunnelId: access.tunnelId,
      allowInsecure: access.allowInsecure,
      preferredRoute:
        body.preferredRoute ?? (accessMode === 'tunnel' ? 'tunnel' : 'direct'),
      tokenEnc,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'node.create',
      detail: { name: node.name, endpoint: node.endpoint, accessMode: node.accessMode },
    });
    return c.json(
      nodeWithTokenResponseSchema.parse({ node: toPublicNode(node), token }),
      201,
    );
  });

  router.get('/nodes/:id/audit', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const raw = Number(c.req.query('limit') ?? 5);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.trunc(raw))) : 5;
    const entries = await deps.audit.list({ nodeId: node.id, limit });
    return c.json({ entries });
  });

  router.get('/nodes/:id', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const summaries = await deps.apps.listSummaries(node.id);
    return c.json(
      nodeResponseSchema.parse({
        node: { ...toPublicNode(node), summary: summarizeAppSummaries(summaries) },
      }),
    );
  });

  router.patch('/nodes/:id', async (c) => {
    const patch = await parseJsonBody(c, updateNodeRequestSchema);
    const current = await requireNode(deps, c.req.param('id'));
    const accessMode = patch.accessMode ?? current.accessMode;
    const access = await resolveAccess(deps, {
      endpoint: patch.endpoint ?? current.endpoint,
      tunnelEndpoint:
        patch.tunnelEndpoint !== undefined
          ? patch.tunnelEndpoint
          : current.accessMode === 'tunnel' && accessMode !== 'tunnel'
            ? null
            : current.tunnelEndpoint,
      accessMode,
      tunnelId: patch.tunnelId !== undefined ? patch.tunnelId : current.tunnelId,
      allowInsecure: patch.allowInsecure ?? current.allowInsecure,
    });
    // §3.2：存量 http 节点不阻断——仅当本次「显式改 endpoint」或「切换接入方式」时校验；
    // 改名 / 轮换 token / 仅改路由等请求完全不触发。
    // 显式允许明文（IP 直连）时跳过 https 门禁。
    if (patch.endpoint !== undefined || accessMode !== current.accessMode) {
      assertProductionTls(
        c.env,
        { endpoint: access.endpoint, tunnelEndpoint: patch.tunnelEndpoint },
        access.allowInsecure,
      );
    }
    // F-3：token 显式支持轮换（加密写入 tokenEnc），不再被 zod 静默剥离；
    // 审计只记 tokenRotated，明文 token 零落库零回显。
    let tokenEnc: string | undefined;
    if (patch.token !== undefined) {
      if (!c.env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
      tokenEnc = await encryptSecret(c.env.MASTER_ENC_KEY, patch.token, {
        keyId: c.env.MASTER_ENC_KEY_ID,
      });
    }
    const { token: _token, ...safePatch } = patch;
    const preferredRoute =
      patch.preferredRoute ??
      (patch.accessMode !== undefined
        ? accessMode === 'tunnel'
          ? 'tunnel'
          : 'direct'
        : undefined);
    const node = await deps.nodes.update(c.req.param('id'), {
      ...safePatch,
      ...(access.endpoint !== current.endpoint || safePatch.endpoint !== undefined
        ? { endpoint: access.endpoint }
        : {}),
      ...(access.tunnelEndpoint !== current.tunnelEndpoint || safePatch.tunnelEndpoint !== undefined
        ? { tunnelEndpoint: access.tunnelEndpoint }
        : {}),
      ...(access.tunnelId !== current.tunnelId || safePatch.tunnelId !== undefined
        ? { tunnelId: access.tunnelId }
        : {}),
      ...(access.allowInsecure !== current.allowInsecure
        ? { allowInsecure: access.allowInsecure }
        : {}),
      ...(preferredRoute !== undefined && preferredRoute !== current.preferredRoute
        ? { preferredRoute }
        : {}),
      ...(tokenEnc !== undefined ? { tokenEnc } : {}),
    });
    if (!node) throw notFound('节点不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'node.update',
      detail: {
        ...safePatch,
        ...(node.endpoint !== current.endpoint ? { endpoint: node.endpoint } : {}),
        ...(tokenEnc !== undefined ? { tokenRotated: true } : {}),
      },
    });
    return c.json(nodeResponseSchema.parse({ node: toPublicNode(node) }));
  });

  router.delete('/nodes/:id', async (c) => {
    const nodeId = c.req.param('id');
    const removed = await deps.nodes.remove(nodeId);
    if (!removed) throw notFound('节点不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId,
      action: 'node.delete',
    });
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  /**
   * POST /nodes/probe —— 一次请求探测全部节点（首页打开只发这一次）。
   *
   * 自 0.8.1 起改用 Agent 的 GET /state：一次拿回可达性 + 各适配器实装/运行状态，
   * 让首页卡片能表达「实装未纳管」与「D1 有、实装无」。仍是一次 Worker 请求、
   * 每节点一次 Agent 调用；/state 解析失败或超时只让该节点的 apps 缺失，
   * 不影响 reachable 结论，也不让整卡报错。
   * 自 0.20.0 起同源附加每节点 projection 与顶层 expiringCerts，供首页去掉独立 /certs 请求。
   * 单个节点失败只影响自己这一项；整体始终 200。
   * 成功才写 lastSeenAt（探活租约），失败不写 D1、不产生负向持久状态。
   */
  router.post('/nodes/probe', async (c) => {
    c.header('Cache-Control', 'no-store');
    const [nodes, allConfigs, certs] = await Promise.all([
      deps.nodes.list(),
      deps.apps.listForSummary(),
      deps.certs.list(),
    ]);
    const configsByNode = new Map<string, AppConfigSummaryRow[]>();
    for (const row of allConfigs) {
      const list = configsByNode.get(row.nodeId);
      if (list) list.push(row);
      else configsByNode.set(row.nodeId, [row]);
    }

    const probedAt = nowSec();
    const results: NodeProbeItem[] = [];

    // Cloudflare Workers 单次调用子请求数有限（6），分批并发避免节点多时触顶。
    const concurrency = 4;
    for (let offset = 0; offset < nodes.length; offset += concurrency) {
      const batch = nodes.slice(offset, offset + concurrency);
      const settled = await Promise.all(
        batch.map(async (node): Promise<NodeProbeItem> => {
          const nodeConfigs = configsByNode.get(node.id) ?? [];
          const probeEndpoint =
            node.preferredRoute === 'tunnel' ? node.tunnelEndpoint : node.endpoint;
          try {
            const token = await nodeToken(c.env, node);
            const response = await deps.agent.call(
              node,
              token,
              'GET',
              '/state',
              undefined,
              // /state 比 /health 重（ops 要跑 systemctl/ps/df），沿用状态页的 10s 预算；
              // 超时只丢 apps，不会把整次探测打成 5xx。
              { timeoutMs: 10_000, bypassCooldown: true },
            );
            const reachable = response.status >= 200 && response.status < 300;
            if (!reachable) {
              const error = `Agent /state 返回 HTTP ${response.status}`;
              const tls = classifyTlsProbe({
                endpoint: probeEndpoint,
                reachable: false,
                error,
                now: probedAt,
              });
              return {
                id: node.id,
                reachable: false,
                route: response.route,
                via: response.via,
                error,
                lastSeenAt: node.lastSeenAt,
                projection: projectNodeProbe({
                  node,
                  configs: nodeConfigs,
                  certs,
                  state: null,
                  tls,
                  now: probedAt,
                }),
              };
            }
            await deps.nodes.update(node.id, { lastSeenAt: probedAt });
            const parsed = agentStateSchema.safeParse(response.body);
            const parsedState = parsed.success ? parsed.data : null;
            const tls = classifyTlsProbe({
              endpoint: probeEndpoint,
              reachable: true,
              now: probedAt,
            });
            return {
              id: node.id,
              reachable: true,
              route: response.route,
              via: response.via,
              error: null,
              lastSeenAt: probedAt,
              apps: probeApps(response.body),
              projection: projectNodeProbe({
                node,
                configs: nodeConfigs,
                certs,
                state: parsedState,
                tls,
                now: probedAt,
              }),
            };
          } catch (error) {
            const message =
              error instanceof HubUnreachableError
                ? formatRouteErrors(error)
                : error instanceof Error
                  ? error.message
                  : String(error);
            const tls = classifyTlsProbe({
              endpoint: probeEndpoint,
              reachable: false,
              error: message,
              now: probedAt,
            });
            return {
              id: node.id,
              reachable: false,
              route: null,
              via: null,
              error: message,
              lastSeenAt: node.lastSeenAt,
              projection: projectNodeProbe({
                node,
                configs: nodeConfigs,
                certs,
                state: null,
                tls,
                now: probedAt,
              }),
            };
          }
        }),
      );
      results.push(...settled);
    }

    const expiringCerts = collectExpiringCerts(certs, probedAt);
    return c.json(nodeProbeResponseSchema.parse({ probedAt, nodes: results, expiringCerts }));
  });

  /**
   * 打开面板时并发拉取：单节点失败只影响自己这一行。
   * 返回 200 + reachable:false，而不是 5xx，方便前端 fan-out。
   */
  router.get('/nodes/:id/state', async (c) => {
    // 运行状态是瞬时的：不进入共享缓存（也不进入 D1）。
    c.header('Cache-Control', 'no-store');
    const node = await requireNode(deps, c.req.param('id'));
    const force = c.req.query('force');
    const result = await fetchNodeState(c.env, deps, node, {
      force: force === '1' || force === 'true',
    });
    return c.json(
      nodeStateResponseSchema.parse({
        reachable: result.reachable,
        route: result.route,
        via: result.via,
        state: result.state,
        error: result.error,
        ...(result.epochStale ? { epochStale: true } : {}),
        tls: result.tls,
      }),
    );
  });

  /**
   * GET /nodes/:id/overview —— VM 概况聚合接口（合并节点信息 + D1 配置 + 证书 + /state + 投影）。
   * Agent 不可达时 D1 部分照常返回，state 为 null，reachable 为 false。
   */
  router.get('/nodes/:id/overview', async (c) => {
    c.header('Cache-Control', 'no-store');
    const node = await requireNode(deps, c.req.param('id'));
    const force = c.req.query('force');
    const [configs, certs, stateResult] = await Promise.all([
      deps.apps.listByNode(node.id),
      deps.certs.list(),
      fetchNodeState(c.env, deps, node, {
        force: force === '1' || force === 'true',
      }),
    ]);
    const nodeForPublic =
      stateResult.lastSeenAt !== undefined
        ? { ...node, lastSeenAt: stateResult.lastSeenAt }
        : node;
    const publicNode = {
      ...toPublicNode(nodeForPublic),
      summary: summarizeNodeApps(configs),
    };
    const overview = projectNodeOverview({
      node,
      configs,
      certs,
      state: stateResult.state,
      tls: stateResult.tls,
      now: nowSec(),
    });
    return c.json(
      nodeOverviewResponseSchema.parse({
        node: publicNode,
        reachable: stateResult.reachable,
        route: stateResult.route,
        via: stateResult.via,
        error: stateResult.error,
        ...(stateResult.epochStale ? { epochStale: true } : {}),
        tls: stateResult.tls,
        state: stateResult.state,
        overview,
      }),
    );
  });

  return router;
}

/** 供 apps 路由复用：把 Agent 的错误映射成 Worker 错误信封 */
export function throwAgentError(status: number, body: unknown): never {
  const envelope = body as { error?: { code?: string; message?: string } } | null;
  const code = envelope?.error?.code ?? 'agent_error';
  const message = envelope?.error?.message ?? `Agent 调用失败（HTTP ${status}）`;
  const details = (envelope?.error as { details?: Record<string, unknown> } | undefined)?.details;
  throw new AppError(status >= 400 && status < 500 ? status : 502, code, message, undefined, details);
}
