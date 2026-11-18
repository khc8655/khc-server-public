import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ApiError } from '../data/client';
import { certificatesQueryOptions } from '../data/certs';
import { hubQueryOptions } from '../data/queries';
import { useHubChannelsContext } from '../app/HubChannelsProvider';
import { caddyConfigQueryOptions, kindLabelKey } from '../data/sites';
import { forwardConfigQueryOptions } from '../data/forwards';
import { wireGuardConfigQueryOptions } from '../data/wireguard';
import {
  classifyBackend,
  type BackendContext,
  type BackendInfo,
  type BackendKind,
} from '../data/services';
import { paths } from '../registry/routes';
import { resolveCertStatus } from './hubCertStatus';
import {
  Badge,
  Banner,
  Button,
  Card,
  Grid,
  Link,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  Stat,
  StatusDot,
} from '../ui';
import { zh, fmt } from '../i18n/zh';
import { TodoChips, type TodoChip } from '../patterns/TodoChips';
import { formatAbsoluteTime, formatBytes } from '../i18n/format';
import { splitFailedUnits } from '../data/managedUnits';
import { pickFailedUnits } from '../data/failedUnits';
import { CopyButton } from '../ui/secret';
import {
  forwardRows,
  peerRows,
  siteRows,
  type ServiceRowGroup,
} from './hubServiceRows';

/** 地址去掉协议前缀，只留主机名（P-1：标题下只显示主机名，不显示 https://）。 */
export function endpointHost(endpoint: string | null | undefined): string {
  const raw = (endpoint ?? '').trim();
  if (!raw) return '';
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

/**
 * 节点地址行（2026-11-16 P-1）：概况页标题下唯一一处地址。
 * 灰色纯文本，悬停/聚焦时才出现复制按钮，不占常态视觉。
 */
function NodeEndpointLine({ endpoint }: { endpoint: string | null | undefined }) {
  const host = endpointHost(endpoint);
  if (!host) return null;
  return (
    <span className="ui-endpoint-line">
      <span className="ui-endpoint-host">{host}</span>
      <span className="ui-endpoint-copy">
        <CopyButton value={host} label={zh.hub.copyEndpoint} />
      </span>
    </span>
  );
}

/**
 * 一组「对外服务」列表（P-2）：每组最多 5 行，超出给「全部 N 个 ›」。
 * 整行可点（不是蓝色链接），悬停出现灰色 ›。
 */
function ServiceRowsView({ group, onOpen }: { group: ServiceRowGroup; onOpen: () => void }) {
  if (!group.installed) {
    return (
      <div className="ui-service-group">
        <div className="ui-service-group-title">{group.title}</div>
        <p className="ui-muted ui-service-empty">未安装</p>
      </div>
    );
  }
  return (
    <div className="ui-service-group">
      <div className="ui-service-group-title">{group.title}</div>
      {group.items.length === 0 ? (
        <p className="ui-muted ui-service-empty">暂无</p>
      ) : (
        <div className="ui-service-list">
          {group.items.map((item) => (
            <button
              type="button"
              className="ui-service-row"
              key={item.key}
              onClick={onOpen}
              title={`${item.name} → ${item.detail}`}
            >
              <StatusDot tone={item.tone} />
              <span className="ui-service-name">{item.name}</span>
              <span className="ui-service-detail ui-muted">{item.detail}</span>
              <span className="ui-service-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
          {group.truncated ? (
            <button type="button" className="ui-service-row is-more" onClick={onOpen}>
              <span className="ui-service-name">全部 {group.total} 个</span>
              <span className="ui-service-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

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

  // 域名证书状态：控制面实测 > Agent 站点探测 > 证书库。
  //
  // 「控制面实测」= GET /nodes/:id/state 附带的 tls 结论：Workers 对 https 请求做完整且
  // 不可关闭的校验，探测通过就说明「该接入地址此刻出示的证书对本域名有效且受信」。
  // 这是唯一能覆盖 TLS 由外部反代 / Caddy / Tunnel 终结的节点的证据源——那类节点上
  // Agent 根本没有证书文件，按站点/证书库判定只会得出「未签发」的错误结论。
  const tlsProbe = state?.tls ?? null;
  const caddyAdapter = (state?.state?.adapters ?? []).find((adapter) => adapter.name === 'caddy-site');
  const caddyStatus = caddyAdapter?.status as
    | { error?: string; installed?: boolean; running?: boolean; siteHealth?: { name?: string; domain?: string; state?: string; error?: string }[] }
    | undefined;
  const domainHealth = node.domain
    ? caddyStatus?.siteHealth?.find((site) => (site.domain ?? site.name) === node.domain)
    : undefined;
  // 到期日：优先 Agent 自报的控制通道证书，其次证书库里本节点最近到期的一张；都没有就不编。
  const certsAdapter = (state?.state?.adapters ?? []).find((adapter) => adapter.name === 'certificates');
  const agentTlsCert = (
    certsAdapter?.status as { tls?: { present?: boolean; notAfter?: string | null } } | undefined
  )?.tls;
  const knownNotAfter: string | null = (() => {
    if (agentTlsCert?.present && agentTlsCert.notAfter) return agentTlsCert.notAfter.slice(0, 10);
    const dated = nodeCerts.filter(
      (cert): cert is (typeof nodeCerts)[number] & { notAfter: number } =>
        typeof cert.notAfter === 'number',
    );
    if (dated.length === 0) return null;
    const soonest = Math.min(...dated.map((cert) => cert.notAfter));
    return new Date(soonest * 1000).toISOString().slice(0, 10);
  })();
  const certStatus = resolveCertStatus({
    domain: node.domain ?? null,
    tlsProbe,
    siteHealth: domainHealth,
    knownNotAfter,
  });

  // 鉴权失败：Worker 已把 Agent 的 401/403 归一成 200 + error，这里单独识别，
  // 不再和「节点不可达」混在一起（那会让人误以为网络问题）。
  const authError = Boolean(
    state?.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(state.error),
  );
  const pfAdapter = (state?.state?.adapters ?? []).find((adapter) => adapter.name === 'port-forward');
  const pfStatus = pfAdapter?.status as
    | { installed?: boolean; running?: boolean; count?: number }
    | undefined;
  // 服务清单只在 /state（快照不含）；失败单元两边都有，快照优先（2026-11-16 U2）：
  // 快照每 10 秒刷新，/state 只在打开页面时拉一次 —— 只用 /state 会让计数冻住。
  const serviceOps = state?.state?.ops?.services;
  const services = serviceOps?.services ?? ops?.services?.services ?? [];
  // 失败单元取「快照优先」（U2）。null = 读不到（旧 Agent 且 /state 也没给），
  // 与空数组「确实没有」是两个不同文案，不能合并。
  const failedUnitsOrNull = pickFailedUnits(ops, serviceOps);
  const failedUnitsKnown = failedUnitsOrNull !== null;
  const failedUnits = failedUnitsOrNull ?? [];
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

  // 应用可见性与「未安装」一律只看 D1 期望配置（离线可见，首屏不闪）；
  // 「未安装」由 serviceGroups 的 installed 表达，不再用独立徽标（2026-11-16 P-2）。
  const sitesDirty = (sitesQuery.data?.rev ?? 0) > (sitesQuery.data?.appliedRev ?? 0);
  const forwardDirty = (forwardQuery.data?.rev ?? 0) > (forwardQuery.data?.appliedRev ?? 0);
  const wgInterface = wgQuery.data?.config.interface;
  const forwards = forwardQuery.data?.config.forwards ?? [];
  const disabledSites = sites.filter((site) => !site.enabled).length;

  // 应用可见性与「未安装」一律只看 D1 期望配置（离线可见，首屏不闪）；
  // 在线状态只用于「运行中 / 未运行 / 未读取」徽标，不参与行增删。
  const caddyConfigured = sitesQuery.data?.exists === true;
  const pfConfigured = forwardQuery.data?.exists === true;
  const wgReady = peerEnabled;

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

  // 对外服务摘要：只读聚合 D1 期望配置；后端识别复用 data/services.ts（与站点表/对外服务页同一来源）。
  const backendCtx: BackendContext =
    typeof wgStatus?.installed === 'boolean'
      ? {
          wireguard: {
            installed: wgStatus.installed,
            peers: peers.map((peer) => ({
              name: peer.name,
              allowedIps: peer.allowedIps,
              online: runtimePeers?.find((item) => item.name === peer.name)?.online ?? null,
            })),
          },
        }
      : {};
  const backendLabel: Record<BackendKind, string> = {
    local: zh.sites.backendLocal,
    vm: zh.sites.backendVm,
    internal: zh.sites.backendInternal,
    external: zh.sites.backendExternal,
    unix: zh.sites.backendUnix,
  };
  const backendSummary = (infos: BackendInfo[]): string =>
    (['local', 'vm', 'internal', 'external', 'unix'] as const)
      .map((kind) => {
        const count = infos.filter((info) => info.kind === kind).length;
        return count > 0 ? `${backendLabel[kind]} ${count}` : null;
      })
      .filter(Boolean)
      .join(' · ');
  const siteBackends = sites
    .filter((site) => site.kind === 'proxy')
    .map((site) => classifyBackend(site.upstreams[0] ?? site.upstream, backendCtx));
  const forwardBackends = forwards.map((forward) =>
    classifyBackend(`${forward.targetHost}:${forward.targetPort}`, backendCtx),
  );
  const disabledForwards = forwards.filter((forward) => !forward.enabled).length;

  // 对外服务三组列表（P-2）：计数只留上方指标卡，这里只列名字。
  // 已配置但空（0 站点 / 无 Peer）的组仍要出现并显示「暂无」；Agent 明确报未安装的
  // 组显示「未安装」——否则「配了却什么都没生效」这件事在页面上看不出来。
  const nowSec = Math.floor(Date.now() / 1000);
  const caddyInstalled = caddyStatus?.installed !== false;
  const pfInstalled = pfStatus?.installed !== false;
  const serviceGroups: ServiceRowGroup[] = [
    ...(caddyConfigured ? [siteRows(sites, caddyInstalled)] : []),
    ...(pfConfigured ? [forwardRows(forwards, pfInstalled)] : []),
    peerRows(peers, runtimePeers, nowSec, wgReady),
  ];

  // 「需要处理」只放面板能处理的单元（P-3 A）：系统单元放进去就永远清不掉。
  const { managed: managedFailedUnits, system: systemFailedUnits } = splitFailedUnits(failedUnits);

  // 「需要处理」聚合：受管失败单元 + 临期证书 + 长期离线 Peer（ui-redesign ③）
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
      action={<Link to={paths.hubSection(hubId, 'ops')} label="主机运维" />}
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
            {!failedUnitsKnown
              ? // 读不到 ≠ 没有失败：旧 Agent 且 /state 也没给时才到这里，宁可不猜。
                zh.hub.servicesUnknown
              : managedFailedUnits.length > 0
                ? fmt(zh.hub.servicesFailedCount, { count: managedFailedUnits.length })
                : services.length > 0
                  ? `${runningServices} / ${services.length}`
                  : '—'}
          </span>
        </Row>
        {/* 系统单元失败只在卡片里给一行灰色入口（P-3 A）：面板管不了，不进「需要处理」。 */}
        {systemFailedUnits.length > 0 ? (
          <button
            type="button"
            className="ui-service-row is-more"
            onClick={() => void navigate({ href: paths.hubSection(hubId, 'ops') })}
          >
            <span className="ui-service-name ui-muted">
              {fmt(zh.hub.systemUnitsFailed, { count: systemFailedUnits.length })}
            </span>
            <span className="ui-service-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ) : null}
        {services.length > 0 ? (
          // 列表用圆点 + 名字（§8.1）：徽标只给状态列用，服务名不是状态。
          <Row gap={3} wrap>
            {services.slice(0, 8).map((service) => (
              <span className="ui-service-chip" key={service.name}>
                <StatusDot
                  tone={service.state === 'active' || service.state === 'running' ? 'ok' : 'neutral'}
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
        {/* 地址只在概况页标题下出现一次（2026-11-16 P-1）：灰色纯文本，悬停出现复制。 */}
        <NodeEndpointLine endpoint={node.endpoint} />
        {summaryMode ? (
          <Row gap={2} wrap>
            <Badge tone="neutral" label={summaryMode === 'wg' ? zh.mode.badgeWg : zh.mode.badgeCaddy} />
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
          /* 不再在这里挂「直连 / 隧道」标签（P-4 A）：它只说明指标走哪条通道，
             却被读成「整页直连」。通道说明收进节点栏的统一连接指示。 */
          hint={agentVersion ? `Agent v${agentVersion}` : undefined}
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

      {/* 需要处理：服务失败 + 临期证书 + 长期离线 Peer，chip 直达对应页 */}
      <TodoChips items={todos} onOpen={(to) => void navigate({ href: to })} />

      {serviceGroups.length > 0 ? (
        <Grid cols={2}>
          <Card
            title={zh.hub.servicesCardTitle}
            action={<Link to={paths.hubSection(hubId, 'services')} label={zh.hub.appEnter} />}
          >
            <Stack gap={4}>
              {serviceGroups.map((group) => (
                <ServiceRowsView
                  key={group.title}
                  group={group}
                  onOpen={() => void navigate({ href: paths.hubSection(hubId, 'services') })}
                />
              ))}
            </Stack>
          </Card>
          {hostCard}
        </Grid>
      ) : hostCard}

      {/* 页脚不再重复地址（P-1）：地址只在标题下出现一次。 */}
      <p className="ui-muted">
        {agentVersion ? `Agent v${agentVersion} · ` : ''}
        {zh.hub.certLabel}：{certStatus} · {zh.fields.lastSeen}{' '}
        {formatAbsoluteTime(node.lastSeenAt)}
      </p>
    </Stack>
  );
}
