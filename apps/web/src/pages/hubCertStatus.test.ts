/**
 * 概况页「证书状态」判定（apps/web/src/pages/hubCertStatus.ts）。
 *
 * 回归目标：TLS 由外部反代 / Caddy / Tunnel 终结的节点，过去会被报成
 * 「未签发（该域名未建站点）」——而那一刻域名 HTTPS 完全可用。现在控制面实测
 * （/state 附带的 tls 结论）优先，只有真的没证据时才说未知。
 */
import { describe, expect, it } from 'vitest';
import type { TlsProbe } from '@khc/contracts';
import { resolveCertStatus } from './hubCertStatus';
import { fmt, zh } from '../i18n/zh';

function probe(state: TlsProbe['state'], detail: string | null = null): TlsProbe {
  return { state, endpoint: 'https://hub.example.com:8443', detail, checkedAt: 100 };
}

describe('resolveCertStatus', () => {
  it('fixture 自检：文案键存在（防止断言在键缺失时静默通过）', () => {
    expect(zh.hub.certVerified).toContain('已签发');
    expect(zh.hub.certNoTls).toContain('未启用 TLS');
  });

  it('控制面实测通过 + 无托管站点 → 已签发（不再误报未签发）', () => {
    expect(
      resolveCertStatus({ domain: 'hub.example.com', tlsProbe: probe('verified'), siteHealth: undefined, knownNotAfter: null }),
    ).toBe(zh.hub.certVerified);
  });

  it('控制面实测通过 + 已知到期日 → 带日期', () => {
    expect(
      resolveCertStatus({
        domain: 'hub.example.com',
        tlsProbe: probe('verified'),
        siteHealth: undefined,
        knownNotAfter: '2027-02-12',
      }),
    ).toBe(fmt(zh.hub.certVerifiedExpiry, { date: '2027-02-12' }));
  });

  it('证书类失败优先于站点健康，并带出原文', () => {
    const text = resolveCertStatus({
      domain: 'hub.example.com',
      tlsProbe: probe('failed', '证书已过期'),
      siteHealth: { state: 'ok' },
      knownNotAfter: null,
    });
    expect(text).toBe(fmt(zh.hub.certTlsFailed, { error: '证书已过期' }));
  });

  it('托管站点健康结果比控制面单点结论更细：ok/warn/down 三态照旧', () => {
    const base = { domain: 'hub.example.com', tlsProbe: probe('verified'), knownNotAfter: null };
    expect(resolveCertStatus({ ...base, siteHealth: { state: 'ok' } })).toBe(zh.hub.certOk);
    expect(resolveCertStatus({ ...base, siteHealth: { state: 'warn', error: '上游 502' } })).toBe(
      fmt(zh.hub.certWarn, { error: '上游 502' }),
    );
    expect(resolveCertStatus({ ...base, siteHealth: { state: 'down' } })).toBe(
      fmt(zh.hub.certDown, { error: '站点不可达' }),
    );
  });

  it('未绑定域名 → 未绑定域名（即便端点有 TLS 结论）', () => {
    expect(
      resolveCertStatus({ domain: null, tlsProbe: probe('verified'), siteHealth: undefined, knownNotAfter: null }),
    ).toBe(zh.hub.certNoDomain);
  });

  it('端点非 https → 未启用 TLS，不冒充未签发', () => {
    expect(
      resolveCertStatus({
        domain: 'hub.example.com',
        tlsProbe: { state: 'none', endpoint: 'http://203.0.113.20:8880', detail: null, checkedAt: 1 },
        siteHealth: undefined,
        knownNotAfter: null,
      }),
    ).toBe(zh.hub.certNoTls);
  });

  it('网络类失败（unknown）与旧 Worker（无 tls 字段）都落到未知', () => {
    for (const tlsProbe of [probe('unknown', 'connect timeout'), null, undefined]) {
      expect(
        resolveCertStatus({ domain: 'hub.example.com', tlsProbe, siteHealth: undefined, knownNotAfter: null }),
      ).toBe(zh.hub.certUnknown);
    }
  });
});
