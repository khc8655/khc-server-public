import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshCfDnsAccount } from './cfDns';

const account = {
  id: 'acc_1',
  name: '主账号',
  accountName: 'Acme',
  hasToken: true,
  enabled: true,
  zones: [{ id: 'zone_1', name: 'example.com' }],
  enabledZoneIds: ['zone_1'],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshCfDnsAccount', () => {
  it('用 JSON 空对象 POST 刷新 Zone，避免写请求守卫 415', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ account, zones: account.zones }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshCfDnsAccount('acc_1');
    expect(result.account.id).toBe('acc_1');
    expect(result.zones).toEqual(account.zones);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/cf-dns/accounts/acc_1/refresh');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('刷新失败时保留契约化错误（不静默降级）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'cf_dns_token_invalid', message: 'Token 无效' } }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await expect(refreshCfDnsAccount('acc_1')).rejects.toMatchObject({
      status: 403,
      code: 'cf_dns_token_invalid',
    });
  });
});
