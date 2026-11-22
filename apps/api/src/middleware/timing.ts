import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../types';
import { RequestTiming, runWithTiming } from '../lib/timing';

export const SLOW_REQUEST_LOG_MS = 1500;

function writeTimingHeader(c: Context<AppBindings>, value: string): void {
  const res = c.res;
  if (!res) return;
  try {
    res.headers.append('Server-Timing', value);
  } catch {
    const headers = new Headers(res.headers);
    headers.append('Server-Timing', value);
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/**
 * 外层计时中间件：为所有 /api/* 响应（含 401/404/5xx）追加 Server-Timing 头，
 * 并在 total 达到阈值时打一行结构化慢请求日志（防生产边缘剥离响应头后无法排查）。
 */
export const serverTiming = createMiddleware<AppBindings>(async (c, next) => {
  const timing = new RequestTiming();
  try {
    await runWithTiming(timing, () => next());
  } finally {
    if (c.res) {
      const end = timing.now();
      const headerValue = timing.header(end);
      writeTimingHeader(c, headerValue);
      const { total } = timing.summary(end);
      if (total >= SLOW_REQUEST_LOG_MS) {
        console.info('[timing] slow request', {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          serverTiming: headerValue,
        });
      }
    }
  }
});
