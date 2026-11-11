import type { Node } from '@khc/contracts';
import type { AppDeps, Env } from '../types';
import type { StoredNode } from '../domain/repos';
import { decryptSecret } from '../lib/crypto';
import { misconfigured, notFound } from '../lib/errors';
import { nowSec } from '../lib/ids';

/** 校验节点存在，返回内部记录（含 token 密文） */
export async function requireNode(deps: AppDeps, nodeId: string): Promise<StoredNode> {
  const node = await deps.nodes.get(nodeId);
  if (!node) throw notFound('节点不存在');
  return node;
}

const ONLINE_WINDOW_SEC = 300;

/**
 * 浏览器直连观测入口，优先级：
 * 1. 显式配置的 liveEndpoint；
 * 2. 控制通道本身是 HTTPS（Agent 自己监听 TLS）→ 同源同端口。Agent 在主端口提供
 *    `/_live/snapshot`，无需 Caddy，也不会再把 9443 之类的非标端口错推成 443；
 * 3. 兼容旧部署：绑定了域名且入口是明文 → `https://<域名>`（Caddy 443 的 /_live 反代）；
 * 4. 否则 null（走 Worker 转发快照）。
 */
export function deriveLiveEndpoint(
  node: Pick<StoredNode, 'liveEndpoint' | 'endpoint' | 'domain'>,
): string | null {
  if (node.liveEndpoint) return node.liveEndpoint;
  try {
    const url = new URL(node.endpoint);
    if (url.protocol === 'https:') return url.origin;
  } catch {
    // endpoint 非法时退回下面的域名推导
  }
  return node.domain ? `https://${node.domain}` : null;
}

/**
 * 列表里的 status 只表达「最近一次成功探测」的结果：
 * - online：窗口内有人成功拉过 /state（lastSeen 新鲜）
 * - unknown：从未探测过，或最后一次成功探测已超出窗口（老租约≠离线）
 * - offline 不由列表推断：只有前端实际探测失败才有负向证据。
 *
 * UI 口径（2026-11-07 起，见 apps/web/src/data/useHubProbe.ts）：`unknown` 不再直接显示，
 * 前端一打开页面就批量探测，未出结论时显示「探测中…」；只有探测请求整体失败才显示「未知」。
 * 因此这里的 unknown 只是数据事实，不代表用户会看到"未探测"这类状态。
 */
export function toPublicNode(node: StoredNode, now = nowSec()): Node {
  const status =
    node.lastSeenAt === null || now - node.lastSeenAt > ONLINE_WINDOW_SEC
      ? 'unknown'
      : 'online';
  return {
    id: node.id,
    name: node.name,
    endpoint: node.endpoint,
    tunnelEndpoint: node.tunnelEndpoint,
    liveEndpoint: deriveLiveEndpoint(node),
    domain: node.domain,
    accessMode: node.accessMode,
    tunnelId: node.tunnelId,
    allowInsecure: node.allowInsecure,
    preferredRoute: node.preferredRoute,
    status,
    lastSeenAt: node.lastSeenAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export async function nodeToken(env: Env, node: StoredNode): Promise<string> {
  if (!env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
  return decryptSecret(env.MASTER_ENC_KEY, node.tokenEnc, {
    previousKey: env.MASTER_ENC_KEY_PREVIOUS,
  });
}
