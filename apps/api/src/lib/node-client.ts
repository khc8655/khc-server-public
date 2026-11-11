import type { PreferredRoute } from '@khc/contracts';
import { AppError } from './errors';
import { chooseTransport, tcpFetch, TcpTimeoutError, type TcpFetchInit } from './tcp-fetch';
// 版本协商（ADR-0013 兼容矩阵）：面板版本随每个请求下发，Agent 据此判断面板是否过旧。
import { APP_VERSION } from '../version';

/** Agent 的最小节点视图（不包含 token 密文） */
export interface AgentNode {
  id: string;
  endpoint: string;
  tunnelEndpoint: string | null;
  preferredRoute: PreferredRoute;
}

export interface AgentCallOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
  /** 诊断/连接检查用：跳过失败冷却，总是真实探测 */
  bypassCooldown?: boolean;
}

export interface AgentResponse {
  status: number;
  body: unknown;
  route: PreferredRoute;
  /** 实际使用的传输：域名走 fetch，裸 IP/非标端口走 TCP socket */
  via: 'fetch' | 'tcp';
}

export interface AgentClient {
  call(
    node: AgentNode,
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts?: AgentCallOptions,
  ): Promise<AgentResponse>;
}

export class HubUnreachableError extends AppError {
  constructor(
    message: string,
    readonly routeErrors: Record<string, string>,
    /** R-3：失败原因含传输超时（请求可能已送达 Agent，幂等键去重下重试安全） */
    readonly timedOut = false,
  ) {
    super(502, 'hub_unreachable', message);
  }
}

/** 把各条路由的错误拼成一句话，便于面板展示 */
export function formatRouteErrors(error: HubUnreachableError): string {
  const detail = Object.entries(error.routeErrors)
    .map(([route, message]) => `${route}: ${message}`)
    .join('；');
  return detail ? `${error.message}（${detail}）` : error.message;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type TcpFetchLike = (url: string, init?: TcpFetchInit) => Promise<Response>;

interface RouteTarget {
  route: PreferredRoute;
  base: string;
}

/**
 * §3.8：三种接入方案（A 可信证书直连 / B Cloudflare Tunnel / C 自签）为并列方案，
 * 节点创建/配置时经 preferred_route 选定其一，运行时只走该方案。
 * 这里只返回选定方案对应的单一目标：无主备、无跨方案回退、不自动改写 preferred_route。
 */
function orderedRoutes(node: AgentNode): RouteTarget[] {
  if (node.preferredRoute === 'tunnel') {
    return node.tunnelEndpoint
      ? [{ route: 'tunnel', base: node.tunnelEndpoint }]
      : [];
  }
  return [{ route: 'direct', base: node.endpoint }];
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

async function hmacHex(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

/**
 * 生成 HMAC 头：X-Khc-Ts / X-Khc-Nonce / X-Khc-Sig
 *
 * 额外带 ``X-Khc-Panel-Version``：**不参与签名**（签名串固定为
 * ``method|path|ts|nonce|bodyHash``，与 Agent 端契约一致），仅用于版本协商——
 * Agent 校验它是否 >= 自己的 ``MIN_PANEL_VERSION``，不满足返回 426 ``panel_too_old``。
 */
export async function signAgentRequest(
  token: string,
  method: string,
  path: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce();
  const bodyHash = await sha256Hex(bodyText);
  const canonical = `${method.toUpperCase()}|${path}|${ts}|${nonce}|${bodyHash}`;
  const signature = await hmacHex(token, canonical);
  return {
    'x-khc-ts': ts,
    'x-khc-nonce': nonce,
    'x-khc-sig': signature,
    'x-khc-panel-version': APP_VERSION,
    'content-type': 'application/json',
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** 单条路由内 fetch 阶段的超时上限：失败后要给 TCP 回退留出剩余预算 */
const FETCH_TIMEOUT_CAP_MS = 6_000;
/** TCP 回退阶段的超时下限：预算耗尽时也保底给一次短探测 */
const TCP_TIMEOUT_FLOOR_MS = 1_000;

/**
 * 通道/网络错误的人话描述：自签/无效证书与普通网络不可达区分开，
 * 面板据此给出"改用 HTTP 直连或安装受信证书"的可操作提示。
 */
export function describeChannelError(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw);
  if (/cert|tls|ssl|self[- ]?signed/i.test(message)) {
    return `证书校验失败（节点可能使用自签名证书；控制面无法校验其 HTTPS 证书，请改用 HTTP 直连地址或为节点安装受信证书）: ${message}`;
  }
  return message;
}

/**
 * R-1：合法 Agent 错误信封判定——响应体是 JSON 且 error.code 为非空字符串。
 * Agent 业务 5xx（apply_failed/adapter_error 等）长这样；代理/网关的错误页
 * （HTML、空 body）不长这样，仅后者才值得换路由重试。
 */
function hasAgentErrorCode(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0;
}

/**
 * fetch 命中 Cloudflare 边缘拦截（403 error 1003）时值得改走 TCP 重试同一路由。
 * 但 Agent 自身的 403（鉴权失败 / nonce 重放）也是 403：它是合法错误信封，
 * 换 TCP 重发既会掩盖真实原因，又可能对写动作重复执行。故只有"403 且响应体
 * 不是合法 Agent 错误信封"才算边缘拦截。
 */
async function isEdgeBlock(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const text = await response.clone().text();
    return !hasAgentErrorCode(text ? JSON.parse(text) : null);
  } catch {
    // 非 JSON（CF 错误页 / 空 body）按边缘拦截处理，保留原有回退行为
    return true;
  }
}

/** R-3：单条路由内全部传输尝试都失败（无任何响应）时抛出，携带超时标记 */
class RouteAttemptError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

/**
 * R-3：判断单次传输失败是否为超时。超时意味着请求可能已送达 Agent
 * （写动作已开始执行），上层用同一幂等键重试是安全的。
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof TcpTimeoutError) return true;
  // fetch 的 AbortSignal.timeout 超时抛 DOMException，name 为 TimeoutError
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * §3.8：按 preferred_route 选定的单一接入方案发起请求；该方案内 fetch 失败
 * （弱网/边缘 403 拦截）时用 TCP socket 回退重试同一 URL——这是单方案内的
 * 双传输通道，不是跨方案回退。失败即返回明确错误，不切换其他方案。
 */
export class HttpAgentClient implements AgentClient {
  private readonly fetchImpl: FetchLike;
  /**
   * 节点失败冷却（走查 T1 降级上限）：选定方案连接失败后，冷却期内
   * 后续 call 快速失败，避免彻底不可达时每次都等满预算拖慢面板；
   * 成功一次即清除。诊断探测用 bypassCooldown 跳过。
   */
  private readonly cooldown = new Map<string, number>();

  constructor(
    fetchImpl?: FetchLike,
    private readonly tcpFetchImpl: TcpFetchLike = tcpFetch,
    private readonly cooldownMs = 30_000,
  ) {
    // Cloudflare Workers 的 fetch 必须绑定到 globalThis：作为实例方法调用会 Illegal invocation
    const baseFetch = fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => baseFetch(input, init);
  }

  private async attempt(
    url: string,
    token: string,
    method: 'GET' | 'POST',
    path: string,
    bodyText: string,
    body: unknown,
    opts: AgentCallOptions,
  ): Promise<{ response: Response; via: 'fetch' | 'tcp'; errors: string[]; timedOut: boolean }> {
    // F-M1：每次传输尝试独立签名。fetch 超时/失败后请求可能已送达 Agent，
    // nonce 已被防重放缓存消耗；TCP 回退若复用同一签名头会被 Agent 401
    // （nonce_replayed）拒绝。幂等键跨尝试保留：写动作由 Agent 侧去重兜底。
    const signFresh = async (): Promise<Record<string, string>> => {
      const headers = await signAgentRequest(token, method, path, bodyText);
      return {
        ...headers,
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      };
    };
    const via = chooseTransport(url);
    const routeErrors: string[] = [];
    let routeTimedOut = false;
    let response: Response | null = null;
    let usedVia: 'fetch' | 'tcp' = via;

    // 超时预算：单条路由总预算 = timeoutMs（默认 10s），fetch 上限 6s，
    // TCP 回退只拿剩余预算（下限 1s）——预算不叠加，整路由耗时可控。
    const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    if (via === 'fetch') {
      try {
        const fetched = await this.fetchImpl(url, {
          method,
          headers: await signFresh(),
          body: body === undefined ? undefined : bodyText,
          signal: AbortSignal.timeout(Math.min(budget, FETCH_TIMEOUT_CAP_MS)),
        });
        if (await isEdgeBlock(fetched)) {
          // 403 且非 Agent 信封：多为 Cloudflare 边缘拦截（error 1003 等），
          // 不代表 Agent 本意；改走 TCP 重试同一路由（T1）。
          routeErrors.push(`fetch: HTTP ${fetched.status}`);
        } else {
          response = fetched;
        }
      } catch (error) {
        // 弱网/连接失败：路由内回退 TCP（T1）
        routeTimedOut ||= isTimeoutError(error);
        routeErrors.push(`fetch: ${describeChannelError(error)}`);
      }
      if (response === null) {
        const remaining = Math.max(TCP_TIMEOUT_FLOOR_MS, budget - (Date.now() - startedAt));
        try {
          response = await this.tcpFetchImpl(url, {
            method,
            // F-M1：重新生成 nonce/ts 并重签，不复用 fetch 已发出的签名材料
            headers: await signFresh(),
            body: body === undefined ? undefined : bodyText,
            timeoutMs: remaining,
          });
          usedVia = 'tcp';
        } catch (error) {
          routeTimedOut ||= isTimeoutError(error);
          routeErrors.push(`tcp: ${describeChannelError(error)}`);
        }
      }
    } else {
      try {
        response = await this.tcpFetchImpl(url, {
          method,
          headers: await signFresh(),
          body: body === undefined ? undefined : bodyText,
          timeoutMs: budget,
        });
      } catch (error) {
        routeTimedOut ||= isTimeoutError(error);
        routeErrors.push(`tcp: ${describeChannelError(error)}`);
      }
    }
    if (response === null) {
      throw new RouteAttemptError(routeErrors.join('；') || '路由失败', routeTimedOut);
    }
    return { response, via: usedVia, errors: routeErrors, timedOut: routeTimedOut };
  }

  async call(
    node: AgentNode,
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: AgentCallOptions = {},
  ): Promise<AgentResponse> {
    const cooldownUntil = this.cooldown.get(node.id) ?? 0;
    const now = Date.now();
    if (!opts.bypassCooldown && now < cooldownUntil) {
      throw new HubUnreachableError('Hub 不可达（连续失败后冷却中，稍后自动重试）', {
        cooldown: `距下次自动探测还有 ${Math.ceil((cooldownUntil - now) / 1000)} 秒`,
      });
    }
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const [target] = orderedRoutes(node);
    // §3.8：选定 tunnel 却未配置隧道地址属配置缺失，明确报错，不悄悄降级到直连
    if (!target) {
      throw new HubUnreachableError('Hub 不可达（选定接入方案未配置连接地址）', {
        [node.preferredRoute]: '缺少对应的连接地址，请在节点配置中补全',
      });
    }
    const url = `${target.base.replace(/\/+$/, '')}${path}`;
    const errors: Record<string, string> = {};
    let via: 'fetch' | 'tcp';
    let response: Response;
    try {
      const attempt = await this.attempt(url, token, method, path, bodyText, body, opts);
      via = attempt.via;
      response = attempt.response;
      if (attempt.errors.length > 0) {
        errors[target.route] = attempt.errors.join('；');
        // 可观测：方案内 fetch→TCP 回退成功也要能看出实际走了哪条通道（tail 日志）
        console.info('[agent] 通道回退', {
          node: node.id,
          route: target.route,
          via,
          reasons: attempt.errors,
        });
      }
    } catch (error) {
      errors[target.route] = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof RouteAttemptError ? error.timedOut : false;
      this.cooldown.set(node.id, Date.now() + this.cooldownMs);
      throw new HubUnreachableError('Hub 不可达（按选定方案接入失败）', errors, timedOut);
    }
    const text = await response.text();
    let parsed: unknown;
    let agentEnvelope = false;
    try {
      parsed = text ? JSON.parse(text) : {};
      agentEnvelope = hasAgentErrorCode(parsed);
    } catch {
      console.warn(
        '[agent] non-json response',
        url,
        response.status,
        response.headers.get('content-type'),
        response.headers.get('server'),
        text.slice(0, 240),
      );
      parsed = {
        ok: false,
        error: { code: 'bad_agent_response', message: 'Agent 返回了非 JSON 内容' },
      };
      // 合成的兜底信封不算 Agent 应答：5xx + 非 JSON（代理错误页）视为该方案失败
      agentEnvelope = false;
    }
    // R-1：5xx 且响应体不是合法 Agent 信封（代理/网关错误页）说明该方案未触达节点，
    // 明确报错；5xx 信封携带 error.code 是节点可达的证明，按普通响应原样返回，
    // 交由上层（routes/apps.ts 的 5xx 分支）转成用户可读的失败原因。
    if (response.status >= 500 && !agentEnvelope) {
      errors[target.route] = `HTTP ${response.status}`;
      this.cooldown.set(node.id, Date.now() + this.cooldownMs);
      throw new HubUnreachableError('Hub 不可达（按选定方案接入失败）', errors);
    }
    // 版本协商失败（Agent 要求更高的面板版本）：把信封 message 改写成可操作提示，
    // 所有透传 error.message 的调用点（/state、/snapshot）就能直接显示"该升哪一端"。
    if (response.status === 426 && agentEnvelope) {
      const envelope = parsed as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      if (envelope.error?.code === 'panel_too_old') {
        const details = envelope.error.details ?? {};
        const minPanel = typeof details.minPanelVersion === 'string' ? details.minPanelVersion : '未知';
        const agentVersion = typeof details.agentVersion === 'string' ? details.agentVersion : '未知';
        envelope.error.message =
          `节点 Agent ${agentVersion} 要求面板 ≥ ${minPanel}，当前面板 ${APP_VERSION}；` +
          '请先升级面板（Agent 已拒绝本请求，未执行任何动作）';
      }
    }
    // 能拿到 Agent 应答（含 4xx）即证明节点可达：清除失败冷却
    this.cooldown.delete(node.id);
    return { status: response.status, body: parsed, route: target.route, via };
  }
}
