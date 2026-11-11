import { describe, expect, it } from 'vitest';
import {
  HubUnreachableError,
  HttpAgentClient,
  signAgentRequest,
  type AgentNode,
} from '../src/lib/node-client';
import { TcpTimeoutError } from '../src/lib/tcp-fetch';
import { APP_VERSION } from '../src/version';

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return [...view].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

async function hmacHex(token: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

const node: AgentNode = {
  id: 'nd_1',
  endpoint: 'https://hub.example.com:8443',
  tunnelEndpoint: 'https://hub-t.example.com',
  preferredRoute: 'direct',
};

describe('node-client: HMAC 签名', () => {
  it('签名符合 method|path|ts|nonce|sha256(body) 规范', async () => {
    const token = 'tok_test_123';
    const bodyText = JSON.stringify({ config: { port: 9100 } });
    const headers = await signAgentRequest(token, 'POST', '/apps/node-exporter/apply', bodyText);
    const canonical = `POST|/apps/node-exporter/apply|${headers['x-khc-ts']}|${headers['x-khc-nonce']}|${await sha256Hex(bodyText)}`;
    expect(headers['x-khc-sig']).toBe(await hmacHex(token, canonical));
  });

  it('GET 的 body hash 用空串', async () => {
    const headers = await signAgentRequest('tok', 'GET', '/state', '');
    const canonical = `GET|/state|${headers['x-khc-ts']}|${headers['x-khc-nonce']}|${await sha256Hex('')}`;
    expect(headers['x-khc-sig']).toBe(await hmacHex('tok', canonical));
  });

  it('附带 x-khc-panel-version（版本协商用，不参与签名）', async () => {
    const headers = await signAgentRequest('tok', 'GET', '/state', '');
    // 值必须等于面板唯一版本来源；签名规范不变（canonical 里没有它）
    expect(headers['x-khc-panel-version']).toBe(APP_VERSION);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const canonical = `GET|/state|${headers['x-khc-ts']}|${headers['x-khc-nonce']}|${await sha256Hex('')}`;
    expect(headers['x-khc-sig']).toBe(await hmacHex('tok', canonical));
  });
});

describe('node-client: 版本协商失败（426 panel_too_old）', () => {
  it('把 Agent 的 panel_too_old 信封改写成可操作提示', async () => {
    const client = new HttpAgentClient(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'panel_too_old',
            message: '面板版本 0.3.0 低于本 Agent 要求的 0.4.0',
            details: { reason: 'panel_too_old', minPanelVersion: '0.4.0', agentVersion: '0.1.21' },
          },
        }),
        { status: 426, headers: { 'content-type': 'application/json' } },
      ),
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.status).toBe(426);
    const error = (response.body as { error: { message: string } }).error;
    expect(error.message).toContain('要求面板 ≥ 0.4.0');
    expect(error.message).toContain('0.1.21');
    expect(error.message).toContain('请先升级面板');
  });

  it('426 不触发失败冷却（节点本身可达，属配置/升级顺序问题）', async () => {
    const client = new HttpAgentClient(async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'panel_too_old', message: 'x' } }), {
        status: 426,
      }),
    );
    await client.call(node, 'tok', 'GET', '/state');
    // 冷却未生效：立刻再调一次仍会真正发起请求，而不是抛“冷却中”
    await expect(client.call(node, 'tok', 'GET', '/state')).resolves.toMatchObject({ status: 426 });
  });
});

describe('node-client: §3.8 接入方案选定（无跨方案回退）', () => {
  it('选定 direct 时只请求 direct，tunnel 不被调用', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.route).toBe('direct');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(node.endpoint);
  });

  it('选定 tunnel 时只请求 tunnel，direct 不被调用', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const response = await client.call(
      { ...node, preferredRoute: 'tunnel' },
      'tok',
      'GET',
      '/state',
    );
    expect(response.route).toBe('tunnel');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(node.tunnelEndpoint!);
    expect(calls[0]).not.toContain(node.endpoint);
  });

  it('选定 direct 但连接失败：不切换 tunnel，返回明确错误', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(
      async (url) => {
        calls.push(url);
        throw new Error('ECONNREFUSED');
      },
      async () => {
        throw new Error('tcp refused');
      },
    );
    const error = await client.call(node, 'tok', 'GET', '/state').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect((error as HubUnreachableError).code).toBe('hub_unreachable');
    expect((error as HubUnreachableError).message).toContain('选定方案');
    // 错误信息不暗示「切换另一条路 / 主备」
    expect((error as HubUnreachableError).message).not.toMatch(/隧道|另一条|切换|均失败/);
    expect(calls.some((u) => u.includes(node.tunnelEndpoint!))).toBe(false);
  });

  it('选定 tunnel 但连接失败：不回退 direct，返回明确错误', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(
      async (url) => {
        calls.push(url);
        throw new Error('ECONNREFUSED');
      },
      async () => {
        throw new Error('tcp refused');
      },
    );
    await expect(
      client.call({ ...node, preferredRoute: 'tunnel' }, 'tok', 'GET', '/state'),
    ).rejects.toMatchObject({ code: 'hub_unreachable' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(node.tunnelEndpoint!);
  });

  it('单方案内 fetch→TCP 回退仍生效（不跨方案）', async () => {
    const fetchUrls: string[] = [];
    const tcpUrls: string[] = [];
    const client = new HttpAgentClient(
      async (url) => {
        fetchUrls.push(url);
        throw new Error('ECONNRESET');
      },
      async (url) => {
        tcpUrls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.route).toBe('direct');
    expect(response.via).toBe('tcp');
    expect(response.status).toBe(200);
    expect(fetchUrls).toHaveLength(1);
    expect(tcpUrls).toHaveLength(1);
    expect(tcpUrls[0]).toContain(node.endpoint);
    expect([...fetchUrls, ...tcpUrls].some((u) => u.includes(node.tunnelEndpoint!))).toBe(false);
  });

  it('选定 tunnel 却未配置隧道地址：明确报错，不悄悄降级到 direct', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const error = await client
      .call(
        { ...node, preferredRoute: 'tunnel', tunnelEndpoint: null },
        'tok',
        'GET',
        '/state',
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect(calls).toHaveLength(0);
  });
});


describe('node-client: 路由内 fetch→TCP 回退（T1）', () => {
  it('弱网 fetch 抛错时同一路由回退 TCP，成功后 via=tcp', async () => {
    const fetchUrls: string[] = [];
    const tcpUrls: string[] = [];
    const client = new HttpAgentClient(
      async (url) => {
        fetchUrls.push(url);
        throw new Error('网络连接失败 ECONNRESET');
      },
      async (url) => {
        tcpUrls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.route).toBe('direct');
    expect(response.via).toBe('tcp');
    expect(response.status).toBe(200);
    expect(fetchUrls).toHaveLength(1);
    expect(tcpUrls).toHaveLength(1);
    expect(tcpUrls[0]).toContain(node.endpoint);
  });

  it('fetch 命中边缘 403 拦截（error 1003 场景）时回退 TCP', async () => {
    const client = new HttpAgentClient(
      async (url) => {
        if (url.startsWith(node.endpoint)) {
          return new Response('error code: 1003', { status: 403 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.route).toBe('direct');
    expect(response.via).toBe('tcp');
  });

  it('Agent 自身的 403 错误信封不回退、不换路，原样返回（回归：曾一律判为边缘拦截）', async () => {
    const tcpUrls: string[] = [];
    const envelope = { ok: false, error: { code: 'unauthorized', message: '签名无效' } };
    const client = new HttpAgentClient(
      async () => new Response(JSON.stringify(envelope), { status: 403 }),
      async (url) => {
        tcpUrls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'POST', '/apps/wireguard/apply', {
      config: {},
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(envelope);
    expect(response.via).toBe('fetch');
    expect(response.route).toBe('direct');
    expect(tcpUrls).toHaveLength(0);
  });

  it('403 但非 Agent 信封（网关/代理错误）仍回退 TCP', async () => {
    const tcpUrls: string[] = [];
    const client = new HttpAgentClient(
      async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
      async (url) => {
        tcpUrls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.via).toBe('tcp');
    expect(tcpUrls).toHaveLength(1);
  });

  it('Agent 自身 404 不回退、原样返回', async () => {
    const tcpUrls: string[] = [];
    const client = new HttpAgentClient(
      async () => new Response(JSON.stringify({ ok: false }), { status: 404 }),
      async (url) => {
        tcpUrls.push(url);
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.status).toBe(404);
    expect(tcpUrls).toHaveLength(0);
  });

  it('方案内 fetch 与 TCP 均失败：返回 HubUnreachableError，不切换方案', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(
      async (url) => {
        calls.push(`fetch:${url}`);
        throw new Error('fetch 弱网');
      },
      async (url) => {
        calls.push(`tcp:${url}`);
        throw new Error('TCP 连接超时（>8000ms）');
      },
    );
    const error = await client.call(node, 'tok', 'GET', '/state').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`fetch:${node.endpoint}`);
    expect(calls[1]).toContain(`tcp:${node.endpoint}`);
    expect(calls.some((c) => c.includes(node.tunnelEndpoint!))).toBe(false);
  });

});

describe('node-client: 回退的重签与预算（批次 E/N，F-M1）', () => {
  it('F-M1：fetch 超时→TCP 回退重新签名（nonce/ts/sig 不同），幂等键保留', async () => {
    let fetchHeaders: Record<string, string> = {};
    let tcpHeaders: Record<string, string> = {};
    const client = new HttpAgentClient(
      async (_url, init) => {
        fetchHeaders = (init?.headers ?? {}) as Record<string, string>;
        // 模拟 fetch 超时：请求已发出（可能已被 Agent 接收、消耗 nonce）后中断
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('TimeoutError: The operation was aborted due to timeout');
      },
      async (_url, init) => {
        tcpHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'POST', '/apps/x/apply', { a: 1 }, {
      idempotencyKey: 'idem-1',
    });
    expect(response.via).toBe('tcp');
    // 回退请求的签名材料必须是新生成的：同 nonce 重放会被 Agent 401 拒绝
    expect(tcpHeaders['x-khc-nonce']).not.toBe(fetchHeaders['x-khc-nonce']);
    expect(tcpHeaders['x-khc-sig']).not.toBe(fetchHeaders['x-khc-sig']);
    expect(tcpHeaders['x-khc-ts']).toBeTruthy();
    expect(fetchHeaders['x-khc-nonce']).toBeTruthy();
    // 幂等键跨尝试保留（写动作由 Agent 侧去重兜底）
    expect(tcpHeaders['idempotency-key']).toBe('idem-1');
    expect(fetchHeaders['idempotency-key']).toBe('idem-1');
  });

  it('F-M1：边缘 403 拦截→TCP 回退同样重新签名', async () => {
    let fetchHeaders: Record<string, string> = {};
    let tcpHeaders: Record<string, string> = {};
    const client = new HttpAgentClient(
      async (_url, init) => {
        fetchHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response('error code: 1003', { status: 403 });
      },
      async (_url, init) => {
        tcpHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.via).toBe('tcp');
    expect(tcpHeaders['x-khc-nonce']).not.toBe(fetchHeaders['x-khc-nonce']);
    expect(tcpHeaders['x-khc-sig']).not.toBe(fetchHeaders['x-khc-sig']);
  });

  it('超时预算不叠加：TCP 回退只拿剩余预算', async () => {
    let tcpTimeout = Number.NaN;
    const client = new HttpAgentClient(
      // fetch 阶段真实耗时 ~1.2s 后失败
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        throw new Error('fetch 弱网');
      },
      async (_url, init) => {
        tcpTimeout = init?.timeoutMs ?? Number.NaN;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(node, 'tok', 'GET', '/state');
    expect(response.via).toBe('tcp');
    // 剩余预算 = 10000 - 已耗 ~1200，落在 (8000, 10000] 内且不叠加
    expect(tcpTimeout).toBeLessThanOrEqual(10_000);
    expect(tcpTimeout).toBeGreaterThanOrEqual(8_000);
  });

  it('彻底不可达进入冷却：后续调用快速失败、不再打满预算', async () => {
    let attempts = 0;
    const client = new HttpAgentClient(
      async (url) => {
        attempts += 1;
        throw new Error(`weak net ${url}`);
      },
      async (url) => {
        attempts += 1;
        throw new Error(`tcp refused ${url}`);
      },
      10_000,
    );
    await expect(client.call(node, 'tok', 'GET', '/state')).rejects.toBeInstanceOf(
      HubUnreachableError,
    );
    const attemptsAfterFirst = attempts;
    // 冷却期内：立即失败，fetch/TCP 都不再被调用
    await expect(client.call(node, 'tok', 'GET', '/state')).rejects.toMatchObject({
      code: 'hub_unreachable',
    });
    expect(attempts).toBe(attemptsAfterFirst);
    // 诊断探测跳过冷却，真实探测
    await expect(
      client.call(node, 'tok', 'GET', '/state', undefined, { bypassCooldown: true }),
    ).rejects.toBeInstanceOf(HubUnreachableError);
    expect(attempts).toBeGreaterThan(attemptsAfterFirst);
  });

  it('冷却期内成功（如诊断后恢复）即清除冷却', async () => {
    let down = true;
    const client = new HttpAgentClient(
      async () => {
        if (down) throw new Error('weak net');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      async () => {
        if (down) throw new Error('tcp refused');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      60_000,
    );
    await expect(client.call(node, 'tok', 'GET', '/state')).rejects.toBeInstanceOf(
      HubUnreachableError,
    );
    // 冷却中普通调用快速失败
    await expect(client.call(node, 'tok', 'GET', '/state')).rejects.toMatchObject({
      code: 'hub_unreachable',
    });
    // bypassCooldown 探测成功 → 冷却清除，普通调用恢复
    down = false;
    const probe = await client.call(node, 'tok', 'GET', '/state', undefined, {
      bypassCooldown: true,
    });
    expect(probe.status).toBe(200);
    const recovered = await client.call(node, 'tok', 'GET', '/state');
    expect(recovered.status).toBe(200);
  });

  it('自签证书错误给出可理解提示（区别于网络不可达）', async () => {
    const client = new HttpAgentClient(
      async (url) => {
        if (url.startsWith(node.endpoint)) {
          throw new Error('unable to verify the first certificate');
        }
        throw new Error('weak net');
      },
      async () => {
        throw new Error('TCP 直连失败: certificate: self-signed certificate in chain');
      },
    );
    const error = await client.call(node, 'tok', 'GET', '/state').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    const routeErrors = (error as HubUnreachableError).routeErrors;
    for (const message of Object.values(routeErrors)) {
      expect(message).toContain('自签名证书');
    }
  });
});

describe('node-client: TCP 通道（裸 IP）', () => {
  it('IP 节点走 tcpFetch，并回报 via=tcp', async () => {
    const ipNode: AgentNode = {
      id: 'nd_ip',
      endpoint: 'http://203.0.113.12:8880',
      tunnelEndpoint: null,
      preferredRoute: 'direct',
    };
    const calls: string[] = [];
    const client = new HttpAgentClient(
      async () => {
        throw new Error('fetch 不应被调用');
      },
      async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    const response = await client.call(ipNode, 'tok', 'GET', '/state');
    expect(response.via).toBe('tcp');
    expect(response.status).toBe(200);
    expect(calls[0]).toBe('http://203.0.113.12:8880/state');
  });
});

describe('node-client: R-1 业务 5xx 信封按普通响应返回（真实客户端回归）', () => {
  const applyFailedBody = {
    ok: false,
    error: { code: 'apply_failed', message: '应用失败，已自动回滚：wg-quick 启动失败' },
  };

  it('apply_failed 500 信封：返回响应而非 HubUnreachableError（troubleshooting §6 的承诺）', async () => {
    const client = new HttpAgentClient(async () => {
      return new Response(JSON.stringify(applyFailedBody), { status: 500 });
    });
    const response = await client.call(node, 'tok', 'POST', '/apps/wireguard/apply', { a: 1 }, {
      idempotencyKey: 'idem-r1',
    });
    expect(response.status).toBe(500);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('apply_failed');
    expect(body.error.message).toContain('已自动回滚');
    expect(response.route).toBe('direct');
  });

  it('选定方案 5xx 信封不切换方案——写动作只调用一次（防重复执行）', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(applyFailedBody), { status: 500 });
    });
    const response = await client.call(node, 'tok', 'POST', '/apps/wireguard/apply', { a: 1 }, {
      idempotencyKey: 'idem-r1-once',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(node.endpoint);
    expect(response.status).toBe(500);
    // 后续调用不再受失败冷却影响（节点已被证明可达）
    const again = await client.call(node, 'tok', 'GET', '/state');
    expect(again.status).toBe(500);
  });

  it('非信封 5xx（网关 HTML 错误页）：视为方案失败，返回 HubUnreachableError，不切换方案', async () => {
    const calls: string[] = [];
    const client = new HttpAgentClient(async (url) => {
      calls.push(url);
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    });
    const error = await client.call(node, 'tok', 'GET', '/state').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(node.endpoint);
  });
});

describe('node-client: R-3 传输超时类型化标记（timedOut）', () => {
  it('fetch/TCP 双双超时：HubUnreachableError.timedOut=true', async () => {
    const client = new HttpAgentClient(
      async () => {
        // AbortSignal.timeout 超时抛 DOMException（name=TimeoutError）
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      async () => {
        throw new TcpTimeoutError('TCP 连接超时（>1000ms）');
      },
    );
    const error = await client.call(node, 'tok', 'POST', '/apps/wireguard/apply').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect((error as HubUnreachableError).timedOut).toBe(true);
  });

  it('连接拒绝（非超时）：timedOut=false', async () => {
    const client = new HttpAgentClient(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => {
        throw new Error('connection refused');
      },
    );
    const error = await client.call(node, 'tok', 'POST', '/apps/wireguard/apply').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HubUnreachableError);
    expect((error as HubUnreachableError).timedOut).toBe(false);
  });

  it('混掺场景：fetch 连接拒绝 + TCP 超时 → timedOut=true（请求可能已送达）', async () => {
    const client = new HttpAgentClient(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => {
        throw new TcpTimeoutError('TCP 连接超时（>6000ms）');
      },
    );
    const error = await client.call(node, 'tok', 'GET', '/state').catch((e: unknown) => e);
    expect((error as HubUnreachableError).timedOut).toBe(true);
  });
});
