import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotLoop, type SnapshotChannelLike, type SnapshotState } from './snapshot';

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

type Listener = (event: { data: unknown }) => void;

/** BroadcastChannel 语义的最小替身：同名的其它通道收到消息，发送者自己收不到。 */
class FakeChannel implements SnapshotChannelLike {
  private listeners = new Set<Listener>();

  constructor(
    private readonly bus: FakeBus,
    private readonly name: string,
  ) {}

  postMessage(data: unknown): void {
    this.bus.deliver(this, this.name, data);
  }

  addEventListener(type: 'message', listener: Listener): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: 'message', listener: Listener): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.bus.remove(this, this.name);
  }

  receive(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data });
  }
}

class FakeBus {
  private readonly channels = new Map<string, Set<FakeChannel>>();

  open(name: string): FakeChannel {
    const channel = new FakeChannel(this, name);
    const set = this.channels.get(name) ?? new Set<FakeChannel>();
    set.add(channel);
    this.channels.set(name, set);
    return channel;
  }

  remove(channel: FakeChannel, name: string): void {
    this.channels.get(name)?.delete(channel);
  }

  deliver(sender: FakeChannel, name: string, data: unknown): void {
    const set = this.channels.get(name);
    if (!set) return;
    for (const channel of [...set]) {
      if (channel !== sender) channel.receive(data);
    }
  }
}

function makeTab(bus: FakeBus, tabId: string, initiallyVisible = true) {
  let calls = 0;
  const updates: SnapshotState[] = [];
  const loop = new SnapshotLoop({
    mode: 'direct',
    initiallyVisible,
    shared: {
      hubId: 'hub-1',
      tabId,
      createChannel: (name) => bus.open(name),
    },
    fetchSnapshot: async () => {
      calls += 1;
      return SNAP;
    },
    onUpdate: (state) => updates.push(state),
  });
  return {
    loop,
    calls: () => calls,
    last: () => updates[updates.length - 1],
  };
}

describe('SnapshotLoop 多标签共享（BroadcastChannel）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('两个标签只发一路请求，follower 读广播值', async () => {
    const bus = new FakeBus();
    const a = makeTab(bus, 'tab-a');
    const b = makeTab(bus, 'tab-b');
    a.loop.start();
    b.loop.start();

    // 启动稳定期结束后只允许一个标签首发。
    await vi.advanceTimersByTimeAsync(100);
    expect(a.calls() + b.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.calls() + b.calls()).toBe(4);
    // 两个标签的计数之和等于单路节奏：必然有一个始终是 0。
    expect(Math.min(a.calls(), b.calls())).toBe(0);
    // follower 没有发请求，但通过广播拿到了快照。
    expect(b.last()?.snapshot).not.toBeNull();
    expect(b.last()?.status).toBe('live');

    a.loop.stop();
    b.loop.stop();
  });

  it('leader 退出后由存活标签自动接管', async () => {
    const bus = new FakeBus();
    const a = makeTab(bus, 'tab-a');
    a.loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(a.calls()).toBe(1);

    const b = makeTab(bus, 'tab-b');
    b.loop.start();
    await vi.advanceTimersByTimeAsync(100);
    // 新标签不抢跑，总量仍是 1。
    expect(a.calls() + b.calls()).toBe(1);
    expect(b.calls()).toBe(0);
    expect(b.last()?.snapshot).not.toBeNull();

    a.loop.stop();
    // 接管后按剩余间隔续上，不额外补发。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.calls()).toBe(2);
    expect(a.calls()).toBe(1);

    b.loop.stop();
  });

  it('全部标签隐藏时停表，任一标签可见后恢复', async () => {
    const bus = new FakeBus();
    const a = makeTab(bus, 'tab-a', true);
    const b = makeTab(bus, 'tab-b', false);
    a.loop.start();
    b.loop.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(a.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(0);

    // leader 与 follower 都隐藏：无人可见，立即停表。
    a.loop.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(0);

    // 任一标签恢复可见即继续（含超过 10s 后立即补一次）。
    a.loop.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls()).toBe(3);

    a.loop.stop();
    b.loop.stop();
  });
});
