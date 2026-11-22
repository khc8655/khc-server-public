import type { Node } from '@khc/contracts';
import type { AppDeps, Env } from '../types';
import type { NodeRepo, StoredNode } from '../domain/repos';
import { decryptSecret } from '../lib/crypto';
import { misconfigured, notFound } from '../lib/errors';
import { nowSec } from '../lib/ids';

const NODE_CACHE_TTL_MS = 15_000;

interface NodeCacheEntry {
  node: StoredNode;
  at: number;
}

const nodeReadCache = new WeakMap<NodeRepo, Map<string, NodeCacheEntry>>();

/** 校验节点存在，返回内部记录（含 token 密文） */
export async function requireNode(deps: AppDeps, nodeId: string): Promise<StoredNode> {
  const node = await deps.nodes.get(nodeId);
  if (!node) throw notFound('节点不存在');
  return node;
}

/**
 * 只读路由（/snapshot、/state、/overview）使用的 isolate 内 15s 节点读取缓存。
 * 写路由与动作路由仍走 requireNode 直读主库，避免写路径用到旧 endpoint。
 */
export async function getNodeCached(deps: AppDeps, nodeId: string): Promise<StoredNode> {
  const now = Date.now();
  let map = nodeReadCache.get(deps.nodes);
  if (!map) {
    map = new Map();
    nodeReadCache.set(deps.nodes, map);
  }
  const cached = map.get(nodeId);
  if (cached && now - cached.at < NODE_CACHE_TTL_MS) {
    return cached.node;
  }
  const node = await requireNode(deps, nodeId);
  map.set(nodeId, { node, at: now });
  return node;
}

/** 节点字段/地址变更后清掉本 isolate 缓存，保证同 isolate 紧邻只读立即见新值。 */
export function forgetNode(deps: AppDeps, nodeId: string): void {
  nodeReadCache.get(deps.nodes)?.delete(nodeId);
}

/** 批量探活写回 lastSeenAt 后同步更新缓存对象，确保 60s 节流判断读取一致字段。 */
export function touchNodeLastSeen(deps: AppDeps, nodeId: string, seenAt: number): void {
  const cached = nodeReadCache.get(deps.nodes)?.get(nodeId);
  if (cached) cached.node.lastSeenAt = seenAt;
}

const ONLINE_WINDOW_SEC = 300;

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
    liveEndpoint: null,
    domain: node.domain,
    accessMode: node.accessMode,
    tunnelId: node.tunnelId,
    allowInsecure: node.allowInsecure,
    preferredRoute: node.preferredRoute,
    status,
    expiresAt: node.expiresAt,
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
