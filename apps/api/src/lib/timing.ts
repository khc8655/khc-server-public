import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentCallOptions, AgentClient, AgentNode, AgentResponse } from './node-client';

export type TimingMetric = 'auth' | 'd1' | 'agent';
export type Clock = () => number;

const METRIC_ORDER: readonly TimingMetric[] = ['auth', 'd1', 'agent'];
const MAX_INTERVALS_PER_METRIC = 500;
const TOKEN_RE = /^[a-z0-9_-]{1,32}$/;

interface MetricBucket {
  count: number;
  intervals: Array<[number, number]>;
  tokens: Set<string>;
}

export interface MetricSummary {
  dur: number;
  count: number;
  tokens: string[];
}

export interface TimingSummary {
  auth?: MetricSummary;
  d1?: MetricSummary;
  agent?: MetricSummary;
  total: number;
}

/**
 * 求区间列表的并集总长度（并行执行的同类 I/O 只计墙钟覆盖时长，避免重复相加）。
 */
export function unionDuration(intervals: ReadonlyArray<readonly [number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals
    .map(([start, end]): [number, number] => [start, end > start ? end : start])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const first = sorted[0];
  if (!first) return 0;
  let total = 0;
  let [curStart, curEnd] = first;
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= curEnd) {
      if (nextEnd > curEnd) curEnd = nextEnd;
    } else {
      total += curEnd - curStart;
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * 单次请求的轻量分段计时器：分别记录 auth / d1 / agent 区间与 total 墙钟时间。
 * 响应头仅允许安全计数与传输方式 token（如 fetch/tcp），绝不写入路径、节点或凭据。
 */
export class RequestTiming {
  private readonly clock: Clock;
  private readonly startedAt: number;
  private readonly buckets = new Map<TimingMetric, MetricBucket>();

  constructor(clock: Clock = () => performance.now()) {
    this.clock = clock;
    this.startedAt = this.clock();
  }

  now(): number {
    return this.clock();
  }

  record(metric: TimingMetric, start: number, end: number, detail?: string): void {
    let bucket = this.buckets.get(metric);
    if (!bucket) {
      bucket = { count: 0, intervals: [], tokens: new Set<string>() };
      this.buckets.set(metric, bucket);
    }
    bucket.count += 1;
    if (bucket.intervals.length < MAX_INTERVALS_PER_METRIC) {
      bucket.intervals.push([start, end > start ? end : start]);
    }
    if (typeof detail === 'string' && TOKEN_RE.test(detail)) {
      bucket.tokens.add(detail);
    }
  }

  summary(end: number = this.clock()): TimingSummary {
    const out: TimingSummary = {
      total: Math.max(0, end - this.startedAt),
    };
    for (const metric of METRIC_ORDER) {
      const bucket = this.buckets.get(metric);
      if (!bucket) continue;
      out[metric] = {
        dur: unionDuration(bucket.intervals),
        count: bucket.count,
        tokens: Array.from(bucket.tokens),
      };
    }
    return out;
  }

  header(end: number = this.clock()): string {
    const stat = this.summary(end);
    const parts: string[] = [];
    for (const metric of METRIC_ORDER) {
      const entry = stat[metric];
      if (!entry) continue;
      const desc = [`n=${entry.count}`, ...entry.tokens].join(' ');
      parts.push(`${metric};dur=${entry.dur.toFixed(1)};desc="${desc}"`);
    }
    parts.push(`total;dur=${stat.total.toFixed(1)}`);
    return parts.join(', ');
  }
}

const timingStorage = new AsyncLocalStorage<RequestTiming>();

export function runWithTiming<T>(timing: RequestTiming, fn: () => T): T {
  return timingStorage.run(timing, fn);
}

export function currentTiming(): RequestTiming | undefined {
  return timingStorage.getStore();
}

export async function timed<T>(
  metric: TimingMetric,
  fn: () => Promise<T>,
  detailOf?: (result: T) => string | undefined,
): Promise<T> {
  const timing = timingStorage.getStore();
  if (!timing) return fn();
  const start = timing.now();
  let detail: string | undefined;
  try {
    const result = await fn();
    detail = detailOf?.(result);
    return result;
  } finally {
    timing.record(metric, start, timing.now(), detail);
  }
}

const rawStatementMap = new WeakMap<object, object>();

function unwrapStatement(value: unknown): unknown {
  if (value && typeof value === 'object') {
    return rawStatementMap.get(value) ?? value;
  }
  return value;
}

function wrapStatement<T extends object>(stmt: T): T {
  const TIMED_STMT_METHODS = new Set(['first', 'all', 'run', 'raw']);
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'bind') {
        return (...args: unknown[]) => {
          const bound = (value as (...a: unknown[]) => unknown).apply(target, args);
          return bound && typeof bound === 'object' ? wrapStatement(bound) : bound;
        };
      }
      if (typeof prop === 'string' && TIMED_STMT_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          timed('d1', () => Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)));
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  rawStatementMap.set(wrapped, stmt);
  return wrapped;
}

function wrapD1Session<T extends object>(session: T): T {
  return new Proxy(session, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') {
        return (...args: unknown[]) => {
          const stmt = (value as (...a: unknown[]) => unknown).apply(target, args);
          return stmt && typeof stmt === 'object' ? wrapStatement(stmt) : stmt;
        };
      }
      if (prop === 'exec') {
        return (...args: unknown[]) =>
          timed('d1', () => Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)));
      }
      if (prop === 'batch') {
        return (statements: unknown[], ...rest: unknown[]) =>
          timed('d1', () =>
            Promise.resolve(
              (value as (...a: unknown[]) => unknown).call(
                target,
                Array.isArray(statements) ? statements.map(unwrapStatement) : statements,
                ...rest,
              ),
            ),
          );
      }
      if (prop === 'withSession') {
        return (...args: unknown[]) => {
          const next = (value as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === 'object' ? wrapD1Session(next) : next;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/**
 * 包装 D1Database（含 withSession 会话），无侵入统计 D1 耗时；
 * WeakMap 保留原生 Statement 引用供 batch() 解包，并用 Reflect.get(target, prop, target) 兼容私有字段。
 */
export function instrumentD1<T extends D1Database | undefined>(db: T): T {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    return db;
  }
  return wrapD1Session(db as unknown as object) as unknown as T;
}

/** 包装 AgentClient，将每次 call() 的墙钟与实际传输方式（fetch/tcp）记入 agent 段。 */
export function instrumentAgent(client: AgentClient): AgentClient {
  return {
    call(
      node: AgentNode,
      token: string,
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
      opts?: AgentCallOptions,
    ): Promise<AgentResponse> {
      return timed(
        'agent',
        () => client.call(node, token, method, path, body, opts),
        (response) => response.via,
      );
    },
  };
}
