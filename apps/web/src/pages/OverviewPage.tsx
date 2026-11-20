import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { hubOutageDays, useHubProbe } from '../data/useHubProbe';
import { formatRelativeTime } from '../i18n/format';
import { fmt, zh } from '../i18n/zh';
import { NodeExpiryChip, daysLeftFromDate, formatRatioMetric } from '../patterns/NodePresentation';
import { HubCard } from '../patterns/HubCard';
import { TodoChips, type TodoChip } from '../patterns/TodoChips';
import { paths } from '../registry/routes';
import { PANEL_VERSION_LABEL } from '../version';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  Truncate,
} from '../ui';

interface KpiItem {
  key: string;
  label: string;
  value: ReactNode;
  hint: string;
  tone?: 'warn' | 'danger' | 'neutral';
}

export function OverviewPage() {
  const routerNavigate = useNavigate();
  const goTo = (to: string) => void routerNavigate({ href: to });

  // 首页仅需 2 个请求：GET /nodes + POST /nodes/probe（不再拉取 /api/v1/certs）。
  const {
    hubs,
    hubsQuery,
    phase,
    error: probeError,
    probe,
    counts,
    probedAt,
    expiringCerts,
  } = useHubProbe();
  const probing = phase === 'probing';
  const runProbe = () => void probe({ force: true });

  // 聚合「需要处理」分诊列表（R3：离线节点只报节点离线，不重复拆成应用/Peer 离线）。
  const todos: TodoChip[] = [];
  let offlineNodeCount = 0;
  let appIssueCount = 0;
  let offlinePeerCount = 0;

  for (const hub of hubs) {
    if (hub.probed && hub.status === 'offline') {
      offlineNodeCount += 1;
      const outageDays = hubOutageDays(hub);
      todos.push({
        id: `node:${hub.id}`,
        tone: 'danger',
        badge: zh.overview.todoOfflineBadge,
        name: hub.name,
        desc:
          outageDays !== null && outageDays >= 1
            ? fmt(zh.status.staleDays, { days: outageDays })
            : zh.overview.todoOfflineControlUnreachable,
        to: paths.hub(hub.id),
      });
      continue;
    }

    if (hub.probed && hub.status === 'online' && hub.projection) {
      for (const issue of hub.projection.apps.issues) {
        appIssueCount += 1;
        todos.push({
          id: `app:${hub.id}:${issue.name}`,
          tone: 'danger',
          badge: zh.overview.todoAppIssueBadge,
          name: `${hub.name} · ${issue.name}`,
          desc:
            issue.status !== null
              ? `HTTP ${issue.status}`
              : zh.overview.todoAppUnreachable,
          to: paths.hubSection(hub.id, 'sites'),
        });
      }
      for (const peerName of hub.projection.peers.offline) {
        offlinePeerCount += 1;
        todos.push({
          id: `peer:${hub.id}:${peerName}`,
          tone: 'warn',
          badge: zh.hub.todoPeerBadge,
          name: `${hub.name} · ${peerName}`,
          to: paths.hubSection(hub.id, 'wireguard'),
        });
      }
    }
  }

  for (const cert of expiringCerts) {
    todos.push({
      id: `cert:${cert.id}`,
      tone: cert.daysLeft <= 0 ? 'danger' : 'warn',
      badge: zh.hub.todoCertBadge,
      name: cert.name,
      desc:
        cert.daysLeft < 0
          ? zh.overview.todoCertExpired
          : cert.daysLeft === 0
            ? zh.overview.todoCertToday
            : fmt(zh.overview.todoCertExpiring, { days: cert.daysLeft }),
      to: `${paths.settings}?tab=certs`,
    });
  }

  let expiringNodeCount = 0;
  for (const hub of hubs) {
    const expiryDaysLeft = hub.projection?.expiresDaysLeft ?? daysLeftFromDate(hub.expiresAt);
    if (expiryDaysLeft === null || expiryDaysLeft > 14) continue;
    expiringNodeCount += 1;
    todos.push({
      id: `node-expiry:${hub.id}`,
      tone: expiryDaysLeft <= 0 ? 'danger' : 'warn',
      badge:
        expiryDaysLeft <= 0 ? zh.overview.todoNodeExpiredBadge : zh.overview.todoNodeExpiringBadge,
      name: hub.name,
      desc:
        expiryDaysLeft < 0
          ? fmt(zh.overview.todoNodeExpiredDays, { days: Math.abs(expiryDaysLeft) })
          : expiryDaysLeft === 0
            ? zh.overview.todoNodeToday
            : fmt(zh.overview.todoNodeExpiring, { days: expiryDaysLeft }),
      to: paths.hubSection(hub.id, 'settings'),
    });
  }

  // 聚合全集群 KPI（R2：合计为 0 的 KPI 直接隐藏；R3：全离线标红「N 个离线」）。
  const probedCount = hubs.filter((hub) => hub.probed).length;
  const kpis: KpiItem[] = [];

  if (hubs.length > 0) {
    const nodeMetric = formatRatioMetric({
      online: probedCount > 0 ? counts.online : null,
      total: hubs.length,
      reachable: probedCount > 0 ? true : null,
    });
    kpis.push({
      key: 'nodes',
      label: zh.overview.kpiOnlineNodes,
      value:
        nodeMetric?.kind === 'all-offline' ? (
          <span className="is-danger">{nodeMetric.text}</span>
        ) : nodeMetric?.kind === 'ratio' ? (
          <>
            {nodeMetric.online}
            <small className="ui-stat-den"> / {nodeMetric.total}</small>
          </>
        ) : (
          String(hubs.length)
        ),
      tone: nodeMetric?.kind === 'all-offline' ? 'danger' : 'neutral',
      hint:
        probedCount === 0
          ? zh.overview.statHubsHintProbing
          : counts.offline > 0
            ? fmt(zh.overview.kpiOnlineHintPartial, {
                online: counts.online,
                offline: counts.offline,
              })
            : zh.overview.kpiOnlineHintAll,
    });
  }

  let appsTotalCluster = 0;
  let appsKnownTotal = 0;
  let appsKnownOnline = 0;
  let peersTotalCluster = 0;
  let peersKnownTotal = 0;
  let peersKnownOnline = 0;

  for (const hub of hubs) {
    const p = hub.projection;
    const nodeAppsTotal = p ? p.apps.total : (hub.summary?.sites?.total ?? 0);
    appsTotalCluster += nodeAppsTotal;
    if (hub.probed && hub.status === 'online' && p && p.apps.online !== null) {
      appsKnownTotal += p.apps.total;
      appsKnownOnline += p.apps.online;
    }

    const nodePeersTotal = p
      ? p.peers.enabled
        ? p.peers.total
        : 0
      : (hub.summary?.peers ?? 0);
    peersTotalCluster += nodePeersTotal;
    if (
      hub.probed &&
      hub.status === 'online' &&
      p?.peers.enabled &&
      p.peers.online !== null
    ) {
      peersKnownTotal += p.peers.total;
      peersKnownOnline += p.peers.online;
    }
  }

  if (appsTotalCluster > 0) {
    const appMetric = formatRatioMetric({
      online: appsKnownTotal > 0 ? appsKnownOnline : null,
      total: appsKnownTotal > 0 ? appsKnownTotal : appsTotalCluster,
      reachable: appsKnownTotal > 0 ? true : null,
    });
    if (appMetric) {
      kpis.push({
        key: 'apps',
        label: zh.overview.kpiAppsOnline,
        value:
          appMetric.kind === 'all-offline' ? (
            <span className="is-danger">{appMetric.text}</span>
          ) : appMetric.kind === 'ratio' ? (
            <>
              {appMetric.online}
              <small className="ui-stat-den"> / {appMetric.total}</small>
            </>
          ) : (
            String(appsTotalCluster)
          ),
        tone: appMetric.kind === 'all-offline' ? 'danger' : 'neutral',
        hint:
          appsKnownTotal === 0
            ? probing
              ? zh.overview.probing
              : zh.hub.appUnknown
            : appIssueCount > 0
              ? fmt(zh.overview.kpiAppsIssues, { count: appIssueCount })
              : zh.overview.kpiAppsAllOk,
      });
    }
  }

  if (peersTotalCluster > 0) {
    const peerMetric = formatRatioMetric({
      online: peersKnownTotal > 0 ? peersKnownOnline : null,
      total: peersKnownTotal > 0 ? peersKnownTotal : peersTotalCluster,
      reachable: peersKnownTotal > 0 ? true : null,
    });
    if (peerMetric) {
      kpis.push({
        key: 'peers',
        label: zh.overview.kpiPeersOnline,
        value:
          peerMetric.kind === 'all-offline' ? (
            <span className="is-danger">{peerMetric.text}</span>
          ) : peerMetric.kind === 'ratio' ? (
            <>
              {peerMetric.online}
              <small className="ui-stat-den"> / {peerMetric.total}</small>
            </>
          ) : (
            String(peersTotalCluster)
          ),
        tone: peerMetric.kind === 'all-offline' ? 'danger' : 'neutral',
        hint: zh.overview.kpiPeersHint,
      });
    }
  }

  if (todos.length > 0) {
    const hintParts = [
      offlineNodeCount > 0 ? `${offlineNodeCount} 离线` : null,
      appIssueCount > 0 ? `${appIssueCount} 应用异常` : null,
      offlinePeerCount > 0 ? `${offlinePeerCount} Peer 离线` : null,
      expiringCerts.length > 0 ? `${expiringCerts.length} 张证书到期` : null,
      expiringNodeCount > 0 ? `${expiringNodeCount} 节点到期` : null,
    ].filter(Boolean);
    kpis.push({
      key: 'todos',
      label: zh.overview.kpiAttention,
      value: <span className="is-warn">{todos.length}</span>,
      tone: 'warn',
      hint: hintParts.join(' · '),
    });
  }

  const summaryParts =
    phase === 'probing' && probedCount === 0
      ? [zh.overview.summaryProbing]
      : hubs.length === 0
        ? [zh.overview.summaryEmpty]
        : [
            fmt(zh.overview.summaryOnlineNodes, { count: counts.online }),
            todos.length > 0 ? fmt(zh.overview.summaryTodos, { count: todos.length }) : null,
            probedAt ? fmt(zh.overview.summaryRecentProbe, { time: formatRelativeTime(probedAt) }) : null,
          ].filter(Boolean);

  return (
    <Stack gap={5}>
      <PageHeader title={zh.overview.title} summary={summaryParts.join(' · ')}>
        <p className="ui-panel-version">
          {fmt(zh.overview.panelVersion, { label: PANEL_VERSION_LABEL })}
        </p>
      </PageHeader>

      {hubsQuery.isError ? (
        <Banner
          tone="danger"
          title={zh.hubs.loadError}
          action={
            <Button
              variant="default"
              size="sm"
              label={zh.common.retry}
              onClick={() => void hubsQuery.refetch()}
            />
          }
        />
      ) : null}

      {probeError ? (
        <Banner
          tone="warn"
          title={zh.overview.probeFailedTitle}
          description={`${probeError} ${zh.overview.probeFailedHint}`}
          action={
            <Button
              variant="default"
              size="sm"
              label={zh.overview.refreshStatus}
              loading={probing}
              onClick={() => void runProbe()}
            />
          }
        />
      ) : null}

      {kpis.length > 0 ? (
        <div className="ui-kpi-strip" data-cols={String(kpis.length)}>
          {kpis.map((kpi) => (
            <div
              key={kpi.key}
              className={`ui-stat${kpi.tone === 'warn' ? ' ui-stat--warn' : kpi.tone === 'danger' ? ' ui-stat--danger' : ''}`}
            >
              <div className="ui-stat-label">
                <Truncate text={kpi.label} mode="end" />
              </div>
              <div className="ui-stat-value num">{kpi.value}</div>
              {kpi.hint ? (
                <div className="ui-stat-hint">
                  <Truncate text={kpi.hint} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <TodoChips items={todos} onOpen={goTo} />

      {hubsQuery.isLoading ? (
        <Grid cols={2} gap={4}>
          <Skeleton height={152} />
          <Skeleton height={152} />
        </Grid>
      ) : hubs.length === 0 ? (
        <Card>
          <EmptyState
            icon="server"
            title={zh.overview.noHubs}
            description={zh.overview.noHubsHint}
            action={
              <Button
                variant="primary"
                icon="plus"
                label={zh.overview.addFirstNodeGuide}
                onClick={() => goTo(`${paths.hubs}?create=1`)}
              />
            }
          />
        </Card>
      ) : (
        <Stack gap={3}>
          <div className="ui-section-header">
            <h2 className="ui-section-title">{zh.overview.sectionNodesTitle}</h2>
            <Row gap={2}>
              <Button
                variant="ghost"
                size="sm"
                label={zh.overview.refreshStatus}
                loading={probing}
                onClick={() => void runProbe()}
              />
              <Button
                variant="ghost"
                size="sm"
                label={zh.overview.manageNodes}
                onClick={() => goTo(paths.hubs)}
              />
            </Row>
          </div>
          <div className="ui-hub-grid">
            {hubs.map((hub) => {
              const expiryDaysLeft =
                hub.projection?.expiresDaysLeft ?? daysLeftFromDate(hub.expiresAt);
              const expiryWarn = expiryDaysLeft !== null && expiryDaysLeft <= 14;
              return (
                <HubCard
                  key={hub.id}
                  hub={hub}
                  phase={phase}
                  hasWarn={expiryWarn || undefined}
                  expirySlot={
                    hub.expiresAt ? (
                      <NodeExpiryChip expiresAt={hub.expiresAt} daysLeft={expiryDaysLeft} />
                    ) : undefined
                  }
                  onOpen={() => goTo(paths.hub(hub.id))}
                />
              );
            })}
          </div>
        </Stack>
      )}
    </Stack>
  );
}

export default OverviewPage;
