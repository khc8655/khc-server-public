import { describe, expect, it } from 'vitest';
import {
  HubUnreachableError,
  HttpAgentClient,
  type AgentClient,
  type AgentNode,
  type AgentResponse,
} from '../src/lib/node-client';
import { TcpTimeoutError } from '../src/lib/tcp-fetch';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

/**
 * /state 慢请求回归：
 * - 传输预算内慢响应不能被误判为超时；
 * - 超时必须落到"200 + reachable:false"，而不是 5xx/挂起；
 * - 单节点慢不能阻塞其他节点的并发探测；
 * - 失败不更新 lastSeenAt（避免面板把旧租约当成在线）。
 */

const node: AgentNode = {
  id: 'nd_slow',
  endpoint: 'https://slow.example.com:8443',
  tunnelEndpoint: null,
  preferredRoute: 'direct',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('node-client: /state 传输预算', () => {
  it('fetch 慢但在预算内返回时成功，不误判超时', async () => {
    const client = new HttpAgentClient(
      async () => {
        await sleep(80);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      async () => {
        throw new Error('不应回退 TCP');
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state', undefined, {
      timeoutMs: 500,
    });
    expect(response.via).toBe('fetch');
    expect(response.status).toBe(200);
  });

  it('fetch 与 TCP 均超时：预算内抛 hub_unreachable 且标记 timedOut', async () => {
    const client = new HttpAgentClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // 模拟真实 fetch：不响应 AbortSignal 的实现在这里会被测试挡住。
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      async () => {
        throw new TcpTimeoutError('TCP 连接超时（>1000ms）');
      },
    );
    const started = Date.now();
    const error = await client
      .call(node, 'tok', 'GET', '/state', undefined, { timeoutMs: 120 })
      .catch((err: unknown) => err);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(HubUnreachableError);
    expect((error as HubUnreachableError).timedOut).toBe(true);
    // 预算 120ms + TCP 兜底（这里立即失败），不应拖到默认 10s。
    expect(elapsed).toBeLessThan(2_000);
  });
});

/** 可编排的假 Agent：指定节点慢返回并超时，其余节点立即成功。 */
class FanoutAgent implements AgentClient {
  readonly slow = new Set<string>();

  async call(
    target: AgentNode,
    _token: string,
    _method: 'GET' | 'POST',
    _path: string,
  ): Promise<AgentResponse> {
    if (this.slow.has(target.id)) {
      await sleep(300);
      throw new HubUnreachableError('Hub 不可达（连接超时）', { direct: 'timeout' }, true);
    }
    return {
      status: 200,
      body: {
        ok: true,
        host: { hostname: `hub-${target.id}` },
        adapters: [],
        ports: [],
      },
      route: target.preferredRoute,
      via: 'fetch',
    };
  }
}

async function createNodeNamed(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  name: string,
  endpoint: string,
): Promise<string> {
  const res = await ctx.app.request(
    '/api/v1/nodes',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ name, endpoint }),
    },
    ctx.env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { node: { id: string } };
  return body.node.id;
}

describe('GET /state：慢节点隔离与租约', () => {
  it('一个节点慢超时不影响另一个节点，且失败不写 lastSeenAt', async () => {
    const agent = new FanoutAgent();
    const ctx = makeTestContext(undefined, agent);
    const cookie = await loginAsAdmin(ctx);
    const slowId = await createNodeNamed(ctx, cookie, '慢节点', 'https://slow.example.com:8443');
    const fastId = await createNodeNamed(ctx, cookie, '快节点', 'https://fast.example.com:8443');
    agent.slow.add(slowId);

    const started = Date.now();
    const read = async (id: string) => {
      const res = await ctx.app.request(
        `/api/v1/nodes/${id}/state`,
        { headers: authHeaders(cookie) },
        ctx.env,
      );
      expect(res.status).toBe(200);
      return {
        at: Date.now() - started,
        body: (await res.json()) as { reachable: boolean; error: string | null },
      };
    };

    const slowPromise = read(slowId);
    const fast = await read(fastId);
    const slow = await slowPromise;

    expect(fast.body.reachable).toBe(true);
    // 快节点必须比慢节点先完成（不依赖绝对耗时，避免 CI 抖动）。
    expect(fast.at).toBeLessThan(slow.at);
    expect(slow.body.reachable).toBe(false);
    expect(slow.body.error).toContain('超时');
    expect(slow.at).toBeGreaterThanOrEqual(250);

    const slowNode = await ctx.nodes.get(slowId);
    const fastNode = await ctx.nodes.get(fastId);
    expect(slowNode?.lastSeenAt).toBeFalsy();
    expect(fastNode?.lastSeenAt).toBeTruthy();
  });
});
