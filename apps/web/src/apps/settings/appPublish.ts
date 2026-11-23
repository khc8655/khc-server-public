/**
 * 应用目录「安装后发布」的计划推导。
 *
 * 清单里的 `publish` 只声明「哪个本机端口要发出去」；域名来自节点、发布端口来自用户选择。
 * 这里把三方拼成一个可直接交给 `publishProxySite` 的计划，并给出不可发布的原因，
 * 免得 UI 各写一套判断，出现「按钮能点但必然失败」。
 */
import {
  toManifestV2,
  type AppManifestAnyDefinition,
  type Node,
} from '@khc/contracts';
import { buildDomainEndpoint, parseDomainEndpoint } from '../../data/endpoint';

export interface AppPublishPlan {
  domain: string;
  /** Agent 监听端口：与发布端口相同就不能发布（一条端口只能一个进程） */
  agentPort: number;
  publishPort: number;
  /** 反代目标 `host:port` */
  upstream: string;
}

/** 不能发布的原因；`null` 表示计划可用。 */
export type AppPublishIssue = 'no-publish' | 'no-port' | 'no-domain' | 'port-conflict';

export interface AppPublishResult {
  plan: AppPublishPlan | null;
  issue: AppPublishIssue | null;
  /** 无论能否发布都给出这两项，便于 UI 说明「卡在哪」 */
  domain: string;
  agentPort: number;
  upstream: string | null;
}

/** 节点的发布域名：优先落库的 domain，其次从域名入口地址里取。 */
export function nodePublishDomain(node: Node | undefined): string {
  const domain = (node?.domain ?? '').trim();
  if (domain) return domain;
  return node?.endpoint ? (parseDomainEndpoint(node.endpoint)?.domain ?? '') : '';
}

/** 节点入口的实际端口（Agent 占着的那条），Caddy 不能再用同一条。 */
export function nodeAgentPort(node: Node | undefined): number {
  if (!node?.endpoint) return 0;
  try {
    const url = new URL(node.endpoint);
    if (url.port) {
      const port = Number(url.port);
      return Number.isInteger(port) ? port : 0;
    }
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

/** 清单声明要发布的本机端口 → `host:port`；参数缺失或非法返回 null。 */
export function appPublishUpstream(
  manifest: AppManifestAnyDefinition,
  values: Record<string, unknown>,
): string | null {
  const v2 = toManifestV2(manifest);
  const endpoint = v2.endpoints?.find((ep) => ep.publish === 'caddy') ?? v2.endpoints?.[0];
  if (!endpoint) return null;
  const raw = endpoint.portParam ? values[endpoint.portParam] : endpoint.port;
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const legacyHost = 'publish' in manifest ? manifest.publish?.host?.trim() : undefined;
  const host = legacyHost || (endpoint.bind === 'any' ? '0.0.0.0' : '127.0.0.1');
  return `${host}:${port}`;
}

export function deriveAppPublishPlan(args: {
  manifest: AppManifestAnyDefinition;
  node: Node | undefined;
  values: Record<string, unknown>;
  publishPort: number;
}): AppPublishResult {
  const { manifest, node, values, publishPort } = args;
  const v2 = toManifestV2(manifest);
  const endpoint = v2.endpoints?.find((ep) => ep.publish === 'caddy') ?? v2.endpoints?.[0];
  const domain = nodePublishDomain(node);
  const agentPort = nodeAgentPort(node);
  const upstream = appPublishUpstream(manifest, values);
  const base = { domain, agentPort, upstream };
  if (!endpoint) return { plan: null, issue: 'no-publish', ...base };
  if (!upstream) return { plan: null, issue: 'no-port', ...base };
  if (!domain) return { plan: null, issue: 'no-domain', ...base };
  const port = Number.isInteger(publishPort) && publishPort > 0 && publishPort < 65536 ? publishPort : 0;
  if (!port || port === agentPort) return { plan: null, issue: 'port-conflict', ...base };
  return { plan: { domain, agentPort, publishPort: port, upstream }, issue: null, ...base };
}

/** 对外访问地址（443 省略端口）。 */
export function appPublishUrl(plan: Pick<AppPublishPlan, 'domain' | 'publishPort'>): string {
  return buildDomainEndpoint(plan.domain, String(plan.publishPort));
}

/** 一句话说明「发到哪里 → 转到哪里」。 */
export function appPublishTarget(plan: AppPublishPlan): string {
  return `${appPublishUrl(plan)} → ${plan.upstream}`;
}
