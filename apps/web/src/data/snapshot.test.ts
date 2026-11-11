import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotLoop, type SnapshotState } from './snapshot';

const SNAP = {
  ts: 1,
  host: { hostname: 'hub', uptime: 100, load: [0, 0, 0] },
  ops: {
    cpu: { cores: 2, model: 'x', usagePercent: 10, load: [0, 0, 0] },
    mem: { total: 100, available: 50, used: 50, percent: 50 },
    disks: [{ name: 'root', path: '/', total: 100, used: 20, free: 80, percent: 20 }],
    collectedAt: 1,
  },
};

function makeLoop(overrides: Partial<ConstructorParameters<typeof SnapshotLoop>[0]> = {}) {
  let calls = 0;
  const updates: SnapshotState[] = [];
  let failNext = false;
  const loop = new SnapshotLoop({
    mode: 'forward',
    fetchSnapshot: async () => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('network');
      }
      return SNAP;
    },
    onUpdate: (state) => updates.push(state),
    ...overrides,
  });
  return {
    loop,
    updates,
    calls: () => calls,
    fail: () => {
      failNext = true;
    },
    last: () => updates[updates.length - 1],
  };
}

describe('SnapshotLoop：10s 节奏 / 可见性 / 上限 / 环形缓冲', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('打开即拉一次，之后每 10 秒一次', async () => {
    const h = makeLoop();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls()).toBe(4); // 0s + 10s + 20s + 30s
    expect(h.last()?.status).toBe('live');
  });

  it('隐藏立即停表，增量 0；切回恢复且不叠加第二个循环', async () => {
    const h = makeLoop();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toBe(2);

    h.loop.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls()).toBe(2);

    h.loop.setVisible(true);
    // 已超过 10s，切回立即补一次，然后恢复 10s 节奏。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toBe(4);

    // 反复切可见/隐藏不应制造并行计时器：每 10 秒只允许 +1。
    h.loop.setVisible(false);
    h.loop.setVisible(true);
    h.loop.setVisible(false);
    h.loop.setVisible(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toBe(5);
  });

  it('60 次/10 分钟上限到顶后停住，手动刷新只补一次', async () => {
    const h = makeLoop({ maxPolls: 3 });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls()).toBe(3);
    expect(h.last()?.status).toBe('stopped');
    expect(h.last()?.capped).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls()).toBe(3);

    h.loop.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls()).toBe(4);
    expect(h.last()?.status).toBe('stopped');
  });

  it('环形缓冲只保留最近 N 个点', async () => {
    const h = makeLoop({ ringSize: 3 });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.last()?.history).toHaveLength(3);
    expect(h.last()?.history.at(-1)?.cpu).toBe(10);
  });

  it('失败进入 fallback 并继续按节奏自动恢复', async () => {
    const h = makeLoop();
    h.fail();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()?.status).toBe('fallback');
    expect(h.last()?.error).toContain('network');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.last()?.status).toBe('live');
    expect(h.last()?.error).toBeNull();
  });

  it('readForward 只显式读取一次控制面快照，不改变模式也不重启自动循环', async () => {
    let forwardCalls = 0;
    const h = makeLoop({
      mode: 'direct',
      fetchSnapshot: async () => {
        throw new Error('直连观测入口不可达');
      },
      fetchForward: async () => {
        forwardCalls += 1;
        return SNAP;
      },
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()?.status).toBe('fallback');
    expect(h.last()?.mode).toBe('direct');

    h.loop.readForward();
    await vi.advanceTimersByTimeAsync(0);
    expect(forwardCalls).toBe(1);
    expect(h.last()?.receivedAt).not.toBeNull();
    expect(h.last()?.status).toBe('fallback');
    expect(h.last()?.mode).toBe('direct');

    // 自动循环仍按 10s 继续尝试直连；不会因为手动读取而改成转发模式。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.last()?.mode).toBe('direct');
    expect(h.last()?.pollCount).toBe(2);
  });
});
