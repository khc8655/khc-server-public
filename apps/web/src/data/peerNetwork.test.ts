/**
 * Peer 网络策略规范化（2026-11-16 U3）。
 *
 * 最重要的回归目标：**存量 Peer 升级后不能被掐断**。老配置里没有 reach/egress 字段，
 * 一旦被当成「默认仅 Hub」，升级瞬间所有 Peer 之间的连通性就没了。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEW_PEER_POLICY,
  LEGACY_PEER_POLICY,
  clientAllowedIps,
  egressLabel,
  peersMayCommunicate,
  reachLabel,
  resolvePeerPolicy,
} from './peerNetwork';

describe('resolvePeerPolicy 缺省语义（N-6）', () => {
  it('字段全缺省的存量 Peer 按 reach=all / egress=internal 处理', () => {
    const policy = resolvePeerPolicy({ name: 'old' });
    expect(policy).toEqual({ reach: 'all', reachPeers: [], egress: 'internal' });
    expect(policy).toEqual(LEGACY_PEER_POLICY);
  });

  it('非法值一律退回存量语义（宁可多通，不要在升级瞬间断连）', () => {
    const policy = resolvePeerPolicy({ name: 'x', reach: 'nope' as never, egress: 'weird' as never });
    expect(policy.reach).toBe('all');
    expect(policy.egress).toBe('internal');
  });

  it('新建默认值必须是「仅 Hub」，且与存量默认值不同', () => {
    expect(DEFAULT_NEW_PEER_POLICY.reach).toBe('hub');
    expect(DEFAULT_NEW_PEER_POLICY.egress).toBe('internal');
    expect(DEFAULT_NEW_PEER_POLICY).not.toEqual(LEGACY_PEER_POLICY);
  });

  it('reach 不是 peers 时清空 reachPeers（防止脏数据残留）', () => {
    const policy = resolvePeerPolicy({ name: 'a', reach: 'hub', reachPeers: ['b'] });
    expect(policy.reachPeers).toEqual([]);
  });

  it('peers 模式下过滤空串，保留有效名字', () => {
    const policy = resolvePeerPolicy({ name: 'a', reach: 'peers', reachPeers: ['b', '', '  ', 'c'] });
    expect(policy.reachPeers).toEqual(['b', 'c']);
  });
});

describe('peersMayCommunicate', () => {
  it('两个新建 Peer（默认仅 Hub）之间不通', () => {
    const a = { name: 'a', ...DEFAULT_NEW_PEER_POLICY };
    const b = { name: 'b', ...DEFAULT_NEW_PEER_POLICY };
    expect(peersMayCommunicate(a, b)).toBe(false);
  });

  it('存量 all 与存量 all 之间通（升级后老网络不变）', () => {
    const legacyA = { name: 'legacy-a' }; // 缺字段 = all
    const legacyB = { name: 'legacy-b' };
    expect(peersMayCommunicate(legacyA, legacyB)).toBe(true);
  });

  it('存量 all 连不进「仅 Hub」的新 Peer（隔离是单向生效的）', () => {
    // 这条是有意的：新 Peer 选了「仅 Hub」就该真的只连 Hub，
    // 不能因为对面是老 Peer 就被动暴露。不想要隔离的老 Peer 也会被标成 all。
    const legacy = { name: 'legacy' };
    const fresh = { name: 'fresh', ...DEFAULT_NEW_PEER_POLICY };
    expect(peersMayCommunicate(legacy, fresh)).toBe(false);
    expect(peersMayCommunicate(fresh, legacy)).toBe(false);
  });

  it('指定互通必须双方互相点名（单向不算通）', () => {
    const a = { name: 'a', reach: 'peers' as const, reachPeers: ['b'] };
    const b = { name: 'b', reach: 'peers' as const, reachPeers: ['a'] };
    expect(peersMayCommunicate(a, b)).toBe(true);

    const onlyOneWay = { name: 'b', reach: 'peers' as const, reachPeers: [] };
    expect(peersMayCommunicate(a, onlyOneWay)).toBe(false);
  });

  it('pointing 到不存在的名字不算通', () => {
    const a = { name: 'a', reach: 'peers' as const, reachPeers: ['ghost'] };
    const b = { name: 'b', reach: 'peers' as const, reachPeers: ['a'] };
    expect(peersMayCommunicate(a, b)).toBe(false);
  });

  it('自己与自己不比', () => {
    expect(peersMayCommunicate({ name: 'a' }, { name: 'a' })).toBe(false);
  });

  it('一侧是 hub 模式时即使另一侧是 all 也不通', () => {
    const hubOnly = { name: 'a', reach: 'hub' as const };
    const all = { name: 'b', reach: 'all' as const };
    expect(peersMayCommunicate(hubOnly, all)).toBe(false);
  });
});

describe('clientAllowedIps', () => {
  const hub = '10.98.0.1/32';

  it('仅 Hub：只给 Hub 的 /32', () => {
    const ips = clientAllowedIps({ reach: 'hub', reachPeers: [], egress: 'internal' }, { hubCidr: hub });
    expect(ips).toEqual([hub]);
  });

  it('指定 Peer：Hub /32 + 对方 /32', () => {
    const ips = clientAllowedIps(
      { reach: 'peers', reachPeers: ['b'], egress: 'internal' },
      { hubCidr: hub, peerCidrs: ['10.98.0.2/32'] },
    );
    expect(ips).toEqual([hub, '10.98.0.2/32']);
  });

  it('所有 Peer：只给整个网段（它已包含 Hub，不要多写 /32，否则存量配置会变）', () => {
    const ips = clientAllowedIps(
      { reach: 'all', reachPeers: [], egress: 'internal' },
      { hubCidr: hub, allPeerCidr: '10.98.0.0/24' },
    );
    expect(ips).toEqual(['10.98.0.0/24']);
    // 守门：存量 Peer 解析后就是 all，其 AllowedIPs 必须与升级前完全一致
    expect(ips).not.toContain(hub);
  });

  it('全部流量走 Hub：0.0.0.0/0 与 ::/0', () => {
    const ips = clientAllowedIps(
      { reach: 'hub', reachPeers: [], egress: 'all' },
      { hubCidr: hub },
    );
    expect(ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('egress=all 时不重复叠加 Hub /32', () => {
    const ips = clientAllowedIps(
      { reach: 'all', reachPeers: [], egress: 'all' },
      { hubCidr: hub, allPeerCidr: '10.98.0.0/24' },
    );
    expect(ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('去重且过滤空值', () => {
    const ips = clientAllowedIps(
      { reach: 'peers', reachPeers: ['b', 'c'], egress: 'internal' },
      { hubCidr: hub, peerCidrs: ['10.98.0.2/32', '10.98.0.2/32', ''] },
    );
    expect(ips).toEqual([hub, '10.98.0.2/32']);
  });
});

describe('标签文案（页面与确认框同源）', () => {
  it('可达范围短标签', () => {
    expect(reachLabel({ reach: 'hub', reachPeers: [], egress: 'internal' })).toBe('仅 Hub');
    expect(reachLabel({ reach: 'all', reachPeers: [], egress: 'internal' })).toBe('Hub + 所有 Peer');
    expect(reachLabel({ reach: 'peers', reachPeers: ['a', 'b'], egress: 'internal' })).toBe(
      'Hub + 2 个指定 Peer',
    );
  });

  it('未选 Peer 时说清楚（不能显示成「Hub + 0 个」）', () => {
    expect(reachLabel({ reach: 'peers', reachPeers: [], egress: 'internal' })).toContain('未选择');
  });

  it('出网方式短标签', () => {
    expect(egressLabel('internal')).toBe('仅内网流量走 Hub');
    expect(egressLabel('all')).toBe('全部流量走 Hub');
  });
});
