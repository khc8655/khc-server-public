import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { certificatesQueryOptions } from '../data/certs';
import { useQuery } from '@tanstack/react-query';
import { hubOutageDays, hubStatusView, useHubProbe, type HubView } from '../data/useHubProbe';
import { formatRelativeTime } from '../i18n/format';
import { fmt, zh } from '../i18n/zh';
import { paths } from '../registry/routes';
import { NodeSummaryTokens } from '../patterns/NodeSummaryTokens';
import { PANEL_VERSION_LABEL } from '../version';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Grid,
  Icon,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  Stat,
} from '../ui';

function statusBadge(hub: HubView, phase: 'probing' | 'done' | 'failed') {
  const view = hubStatusView(hub, phase);
  return <Badge tone={view.tone} label={view.label} dot />;
}

export function OverviewPage() {
  const routerNavigate = useNavigate();
  const goTo = (to: string) => void routerNavigate({ to });

  // 请求预算：概览页只读控制面的两份列表（/nodes、/certificates）
  // + 一次批量轻量探测（POST /nodes/probe，覆盖全部节点）；不对每个节点 fan-out。
  // 运行态只在节点页或浏览器直连观测里看。
  const { hubs, hubsQuery, phase, error: probeError, probe, counts, probedAt } = useHubProbe();
  const certsQuery = useQuery(certificatesQueryOptions());
  const probing = phase === 'probing';
  const runProbe = () => void probe({ force: true });

  const certs = certsQuery.data ?? [];

  const onlineCount = counts.online;
  const offlineHubs = hubs.filter((hub) => hub.status === 'offline');
  const nowSec = Math.floor(Date.now() / 1000);
  const expiringCerts = certs.filter(
    (c) => c.notAfter !== null && c.notAfter - nowSec <= 86400 * 14,
  );
  const attentionCount = offlineHubs.length + expiringCerts.length;

  // 探测未完成前的文案不能"报喜"：否则会出现「节点总数 0/2」+「所有节点都在正常运行」的自相矛盾
  const summary =
    phase === 'probing'
      ? zh.overview.summaryProbing
      : hubs.length === 0
        ? zh.overview.summaryEmpty
        : attentionCount > 0
          ? fmt(zh.overview.summaryAttention, { count: attentionCount })
          : zh.overview.summaryAllOk;

  return (
    <Stack gap={5}>
      <PageHeader
        title={zh.overview.title}
        summary={summary}
      >
        <p className="ui-panel-version">{fmt(zh.overview.panelVersion, { label: PANEL_VERSION_LABEL })}</p>
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

      {/* Top 4-Card Cluster KPI Strip */}
      <Grid cols={4} gap={3}>
        <Stat
          label={zh.overview.statHubs}
          value={phase === 'probing' ? `— / ${hubs.length}` : `${onlineCount} / ${hubs.length}`}
          hint={
            phase === 'probing'
              ? zh.overview.statHubsHintProbing
              : offlineHubs.length > 0
                ? `${zh.overview.statOnline} ${onlineCount} · ${zh.overview.statOffline} ${offlineHubs.length}`
                : zh.overview.summaryAllOk
          }
        />
        <Stat
          label={zh.overview.statProbe}
          value={probedAt ? formatRelativeTime(probedAt) : zh.status.probing}
          hint={zh.overview.statProbeHint}
        />
        <Stat
          label={zh.overview.statCerts}
          value={String(certs.length)}
          hint={
            expiringCerts.length > 0
              ? fmt(zh.overview.statCertsHint, { expiring: expiringCerts.length })
              : zh.overview.statCertsOk
          }
        />
        <Stat
          label={zh.overview.statAttention}
          value={String(attentionCount)}
          hint={zh.overview.statAttentionHint}
        />
      </Grid>

      {/* Compact Actionable Triage Strip (only shown when attention is needed) */}
      {attentionCount > 0 ? (
        <div className="ui-triage-strip" role="region" aria-label={zh.overview.attention}>
          <div className="ui-triage-strip-head">
            <Badge
              tone="warn"
              label={`${zh.overview.attention} · ${attentionCount}`}
            />
          </div>
          <div className="ui-triage-strip-items">
            {offlineHubs.map((hub) => (
              <button
                key={hub.id}
                type="button"
                className="ui-triage-chip"
                onClick={() => goTo(paths.hub(hub.id))}
              >
                <Badge tone={hubStatusView(hub, phase).tone} label={hubStatusView(hub, phase).label} dot />
                <span className="ui-triage-name">{hub.name}</span>
                <span className="ui-triage-desc">
                  {fmt(
                    (hubOutageDays(hub) ?? 0) >= 1
                      ? zh.overview.nodeOfflineStaleReason
                      : zh.overview.nodeOfflineReason,
                    {
                      days: hubOutageDays(hub) ?? 0,
                      time: hub.lastSeenAt ? formatRelativeTime(hub.lastSeenAt) : zh.common.unknown,
                    },
                  )}
                </span>
                <Icon name="arrow" size={14} />
              </button>
            ))}
            {expiringCerts.map((cert) => {
              const daysLeft = Math.max(
                0,
                Math.ceil(((cert.notAfter ?? nowSec) - nowSec) / 86400),
              );
              return (
                <button
                  key={cert.id}
                  type="button"
                  className="ui-triage-chip"
                  onClick={() => goTo(`${paths.settings}?tab=certs`)}
                >
                  <Badge tone="warn" label={zh.nav.certs} dot />
                  <span className="ui-triage-name">{cert.name}</span>
                  <span className="ui-triage-desc">
                    {fmt(zh.overview.certExpiringReason, { days: daysLeft })}
                  </span>
                  <Icon name="arrow" size={14} />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {hubsQuery.isLoading ? (
        <Grid cols={2} gap={4}>
          <Skeleton height={210} />
          <Skeleton height={210} />
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
                label={zh.overview.addFirstHub}
                onClick={() => goTo(`${paths.hubs}?create=1`)}
              />
            }
          />
        </Card>
      ) : (
        <Card
          title={zh.overview.nodeMatrixTitle}
          action={
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
                label={zh.overview.manageHubs}
                onClick={() => goTo(paths.hubs)}
              />
            </Row>
          }
        >
          <div className="ui-hub-grid">
            {hubs.map((hub) => {
              const toneClass =
                hub.status === 'online'
                  ? 'ui-hub-tile-ok'
                  : hub.status === 'offline'
                    ? 'ui-hub-tile-danger'
                    : '';

              return (
                <div
                  key={hub.id}
                  role="link"
                  tabIndex={0}
                  className={`ui-hub-tile ${toneClass}`.trim()}
                  onClick={() => goTo(paths.hub(hub.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goTo(paths.hub(hub.id));
                    }
                  }}
                >
                  <div className="ui-hub-tile-head">
                    <div className="ui-hub-tile-title-row">
                      <span className="ui-hub-tile-name">{hub.name}</span>
                    </div>
                    <div className="ui-Cluster">
                      {statusBadge(hub, phase)}
                      <span className="sr-only">{zh.overview.hubCardEnter}</span>
                      <span className="ui-hub-tile-chevron" aria-hidden="true">
                        <Icon name="arrow" />
                      </span>
                    </div>
                  </div>

                  <div className="ui-hub-tile-endpoint-row">
                    <span className="ui-hub-tile-endpoint">{hub.endpoint}</span>
                    <span className="ui-hub-tile-route-chip">
                      {hub.preferredRoute === 'tunnel' ? zh.hubs.routeTunnel : zh.hubs.routeDirect}
                    </span>
                  </div>

                  <NodeSummaryTokens summary={hub.summary} apps={hub.apps} />

                  <div className="ui-hub-offline-bar">
                    <span>
                      {zh.fields.lastSeen}：{hub.lastSeenAt ? formatRelativeTime(hub.lastSeenAt) : zh.common.dash}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </Stack>
  );
}

export default OverviewPage;
