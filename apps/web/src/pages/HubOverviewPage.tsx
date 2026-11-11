import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../data/client';
import { certificatesQueryOptions } from '../data/certs';
import { hubQueryOptions } from '../data/queries';
import { useHubChannelsContext } from '../app/HubChannelsProvider';
import { caddyConfigQueryOptions, kindLabelKey } from '../data/sites';
import { forwardConfigQueryOptions, forwardTarget } from '../data/forwards';
import { wireGuardConfigQueryOptions } from '../data/wireguard';
import { appPresence } from '../data/appPresence';
import { paths } from '../registry/routes';
import {
  Badge,
  Banner,
  Button,
  Card,
  Grid,
  Icon,
  Link,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  Stat,
} from '../ui';
import { zh, fmt } from '../i18n/zh';
import { TodoChips, type TodoChip } from '../patterns/TodoChips';
import { formatAbsoluteTime, formatBytes } from '../i18n/format';

export default function HubOverviewPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId' });
  const navigate = useNavigate();
  const hubQuery = useQuery(hubQueryOptions(hubId));
  const { stateQuery, live, channels } = useHubChannelsContext();
  const wgQuery = useQuery(wireGuardConfigQueryOptions(hubId));
  const sitesQuery = useQuery(caddyConfigQueryOptions(hubId));
  const certsQuery = useQuery(certificatesQueryOptions());
  const forwardQuery = useQuery(forwardConfigQueryOptions(hubId));

  if (hubQuery.isLoading) {
    return (
      <Stack gap={4}>
        <PageHeader title={hubId} summary={zh.hub.summary} />
        <Skeleton height={96} />
        <Skeleton height={220} />
      </Stack>
    );
  }

  if (hubQuery.error) {
    const notFound = hubQuery.error instanceof ApiError && hubQuery.error.status === 404;
    return (
      <Stack gap={4}>
        <PageHeader title={zh.hub.notFound} />
        <Banner
          tone={notFound ? 'neutral' : 'danger'}
          title={fmt(zh.errors.loadTitle, { page: zh.hub.summary })}
          description={(hubQuery.error as Error).message}
          action={
            notFound ? undefined : (
              <Button label={zh.common.retry} size="sm" onClick={() => void hubQuery.refetch()} />
            )
          }
        />
      </Stack>
    );
  }

  const node = hubQuery.data;
  if (!node) {
    return (
      <Stack gap={4}>
        <PageHeader title={zh.hub.notFound} />
      </Stack>
    );
  }

  const state = stateQuery.data;
  // 主机指标用 10s 快照；适配器/端口等来自一次性 /state（快照不采集这些重数据）。
  const snapshot = live.snapshot;
  const host = snapshot?.host ?? state?.state?.host;
  const ops = snapshot?.ops ?? state?.state?.ops;
  const peers = wgQuery.data?.config.peers ?? [];
  const sites = sitesQuery.data?.config.sites ?? [];
  const allCerts = certsQuery.data ?? [];

  const wgAdapter = state?.state?.adapters.find((adapter) => adapter.name === 'wireguard');
  const wgStatus = wgAdapter?.status as
    | { installed?: boolean; running?: boolean; peers?: { name: string; online?: boolean }[] }
    | undefined;
  const runtimePeers = wgStatus?.peers;
  const onlinePeers = peers.filter(
    (peer) => runtimePeers?.find((item) => item.name === peer.name)?.online === true,
  ).length;

  // 统计当前节点签发或被当前节点站点绑定的证书
  const boundCertIds = new Set(
    sites.map((s) => s.tls.cert?.$cert).filter((id): id is string => Boolean(id)),
  );
  const nodeCerts = allCerts.filter(
    (cert) => cert.sourceNodeId === hubId || boundCertIds.has(cert.id),
  );

  // 模式口径 = D1 期望配置（summary.mode，与首页令牌一致）；离线也能显示。
  // summary 缺失（POST/PATCH 响应、旧缓存）时回退到同源 wireguard 配置，避免整块消失。
  const summaryMode = node.summary ? node.summary.mode : (wgQuery.data?.mode ?? null);
  const peerEnabled = summaryMode === 'wg';
  const cpuPct = ops?.cpu?.usagePercent ?? null;
  const memPct = ops?.mem?.percent ?? null;
  const memUsed = ops?.mem?.used ?? null;
  const memTotal = ops?.mem?.total ?? null;
  // 只给百分比看不出「到底占了多少」：同时给已用/总量（Agent 口径 = total - MemAvailable）。
  const memSummary =
    memPct === null
      ? null
      : memUsed !== null && memTotal !== null
        ? `内存 ${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
        : `内存 ${memPct.toFixed(0)}%`;
  const diskPct = ops?.disks?.[0]?.percent ?? null;
  const agentVersion = state?.state?.agent?.version ?? snapshot?.agent?.version;

  // 域名证书状态：只认 Agent 实际探测结果；拿不到就明说未知，不做「看起来成功」的兜底。
  const caddyAdapter = (state?.state?.adapters ?? []).find((adapter) => adapter.name === 'caddy-site');
  const caddyStatus = caddyAdapter?.status as
    | { error?: string; installed?: boolean; running?: boolean; siteHealth?: { name?: string; domain?: string; state?: string; error?: string }[] }
    | undefined;
  const domainHealth = node.domain
    ? caddyStatus?.siteHealth?.find((site) => (site.domain ?? site.name) === node.domain)
    : undefined;
  const domainHasSite = node.domain ? sites.some((site) => site.domain === node.domain) : false;
  let certStatus: string;
  if (!node.domain) {
    certStatus = zh.hub.certNoDomain;
  } else if (!caddyStatus || caddyStatus.error) {
    certStatus = zh.hub.certUnknown;
  } else if (!domainHasSite && !domainHealth) {
    certStatus = zh.hub.certNoSite;
  } else if (!domainHealth) {
    certStatus = zh.hub.certUnknown;
  } else if (domainHealth.state === 'ok') {
    certStatus = zh.hub.certOk;
  } else if (domainHealth.state === 'warn') {
    certStatus = fmt(zh.hub.certWarn, { error: domainHealth.error ?? 'HTTPS 校验未通过' });
  } else if (domainHealth.state === 'down') {
    certStatus = fmt(zh.hub.certDown, { error: domainHealth.error ?? '站点不可达' });
  } else {
    certStatus = zh.hub.certUnknown;
  }

  // 鉴权失败：Worker 已把 Agent 的 401/403 归一成 200 + error，这里单独识别，
  // 不再和「节点不可达」混在一起（那会让人误以为网络问题）。
  const authError = Boolean(
    state?.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(state.error),
  );
  const pfAdapter = (state?.state?.adapters ?? []).find((adapter) => adapter.name === 'port-forward');
  const pfStatus = pfAdapter?.status as
    | { installed?: boolean; running?: boolean; count?: number }
    | undefined;
  // 10s 轻量快照只带 CPU/内存/磁盘/负载，不含服务清单与失败单元；
  // 这两项取一次性 /state 的 ops（与主机运维页同一口径），否则卡片永远是空的。
  const serviceOps = state?.state?.ops?.services;
  const services = serviceOps?.services ?? ops?.services?.services ?? [];
  const failedUnits = serviceOps?.failedUnits ?? ops?.services?.failedUnits ?? [];
  const runningServices = services.filter(
    (service) => service.state === 'active' || service.state === 'running',
  ).length;
  const loadAvg = host?.load?.[0] ?? ops?.cpu?.load?.[0] ?? null;

  const uptimeText = (seconds?: number): string => {
    if (!seconds || seconds <= 0) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return `${minutes} 分钟`;
  };

  // 单徽标口径：待生效（配置未应用）> 运行中 / 未运行 > 未读取；不叠「已安装 + 运行中」。
  const appBadge = (dirty: boolean, running?: boolean) =>
    dirty
      ? { tone: 'warn' as const, label: zh.hub.appPending }
      : running === true
        ? { tone: 'ok' as const, label: zh.hub.appRunning }
        : running === false
          ? { tone: 'warn' as const, label: zh.hub.appStopped }
          : { tone: 'neutral' as const, label: zh.hub.appUnknown };

  const wgDirty = (wgQuery.data?.rev ?? 0) > (wgQuery.data?.appliedRev ?? 0);
  const sitesDirty = (sitesQuery.data?.rev ?? 0) > (sitesQuery.data?.appliedRev ?? 0);
  const forwardDirty = (forwardQuery.data?.rev ?? 0) > (forwardQuery.data?.appliedRev ?? 0);
  const wgInterface = wgQuery.data?.config.interface;
  const forwards = forwardQuery.data?.config.forwards ?? [];
  const [firstSite] = sites;
  const [firstForward] = forwards;
  const disabledSites = sites.filter((site) => !site.enabled).length;

  // 纳管状态 = D1 期望配置 × 节点在线状态（/state 的 adapters，零新增请求）。
  // 「D1 有、实装无」必须显示，不能因为条数为 0 就整行消失。
  // 纯 Caddy 模式下 WG 不算"未纳管"；只有完全没有 WG 配置行时才看实装情况。
  const wgPresence =
    summaryMode === 'wg'
      ? appPresence(true, peers.length, wgStatus)
      : summaryMode === null
        ? appPresence(false, null, wgStatus)
        : 'unknown';
  const caddyConfigured = sitesQuery.data?.exists === true;
  const caddyPresence = appPresence(caddyConfigured, sites.length, caddyStatus);
  const pfConfigured = forwardQuery.data?.exists === true;
  const pfPresence = appPresence(pfConfigured, forwards.length, pfStatus);
  const wgReady = peerEnabled && wgPresence !== 'missing';

  // 站点类型分布（反代/静态/跳转计数）；停用才追加注记。
  const siteKindSummary =
    sites.length > 0
      ? [
          ...(['proxy', 'static', 'redirect'] as const).map((kind) => {
            const count = sites.filter((site) => site.kind === kind).length;
            return count > 0 ? `${zh.sites[kindLabelKey(kind)]} ${count}` : null;
          }),
          disabledSites > 0
            ? fmt(zh.overview.summaryDisabled, { count: disabledSites })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  const peerText =
    runtimePeers !== undefined
      ? `Peer ${onlinePeers}/${peers.length} 在线`
      : peers.length > 0
        ? `Peer ${peers.length}`
        : null;

  // 徽标口径：未安装 / 已安装但面板无配置 / 已安装但暂无条目优先于「待生效 / 运行中」。
  // 注意：这里不出现"未纳管"——是否存在未托管的外部站点块只能由站点页扫描回答。
  const presenceBadge = (
    presence: ReturnType<typeof appPresence>,
    dirty: boolean,
    running?: boolean,
    emptyLabel?: string,
  ) =>
    presence === 'missing'
      ? { tone: 'warn' as const, label: zh.hub.appNotInstalled }
      : presence === 'unconfigured'
        ? { tone: 'neutral' as const, label: zh.hub.appInstalledNoConfig }
        : presence === 'installed-empty' && emptyLabel
          ? { tone: 'neutral' as const, label: emptyLabel }
          : appBadge(dirty, running);

  // 已配置应用 + 节点已安装但面板无配置的应用都要可见（page-specs §2.1 增补）：
  // 「未配置」仍不渲染占位，但「D1 有、实装无」与「实装有、D1 无」不得隐藏。
  const appRows: Array<{
    key: string;
    name: string;
    icon: 'users' | 'globe' | 'arrow';
    badge: { tone: 'ok' | 'warn' | 'neutral'; label: string };
    facts: ReactNode;
    to: string;
  }> = [
    ...(peerEnabled || wgPresence === 'unconfigured'
      ? [
          {
            key: 'wireguard',
            name: zh.hub.appWireguard,
            icon: 'users' as const,
            badge: presenceBadge(wgPresence, wgDirty, wgStatus?.running),
            facts: !peerEnabled ? (
              zh.hub.appInstalledNoConfigFacts
            ) : wgPresence === 'missing' ? (
              zh.hub.appMissingFacts
            ) : (
              <>
                {wgInterface ? (
                  <span className="mono">
                    {`${wgInterface.name} · ${wgInterface.address} · :${wgInterface.listenPort}`}
                  </span>
                ) : null}
                {peerText ? `${wgInterface ? ' · ' : ''}${peerText}` : null}
              </>
            ),
            to: paths.hubSection(hubId, 'wireguard'),
          },
        ]
      : []),
    ...(caddyConfigured || caddyPresence === 'unconfigured'
      ? [
          {
            key: 'caddy',
            name: zh.hub.appCaddy,
            icon: 'globe' as const,
            badge: presenceBadge(
              caddyPresence,
              sitesDirty,
              caddyStatus?.running,
              zh.hub.appInstalledEmptySites,
            ),
            facts: firstSite ? (
              <>
                <span className="mono">{firstSite.domain}</span>
                {` · ${zh.sites[kindLabelKey(firstSite.kind)]}`}
                {sites.length > 1 ? ` 等 ${sites.length} 个` : ''}
                {disabledSites > 0
                  ? ` · ${fmt(zh.overview.summaryDisabled, { count: disabledSites })}`
                  : ''}
              </>
            ) : caddyPresence === 'unconfigured' ? (
              zh.hub.appInstalledNoConfigFacts
            ) : (
              `${sites.length} 个站点`
            ),
            to: paths.hubSection(hubId, 'sites'),
          },
        ]
      : []),
    ...(pfConfigured || pfPresence === 'unconfigured'
      ? [
          {
            key: 'port-forward',
            name: zh.hub.appPortForward,
            icon: 'arrow' as const,
            badge: presenceBadge(
              pfPresence,
              forwardDirty,
              pfStatus?.running ?? undefined,
              zh.hub.appInstalledEmptyForwards,
            ),
            facts: firstForward ? (
              <>
                <span className="mono">
                  {`${firstForward.listenPort}→${forwardTarget(firstForward)}`}
                </span>
                {forwards.length > 1 ? ` 等 ${forwards.length} 条` : ''}
              </>
            ) : pfPresence === 'unconfigured' ? (
              zh.hub.appInstalledNoConfigFacts
            ) : (
              `${forwards.length} 条规则`
            ),
            to: paths.hubSection(hubId, 'wireguard'),
          },
        ]
      : []),
  ];

  // 「需要处理」聚合：服务异常 + 临期证书 + 长期离线 Peer（ui-redesign ③）
  const nowSec = Math.floor(Date.now() / 1000);
  const todos: TodoChip[] = [];
  for (const unit of failedUnits) {
    todos.push({
      id: `unit:${unit}`,
      tone: 'danger',
      badge: zh.hub.todoFailedUnitBadge,
      name: unit,
      to: paths.hubSection(hubId, 'ops'),
    });
  }
  for (const cert of nodeCerts) {
    if (cert.notAfter === null) continue;
    const daysLeft = Math.ceil((cert.notAfter - nowSec) / 86400);
    if (daysLeft > 14 || daysLeft < 0) continue;
    todos.push({
      id: `cert:${cert.id}`,
      tone: 'warn',
      badge: zh.hub.todoCertBadge,
      name: cert.name,
      desc: fmt(zh.hub.todoCertDesc, { days: Math.max(0, daysLeft) }),
      to: `${paths.hubSection(hubId, 'sites')}?tab=certs`,
    });
  }
  if (wgReady) {
    for (const peer of peers) {
      if (!peer.enabled) continue;
      const online = runtimePeers?.find((item) => item.name === peer.name)?.online === true;
      if (online) continue;
      todos.push({
        id: `peer:${peer.name}`,
        tone: 'warn',
        badge: zh.hub.todoPeerBadge,
        name: peer.name,
        to: paths.hubSection(hubId, 'wireguard'),
      });
    }
  }

  const pageSummary = [
    zh.hub.summary,
    sites.length > 0 ? `${sites.length} ${zh.overview.summarySites}` : null,
    peerEnabled && peers.length > 0 ? `${peers.length} Peer` : null,
  ].filter(Boolean).join(' · ');

  const hostCard = (
    <Card
      title={zh.hub.hostCardTitle}
      action={<Link to={paths.hubSection(hubId, 'ops')} label="主机运维 →" />}
    >
      <Stack gap={2}>
        <Row justify="between" gap={3} wrap>
          <span className="ui-muted">{zh.hub.hostOs}</span>
          <span>
            {host
              ? `${host.hostname ?? node.name} · ${host.os ?? '—'}${host.kernel ? ` · ${host.kernel}` : ''}`
              : '—'}
          </span>
        </Row>
        <Row justify="between" gap={3} wrap>
          <span className="ui-muted">{zh.hub.hostUptime}</span>
          <span>{uptimeText(host?.uptime)}</span>
        </Row>
        <Row justify="between" gap={3} wrap>
          <span className="ui-muted">{zh.hub.hostLoad}</span>
          <span>{loadAvg !== null ? loadAvg.toFixed(2) : '—'}</span>
        </Row>
        <Row justify="between" gap={3} wrap>
          <span className="ui-muted">{zh.hub.servicesTitle}</span>
          <span>
            {failedUnits.length > 0
              ? `${failedUnits.length} 个异常`
              : services.length > 0
                ? `${runningServices} / ${services.length}`
                : '—'}
          </span>
        </Row>
        {services.length > 0 ? (
          <Row gap={1} wrap>
            {services.slice(0, 8).map((service) => (
              <Badge
                key={service.name}
                tone={service.state === 'active' || service.state === 'running' ? 'ok' : 'warn'}
                label={service.name}
              />
            ))}
            {services.length > 8 ? (
              <span className="ui-muted">等 {services.length} 个</span>
            ) : null}
          </Row>
        ) : null}
      </Stack>
    </Card>
  );

  return (
    <Stack gap={4}>
      <PageHeader
        title={node.name}
        summary={pageSummary}
        sync={{
          state: channels.presence === 'managed-online' ? 'synced' : 'queued',
          offlineHint: zh.hub.offlineBanner,
        }}
      >
        {summaryMode ? (
          <Row gap={2} wrap>
            {/* WireGuard 未安装时不显示「组网节点」这类肯定口径，改为告警徽标。 */}
            {!(summaryMode === 'wg' && wgPresence === 'missing') ? (
              <Badge tone="neutral" label={summaryMode === 'wg' ? zh.mode.badgeWg : zh.mode.badgeCaddy} />
            ) : null}
            {wgPresence === 'missing' ? (
              <Badge tone="warn" label={`${zh.hub.appWireguard} ${zh.hub.appNotInstalled}`} dot />
            ) : null}
            {caddyPresence === 'missing' ? (
              <Badge tone="warn" label={`${zh.hub.appCaddy} ${zh.hub.appNotInstalled}`} dot />
            ) : null}
          </Row>
        ) : null}
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
              onClick={() => void navigate({ href: paths.hubSection(hubId, 'settings') })}
            />
          }
        />
      ) : null}
      {channels.presence === 'live-only' ? (
        <Banner tone="warn" title={zh.channels.liveOnlyTitle} description={zh.channels.liveOnlyDesc} />
      ) : null}
      {channels.presence === 'offline' ? (
        <Banner
          tone="danger"
          title={zh.hub.unreachableBanner}
          description={channels.control.error ?? state?.error ?? undefined}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void stateQuery.refetch()} />
          }
        />
      ) : null}

      {/* 4 项核心指标：连接 · 站点 · Peer 在线 · 负载 */}
      <Grid cols={4}>
        <Stat
          label={zh.hub.statReachable}
          value={
            authError
              ? zh.hub.authFailed
              : channels.control.reachable === true
                ? zh.status.online
                : channels.control.reachable === false
                  ? zh.status.offline
                  : '—'
          }
          unit={
            state?.route
              ? state.route === 'direct'
                ? zh.hubs.routeDirect
                : zh.hubs.routeTunnel
              : node.preferredRoute === 'direct'
                ? zh.hubs.routeDirect
                : zh.hubs.routeTunnel
          }
          hint={agentVersion ? `${node.endpoint} · Agent v${agentVersion}` : node.endpoint}
          icon="activity"
        />
        <Stat
          label={zh.hub.statSites}
          value={String(sites.length)}
          hint={siteKindSummary}
          icon="globe"
        />
        <Stat
          label={zh.hub.statPeers}
          value={wgReady ? `${onlinePeers} / ${peers.length}` : '—'}
          hint={wgReady && wgInterface ? `${wgInterface.name} · :${wgInterface.listenPort}` : undefined}
          icon="users"
        />
        <Stat
          label={zh.hub.statLoad}
          value={cpuPct !== null ? `${cpuPct.toFixed(1)}%` : '—'}
          hint={
            host
              ? [memSummary, diskPct !== null ? `磁盘 ${diskPct.toFixed(0)}%` : null].filter(Boolean).join(' · ')
              : undefined
          }
          icon="terminal"
        />
      </Grid>

      {/* 需要处理：服务异常 + 临期证书 + 长期离线 Peer，chip 直达对应页 */}
      <TodoChips items={todos} onOpen={(to) => void navigate({ href: to })} />

      {appRows.length > 0 ? (
        <Grid cols={2}>
          <Card title={zh.hub.appsCardTitle}>
            <Stack gap={3}>
              {appRows.map((row) => (
                <div className="ui-app-row" key={row.key}>
                  <Row justify="between" gap={3} wrap>
                    <Row gap={2}>
                      <Icon name={row.icon} size={20} />
                      <strong>{row.name}</strong>
                    </Row>
                    <Row gap={2}>
                      <Badge tone={row.badge.tone} label={row.badge.label} dot />
                      <Link to={row.to} label={zh.hub.appEnter} />
                    </Row>
                  </Row>
                  {row.facts ? <div className="ui-app-facts ui-muted">{row.facts}</div> : null}
                </div>
              ))}
            </Stack>
          </Card>
          {hostCard}
        </Grid>
      ) : hostCard}

      <p className="ui-muted">
        {node.endpoint}
        {agentVersion ? ` · Agent v${agentVersion}` : ''} · {zh.hub.certLabel}：{certStatus} ·{' '}
        {zh.fields.lastSeen} {formatAbsoluteTime(node.lastSeenAt)}
      </p>
    </Stack>
  );
}
