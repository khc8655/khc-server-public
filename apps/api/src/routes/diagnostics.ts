import { Hono } from 'hono';
import {
  agentStateSchema,
  diagnosticHintsResponseSchema,
  diagnosticLayerSchema,
  nodeDiagnosticsResponseSchema,
  type AgentState,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { badRequest } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { HubUnreachableError } from '../lib/node-client';
import { nodeToken, requireNode } from './helpers';
import { diagnosticHints, hintsVersion } from '../lib/diagnostics/hints';
import {
  evaluateDiagnostics,
  finalizeChecks,
  type EvalConfig,
  type EvalTransportError,
} from '../lib/diagnostics/evaluate';
import {
  adjustAcmeProblems,
  certificateProblems,
  selectRelevantCertificates,
} from '../lib/app-diagnostics/certificates';

/** 响应体硬上限（§4.2）：64 KB。 */
const MAX_RESPONSE_BYTES = 64 * 1024;
const AGENT_TIMEOUT_MS = 3000;

interface AgentFailure {
  status?: number;
  body?: unknown;
  message: string;
  routeErrors?: Record<string, string>;
}

interface AgentOutcome {
  latencyMs: number;
  response?: {
    status: number;
    body: unknown;
    route: 'direct' | 'tunnel';
    via: 'fetch' | 'tcp';
  };
  failure?: AgentFailure;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  }
  return 'Agent 调用失败';
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** 只调用一次 /state；诊断只有一档，不再拉 /adapters。 */
async function callState(
  deps: AppDeps,
  node: Parameters<typeof nodeToken>[1],
  token: string,
): Promise<AgentOutcome> {
  const started = Date.now();
  try {
    const response = await deps.agent.call(node, token, 'GET', '/state', undefined, {
      bypassCooldown: true,
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    return {
      latencyMs: Math.max(0, Date.now() - started),
      response: {
        status: response.status,
        body: response.body,
        route: response.route,
        via: response.via,
      },
    };
  } catch (error) {
    const failure: AgentFailure = {
      message: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof HubUnreachableError) {
      failure.routeErrors = error.routeErrors;
      failure.status = error.status;
    }
    return { latencyMs: Math.max(0, Date.now() - started), failure };
  }
}

export function diagnosticsRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use('/diagnostics', requireAuth);
  router.use('/diagnostics/*', requireAuth);
  router.use('/nodes', requireAuth);
  router.use('/nodes/*', requireAuth);

  /** GET /api/v1/diagnostics/hints —— 核心 7 码的静态知识库（5 分钟缓存）。 */
  router.get('/diagnostics/hints', (c) => {
    const layerRaw = c.req.query('layer');
    let hints = diagnosticHints;
    if (layerRaw !== undefined) {
      const layer = diagnosticLayerSchema.safeParse(layerRaw);
      if (!layer.success) {
        throw badRequest('未知的 layer', { layer: '只支持 transport/agent/config' });
      }
      hints = diagnosticHints.filter((item) => item.layer === layer.data);
    }
    const body = diagnosticHintsResponseSchema.parse({ hintsVersion, hints });
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(body);
  });

  /**
   * GET /api/v1/nodes/:id/diagnostics
   *
   * 只读：不写 D1、不更新 last_seen_at、不写 audit、不触发修复。
   * 只返回问题（info/warn/error）；全部正常时 checks 为空。
   * 节点不可达一律 200 + reachable:false；只有鉴权/参数/节点不存在用 4xx，
   * MASTER_ENC_KEY 缺失由 nodeToken 抛 503。
   */
  router.get('/nodes/:id/diagnostics', async (c) => {
    const started = Date.now();
    const node = await requireNode(deps, c.req.param('id'));
    const token = await nodeToken(c.env, node);

    const [stateOutcome, configRows, certRows] = await Promise.all([
      callState(deps, node, token),
      deps.apps.listByNode(node.id),
      deps.certs.list(),
    ]);

    let reachable = false;
    let route: 'direct' | 'tunnel' | null = null;
    let via: 'fetch' | 'tcp' | null = null;
    let state: AgentState | null = null;
    let routeErrors: Record<string, string> | undefined;
    let transportError: EvalTransportError | null = null;

    if (stateOutcome.response) {
      const response = stateOutcome.response;
      if (response.status >= 400) {
        transportError = {
          status: response.status,
          body: response.body,
          message: errorMessage(response.body),
        };
      } else {
        reachable = true;
        route = response.route;
        via = response.via;
        const parsed = agentStateSchema.safeParse(response.body);
        if (parsed.success) state = parsed.data;
        else transportError = { stateInvalid: true };
      }
    } else if (stateOutcome.failure) {
      transportError = {
        status: stateOutcome.failure.status,
        body: stateOutcome.failure.body,
        message: stateOutcome.failure.message,
      };
      routeErrors = stateOutcome.failure.routeErrors;
    }

    const evalConfigs: EvalConfig[] = configRows.map((row) => ({
      app: row.app,
      rev: row.rev,
      appliedRev: row.appliedRev,
      updatedAt: row.updatedAt,
      lastApplyError: row.lastApplyError ?? null,
    }));
    const now = Math.floor(Date.now() / 1000);
    const relevantCerts = selectRelevantCertificates(
      node.id,
      configRows.map((row) => ({ app: row.app, config: row.config })),
      certRows,
    );

    // acme.sh 缺失只在节点确实有 ACME 证书时才算失败；否则降为提示（3A）。
    const hasAcmeCert = relevantCerts.some((cert) => cert.issuer === 'acme');
    const checks = evaluateDiagnostics({
      node: { lastSeenAt: node.lastSeenAt },
      state: adjustAcmeProblems(state, hasAcmeCert),
      configs: evalConfigs,
      now,
      reachable,
      routeErrors,
      error: transportError,
      extraProblems: [{ app: 'certificates', problems: certificateProblems(relevantCerts, now) }],
    });

    const finalized = finalizeChecks(checks);
    let keptChecks = finalized.checks;
    let truncated = finalized.truncated;

    const base = {
      nodeId: node.id,
      generatedAt: Math.floor(Date.now() / 1000),
      durationMs: Math.max(0, Date.now() - started),
      hintsVersion,
      reachable,
      route,
      via,
    };
    // 总响应 ≤64KB：按已排序的 checks 从尾部（低优先级）丢弃，并标记 truncated。
    while (byteLength({ ...base, checks: keptChecks, truncated: true }) > MAX_RESPONSE_BYTES) {
      if (keptChecks.length === 0) break;
      keptChecks = keptChecks.slice(0, -1);
      truncated = true;
    }

    const payload = nodeDiagnosticsResponseSchema.parse({
      ...base,
      checks: keptChecks,
      ...(truncated ? { truncated: true } : {}),
    });
    c.header('Cache-Control', 'no-store');
    return c.json(payload);
  });

  return router;
}
