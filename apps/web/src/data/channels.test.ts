import { describe, expect, it } from 'vitest';
import { deriveHubChannels, shouldRetryControlProbe } from './channels';

const liveSnapshot = { ts: 123 };

describe('Hub 双通道状态派生', () => {
  it('控制面可达时，节点可管理；快照只读不改变可写能力', () => {
    const channels = deriveHubChannels({
      controlReachable: true,
      live: { status: 'fallback', snapshot: null, error: null, mode: 'forward' },
    });
    expect(channels.presence).toBe('managed-online');
    expect(channels.canApply).toBe(true);
    expect(channels.canMutate).toBe(true);
    expect(channels.canSave).toBe(true);
    // 无域名时读通道是控制面转发快照。
    expect(channels.readSource).toBe('forward');
  });

  it('控制面不可达但直连快照成功时，执行类禁用但保存配置仍允许', () => {
    const channels = deriveHubChannels({
      controlReachable: false,
      controlError: 'Hub 不可达',
      live: { status: 'live', snapshot: liveSnapshot, error: null, mode: 'direct' },
    });
    expect(channels.presence).toBe('live-only');
    expect(channels.canApply).toBe(false);
    expect(channels.canMutate).toBe(false);
    expect(channels.canSave).toBe(true);
    expect(channels.readSource).toBe('direct');
    expect(channels.live.lastFrameAt).toBe(123);
  });

  it('两边都不可达时离线，保存配置仍允许（纯 D1 写）', () => {
    const channels = deriveHubChannels({
      controlReachable: false,
      live: { status: 'fallback', snapshot: null, error: 'timeout', mode: 'forward' },
    });
    expect(channels.presence).toBe('offline');
    expect(channels.canApply).toBe(false);
    expect(channels.canSave).toBe(true);
    expect(channels.readSource).toBe('forward');
  });

  it('探测中保持 unknown，不提前宣称在线', () => {
    const channels = deriveHubChannels({
      controlReachable: null,
      live: { status: 'disabled', snapshot: null, error: null, mode: 'forward' },
    });
    expect(channels.presence).toBe('unknown');
    expect(channels.canApply).toBe(false);
    expect(channels.canSave).toBe(true);
  });

  it('达到自动刷新上限后仍算已有数据，不提前宣称离线', () => {
    const channels = deriveHubChannels({
      controlReachable: false,
      live: { status: 'stopped', snapshot: liveSnapshot, error: null, mode: 'direct' },
    });
    expect(channels.presence).toBe('live-only');
    expect(channels.live.status).toBe('stopped');
  });

  it('探测失败但节点列表仍在线时保持 unknown，不误报离线', () => {
    const channels = deriveHubChannels({
      controlReachable: false,
      controlError: 'timeout',
      knownStatus: 'online',
      live: { status: 'disabled', snapshot: null, error: null, mode: 'forward' },
    });
    expect(channels.presence).toBe('unknown');
    expect(channels.canApply).toBe(false);
  });

  it('探测失败且节点列表离线时判定离线', () => {
    const channels = deriveHubChannels({
      controlReachable: false,
      knownStatus: 'offline',
      live: { status: 'disabled', snapshot: null, error: null, mode: 'forward' },
    });
    expect(channels.presence).toBe('offline');
  });
});

describe('控制面补探（D-03）', () => {
  it('探测失败但快照有新帧时补探，最多 3 次', () => {
    const base = { controlReachable: false, hasLiveFrame: true, fetching: false };
    expect(shouldRetryControlProbe({ ...base, attempts: 0 })).toBe(true);
    expect(shouldRetryControlProbe({ ...base, attempts: 2 })).toBe(true);
    expect(shouldRetryControlProbe({ ...base, attempts: 3 })).toBe(false);
  });

  it('没有快照、正在请求或控制面已可达时不补探', () => {
    expect(
      shouldRetryControlProbe({
        attempts: 0,
        controlReachable: false,
        hasLiveFrame: false,
        fetching: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryControlProbe({
        attempts: 0,
        controlReachable: false,
        hasLiveFrame: true,
        fetching: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryControlProbe({
        attempts: 0,
        controlReachable: true,
        hasLiveFrame: true,
        fetching: false,
      }),
    ).toBe(false);
  });

  it('请求本身失败（无 reachable 数据）时也有限补探，不依赖快照帧', () => {
    const base = {
      controlReachable: null,
      hasLiveFrame: false,
      fetching: false,
      failed: true,
    };
    expect(shouldRetryControlProbe({ ...base, attempts: 0 })).toBe(true);
    expect(shouldRetryControlProbe({ ...base, attempts: 2 })).toBe(true);
    expect(shouldRetryControlProbe({ ...base, attempts: 3 })).toBe(false);
    expect(shouldRetryControlProbe({ ...base, attempts: 0, fetching: true })).toBe(false);
  });

  it('请求失败但有快照帧时同样补探；未失败且无数据时不补探', () => {
    expect(
      shouldRetryControlProbe({
        attempts: 0,
        controlReachable: null,
        hasLiveFrame: true,
        fetching: false,
        failed: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryControlProbe({
        attempts: 0,
        controlReachable: null,
        hasLiveFrame: true,
        fetching: false,
        failed: false,
      }),
    ).toBe(false);
  });
});
