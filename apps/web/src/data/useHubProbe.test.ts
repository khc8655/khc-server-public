import { describe, expect, it } from 'vitest';
import {
  hubOutageDays,
  hubOutageLabel,
  hubStatusView,
  nextProbeRetryDelay,
  type HubView,
} from './useHubProbe';

const NOW_MS = 1_800_000_000_000;
const DAY_SEC = 86_400;

function hub(overrides: Partial<HubView> = {}): HubView {
  return {
    id: 'hub-1',
    name: 'hub-1',
    endpoint: 'http://203.0.113.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    domain: null,
    accessMode: 'ip',
    tunnelId: null,
    allowInsecure: true,
    preferredRoute: 'direct',
    status: 'offline',
    lastSeenAt: null,
    createdAt: 1,
    updatedAt: 1,
    probed: true,
    ...overrides,
  };
}

describe('离线节点失联口径', () => {
  it('只在本次探测确认不可达时才计算失联天数', () => {
    const lastSeenAt = NOW_MS / 1000 - 3 * DAY_SEC;
    expect(hubOutageDays(hub({ lastSeenAt }), NOW_MS)).toBe(3);
    expect(hubOutageDays(hub({ lastSeenAt, probed: false }), NOW_MS)).toBeNull();
    expect(hubOutageDays(hub({ lastSeenAt, status: 'online' }), NOW_MS)).toBeNull();
    expect(hubOutageDays(hub({ lastSeenAt: null }), NOW_MS)).toBeNull();
  });

  it('失联满 1 天才标记「已失联 N 天」，不足 1 天与从未上线仍显示「离线」', () => {
    const threeDays = hub({ lastSeenAt: NOW_MS / 1000 - 3 * DAY_SEC });
    expect(hubOutageLabel(threeDays, NOW_MS)).toBe('已失联 3 天');
    expect(hubStatusView(threeDays, 'done', NOW_MS)).toEqual({
      tone: 'danger',
      label: '离线 · 已失联 3 天',
    });

    const halfDay = hub({ lastSeenAt: NOW_MS / 1000 - DAY_SEC / 2 });
    expect(hubOutageLabel(halfDay, NOW_MS)).toBeNull();
    expect(hubStatusView(halfDay, 'done', NOW_MS)).toEqual({ tone: 'danger', label: '离线' });

    expect(hubOutageLabel(hub({ lastSeenAt: null }), NOW_MS)).toBeNull();
    expect(hubStatusView(hub({ lastSeenAt: null }), 'done', NOW_MS)).toEqual({
      tone: 'danger',
      label: '离线',
    });
  });

  it('在线、未探测、探测整体失败分别显示 在线 / 探测中… / 未知', () => {
    expect(hubStatusView(hub({ status: 'online' }), 'done', NOW_MS)).toEqual({
      tone: 'ok',
      label: '在线',
    });
    expect(hubStatusView(hub({ probed: false }), 'probing', NOW_MS)).toEqual({
      tone: 'neutral',
      label: '探测中…',
    });
    expect(hubStatusView(hub({ probed: false }), 'failed', NOW_MS)).toEqual({
      tone: 'neutral',
      label: '未知',
    });
  });
});

describe('离线自动复核节奏', () => {
  it('60s → 120s → 240s，最多 3 次后停手', () => {
    expect(nextProbeRetryDelay(0)).toBe(60_000);
    expect(nextProbeRetryDelay(1)).toBe(120_000);
    expect(nextProbeRetryDelay(2)).toBe(240_000);
    expect(nextProbeRetryDelay(3)).toBeNull();
  });
});
