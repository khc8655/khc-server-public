/**
 * 主机运维服务写操作精确刷新单测（2026-11-16 §5 / B2 收敛）：
 * - 失效 `svc.list` 的 React Query 缓存；
 * - 刷新轻量 `/snapshot` 失败计数（`live.refresh()`），不再重拉整份 `/state` 或 `/overview`；
 * - 距上次快照不足 2.1s 时延迟到满 2.1s 再调用，避开 Worker 2s 同节点去重返回旧帧。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_OPS_TARGET_SELF, hostOpsQueryKey } from '../../data/hostOps';
import { SNAPSHOT_DEDUPE_DELAY_MS, refreshAfterServiceWrite } from './refreshAfterWrite';

describe('refreshAfterServiceWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('精确失效 svc.list 并在距上次快照已满 2.1s 时立即调 live.refresh()', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();

    await refreshAfterServiceWrite(
      { invalidateQueries },
      'hub-1',
      { lastAt: 10_000 - SNAPSHOT_DEDUPE_DELAY_MS - 100, refresh },
      () => 10_000,
    );

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostOpsQueryKey('hub-1', HOST_OPS_TARGET_SELF, 'svc.list', {}),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('距上次快照不足 2.1s 时，延迟到满 2.1s 再调用 live.refresh() 避开 Worker 去重', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();

    // 仅过了 500ms，还差 1_600ms 才到 2_100ms
    await refreshAfterServiceWrite(
      { invalidateQueries },
      'hub-1',
      { lastAt: 9_500, refresh },
      () => 10_000,
    );

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_599);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('首次无 lastAt 记录时直接调 live.refresh()', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();

    await refreshAfterServiceWrite({ invalidateQueries }, 'hub-1', { lastAt: null, refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
