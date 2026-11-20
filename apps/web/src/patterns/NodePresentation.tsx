import type { ReactNode } from 'react';
import type { Node, NodeAccessCert, NodeAccessMode } from '@khc/contracts';
import { fmt, zh } from '../i18n/zh';
import { Truncate, type Tone } from '../ui';

/** 提取接入地址的主机与非默认端口（去掉 http(s):// 与末尾斜杠）。 */
export function endpointHost(endpoint: string | null | undefined): string {
  const raw = (endpoint ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.host) return parsed.host;
  } catch {
    // 非标准 URL 字符串退回纯正则去前缀
  }
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

export function accessModeShortLabel(mode: NodeAccessMode | undefined): string {
  switch (mode) {
    case 'tunnel':
      return zh.hubs.accessModeTunnel;
    case 'ip':
      return zh.hubs.accessModeIp;
    default:
      return zh.hubs.accessModeDomain;
  }
}

export interface AccessSecurityInfo {
  tone: Tone;
  text: string;
}

/** R5 单行安全说明：域名含接入证书到期状态；Tunnel 由边缘托管；IP 为明文。 */
export function accessSecurityInfo(
  hub: Pick<Node, 'accessMode'>,
  accessCert?: NodeAccessCert | null,
): AccessSecurityInfo {
  if (hub.accessMode === 'tunnel') {
    return { tone: 'neutral', text: zh.overview.accessTunnelHosted };
  }
  if (hub.accessMode === 'ip') {
    return { tone: 'neutral', text: zh.overview.accessIpPlain };
  }
  if (accessCert?.daysLeft !== null && accessCert?.daysLeft !== undefined) {
    if (accessCert.daysLeft < 0) {
      return { tone: 'danger', text: zh.overview.accessCertExpired };
    }
    if (accessCert.daysLeft === 0) {
      return { tone: 'danger', text: zh.overview.accessCertToday };
    }
    return {
      tone: accessCert.daysLeft <= 14 ? 'warn' : 'ok',
      text: fmt(zh.overview.accessCertDaysLeft, { days: accessCert.daysLeft }),
    };
  }
  if (accessCert?.tlsState === 'failed') {
    return { tone: 'danger', text: zh.overview.accessCertFailed };
  }
  if (accessCert?.tlsState === 'verified') {
    return { tone: 'ok', text: zh.overview.accessCertVerified };
  }
  return { tone: 'neutral', text: zh.overview.accessHttps };
}

export type RatioMetric =
  | { kind: 'all-offline'; tone: 'danger'; online: 0; total: number; text: string }
  | { kind: 'total-only'; tone: 'neutral'; online: null; total: number; text: string }
  | { kind: 'ratio'; tone: 'ok' | 'warn'; online: number; total: number; text: string };

/**
 * R2/R3 比例指标格式化（应用在线 / Peer 在线通用）：
 * - total <= 0 → null（调用方隐藏整项，不出 0 / 0）
 * - reachable === true && online === 0 → 红色 `{total} 个离线`
 * - 节点不可达或探测中（!reachable 或 online == null）→ 中性 `{total}`（不伪造 0 / N）
 * - 其余 → `{online} / {total}`（部分离线标 warn）
 */
export function formatRatioMetric(input: {
  online: number | null | undefined;
  total: number;
  reachable: boolean | null | undefined;
}): RatioMetric | null {
  const { online, total, reachable } = input;
  if (total <= 0) return null;
  if (reachable === true && online === 0) {
    return {
      kind: 'all-offline',
      tone: 'danger',
      online: 0,
      total,
      text: fmt(zh.overview.allOfflineCount, { count: total }),
    };
  }
  if (reachable !== true || online === null || online === undefined) {
    return {
      kind: 'total-only',
      tone: 'neutral',
      online: null,
      total,
      text: String(total),
    };
  }
  return {
    kind: 'ratio',
    tone: online < total ? 'warn' : 'ok',
    online,
    total,
    text: `${online} / ${total}`,
  };
}

export interface CertMetric {
  count: number;
  daysLeft: number | null;
  tone: 'neutral' | 'warn' | 'danger';
  countText: string;
  daysText: string | null;
  text: string;
}

/** R2 证书指标格式化：0 张返回 null；含最短剩余天数，≤14d 标 warn，≤0d 标 danger。 */
export function formatCertMetric(input: {
  count: number;
  soonestDaysLeft: number | null;
}): CertMetric | null {
  const { count, soonestDaysLeft } = input;
  if (count <= 0) return null;
  if (soonestDaysLeft === null) {
    const countText = fmt(zh.overview.certMetricCount, { count });
    return {
      count,
      daysLeft: null,
      tone: 'neutral',
      countText,
      daysText: null,
      text: countText,
    };
  }
  if (soonestDaysLeft < 0) {
    return {
      count,
      daysLeft: soonestDaysLeft,
      tone: 'danger',
      countText: fmt(zh.overview.certMetricCount, { count }),
      daysText: zh.overview.todoCertExpired,
      text: fmt(zh.overview.certMetricExpired, { count }),
    };
  }
  if (soonestDaysLeft === 0) {
    return {
      count,
      daysLeft: 0,
      tone: 'danger',
      countText: fmt(zh.overview.certMetricCount, { count }),
      daysText: zh.overview.todoCertToday,
      text: fmt(zh.overview.certMetricToday, { count }),
    };
  }
  return {
    count,
    daysLeft: soonestDaysLeft,
    tone: soonestDaysLeft <= 14 ? 'warn' : 'neutral',
    countText: fmt(zh.overview.certMetricCount, { count }),
    daysText: `${soonestDaysLeft} 天`,
    text: fmt(zh.overview.certMetricDays, { count, days: soonestDaysLeft }),
  };
}

/** R5 统一连接方式单行：接入方式 chip + 等宽主机 + 安全与证书说明。 */
export function NodeAccessLine({
  hub,
  accessCert,
  trailing,
}: {
  hub: Pick<Node, 'accessMode' | 'endpoint' | 'domain'>;
  accessCert?: NodeAccessCert | null;
  trailing?: ReactNode;
}) {
  const host = endpointHost(hub.endpoint) || hub.domain || '';
  const sec = accessSecurityInfo(hub, accessCert);
  return (
    <div className="ui-access-line">
      <div className="ui-access-main">
        <span className="ui-node-card-access-chip">{accessModeShortLabel(hub.accessMode)}</span>
        {host ? (
          <span className="ui-access-host">
            <Truncate text={host} mode="middle" />
          </span>
        ) : null}
      </div>
      <div className="ui-access-meta">
        <span className={`ui-access-sec ui-access-sec--${sec.tone}`}>{sec.text}</span>
        {trailing ? <span className="ui-access-trailing">{trailing}</span> : null}
      </div>
    </div>
  );
}

/** 计算固定公历日期（YYYY-MM-DD）相对今日 UTC 日期的剩余天数；无效日期返回 null。 */
export function daysLeftFromDate(
  expiresAt: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!expiresAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAt.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const target = new Date(Date.UTC(year, month - 1, day));
  if (
    target.getUTCFullYear() !== year ||
    target.getUTCMonth() !== month - 1 ||
    target.getUTCDate() !== day
  ) {
    return null;
  }
  const now = new Date(nowMs);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const raw = Math.round((target.getTime() - todayUtc) / 86_400_000);
  return Object.is(raw, -0) ? 0 : raw;
}

/** 节点到期徽标（U4）：>14 天中性灰，1–14 天提醒黄，≤0 天警告红；未设置不渲染。 */
export function NodeExpiryChip({
  expiresAt,
  daysLeft,
}: {
  expiresAt: string | null | undefined;
  daysLeft?: number | null;
}) {
  if (!expiresAt) return null;
  const left = daysLeft ?? daysLeftFromDate(expiresAt);
  if (left === null) return null;
  const tone: 'neutral' | 'warn' | 'danger' =
    left <= 0 ? 'danger' : left <= 14 ? 'warn' : 'neutral';
  const text =
    left < 0
      ? fmt(zh.overview.expiryExpiredDays, { days: Math.abs(left) })
      : left === 0
        ? zh.overview.expiryToday
        : fmt(zh.overview.expiryDaysLeft, { days: left });
  return (
    <span
      className={`ui-expiry-chip ui-expiry-chip--${tone} num`}
      title={`${zh.overview.expiryTitle}：${expiresAt}`}
    >
      {text}
    </span>
  );
}
