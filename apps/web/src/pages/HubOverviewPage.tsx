import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useHubChannelsContext } from '../app/HubChannelsProvider';
import { agentReleasesQueryOptions, latestNewerAgentRelease } from '../data/agent';
import { ApiError } from '../data/client';
import { pickFailedUnits } from '../data/failedUnits';
import { splitFailedUnits } from '../data/managedUnits';
import { formatBytes, formatRelativeTime } from '../i18n/format';
import { fmt, zh } from '../i18n/zh';
import {
  NodeAccessLine,
  NodeExpiryChip,
  daysLeftFromDate,
  formatCertMetric,
  formatRatioMetric,
} from '../patterns/NodePresentation';
import { TodoChips, type TodoChip } from '../patterns/TodoChips';
import { paths } from '../registry/routes';
import {
  Banner,
  Button,
  Card,
  Grid,
  Link,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  StatusDot,
} from '../ui';

function formatUptime(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function meterTone(pct: number): 'normal' | 'warn' | 'danger' {
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'normal';
}

export default function HubOverviewPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId' });
  const navigate = useNavigate();
  const goTo = (href: string) => void navigate({ href });
  const { overviewQuery, live } = useHubChannelsContext();
  const releasesQuery = useQuery(agentReleasesQueryOptions());

  if (overviewQuery.isLoading && !overviewQuery.data) {
    return (
      <Stack gap={4}>
        <PageHeader title={hubId} />
        <Skeleton height={84} />
        <Skeleton height={220} />
      </Stack>
    );
  }

  if (overviewQuery.error && !overviewQuery.data) {
    const notFound =
      overviewQuery.error instanceof ApiError && overviewQuery.error.status === 404;
    return (
      <Stack gap={4}>
        <PageHeader title={zh.hub.notFound} />
        <Banner
          tone={notFound ? 'neutral' : 'danger'}
          title={fmt(zh.errors.loadTitle, { page: zh.nav.hubOverview })}
          description={(overviewQuery.error as Error).message}
          action={
            notFound ? undefined : (
              <Button
                label={zh.common.retry}
                size="sm"
                onClick={() => void overviewQuery.refetch()}
              />
            )
          }
        />
      </Stack>
    );
  }

  const data = overviewQuery.data;
  if (!data) {
    return (
      <Stack gap={4}>
        <PageHeader title={zh.hub.notFound} />
      </Stack>
    );
  }

  const { node, reachable, state, overview } = data;
  const snapshot = live.snapshot;
  const ops = snapshot?.ops ?? state?.ops ?? null;
  const hostMetrics = snapshot?.host ?? state?.host ?? null;
  const hostStatic = snapshot?.host ?? state?.host ?? overview.host;
  const agentVersion = snapshot?.agent?.version ?? overview.host?.agentVersion ?? null;
  const newerAgent = latestNewerAgentRelease(releasesQuery.data, agentVersion);

  const authError = Boolean(
    data.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(data.error),
  );

  // 「需要处理」只收面板受管 failed 单元；系统自带单元仅在主机卡保留灰色入口（PR #96/#97）。
  const failedUnitsOrNull =
    pickFailedUnits(snapshot?.ops, state?.ops?.services) ?? overview.failedUnits;
  const { managed: managedFailedUnits, system: systemFailedUnits } = splitFailedUnits(
    failedUnitsOrNull ?? [],
  );

  const todos: TodoChip[] = [];
  for (const unit of managedFailedUnits) {
    todos.push({
      id: `unit:${unit}`,
      tone: 'danger',
      badge: zh.hub.todoFailedUnitBadge,
      name: unit,
      to: paths.hubSection(hubId, 'ops'),
    });
  }
  if (reachable) {
    for (const issue of overview.apps.issues) {
      todos.push({
        id: `app:${issue.name}`,
        tone: 'danger',
        badge: zh.overview.todoAppIssueBadge,
        name: issue.name,
        desc:
          issue.status !== null
            ? `HTTP ${issue.status}`
            : zh.overview.todoAppUnreachable,
        to: paths.hubSection(hubId, 'sites'),
      });
    }
    if (overview.peers.enabled) {
      for (const peerName of overview.peers.offline) {
        todos.push({
          id: `peer:${peerName}`,
          tone: 'warn',
          badge: zh.hub.todoPeerBadge,
          name: peerName,
          to: paths.hubSection(hubId, 'wireguard'),
        });
      }
    }
  }
  for (const cert of overview.certs.expiring) {
    todos.push({
      id: `cert:${cert.id}`,
      tone: cert.daysLeft <= 0 ? 'danger' : 'warn',
      badge:
        cert.daysLeft <= 0 ? zh.overview.todoCertExpiredBadge : zh.hub.todoCertBadge,
      name: cert.name,
      desc:
        cert.daysLeft < 0
          ? zh.overview.todoCertExpired
          : cert.daysLeft === 0
            ? zh.overview.todoCertToday
            : fmt(zh.overview.todoCertExpiring, { days: cert.daysLeft }),
      to: `${paths.settings}?tab=certs&drawer=${encodeURIComponent(`cert:${cert.id}`)}`,
    });
  }

  const expiryDaysLeft = overview.expiresDaysLeft ?? daysLeftFromDate(node.expiresAt);
  if (expiryDaysLeft !== null && expiryDaysLeft <= 14) {
    todos.push({
      id: `node-expiry:${node.id}`,
      tone: expiryDaysLeft <= 0 ? 'danger' : 'warn',
      badge:
        expiryDaysLeft <= 0 ? zh.overview.todoNodeExpiredBadge : zh.overview.todoNodeExpiringBadge,
      name: node.name,
      desc:
        expiryDaysLeft < 0
          ? fmt(zh.overview.todoNodeExpiredDays, { days: Math.abs(expiryDaysLeft) })
          : expiryDaysLeft === 0
            ? zh.overview.todoNodeToday
            : fmt(zh.overview.todoNodeExpiring, { days: expiryDaysLeft }),
      to: paths.hubSection(hubId, 'settings'),
    });
  }
  if (newerAgent && agentVersion) {
    todos.push({
      id: `agent-upgrade:${hubId}`,
      tone: 'warn',
      badge: zh.agent.todoUpgradeBadge,
      name: `Agent v${newerAgent.version}`,
      desc: fmt(zh.agent.todoUpgradeDesc, {
        current: agentVersion,
        latest: newerAgent.version,
      }),
      to: paths.hubSection(hubId, 'settings'),
    });
  }

  // R2/R3 指标带：与首页节点卡片完全同源，只展示非零项。
  const appsMetric = formatRatioMetric({
    online: overview.apps.online,
    total: overview.apps.total,
    reachable,
  });
  const peersMetric =
    overview.peers.enabled
      ? formatRatioMetric({
          online: overview.peers.online,
          total: overview.peers.total,
          reachable,
        })
      : null;
  const certMetric = formatCertMetric(overview.certs);

  const kpis: Array<{
    key: string;
    label: string;
    value: React.ReactNode;
    hint?: string;
    tone?: 'ok' | 'warn' | 'danger' | 'neutral';
  }> = [];

  if (appsMetric) {
    const appHint = [
      overview.apps.staticCount > 0
        ? fmt(zh.overview.kpiStaticSites, { count: overview.apps.staticCount })
        : null,
      overview.apps.redirectCount > 0
        ? fmt(zh.overview.kpiRedirectSites, { count: overview.apps.redirectCount })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    kpis.push({
      key: 'apps',
      label: zh.overview.metricApps,
      value: <span className="num">{appsMetric.text}</span>,
      hint: appHint || undefined,
      tone: appsMetric.tone === 'ok' ? 'neutral' : appsMetric.tone,
    });
  }

  if (peersMetric) {
    const peerHint = [
      overview.peers.interfaceName,
      overview.peers.listenPort ? `:${overview.peers.listenPort}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    kpis.push({
      key: 'peers',
      label: zh.overview.metricPeers,
      value: <span className="num">{peersMetric.text}</span>,
      hint: peerHint || undefined,
      tone: peersMetric.tone === 'ok' ? 'neutral' : peersMetric.tone,
    });
  }

  if (overview.forwards.total > 0) {
    const forwardHint = [
      overview.forwards.tcpCount > 0 ? `TCP ${overview.forwards.tcpCount}` : null,
      overview.forwards.udpCount > 0 ? `UDP ${overview.forwards.udpCount}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    kpis.push({
      key: 'forwards',
      label: zh.overview.metricForwards,
      value: (
        <span className="num">
          {fmt(zh.overview.metricForwardsValue, { count: overview.forwards.total })}
        </span>
      ),
      hint: forwardHint || undefined,
    });
  }

  if (certMetric) {
    kpis.push({
      key: 'certs',
      label: zh.overview.metricCerts,
      value: <span className="num">{certMetric.text}</span>,
      hint: zh.overview.certsHintLibrary,
      tone: certMetric.tone,
    });
  }

  const hasApps = overview.apps.items.length > 0;
  const hasPeers = overview.peers.enabled && overview.peers.items.length > 0;
  const hasForwards = overview.forwards.items.length > 0;
  const hasNetwork = hasPeers || hasForwards;
  const showLeftCard = hasApps || hasNetwork;

  // 主机卡实时资源条（仅在读到百分比数值时展示，离线时不造 0% / —）。
  const cpuPct = ops?.cpu?.usagePercent ?? null;
  const memPct = ops?.mem?.percent ?? null;
  const memUsed = ops?.mem?.used ?? null;
  const memTotal = ops?.mem?.total ?? null;
  const diskPct = ops?.disks?.[0]?.percent ?? null;
  const loadAvg = hostMetrics?.load?.[0] ?? ops?.cpu?.load?.[0] ?? null;

  const meters: Array<{ key: string; label: string; pct: number; detail?: string }> = [];
  if (typeof cpuPct === 'number' && Number.isFinite(cpuPct)) {
    meters.push({
      key: 'cpu',
      label: zh.hub.meterCpu,
      pct: Math.max(0, Math.min(100, cpuPct)),
      detail: loadAvg !== null ? fmt(zh.hub.meterLoad, { load: loadAvg.toFixed(2) }) : undefined,
    });
  }
  if (typeof memPct === 'number' && Number.isFinite(memPct)) {
    meters.push({
      key: 'mem',
      label: zh.hub.meterMem,
      pct: Math.max(0, Math.min(100, memPct)),
      detail:
        memUsed !== null && memTotal !== null
          ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
          : undefined,
    });
  }
  if (typeof diskPct === 'number' && Number.isFinite(diskPct)) {
    meters.push({
      key: 'disk',
      label: zh.hub.meterDisk,
      pct: Math.max(0, Math.min(100, diskPct)),
    });
  }

  const sysInfo = [hostStatic?.hostname, hostStatic?.os, hostStatic?.kernel]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join(' · ');
  const uptimeText = formatUptime(hostStatic?.uptime);
  const services =
    snapshot?.ops?.services?.services && snapshot.ops.services.services.length > 0
      ? snapshot.ops.services.services
      : overview.managedServices;
  const runningServices = services.filter(
    (service) => service.state === 'active' || service.state === 'running',
  ).length;

  const hostCard = (
    <Card
      title={zh.hub.hostTitle}
      action={<Link to={paths.hubSection(hubId, 'ops')} label={zh.hub.enterHost} />}
    >
      <Stack gap={3}>
        {meters.length > 0 ? (
          <div className="ui-host-meters">
            {meters.map((meter) => {
              const tone = meterTone(meter.pct);
              const pctText =
                meter.key === 'cpu' ? `${meter.pct.toFixed(1)}%` : `${meter.pct.toFixed(0)}%`;
              return (
                <div className="ui-meter" key={meter.key}>
                  <div className="ui-meter-head">
                    <span className="ui-meter-label">{meter.label}</span>
                    <span className="ui-meter-val num">
                      {pctText}
                      {meter.detail ? (
                        <span className="ui-meter-detail"> · {meter.detail}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="ui-meter-track">
                    <div
                      className={`ui-meter-fill${tone === 'normal' ? '' : ` is-${tone}`}`}
                      style={{ width: `${meter.pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : !reachable ? (
          <p className="ui-muted">{zh.hub.hostOfflineMetrics}</p>
        ) : null}

        {sysInfo ? (
          <Row justify="between" gap={3} wrap>
            <span className="ui-muted">{zh.hub.hostOs}</span>
            <span>{sysInfo}</span>
          </Row>
        ) : null}

        {uptimeText ? (
          <Row justify="between" gap={3} wrap>
            <span className="ui-muted">{zh.hub.hostUptime}</span>
            <span>{uptimeText}</span>
          </Row>
        ) : null}

        {services.length > 0 || managedFailedUnits.length > 0 ? (
          <Stack gap={2}>
            <Row justify="between" gap={3} wrap>
              <span className="ui-muted">{zh.hub.managedServicesTitle}</span>
              <span className="num">
                {managedFailedUnits.length > 0
                  ? fmt(zh.hub.servicesFailedCount, { count: managedFailedUnits.length })
                  : `${runningServices} / ${services.length}`}
              </span>
            </Row>
            {services.length > 0 ? (
              <Row gap={3} wrap>
                {services.slice(0, 8).map((service) => (
                  <span className="ui-service-chip" key={service.name}>
                    <StatusDot
                      tone={
                        service.state === 'active' || service.state === 'running'
                          ? 'ok'
                          : 'neutral'
                      }
                    />
                    {service.name}
                  </span>
                ))}
                {services.length > 8 ? (
                  <span className="ui-muted">等 {services.length} 个</span>
                ) : null}
              </Row>
            ) : null}
          </Stack>
        ) : null}

        {systemFailedUnits.length > 0 ? (
          <button
            type="button"
            className="ui-service-row is-more"
            onClick={() => goTo(paths.hubSection(hubId, 'ops'))}
          >
            <span className="ui-service-name ui-muted">
              {fmt(zh.hub.systemUnitsFailed, { count: systemFailedUnits.length })}
            </span>
            <span className="ui-service-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ) : null}
      </Stack>
    </Card>
  );

  return (
    <Stack gap={4}>
      <PageHeader
        title={node.name}
        actions={
          node.expiresAt ? (
            <NodeExpiryChip expiresAt={node.expiresAt} daysLeft={expiryDaysLeft} />
          ) : undefined
        }
      >
        <NodeAccessLine
          hub={node}
          accessCert={overview.accessCert}
          trailing={agentVersion ? `Agent v${agentVersion}` : undefined}
        />
      </PageHeader>

      {authError ? (
        <Banner
          tone="danger"
          title={zh.hub.authFailedTitle}
          description={zh.hub.authFailedHint}
          action={
            <Button
              label={zh.hub.authFailedAction}
              size="sm"
              onClick={() => goTo(paths.hubSection(hubId, 'settings'))}
            />
          }
        />
      ) : !reachable && node.lastSeenAt === null ? (
        <Banner
          tone="info"
          title={zh.hub.notInstalledTitle}
          description={zh.hub.notInstalledHint}
          action={
            <Button
              label={zh.hub.notInstalledAction}
              size="sm"
              variant="primary"
              onClick={() => goTo(`${paths.hubSection(hubId, 'settings')}?action=install`)}
            />
          }
        />
      ) : null}

      {kpis.length > 0 ? (
        <div className="ui-kpi-strip" role="region" aria-label={zh.nav.hubOverview}>
          {kpis.map((item) => (
            <div
              className={`ui-stat${
                item.tone === 'danger'
                  ? ' ui-stat--danger'
                  : item.tone === 'warn'
                    ? ' ui-stat--warn'
                    : ''
              }`}
              key={item.key}
            >
              <div className="ui-stat-head">
                <span className="ui-stat-label">{item.label}</span>
              </div>
              <div className="ui-stat-value">{item.value}</div>
              {item.hint ? <div className="ui-stat-hint">{item.hint}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <TodoChips items={todos} onOpen={goTo} />

      {showLeftCard ? (
        <Grid cols={2}>
          <Card
            title={hasApps ? zh.nav.sites : zh.nav.wireguard}
            action={
              <Link
                to={
                  hasApps
                    ? paths.hubSection(hubId, 'sites')
                    : paths.hubSection(hubId, 'wireguard')
                }
                label={hasApps ? zh.hub.enterSites : zh.hub.enterNetwork}
              />
            }
          >
            <Stack gap={3}>
              {hasApps ? (
                <div className="ui-overview-list">
                  {overview.apps.items.map((item) => {
                    const dotTone =
                      item.verdict === 'online'
                        ? 'ok'
                        : item.verdict === 'issue'
                          ? 'danger'
                          : 'neutral';
                    return (
                      <button
                        type="button"
                        key={item.name}
                        className="ui-overview-row"
                        onClick={() => goTo(paths.hubSection(hubId, 'sites'))}
                      >
                        <StatusDot tone={dotTone} />
                        <span className="ui-overview-name">{item.name}</span>
                        <span className="ui-overview-mono ui-muted">
                          {item.upstream || item.domain}
                        </span>
                        {item.verdict === 'issue' ? (
                          <span className="ui-overview-issue num">
                            {item.status !== null
                              ? `HTTP ${item.status}`
                              : zh.overview.todoAppUnreachable}
                          </span>
                        ) : null}
                        <span className="ui-overview-chevron" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {hasNetwork ? (
                <Stack gap={2}>
                  {hasApps ? (
                    <div className="ui-overview-subhead">
                      <span>{zh.hub.networkSection}</span>
                      <Link
                        to={paths.hubSection(hubId, 'wireguard')}
                        label={zh.hub.enterNetwork}
                      />
                    </div>
                  ) : null}
                  <div className="ui-overview-list">
                    {hasPeers
                      ? overview.peers.items.map((peer) => (
                          <button
                            type="button"
                            key={`peer:${peer.name}`}
                            className="ui-overview-row"
                            onClick={() => goTo(paths.hubSection(hubId, 'wireguard'))}
                          >
                            <StatusDot tone={peer.online === true ? 'ok' : 'neutral'} />
                            <span className="ui-overview-name">{peer.name}</span>
                            <span className="ui-overview-meta ui-muted">
                              {peer.latestHandshake
                                ? formatRelativeTime(peer.latestHandshake)
                                : zh.hub.peerUnshaken}
                            </span>
                            <span className="ui-overview-chevron" aria-hidden="true">
                              ›
                            </span>
                          </button>
                        ))
                      : null}
                    {overview.forwards.items.map((fw) => (
                      <button
                        type="button"
                        key={`fw:${fw.name}`}
                        className="ui-overview-row"
                        onClick={() => goTo(paths.hubSection(hubId, 'wireguard'))}
                      >
                        <StatusDot
                          tone={
                            fw.active === true
                              ? 'ok'
                              : fw.active === false
                                ? 'danger'
                                : 'neutral'
                          }
                        />
                        <span className="ui-overview-name">{fw.name}</span>
                        <span className="ui-overview-mono ui-muted">
                          :{fw.listenPort} → {fw.targetHost}:{fw.targetPort}
                        </span>
                        <span className="ui-overview-meta ui-muted">
                          {fw.protocol.toUpperCase()}
                        </span>
                        <span className="ui-overview-chevron" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    ))}
                  </div>
                </Stack>
              ) : null}
            </Stack>
          </Card>
          {hostCard}
        </Grid>
      ) : (
        hostCard
      )}
    </Stack>
  );
}
