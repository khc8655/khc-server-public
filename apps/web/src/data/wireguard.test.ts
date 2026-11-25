import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WG_INTERFACE,
  isValidCidr,
  migrationPeer,
  normalizeWgConfig,
  uniquePeerName,
  type WgConfig,
  type WgPeer,
} from './wireguard';

function peer(overrides: Partial<WgPeer> = {}): WgPeer {
  return {
    name: 'vm-a',
    publicKey: 'a'.repeat(43) + '=',
    privateKey: 'b'.repeat(43) + '=',
    allowedIps: ['10.99.0.2/32'],
    keepalive: 25,
    endpoint: null,
    enabled: true,
    ...overrides,
  };
}

function config(peers: WgPeer[] = []): WgConfig {
  return { interface: { ...DEFAULT_WG_INTERFACE }, peers };
}

describe('allowedIps 地址校验', () => {
  it('接受合法 IPv4/IPv6 与 CIDR', () => {
    for (const value of [
      '10.99.0.2/32',
      '10.99.0.2',
      '172.16.0.0/12',
      'fd00::2/128',
      'fd00::2',
      '::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isValidCidr(value), value).toBe(true);
    }
  });

  it('拒绝只有十六进制字符的伪地址与越界前缀', () => {
    for (const value of ['abc', 'deadbeef', '10.99.0.2/33', 'fd00::2/129', '10.99.0.256/32', '1.2.3/24', '10.99.0.2/']) {
      expect(isValidCidr(value), value).toBe(false);
    }
  });
});

describe('wireguard 数据层', () => {
  it('新配置的接口名默认固定为 khc0', () => {
    expect(DEFAULT_WG_INTERFACE.name).toBe('khc0');
    expect(normalizeWgConfig(null).interface.name).toBe('khc0');
  });

  it('目标节点重名时自动追加序号，且不超过 32 字符', () => {
    expect(uniquePeerName(config(), 'vm-a')).toBe('vm-a');
    expect(uniquePeerName(config([peer({ name: 'vm-a' })]), 'vm-a')).toBe('vm-a-2');
    expect(uniquePeerName(config([peer({ name: 'vm-a' }), peer({ name: 'vm-a-2' })]), 'vm-a')).toBe(
      'vm-a-3',
    );
    const longName = 'x'.repeat(32);
    expect(uniquePeerName(config([peer({ name: longName })]), longName)).toHaveLength(30);
  });

  it('迁移在目标节点现场生成新密钥并重新分配地址，不复用源密钥', () => {
    const target = config([peer({ name: 'other', allowedIps: ['10.99.0.2/32'] })]);
    const migrated = migrationPeer(target, peer({ name: 'vm-a', allowedIps: ['10.99.0.9/32'] }));

    expect(migrated.name).toBe('vm-a');
    expect(migrated.publicKey).toBe('');
    expect(migrated.privateKey).toBe('');
    expect(migrated.allowedIps).toEqual(['10.99.0.3/32']);
    expect(migrated.keepalive).toBe(25);
  });

  it('normalizeWgConfig 保留 reach / reachPeers / egress，且缺省字段保持 undefined（N-6 兼容）', () => {
    const normalized = normalizeWgConfig({
      interface: DEFAULT_WG_INTERFACE,
      peers: [
        {
          name: 'phone-1',
          publicKey: 'k1',
          privateKey: 'p1',
          allowedIps: ['10.99.0.2/32'],
          reach: 'hub',
          egress: 'internal',
        },
        {
          name: 'laptop-1',
          publicKey: 'k2',
          privateKey: 'p2',
          allowedIps: ['10.99.0.3/32'],
          reach: 'peers',
          reachPeers: ['phone-1', 'nas-1'],
          egress: 'all',
        },
        {
          name: 'legacy-1',
          publicKey: 'k3',
          privateKey: 'p3',
          allowedIps: ['10.99.0.4/32'],
          reach: 'invalid-value',
          egress: 'bogus',
        },
      ],
    });

    const [phone, laptop, legacy] = normalized.peers;
    if (!phone || !laptop || !legacy) throw new Error('missing normalized peers');

    expect(phone).toMatchObject({ reach: 'hub', egress: 'internal' });
    expect('reachPeers' in phone).toBe(false);
    expect(laptop).toMatchObject({
      reach: 'peers',
      reachPeers: ['phone-1', 'nas-1'],
      egress: 'all',
    });
    expect(legacy.reach).toBeUndefined();
    expect(legacy.reachPeers).toBeUndefined();
    expect(legacy.egress).toBeUndefined();
  });
});
