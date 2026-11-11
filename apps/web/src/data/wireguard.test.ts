import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WG_INTERFACE,
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
});
