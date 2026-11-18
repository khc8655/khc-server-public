import { describe, expect, it } from 'vitest';
import { channelRows, connectionState } from './connectionState';
import type { HubPresence } from '../../data/channels';

function state(presence: HubPresence) {
  return connectionState({ presence });
}

describe('connectionState 三态', () => {
  it('控制面不可达 → 离线（红色）', () => {
    const result = state('offline');
    expect(result.kind).toBe('offline');
    expect(result.label).toBe('离线');
    expect(result.tone).toBe('danger');
  });

  it('控制面可达 → 在线（绿色）', () => {
    const result = state('managed-online');
    expect(result.kind).toBe('online');
    expect(result.label).toBe('在线');
    expect(result.tone).toBe('ok');
  });

  it('未确认 → 探测中（中性）', () => {
    const result = state('unknown');
    expect(result.kind).toBe('unknown');
    expect(result.label).toBe('探测中');
    expect(result.tone).toBe('neutral');
  });
});

describe('channelRows 通道说明', () => {
  it('全部数据统一经控制面', () => {
    const rows = channelRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.channel).toContain('经控制面');
    }
  });
});
