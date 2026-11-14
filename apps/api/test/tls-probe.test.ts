/**
 * 控制面 TLS 结论分类（apps/api/src/lib/tls-probe.ts）。
 *
 * 关键约束：Workers 拿不到对端证书字段，所以「https 探测通过 = 证书有效」，
 * 但网络类失败只能说未知，不能顺势报成证书故障。
 */
import { describe, expect, it } from 'vitest';
import { classifyTlsProbe } from '../src/lib/tls-probe';

describe('classifyTlsProbe', () => {
  it('http 接入是「未启用 TLS」，不是「未签发」', () => {
    const probe = classifyTlsProbe({
      endpoint: 'http://203.0.113.20:8880',
      reachable: false,
      error: 'connect timeout',
      now: 100,
    });
    expect(probe).toEqual({ state: 'none', endpoint: 'http://203.0.113.20:8880', detail: null, checkedAt: 100 });
  });

  it('https 且拿到响应 = 证书对该主机名有效且受信', () => {
    const probe = classifyTlsProbe({ endpoint: 'https://hub.example.com:8443', reachable: true, now: 7 });
    expect(probe.state).toBe('verified');
    expect(probe.detail).toBeNull();
    expect(probe.checkedAt).toBe(7);
  });

  it('证书类失败判为 failed 并保留原文', () => {
    const detail =
      'direct: fetch: 证书校验失败（节点可能使用自签名证书；控制面无法校验其 HTTPS 证书）: unable to verify the first certificate';
    const probe = classifyTlsProbe({
      endpoint: 'https://hub.example.com:8443',
      reachable: false,
      error: detail,
      now: 1,
    });
    expect(probe.state).toBe('failed');
    expect(probe.detail).toBe(detail);
  });

  it.each([
    'direct: fetch: TLS handshake timeout',
    'direct: fetch: error constructing cert chain',
    'direct: fetch: request failed: SSL_ERROR',
    'direct: fetch: self-signed certificate in chain',
  ])('识别常见的 TLS 报错变体：%s', (detail) => {
    expect(
      classifyTlsProbe({ endpoint: 'https://h.example.com', reachable: false, error: detail }).state,
    ).toBe('failed');
  });

  it('网络类失败只说未知，不报成证书故障', () => {
    for (const detail of [
      'direct: fetch: connect timeout',
      'direct: fetch: getaddrinfo ENOTFOUND hub.example.com',
      'direct: tcp: connection refused',
    ]) {
      const probe = classifyTlsProbe({ endpoint: 'https://hub.example.com', reachable: false, error: detail });
      expect(probe.state, detail).toBe('unknown');
      expect(probe.detail).toBe(detail);
    }
  });

  it('endpoint 缺失或非法时按非 https 处理，不抛异常', () => {
    for (const endpoint of [null, '', 'not a url', 'hub.example.com:8443']) {
      expect(classifyTlsProbe({ endpoint, reachable: true }).state, String(endpoint)).toBe('none');
    }
  });
});
