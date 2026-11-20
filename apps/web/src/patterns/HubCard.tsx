import type { ReactNode } from 'react';
import { hubStatusView, type HubProbePhase, type HubView } from '../data/useHubProbe';
import { zh } from '../i18n/zh';
import { paths } from '../registry/routes';
import { StatusDot, Truncate } from '../ui';
import {
  NodeAccessLine,
  formatCertMetric,
  formatRatioMetric,
  type RatioMetric,
} from './NodePresentation';

interface HubCardProps {
  hub: HubView;
  phase: HubProbePhase;
  onOpen: () => void;
  /** U4：节点到期标签插槽（未设置时不传，不占空间） */
  expirySlot?: ReactNode;
  /** U4：节点是否处于临期/已过期告警状态，用于卡片边框高亮 */
  hasWarn?: boolean;
}

function RatioValue({ metric }: { metric: RatioMetric }) {
  if (metric.kind === 'all-offline') {
    return <span className="ui-node-stat-val is-danger">{metric.text}</span>;
  }
  if (metric.kind === 'total-only') {
    return <span className="ui-node-stat-val num">{metric.text}</span>;
  }
  return (
    <span className={`ui-node-stat-val num${metric.tone === 'warn' ? ' is-warn' : ''}`}>
      {metric.online}
      <small className="ui-node-stat-den">/{metric.total}</small>
    </span>
  );
}

/**
 * 首页节点卡片（三层排版，R2/R3/R5 口径与节点概况页完全同源）：
 * 1. 身份与在线态：名称 + 可选到期标签 + 状态点（在线 / 离线 / 探测中… / 未知）；
 * 2. 连接方式单行（R5）：接入方式 chip + 等宽主机 + HTTPS/证书/明文说明；
 * 3. 四项精简事实（R2/R3）：应用在线 / Peer 在线 / 转发 / 证书，全为 0 不占行。
 */
export function HubCard({ hub, phase, onOpen, expirySlot, hasWarn = false }: HubCardProps) {
  const status = hubStatusView(hub, phase);
  const reachable = hub.probed ? hub.status === 'online' : null;
  const projection = hub.projection;
  const summary = hub.summary;

  const appsMetric = formatRatioMetric({
    online: projection ? projection.apps.online : null,
    total: projection ? projection.apps.total : (summary?.sites?.total ?? 0),
    reachable,
  });

  const peersMetric = formatRatioMetric({
    online: projection ? projection.peers.online : null,
    total: projection
      ? projection.peers.enabled
        ? projection.peers.total
        : 0
      : (summary?.peers ?? 0),
    reachable,
  });

  const forwardsTotal = projection ? projection.forwards.total : (summary?.forwards ?? 0);
  const certMetric = projection ? formatCertMetric(projection.certs) : null;

  const stats: Array<{ key: string; label: string; content: ReactNode }> = [];
  if (appsMetric) {
    stats.push({
      key: 'apps',
      label: zh.overview.metricApps,
      content: <RatioValue metric={appsMetric} />,
    });
  }
  if (peersMetric) {
    stats.push({
      key: 'peers',
      label: zh.overview.metricPeers,
      content: <RatioValue metric={peersMetric} />,
    });
  }
  if (forwardsTotal > 0) {
    stats.push({
      key: 'forwards',
      label: zh.overview.metricForwards,
      content: <span className="ui-node-stat-val num">{forwardsTotal}</span>,
    });
  }
  if (certMetric) {
    stats.push({
      key: 'certs',
      label: zh.overview.metricCerts,
      content: (
        <span
          className={`ui-node-stat-val num${
            certMetric.tone === 'danger'
              ? ' is-danger'
              : certMetric.tone === 'warn'
                ? ' is-warn'
                : ''
          }`}
        >
          {certMetric.count}
          <small className="ui-node-stat-den">
            {' 张'}
            {certMetric.daysText ? ` · ${certMetric.daysText}` : ''}
          </small>
        </span>
      ),
    });
  }

  const isOffline = hub.probed && hub.status === 'offline';
  const accessCert = projection?.accessCert;
  const hasNodeWarn =
    !isOffline &&
    (hasWarn ||
      (reachable === true &&
        ((projection?.apps.issues.length ?? 0) > 0 ||
          (projection?.peers.offline.length ?? 0) > 0 ||
          (projection?.certs.expiring.length ?? 0) > 0 ||
          accessCert?.tlsState === 'failed' ||
          (accessCert?.daysLeft !== null &&
            accessCert?.daysLeft !== undefined &&
            accessCert.daysLeft <= 14))));

  const cardClass = [
    'ui-node-card',
    isOffline ? 'ui-node-card--offline' : hasNodeWarn ? 'ui-node-card--warn' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <a
      className={cardClass}
      href={paths.hub(hub.id)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="ui-node-card-body">
        <div className="ui-node-card-main">
          <div className="ui-node-card-identity">
            <span className="ui-node-card-name">
              <Truncate text={hub.name} />
            </span>
            {expirySlot}
            <span className={`ui-node-card-status is-${status.tone}`}>
              <StatusDot tone={status.tone} />
              <span>{status.label}</span>
            </span>
          </div>
          <NodeAccessLine hub={hub} accessCert={accessCert} />
        </div>

        {stats.length > 0 ? (
          <div className="ui-node-card-stats">
            {stats.map((stat) => (
              <div className="ui-node-stat" key={stat.key}>
                <span className="ui-node-stat-label">{stat.label}</span>
                {stat.content}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </a>
  );
}
