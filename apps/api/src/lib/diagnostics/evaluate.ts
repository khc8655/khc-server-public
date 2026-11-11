/**
 * 只读诊断求值（docs/diagnostics.md §4）。
 *
 * 核心只回答两件事：节点连得上吗？哪个应用坏了？因此这里只有 7 个核心码，
 * 不包含任何应用名。应用问题由适配器在 `status().problems` 里上报，本文件
 * 只做通用渲染、排序与截断。
 *
 * 纯函数：不依赖 Hono、D1、网络，路由层负责拉取数据与组装响应。
 */
import {
  adapterProblemSchema,
  type AdapterProblem,
  type AgentState,
  type DiagnosticAction,
  type DiagnosticCheck,
  type DiagnosticEvidenceValue,
} from '@khc/contracts';
import { redactText } from '../redact';

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export interface EvalNode {
  lastSeenAt: number | null;
}

export interface EvalConfig {
  app: string;
  rev: number;
  appliedRev: number | null;
  updatedAt: number;
  /** D6：最近一次 apply 失败摘要（app_configs.last_apply_error） */
  lastApplyError?: { code: string; message: string } | null;
}

export interface EvalTransportError {
  status?: number;
  body?: unknown;
  message?: string;
  /** 路由层解析 /state 失败 */
  stateInvalid?: boolean;
}

/** 控制面（D1）为某个应用补充的问题，例如全局证书库的到期信息。 */
export interface EvalProblems {
  app: string;
  problems: AdapterProblem[];
}

export interface EvalInput {
  node: EvalNode;
  state: AgentState | null;
  configs: EvalConfig[];
  now: number;
  reachable: boolean;
  routeErrors?: Record<string, string>;
  error?: EvalTransportError | null;
  /** 适配器之外、由控制面数据推导出的应用问题。 */
  extraProblems?: EvalProblems[];
}

export type DiagnosticEvidence = Record<string, DiagnosticEvidenceValue>;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const OFFLINE_ERROR_SEC = 10 * 60;
const CLOCK_SKEW_SEC = 60;
const PENDING_STUCK_SEC = 10 * 60;
/** 响应里 checks 总数上限（§4.2 输出规则）。 */
export const MAX_CHECK_COUNT = 30;

/** 核心 7 码；适配器问题不得占用这些码。 */
export const CORE_DIAGNOSTIC_CODES: readonly string[] = [
  'khc.transport.unreachable',
  'khc.transport.auth_401',
  'khc.agent.clock_skew',
  'khc.agent.offline',
  'khc.agent.version_unsupported',
  'khc.agent.state_invalid',
  'khc.config.pending_apply',
];

const SEVERITY_RANK: Record<DiagnosticCheck['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function redact(text: string): string {
  return redactText(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\b(token|password|privateKey|secret)\b\s*[=:]\s*\S+/gi, '$1=***');
}

function detailText(text: string): string {
  return truncate(redact(text), 300);
}

function titleText(text: string): string {
  return truncate(text, 40);
}

function evidence(entries: Record<string, unknown>): DiagnosticEvidence {
  const result: DiagnosticEvidence = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (typeof value === 'string') result[key] = truncate(redact(value), 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
    }
  }
  return result;
}

interface CheckInput {
  id: string;
  code: string;
  severity: DiagnosticCheck['severity'];
  title: string;
  detail: string;
  app?: string;
  evidence?: DiagnosticEvidence;
  actions?: DiagnosticAction[];
}

function makeCheck(input: CheckInput): DiagnosticCheck {
  return {
    id: input.id,
    code: input.code,
    severity: input.severity,
    title: titleText(input.title),
    detail: detailText(input.detail),
    ...(input.app ? { app: input.app } : {}),
    ...(input.evidence && Object.keys(input.evidence).length > 0 ? { evidence: input.evidence } : {}),
    ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
  };
}

function bodyError(body: unknown): { code: string | null; message: string | null } {
  if (!isRecord(body)) return { code: null, message: null };
  const error = body.error;
  if (isRecord(error)) {
    return {
      code: readString(error.code),
      message: readString(error.message),
    };
  }
  if (typeof error === 'string') return { code: null, message: error };
  return { code: null, message: null };
}

// ---------------------------------------------------------------------------
// 传输 / 离线
// ---------------------------------------------------------------------------

interface TransportVerdict {
  code: 'khc.transport.unreachable' | 'khc.transport.auth_401';
  title: string;
  detail: string;
  evidence: DiagnosticEvidence;
}

/** 把 timeout/TLS/Cloudflare 等旧码合并成一个码，原因只进 detail/evidence。 */
export function classifyTransport(input: EvalInput): TransportVerdict {
  const body = bodyError(input.error?.body);
  const nativeCode = (body.code ?? '').toLowerCase();
  const routeText = input.routeErrors
    ? Object.entries(input.routeErrors)
        .map(([route, value]) => `${route}: ${String(value)}`)
        .join(' ')
    : '';
  const message = [input.error?.message ?? '', body.message ?? '', nativeCode].join(' ');
  const haystack = `${message} ${routeText}`.toLowerCase();
  const baseEvidence = evidence({
    status: typeof input.error?.status === 'number' ? input.error.status : undefined,
    nativeCode: nativeCode || undefined,
    direct: input.routeErrors?.direct,
    tunnel: input.routeErrors?.tunnel,
    message: message.trim() || undefined,
  });

  const auth =
    input.error?.status === 401 ||
    nativeCode === 'unauthorized' ||
    nativeCode === 'timestamp_out_of_window' ||
    nativeCode === 'nonce_replayed' ||
    /\b401\b/.test(haystack) ||
    haystack.includes('unauthorized') ||
    haystack.includes('bad signature');
  if (auth) {
    return {
      code: 'khc.transport.auth_401',
      title: 'Agent 拒绝签名',
      detail: 'HMAC 校验失败（401）；请校时或重新接入节点。',
      evidence: baseEvidence,
    };
  }

  const cfMatch = /\b(1003|522|524|530)\b/.exec(haystack)?.[1] ?? null;
  const cf = cfMatch ? Number(cfMatch) : null;
  let detail = '直连与隧道均失败，无法获取节点状态。';
  let reason = 'unreachable';
  if (cf === 1003) {
    reason = 'cf_1003';
    detail = '直连被 Cloudflare 拒绝（1003）；请改用可回源地址或隧道。';
  } else if (cf === 530) {
    reason = 'cf_530';
    detail = '隧道未连通（530）；cloudflared 可能已断开。';
  } else if (cf === 522) {
    reason = 'cf_522';
    detail = 'Cloudflare 回源超时（522）；源站 8880 不可达。';
  } else if (cf === 524) {
    reason = 'cf_524';
    detail = '代理链路超时（524）；长动作可能已部分生效。';
  } else if (haystack.includes('timeout') || haystack.includes('超时') || haystack.includes('abort')) {
    reason = 'timeout';
    detail = '连接超时；Agent 可能未运行或被安全组阻断。';
  } else if (haystack.includes('tls') || haystack.includes('handshake') || haystack.includes('证书')) {
    reason = 'tls';
    detail = 'TLS 握手失败；请检查证书、端口与 SNI。';
  } else if (
    nativeCode === 'bad_agent_response' ||
    nativeCode === 'bad_response' ||
    haystack.includes('非 json') ||
    haystack.includes('non-json')
  ) {
    reason = 'bad_response';
    detail = 'Agent 返回内容不合法；端口可能被其它服务占用。';
  }
  return {
    code: 'khc.transport.unreachable',
    title: '节点不可达',
    detail,
    evidence: evidence({ ...baseEvidence, reason, cf: cf ?? undefined }),
  };
}

function offlineCheck(input: EvalInput): DiagnosticCheck | null {
  if (input.reachable) return null;
  const base = {
    id: 'agent.offline',
    code: 'khc.agent.offline',
  };
  if (input.node.lastSeenAt === null) {
    return makeCheck({
      ...base,
      severity: 'warn',
      title: '节点离线',
      detail: '控制通道不可用，且没有最近一次成功连接记录。',
    });
  }
  const idleSec = Math.max(0, input.now - input.node.lastSeenAt);
  const minutes = Math.max(1, Math.floor(idleSec / 60));
  const ev = evidence({ lastSeenAt: input.node.lastSeenAt, idleSec });
  if (idleSec > OFFLINE_ERROR_SEC) {
    return makeCheck({
      ...base,
      severity: 'error',
      title: `节点已离线 ${minutes} 分钟`,
      detail: `最后一次成功连接在 ${minutes} 分钟前，超过 10 分钟。`,
      evidence: ev,
    });
  }
  return makeCheck({
    ...base,
    severity: 'warn',
    title: `节点离线 ${minutes} 分钟`,
    detail: '控制通道不可用，但仍在 10 分钟观察窗口内。',
    evidence: ev,
  });
}

function clockCheck(input: EvalInput): DiagnosticCheck | null {
  const serverTime = input.state?.agent?.serverTime;
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return null;
  const skewSeconds = Math.round(Math.abs(input.now - serverTime));
  if (skewSeconds <= CLOCK_SKEW_SEC) return null;
  return makeCheck({
    id: 'agent.clock',
    code: 'khc.agent.clock_skew',
    severity: 'warn',
    title: `节点时钟偏差 ${skewSeconds} 秒`,
    detail: `Agent 时间与控制面相差 ${skewSeconds} 秒，会触发 HMAC 401，请校时。`,
    evidence: evidence({ serverTime, skewSeconds }),
  });
}

function versionCheck(input: EvalInput): DiagnosticCheck | null {
  const version = input.state?.agent?.version;
  if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return null;
  }
  return makeCheck({
    id: 'agent.version',
    code: 'khc.agent.version_unsupported',
    severity: 'warn',
    title: 'Agent 版本不兼容',
    detail: 'Agent 未上报可识别的版本，无法确认与当前契约兼容；请在升级页升级。',
    evidence: evidence({ version: version ?? null }),
  });
}

function stateInvalidCheck(input: EvalInput): DiagnosticCheck | null {
  const base = { id: 'agent.state_schema', code: 'khc.agent.state_invalid' };
  if (!input.state) {
    return makeCheck({
      ...base,
      severity: 'error',
      title: 'Agent 状态结构不合法',
      detail: '/state 不符合当前契约，通常是 Agent 版本不匹配。',
    });
  }
  const present = new Set(input.state.adapters.map((adapter) => adapter.name));
  const missing = input.configs.map((config) => config.app).filter((app) => !present.has(app));
  if (missing.length === 0) return null;
  const names = missing.slice(0, 3).join('、');
  return makeCheck({
    ...base,
    severity: 'error',
    title: '节点缺少适配器',
    detail: `${names} 在节点上没有适配器，无法应用配置。`,
    evidence: evidence({ missing: missing.length, apps: names }),
  });
}

function configCheck(input: EvalInput): DiagnosticCheck | null {
  const base = { id: 'config.sync', code: 'khc.config.pending_apply' };
  const failed = input.configs.filter(
    (config) =>
      config.lastApplyError &&
      typeof config.lastApplyError.code === 'string' &&
      config.lastApplyError.code.length > 0,
  );
  if (failed.length > 0) {
    const first = failed[0]!;
    const error = first.lastApplyError!;
    const names = failed
      .slice(0, 3)
      .map((config) => `${config.app}（${config.lastApplyError!.code}）`)
      .join('、');
    return makeCheck({
      ...base,
      severity: 'warn',
      title: '配置应用失败',
      detail: `${names} 上次 apply 失败：${error.message}`,
      evidence: evidence({ failed: failed.length, apps: names, errorCode: error.code }),
    });
  }

  const pending = input.configs.filter(
    (config) => config.appliedRev === null || config.appliedRev < config.rev,
  );
  if (pending.length === 0) return null;
  const oldest = pending.reduce(
    (min, config) => (config.updatedAt < min ? config.updatedAt : min),
    pending[0]!.updatedAt,
  );
  const ageSec = Math.max(0, input.now - oldest);
  const names = pending.slice(0, 3).map((config) => `${config.app} rev ${config.rev}`).join('、');
  const ev = evidence({ pending: pending.length, oldestAgeSec: ageSec, apps: names });
  if (ageSec > PENDING_STUCK_SEC) {
    return makeCheck({
      ...base,
      severity: 'warn',
      title: '配置长时间未生效',
      detail: `${names} 待生效超过 10 分钟，可能 apply 失败；请重新应用。`,
      evidence: ev,
    });
  }
  return makeCheck({
    ...base,
    severity: 'info',
    title: '配置待生效',
    detail: `${names} 尚未在节点生效，请重新应用。`,
    evidence: ev,
  });
}

// ---------------------------------------------------------------------------
// 适配器问题（通用渲染）
// ---------------------------------------------------------------------------

const APP_NAME_RE = /^[a-z][a-z0-9-]*$/;

function adapterChecks(app: string, raw: unknown, taken: Set<string>): DiagnosticCheck[] {
  if (!APP_NAME_RE.test(app) || !Array.isArray(raw)) return [];
  const checks: DiagnosticCheck[] = [];
  for (const item of raw) {
    const parsed = adapterProblemSchema.safeParse(item);
    if (!parsed.success) continue;
    const problem = parsed.data;
    const code = `khc.${app}.${problem.code}`;
    if (CORE_DIAGNOSTIC_CODES.includes(code)) continue;
    let id = `problem.${app}.${problem.code}`;
    for (let index = 2; taken.has(id); index += 1) {
      id = `problem.${app}.${problem.code}.${index}`;
    }
    taken.add(id);
    const actions: DiagnosticAction[] = problem.action
      ? [{ ...problem.action, label: problem.action.label ?? problem.title }]
      : [];
    checks.push(
      makeCheck({
        id,
        code,
        severity: problem.severity,
        title: problem.title,
        detail: problem.hint ?? problem.title,
        app,
        evidence: problem.evidence ? evidence(problem.evidence) : undefined,
        actions,
      }),
    );
  }
  return checks;
}

function collectAdapterChecks(input: EvalInput): DiagnosticCheck[] {
  const taken = new Set<string>();
  const checks: DiagnosticCheck[] = [];
  for (const adapter of input.state?.adapters ?? []) {
    const status = adapter.status;
    if (!isRecord(status)) continue;
    checks.push(...adapterChecks(adapter.name, status.problems, taken));
  }
  for (const source of input.extraProblems ?? []) {
    checks.push(...adapterChecks(source.app, source.problems, taken));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function evaluateDiagnostics(input: EvalInput): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  if (!input.reachable) {
    const transport = classifyTransport(input);
    checks.push(
      makeCheck({
        id: 'transport.reachability',
        code: transport.code,
        severity: 'error',
        title: transport.title,
        detail: transport.detail,
        evidence: transport.evidence,
      }),
    );
    const offline = offlineCheck(input);
    if (offline) checks.push(offline);
  } else {
    if (input.error?.stateInvalid || !input.state) {
      const invalid = stateInvalidCheck(input);
      if (invalid) checks.push(invalid);
    } else {
      for (const check of [
        clockCheck(input),
        versionCheck(input),
        stateInvalidCheck(input),
      ]) {
        if (check) checks.push(check);
      }
    }
  }
  const config = configCheck(input);
  if (config) checks.push(config);
  checks.push(...collectAdapterChecks(input));
  return checks;
}

/** 兼容别名（部分调用方把它叫 evaluateChecks）。 */
export const evaluateChecks = evaluateDiagnostics;

// ---------------------------------------------------------------------------
// 排序 / 截断（§4.2 输出规则）
// ---------------------------------------------------------------------------

export function sortChecks(checks: DiagnosticCheck[]): DiagnosticCheck[] {
  return [...checks].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}

export interface FinalizedChecks {
  checks: DiagnosticCheck[];
  truncated: boolean;
}

/** 按严重度排序；总数最多 30 条。 */
export function finalizeChecks(checks: DiagnosticCheck[]): FinalizedChecks {
  const sorted = sortChecks(checks);
  return {
    checks: sorted.slice(0, MAX_CHECK_COUNT),
    truncated: sorted.length > MAX_CHECK_COUNT,
  };
}
