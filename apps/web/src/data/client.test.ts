import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './client';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function captureFetch(): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('成功响应返回解析后的 JSON', async () => {
    mockFetch(200, { ok: true });
    await expect(apiRequest('/api/v1/health')).resolves.toEqual({ ok: true });
  });

  it('契约化错误映射为 ApiError（含字段级错误）', async () => {
    mockFetch(400, {
      error: { code: 'validation_failed', message: '参数校验失败', fields: { name: '必填' } },
    });
    await expect(apiRequest('/api/v1/nodes')).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      fields: { name: '必填' },
    });
  });

  it('非契约错误退化为 http_error，且不泄露响应内容', async () => {
    mockFetch(502, { unexpected: 'bad gateway' });
    const error = await apiRequest('/api/v1/nodes').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('http_error');
    expect((error as ApiError).message).toBe('HTTP 502');
  });

  it('无 body 的 POST 也按 JSON 发送（项目探测曾因此被判 415）', async () => {
    const calls = captureFetch();
    await apiRequest('/api/v1/nodes/probe', { method: 'POST' });
    const init = (calls[0]?.init ?? {}) as RequestInit;
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('无 body 的 DELETE 也按 JSON 发送（删除公钥曾因此被判 415）', async () => {
    const calls = captureFetch();
    await apiRequest('/api/v1/ssh-keys/key_1', { method: 'DELETE' });
    const init = (calls[0]?.init ?? {}) as RequestInit;
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('GET 不额外添加 content-type，也不发送 body', async () => {
    const calls = captureFetch();
    await apiRequest('/api/v1/nodes');
    const init = (calls[0]?.init ?? {}) as RequestInit;
    expect((init.headers as Headers).has('content-type')).toBe(false);
    expect(init.body).toBeUndefined();
  });
});
