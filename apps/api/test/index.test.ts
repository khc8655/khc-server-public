import { describe, expect, it } from 'vitest';
import worker, { getWorkerRuntime } from '../src/index';
import {
  HubUnreachableError,
  type AgentNode,
  type FetchLike,
  type TcpFetchLike,
} from '../src/lib/node-client';
import type { Env } from '../src/types';

function makeEnv(db: object): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ENVIRONMENT: 'development',
    ADMIN_PASSWORD: 'test-pass',
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
    MASTER_ENC_KEY: 'test-master-key-0123456789',
  } as unknown as Env;
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const nodeDirect: AgentNode = {
  id: 'nd_index_1',
  endpoint: 'https://hub.example.com:8443',
  tunnelEndpoint: 'https://hub-t.example.com',
  preferredRoute: 'direct',
};

describe('index: §3.1 client/app 单例（cooldown 跨请求共享）', () => {
  it('同一 isolate 内两次请求（不同 env 对象、相同 DB 绑定）复用同一 client/app', async () => {
    const db = {};
    const envA = makeEnv(db);
    // Workers 每次请求可能给出新的 env 对象，但 DB 绑定引用稳定
    const envB = makeEnv(db);

    const first = getWorkerRuntime(envA);
    const second = getWorkerRuntime(envB);
    expect(second.agent).toBe(first.agent);
    expect(second.app).toBe(first.app);

    // 端到端：两次 worker.fetch 都走同一份缓存 app，健康检查正常
    const resA = await worker.fetch(new Request('http://localhost/api/v1/health'), envA, executionCtx);
    const resB = await worker.fetch(new Request('http://localhost/api/v1/health'), envB, executionCtx);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // 两次 fetch 之后缓存里仍是同一个 app/client
    expect(getWorkerRuntime(envB).agent).toBe(first.agent);
    expect(getWorkerRuntime(envB).app).toBe(first.app);
  });

  it('不同 DB 绑定各自持有独立的 client/app', () => {
    const a = getWorkerRuntime(makeEnv({}));
    const b = getWorkerRuntime(makeEnv({}));
    expect(a.agent).not.toBe(b.agent);
    expect(a.app).not.toBe(b.app);
  });

  it('失败后第二次请求命中同一 client 的 cooldown，快速失败且不再发起传输', async () => {
    const db = {};
    let transportCalls = 0;
    const failingFetch: FetchLike = async () => {
      transportCalls += 1;
      throw new Error('ECONNREFUSED');
    };
    const failingTcp: TcpFetchLike = async () => {
      transportCalls += 1;
      throw new Error('tcp refused');
    };
    const options = { fetchImpl: failingFetch, tcpFetchImpl: failingTcp };

    // 第一次请求：构造注入失败传输，连接失败后进入冷却
    const first = getWorkerRuntime(makeEnv(db), options);
    await expect(first.agent.call(nodeDirect, 'tok', 'GET', '/state')).rejects.toBeInstanceOf(
      HubUnreachableError,
    );
    const callsAfterFirst = transportCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 第二次请求：不同 env 对象、相同 DB 绑定 → 命中同一 client → cooldown 快速失败
    const second = getWorkerRuntime(makeEnv(db), options);
    expect(second.agent).toBe(first.agent);
    const error = await second.agent
      .call(nodeDirect, 'tok', 'GET', '/state')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect((error as HubUnreachableError).message).toContain('冷却');
    // 冷却期内不再触发 fetch / TCP
    expect(transportCalls).toBe(callsAfterFirst);
  });
});
