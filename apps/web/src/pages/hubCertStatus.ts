/**
 * 「证书状态」这一句文案的唯一判定入口（纯函数，便于单测）。
 *
 * 历史坑：只按「面板托管的 Caddy 站点」判定，TLS 由外部反代 / Caddy / Cloudflare
 * Tunnel 终结的节点会被报成「未签发」，而那一刻域名 HTTPS 其实完全可用。
 * 现在优先级改为：控制面实测 → Agent 站点探测 → 明确未知。
 */
import type { TlsProbe } from '@khc/contracts';
import { fmt, zh } from '../i18n/zh';

export interface CertStatusInput {
  /** 节点绑定的域名；未绑定为 null */
  domain: string | null;
  /** GET /nodes/:id/state 附带的控制面实测结论；旧 Worker 不返回 */
  tlsProbe: TlsProbe | null | undefined;
  /** Agent caddy-site 对该域名的站点健康（面板托管站点才有） */
  siteHealth: { state?: string; error?: string } | undefined;
  /** 已知的到期日（YYYY-MM-DD）；未知传 null，不编造 */
  knownNotAfter: string | null;
}

export function resolveCertStatus(input: CertStatusInput): string {
  const { domain, tlsProbe, siteHealth, knownNotAfter } = input;

  // 1) 控制面实测失败：这是硬结论（过期/域名不匹配/不受信），优先于一切。
  if (tlsProbe?.state === 'failed') {
    return fmt(zh.hub.certTlsFailed, { error: tlsProbe.detail ?? 'TLS 校验未通过' });
  }
  // 2) 没有域名时，「证书状态」不是可判定的问题，直接说未绑定域名。
  if (!domain) return zh.hub.certNoDomain;
  // 3) 面板托管的站点：适配器自己探过 HTTPS 与上游，比控制面单点结论更细。
  if (siteHealth) {
    if (siteHealth.state === 'ok') {
      return knownNotAfter ? fmt(zh.hub.certOkExpiry, { date: knownNotAfter }) : zh.hub.certOk;
    }
    if (siteHealth.state === 'warn') {
      return fmt(zh.hub.certWarn, { error: siteHealth.error ?? 'HTTPS 校验未通过' });
    }
    if (siteHealth.state === 'down') {
      return fmt(zh.hub.certDown, { error: siteHealth.error ?? '站点不可达' });
    }
    return zh.hub.certUnknown;
  }
  // 4) 控制面实测通过：没有托管站点也能断言证书有效（外部承载 TLS 的场景）。
  if (tlsProbe?.state === 'verified') {
    return knownNotAfter
      ? fmt(zh.hub.certVerifiedExpiry, { date: knownNotAfter })
      : zh.hub.certVerified;
  }
  // 5) 接入地址本身不是 https：说清「未启用 TLS」，不冒充「未签发」。
  if (tlsProbe?.state === 'none') return zh.hub.certNoTls;
  return zh.hub.certUnknown;
}
