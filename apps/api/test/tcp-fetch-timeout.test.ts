import { describe, expect, it, vi } from 'vitest';

/**
 * 回归：tcpFetch 的 `finally` 不能 await `socket.close()`。
 *
 * 真实故障（2026-11-07 真机）：节点 IP 变成黑洞（SYN 被丢）时，超时定时器 3s 就触发了，
 * 但 `await socket.close()` 会一直等到系统层 connect 超时（实测约 20s）才 resolve，
 * 于是 `/nodes/probe` 整体耗时 19.8s —— 面板「打开即探测」要转 20 秒。
 */
const mocks = vi.hoisted(() => ({
  closeCalls: 0,
  // 模拟"关闭要等系统 connect 超时"：永不 resolve
  close: () => {
    mocks.closeCalls += 1;
    return new Promise<void>(() => {});
  },
}));

vi.mock('cloudflare:sockets', () => ({
  connect: () => ({
    // 永不 open（黑洞主机）
    opened: new Promise<void>(() => {}),
    readable: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        releaseLock: () => {},
      }),
    },
    writable: {
      getWriter: () => ({ write: async () => {}, releaseLock: () => {} }),
    },
    close: mocks.close,
  }),
}));

import { TcpTimeoutError, tcpFetch } from '../src/lib/tcp-fetch';

describe('tcpFetch: 超时不被 socket.close() 拖住', () => {
  it('连接挂起时在 timeoutMs 附近 reject，而不是等 close 完成', async () => {
    const started = Date.now();
    await expect(
      tcpFetch('http://203.0.113.10:8880/health', { timeoutMs: 120 }),
    ).rejects.toBeInstanceOf(TcpTimeoutError);
    const cost = Date.now() - started;

    // 关键断言：远小于 close() 的"系统 connect 超时"（真实环境约 20s）
    expect(cost).toBeLessThan(1_000);
    // close 仍然被发起过（资源不泄漏的意图保留）
    expect(mocks.closeCalls).toBeGreaterThan(0);
  });
});
