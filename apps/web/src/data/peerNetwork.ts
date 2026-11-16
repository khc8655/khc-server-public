/**
 * Peer 网络策略的规范化与派生（2026-11-16 U3）。
 *
 * 这份逻辑刻意做成纯函数，因为它是「存量 Peer 不能被掐断」这条硬约束的唯一守门人：
 * 只要规范化写错，升级后所有老 Peer 会突然互不可达，而这种故障在生产上极难第一时间归因。
 *
 * 两处必须同源：
 * - 前端：抽屉展示、确认框文案、保存前校验
 * - Agent：`wireguard.py` 渲染 FORWARD 规则与客户端 AllowedIPs
 *
 * 字段缺省的语义（N-6）：
 * - `reach` 缺省 → `all`（老 Peer 本来全体互通，不能因为新字段缺失就隔离）
 * - `egress` 缺省 → `internal`（老 Peer 出网本来就不走 Hub）
 */
import type { WgPeer, WgPeerEgress, WgPeerReach } from './wireguard';

export interface PeerNetworkPolicy {
  reach: WgPeerReach;
  reachPeers: string[];
  egress: WgPeerEgress;
}

/** 新建 Peer 的默认策略：只与 Hub 通，出网保持原状。 */
export const DEFAULT_NEW_PEER_POLICY: PeerNetworkPolicy = {
  reach: 'hub',
  reachPeers: [],
  egress: 'internal',
};

/**
 * 存量 Peer 的兼容策略：全体互通、出网保持原状（N-6）。
 *
 * **不要用它给新建 Peer 设默认值** —— 新建用 `DEFAULT_NEW_PEER_POLICY`。
 */
export const LEGACY_PEER_POLICY: PeerNetworkPolicy = {
  reach: 'all',
  reachPeers: [],
  egress: 'internal',
};

function normalizeReach(value: unknown): WgPeerReach {
  return value === 'hub' || value === 'peers' || value === 'all' ? value : 'all';
}

function normalizeEgress(value: unknown): WgPeerEgress {
  return value === 'all' ? 'all' : 'internal';
}

/**
 * 把任意来源的 Peer 配置折成确定的策略。
 *
 * 缺省/非法值一律落到「最保守但不断连」的存量语义（reach=all / egress=internal）——
 * 宁可多通，也不要在升级瞬间把用户的网络掐断。
 */
export function resolvePeerPolicy(peer: Partial<WgPeer> | null | undefined): PeerNetworkPolicy {
  const reach = normalizeReach(peer?.reach);
  const reachPeers = Array.isArray(peer?.reachPeers)
    ? peer!.reachPeers!.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return {
    reach,
    // reach !== 'peers' 时清空，避免脏数据在切换可达范围后残留
    reachPeers: reach === 'peers' ? reachPeers : [],
    egress: normalizeEgress(peer?.egress),
  };
}

/**
 * 两个 Peer 之间是否允许互通（双向）。
 *
 * 规则：任意一侧声明「全部 Peer」就算通；任意一侧声明「仅 Hub」就不通；
 * 指定互通要求**双方都在对方的名单里**才成立 —— 单向放行会让用户以为已经隔离，
 * 实际还能被对端主动连进来，属于安全假象。
 */
export function peersMayCommunicate(
  a: Partial<WgPeer> | null | undefined,
  b: Partial<WgPeer> | null | undefined,
): boolean {
  if (!a || !b) return false;
  const nameA = typeof a.name === 'string' ? a.name : '';
  const nameB = typeof b.name === 'string' ? b.name : '';
  if (!nameA || !nameB || nameA === nameB) return false;

  const pa = resolvePeerPolicy(a);
  const pb = resolvePeerPolicy(b);
  if (pa.reach === 'hub' || pb.reach === 'hub') return false;
  if (pa.reach === 'all' || pb.reach === 'all') return true;
  // 双方都是 peers 模式：必须互相点名
  return pa.reachPeers.includes(nameB) && pb.reachPeers.includes(nameA);
}

/**
 * 客户端 `AllowedIPs` 该写什么（决定 Peer 侧往隧道里送哪些网段）。
 *
 * 注意这里只描述**路由**，服务端还会用 FORWARD 规则兜底 —— 两者都要对，
 * 单靠客户端配置等于没有策略（用户可以自己改）。
 */
export function clientAllowedIps(
  policy: PeerNetworkPolicy,
  options: { hubCidr: string; peerCidrs?: string[]; allPeerCidr?: string },
): string[] {
  if (policy.egress === 'all') {
    // 全部流量走 Hub。真实配置还要额外写 endpoint 的 /32（见 U3 实测的自环问题），
    // 那一部分由 Agent 侧的配置生成负责，这里只表达「路由范围」。
    return ['0.0.0.0/0', '::/0'];
  }
  if (policy.reach === 'all') {
    // 整网段已经包含 Hub 的地址，**不要再额外写 Hub /32**：
    // 存量 Peer 解析后就是 all，多写一条会让老客户端的 AllowedIPs
    // 从「10.98.0.0/24」变成「10.98.0.1/32, 10.98.0.0/24」，违反 N-6「存量行为不变」。
    return options.allPeerCidr ? [options.allPeerCidr] : [options.hubCidr];
  }
  const result = [options.hubCidr];
  if (policy.reach === 'peers') {
    for (const cidr of options.peerCidrs ?? []) {
      if (!result.includes(cidr)) result.push(cidr);
    }
  }
  return dedupe(result);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim() !== '')));
}

/** 可达范围的中文短标签（页面与确认框共用，避免两处文案漂移）。 */
export function reachLabel(policy: PeerNetworkPolicy): string {
  if (policy.reach === 'hub') return '仅 Hub';
  if (policy.reach === 'all') return 'Hub + 所有 Peer';
  const count = policy.reachPeers.length;
  return count > 0 ? `Hub + ${count} 个指定 Peer` : 'Hub + 指定 Peer（未选择）';
}

/** 出网方式的中文短标签。 */
export function egressLabel(egress: WgPeerEgress): string {
  return egress === 'all' ? '全部流量走 Hub' : '仅内网流量走 Hub';
}
