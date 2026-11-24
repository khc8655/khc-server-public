import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { Certificate, TaskResponse } from '@khc/contracts';
import { ApiError } from '../../data/client';
import { fetchTask, friendlyAgentError } from '../../data/apps';
import { hubAppsQueryOptions, hubQueryOptions, refreshHubRuntime } from '../../data/queries';
import { certificatesQueryOptions, pickPreferredCertId } from '../../data/certs';
import {
  PORT_FORWARD_APP,
  emptyForwardConfig,
  forwardConfigQueryOptions,
  normalizeForwardStatus,
} from '../../data/forwards';
import { HOST_OPS_APP } from '../../data/hostOps';
import {
  classifyBackend,
  listeningUpstream,
  unpublishedListeningPorts,
  type ListeningPort,
} from '../../data/services';
import { wireGuardConfigQueryOptions, parseWireGuardStatus } from '../../data/wireguard';
import {
  CADDY_SITE_APP,
  caddyConfigQueryOptions,
  caddyImportScanQueryOptions,
  caddyImportPreviewQueryOptions,
  emptyCaddyConfig,
  envelopeErrorText,
  externalBlockToSite,
  extractCaddyConfig,
  extractCaddyService,
  extractCaddyValidate,
  extractPasswordHash,
  healthForSite,
  hasExternalBlocks,
  importConflict,
  kindLabelKey,
  normalizeCaddyConfig,
  parseCaddyStatus,
  removeSite,
  runCaddyAction,
  saveCaddyConfig,
  setSiteEnabled,
  splitUpstreamHostPort,
  tlsModeLabelKey,
  upsertSite,
  type CaddyConfig,
  type CaddyConfigExport,
  type CaddyEnvelope,
  type CaddyServiceInfo,
  type CaddySite,
  type CaddyValidateResult,
  type ExternalSiteBlock,
} from '../../data/sites';
import { paths } from '../../registry/routes';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { AdvancedSection, ConfirmAction } from '../../patterns';
import {
  Banner,
  Badge,
  Button,
  Card,
  CodeBlock,
  Drawer,
  EmptyState,
  InlineError,
  KeyValue,
  Link,
  PageHeader,
  Row,
  Segmented,
  Skeleton,
  Stack,
  SyncStatus,
  Table,
  downloadTextFile,
  useToast,
  type ColumnDef,
  type SyncStatusProps,
  type Tone,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { daysUntil, formatAbsoluteTime, formatExpiry } from '../../i18n/format';
import { SiteDrawer } from './SiteDrawer';
import { InstallAndPublishDrawer } from './InstallAndPublishDrawer';
import { diagnoseSiteIssues } from './siteDiagnostics';
import { InstalledAppDrawer } from '../hosted-apps/InstalledAppDrawer';
import { appManifestsQueryOptions } from '../../data/appManifests';
import {
  appStatus,
  installedCatalogState,
  toAppView,
  type AppView,
  type InstalledApp,
} from '../../data/manifestApps';
import { installTaskText } from '../installTaskText';
import {
  buildSite,
  createForm,
  editForm,
  healthBadge,
  isLocalUpstreamHost,
  parseEndpointPort,
  pickRecommendedListenPort,
  siteAccessUrl,
  siteBackendText,
  siteSignature,
  siteTarget,
  uniqueSiteName,
  validateSite,
  type SiteErrors,
  type SiteFormState,
  type SiteRow,
} from './siteForm';

type UnifiedAppRow =
  | {
      kind: 'site';
      site: CaddySite;
      health: SiteRow['health'];
      installed?: InstalledApp;
      view?: AppView;
    }
  | {
      kind: 'installed';
      installed: InstalledApp;
      view?: AppView;
    };

function installedIdentity(entry: Pick<InstalledApp, 'manifestId' | 'instance'>): string {
  return `${entry.manifestId}::${entry.instance}`;
}

function installedDisplayName(entry: InstalledApp, view?: AppView): string {
  const base = !view?.invalid && view?.def.name ? view.def.name : entry.manifestId;
  return entry.instance && entry.instance !== entry.manifestId
    ? `${base} (${entry.instance})`
    : base;
}

function primaryPublishPort(entry: InstalledApp): number | null {
  const caddyEp = entry.endpoints.find((ep) => ep.publish === 'caddy' && typeof ep.port === 'number');
  if (caddyEp?.port !== undefined) return caddyEp.port;
  const pubEp = entry.endpoints.find((ep) => ep.publish !== 'none' && typeof ep.port === 'number');
  if (pubEp?.port !== undefined) return pubEp.port;
  const anyEp = entry.endpoints.find((ep) => typeof ep.port === 'number');
  return anyEp?.port ?? null;
}

function installedTargetText(entry: InstalledApp): string {
  const port = primaryPublishPort(entry);
  if (port !== null) return `${zh.sites.targetLocal} 127.0.0.1:${port}`;
  return entry.units.length > 0 ? `${entry.units.length} 个服务单元` : '—';
}

function matchInstalledSite(entry: InstalledApp, sites: readonly CaddySite[]): CaddySite | null {
  const proxySites = sites.filter((site) => site.kind === 'proxy');
  const candidatePorts = new Set(
    entry.endpoints
      .filter((ep) => ep.publish !== 'none' && typeof ep.port === 'number')
      .map((ep) => ep.port as number),
  );
  if (candidatePorts.size > 0) {
    const byPort = proxySites.find((site) =>
      site.upstreams.some((upstream) => {
        const parsed = splitUpstreamHostPort(upstream);
        const host = parsed.host;
        const isLoopback = !host || isLocalUpstreamHost(host) || host === 'localhost' || host === '::1';
        return isLoopback && parsed.port !== null && candidatePorts.has(parsed.port);
      }),
    );
    if (byPort) return byPort;
  }
  const byName = proxySites.find(
    (site) =>
      (site.name === entry.manifestId ||
        entry.endpoints.some((ep) => site.name === `${entry.manifestId}-${ep.id}`)) &&
      site.upstreams.some((upstream) => {
        const host = splitUpstreamHostPort(upstream).host;
        return !host || isLocalUpstreamHost(host) || host === 'localhost' || host === '::1';
      }),
  );
  return byName ?? null;
}

type ApplyConfirm = { kind: 'page' };

interface ServiceError {
  message: string;
  details: string | null;
}

interface SiteSaveError {
  message: string;
  details: string | null;
  hint: string | null;
}

function collectErrorLines(raw: unknown, out: string[], depth = 0): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 4) return;
  const record = raw as Record<string, unknown>;
  for (const key of ['restartStderr', 'systemctlStderr', 'reloadStderr', 'stderr', 'stdout'] as const) {
    const val = record[key];
    if (typeof val === 'string' && val.trim()) {
      out.push(`${key}: ${val.trim()}`);
    }
  }
  const cause = record.cause;
  if (cause && typeof cause === 'object' && !Array.isArray(cause)) {
    const causeRec = cause as Record<string, unknown>;
    if (typeof causeRec.message === 'string' && causeRec.message.trim()) {
      out.push(`cause: ${causeRec.message.trim()}`);
    }
    collectErrorLines(causeRec.details, out, depth + 1);
  }
}

function formatErrorDetails(raw: unknown, fields?: Record<string, string>): string | null {
  const lines: string[] = [];
  collectErrorLines(raw, lines);
  if (lines.length > 0) return lines.join('\n');
  if (raw && typeof raw === 'object' && Object.keys(raw as Record<string, unknown>).length > 0) {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return null;
    }
  }
  if (fields && Object.keys(fields).length > 0) {
    try {
      return JSON.stringify(fields, null, 2);
    } catch {
      return null;
    }
  }
  return null;
}

function message(error: unknown, fallback: string): string {
  const raw =
    error instanceof ApiError
      ? error.message
      : error instanceof Error && error.message
        ? error.message
        : fallback;
  return friendlyAgentError(raw) ?? fallback;
}

function extractSaveError(error: unknown, fallback: string): SiteSaveError {
  const msg = message(error, fallback);
  const details = error instanceof ApiError ? formatErrorDetails(error.details, error.fields) : null;
  const combined = `${msg}\n${details ?? ''}`;
  const isNotActive =
    /is not active/i.test(combined) ||
    (/127\.0\.0\.1:2019/i.test(combined) && /connection refused/i.test(combined));
  return {
    message: msg,
    details,
    hint: isNotActive ? zh.sites.caddyNotActiveHint : null,
  };
}

function formatServiceTime(value: string | null): string {
  if (!value) return zh.sites.serviceNever;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return formatAbsoluteTime(Math.floor(ms / 1000));
  return value;
}

/** 证书分段（只读摘要）用列定义 */
function certIssuerLabel(issuer: string | null): string {
  if (issuer === 'acme') return zh.certs.issuerAcme;
  if (issuer === 'selfsigned') return zh.certs.issuerSelfsigned;
  if (issuer === 'manual') return zh.certs.issuerManual;
  return zh.certs.issuerUnknown;
}

function certExpiryTone(notAfter: number | null): 'ok' | 'warn' | 'danger' | 'neutral' {
  const days = daysUntil(notAfter);
  if (days === null) return 'neutral';
  if (days < 0) return 'danger';
  if (days <= 30) return 'warn';
  return 'ok';
}

const certColumns: ColumnDef<Certificate>[] = [
  {
    key: 'name',
    type: 'name',
    header: zh.certs.colName,
    value: (cert) => cert.name,
    dot: (cert) => certExpiryTone(cert.notAfter),
  },
  {
    key: 'domains',
    type: 'mono',
    header: zh.certs.colDomains,
    value: (cert) => cert.domains.join(', '),
  },
  {
    key: 'issuer',
    type: 'text',
    header: zh.certs.colIssuer,
    value: (cert) => certIssuerLabel(cert.issuer),
  },
  {
    key: 'expiry',
    type: 'status',
    header: zh.certs.colExpiry,
    status: (cert) => ({
      tone: certExpiryTone(cert.notAfter),
      label: formatExpiry(cert.notAfter),
    }),
  },
];

const listeningColumnsBase: ColumnDef<ListeningPort>[] = [
  {
    key: 'port',
    type: 'name',
    header: zh.services.listeningColPort,
    width: '30%',
    value: (row) => (row.process ? `${row.port} · ${row.process}` : String(row.port)),
  },
  {
    key: 'address',
    type: 'mono',
    header: zh.services.listeningColAddress,
    width: '38%',
    value: (row) => row.address,
  },
  {
    key: 'proto',
    type: 'text',
    header: zh.services.listeningColProto,
    width: '14%',
    value: (row) => row.proto,
  },
];

interface ImportRow {
  block: ExternalSiteBlock;
  conflict: string | null;
}

function importTarget(block: ExternalSiteBlock): string {
  if (block.kind === 'static') return block.root || '—';
  if (block.kind === 'redirect') return block.redirectTo || '—';
  return block.upstreams.join(', ') || '—';
}

const importColumns: ColumnDef<ImportRow>[] = [
  {
    key: 'domains',
    type: 'mono',
    header: zh.sites.colDomain,
    value: (row) => row.block.domains.join(', '),
  },
  {
    key: 'kind',
    type: 'text',
    header: zh.sites.colKind,
    value: (row) => zh.sites[kindLabelKey(row.block.kind)],
  },
  {
    key: 'target',
    type: 'mono',
    header: zh.sites.colTarget,
    value: (row) => importTarget(row.block),
  },
  {
    key: 'tls',
    type: 'text',
    header: zh.sites.colTls,
    value: (row) => zh.sites[tlsModeLabelKey(row.block.tlsMode)],
    priority: 'low',
  },
  {
    key: 'source',
    type: 'text',
    header: zh.sites.importColSource,
    value: (row) => fmt(zh.sites.importSourceLines, { start: row.block.startLine, end: row.block.endLine }),
    priority: 'low',
  },
  {
    key: 'state',
    type: 'status',
    header: zh.sites.colSync,
    status: (row) => {
      if (row.conflict) return { tone: 'warn', label: zh.sites.importConflict };
      return row.block.supported
        ? { tone: 'ok', label: zh.sites.importSupported }
        : { tone: 'neutral', label: zh.sites.importUnsupported };
    },
  },
  { key: 'actions', type: 'actions', header: '' },
];

export default function SitesPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId/sites' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as {
    drawer?: string;
    upstream?: string;
    peer?: string;
    tab?: string;
  };

  const hubQuery = useQuery({ ...hubQueryOptions(hubId), enabled: false });
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const caddyQuery = useQuery(caddyConfigQueryOptions(hubId));
  const certsQuery = useQuery(certificatesQueryOptions());
  const forwardConfigured = appsQuery.data?.apps.some((item) => item.app === PORT_FORWARD_APP);
  const forwardQuery = useQuery({
    ...forwardConfigQueryOptions(hubId),
    enabled: appsQuery.isError ? true : Boolean(forwardConfigured),
  });
  // 反代上游的 Peer 列表只在打开站点抽屉时按需读取，避免跨应用预取 404。
  const [form, setForm] = useState<SiteFormState | null>(null);
  const wgQuery = useQuery({ ...wireGuardConfigQueryOptions(hubId), enabled: Boolean(form) });

  const configState = caddyQuery.data;
  const config = configState?.config ?? emptyCaddyConfig();
  const { channels, stateQuery } = useHubChannelsContext();
  const liveState = stateQuery.data?.state as
    | { adapters?: { name: string; status?: Record<string, unknown> }[] }
    | undefined;
  // 适配器运行态来自打开页面时的 /state 一次性探测（不随 10s 快照轮询）。
  const runtime = liveState
    ? { reachable: true, error: null, status: parseCaddyStatus(liveState.adapters ?? []) }
    : null;
  const status = runtime?.status ?? null;
  // 站点表「后端」列：只复用本页已拉取的 /state（WireGuard 运行态），零新增请求。
  const wgRuntime = parseWireGuardStatus(liveState?.adapters);
  const backendContext = {
    wireguard: wgRuntime
      ? {
          installed: wgRuntime.installed,
          peers: wgRuntime.peers.map((peer) => ({
            name: peer.name,
            allowedIps: peer.allowedIps,
            online: peer.online,
          })),
        }
      : undefined,
  };
  const backendText = (site: (typeof config.sites)[number]): string =>
    siteBackendText(site, backendContext);
  const hubName = hubQuery.data?.name ?? hubId;
  // 以控制面探测结果为准：节点列表状态可能是旧缓存，不能单独判定离线。
  const nodeOffline = channels.presence === 'offline';
  const unreachable = nodeOffline || !channels.canApply;
  const writeDisabledReason = unreachable
    ? nodeOffline
      ? zh.sites.offlineWriteReason
      : zh.channels.unknownWriteReason
    : undefined;
  const adapterMissing = Boolean(
    appsQuery.data && !appsQuery.data.adapters.some((adapter) => adapter.name === CADDY_SITE_APP),
  );
  const hasHostOps = Boolean(
    appsQuery.data?.adapters.some((adapter) => adapter.name === HOST_OPS_APP),
  );
  // 能力驱动：只有新 Agent 明确声明 pkgInstall 才显示「安装 Caddy」，
  // 旧 Agent（0.1.16）不会半可用地露出按钮。
  const canPkgInstall = Boolean(
    (appsQuery.data?.adapters.find((adapter) => adapter.name === CADDY_SITE_APP)?.capabilities as
      | Record<string, boolean>
      | undefined)?.pkgInstall,
  );
  const unapplied =
    configState !== undefined &&
    configState.rev !== null &&
    configState.appliedRev !== configState.rev;
  const certs = certsQuery.data ?? [];
  const peerTargets = (wgQuery.data?.config.peers ?? []).map((peer) => ({
    name: peer.name,
    host: (peer.allowedIps[0] ?? '').split('/')[0] ?? '',
  })).filter((peer) => peer.host);

  const rows: SiteRow[] = useMemo(
    () =>
      config.sites.map((site) => ({
        site,
        health: healthForSite(status, site),
      })),
    [config.sites, status],
  );
  const proxyRows = useMemo(() => rows.filter((row) => row.site.kind === 'proxy'), [rows]);
  const otherRows = useMemo(() => rows.filter((row) => row.site.kind !== 'proxy'), [rows]);
  const siteIssues = useMemo(
    () =>
      diagnoseSiteIssues({
        rows: proxyRows,
        ops: stateQuery.data?.state?.ops,
        backendContext,
      }),
    [proxyRows, stateQuery.data?.state?.ops, liveState?.adapters],
  );

  // 证书分段（只读摘要）：本节点签发，或被本节点站点的 TLS 引用
  const hubCerts = useMemo(
    () =>
      certs.filter(
        (cert) =>
          cert.sourceNodeId === hubId ||
          config.sites.some((site) => site.tls?.cert && site.tls.cert.$cert === cert.id),
      ),
    [certs, hubId, config.sites],
  );

  // 分段默认「应用」（只列 kind=proxy）；「静态与跳转」和「证书」仅在有数据时显示（R2）
  const resolveSegment = (tab?: string): 'apps' | 'other' | 'certs' =>
    tab === 'certs' ? 'certs' : tab === 'other' ? 'other' : 'apps';
  const [segment, setSegment] = useState<'apps' | 'other' | 'certs'>(() =>
    resolveSegment(search.tab),
  );
  useEffect(() => {
    if (search.tab) setSegment(resolveSegment(search.tab));
  }, [search.tab]);

  const forwardConfig = forwardQuery.data?.config ?? emptyForwardConfig();
  const forwardRuntime = normalizeForwardStatus(liveState?.adapters);
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const appViews = useMemo(() => (manifestsQuery.data ?? []).map(toAppView), [manifestsQuery.data]);
  const viewMap = useMemo(() => new Map(appViews.map((v) => [v.id, v])), [appViews]);
  const installedCatalog = useMemo(
    () => installedCatalogState(stateQuery.data?.state ?? null),
    [stateQuery.data?.state],
  );
  const privateManifestPorts = useMemo(
    () =>
      installedCatalog.entries.flatMap((entry) =>
        entry.endpoints
          .filter((ep) => ep.publish === 'none' && typeof ep.port === 'number')
          .map((ep) => ({ port: ep.port as number })),
      ),
    [installedCatalog.entries],
  );
  const claimedTcpPorts = (stateQuery.data?.state?.ports ?? [])
    .filter((entry) => entry.proto.toLowerCase().startsWith('tcp'))
    .map((entry) => ({ port: entry.port }));
  const nodeAgentPort = parseEndpointPort(hubQuery.data?.endpoint);
  const listeningPorts = useMemo(
    () =>
      unpublishedListeningPorts(stateQuery.data?.state?.ops, config.sites, [
        ...forwardConfig.forwards,
        ...(forwardRuntime?.rules ?? []),
        ...claimedTcpPorts,
        ...privateManifestPorts,
        ...(nodeAgentPort ? [{ port: nodeAgentPort }] : []),
      ]),
    [
      stateQuery.data?.state?.ops,
      config.sites,
      forwardConfig.forwards,
      forwardRuntime?.rules,
      stateQuery.data?.state?.ports,
      privateManifestPorts,
      nodeAgentPort,
    ],
  );

  const importScanQuery = useQuery({
    ...caddyImportScanQueryOptions(hubId),
    enabled: segment === 'apps' && !unreachable && !adapterMissing,
  });
  const [importView, setImportView] = useState<ExternalSiteBlock | null>(null);
  // 打开外部块抽屉时才生成影子预览（只读，一次请求）；旧 Agent 不支持时降级为直接接管。
  const importPreviewQuery = useQuery(
    caddyImportPreviewQueryOptions(
      hubId,
      importView?.hash ?? '',
      Boolean(importView?.supported) && !unreachable && !adapterMissing,
    ),
  );
  const [importTakeover, setImportTakeover] = useState<ExternalSiteBlock | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importPending, setImportPending] = useState<{
    backupPath: string;
    siteName: string | null;
    reason: string;
  } | null>(null);
  const [importRestoreConfirm, setImportRestoreConfirm] = useState(false);
  const externalBlocks = useMemo(
    () =>
      (importScanQuery.data?.blocks ?? []).filter(
        (block) => block.domains.length > 0 || block.supported,
      ),
    [importScanQuery.data?.blocks],
  );
  const importRows: ImportRow[] = useMemo(
    () =>
      externalBlocks.map((block) => ({
        block,
        conflict: importConflict(config, block),
      })),
    [externalBlocks, config],
  );

  const importRowActions = (row: ImportRow): ActionRef[] =>
    row.block.supported && !row.conflict ? [action('site.takeover')] : [];

  const importRowActionDisabled = (ref: ActionRef): string | undefined => {
    if (ref.id !== 'site.takeover') return undefined;
    if (unreachable || adapterMissing) return zh.sites.importDisabledOffline;
    if (unapplied) return zh.sites.importDisabledUnapplied;
    if (importBusy) return zh.sites.importTakeoverBusy;
    return undefined;
  };

  const handleImportRowAction = (ref: ActionRef, row: ImportRow) => {
    if (ref.id !== 'site.takeover') return;
    if (!row.block.supported) {
      toast.show({ message: row.block.reason ?? zh.sites.importUnsupported });
      return;
    }
    if (row.conflict) {
      toast.show({ message: row.conflict });
      return;
    }
    if (unapplied) {
      toast.show({ message: zh.sites.importDisabledUnapplied });
      return;
    }
    // 先看影子预览（将生成什么 / 会摘除什么 / 整树能否通过校验），再确认接管。
    setImportView(row.block);
  };
  const [searchText, setSearchText] = useState('');
  const importPreview =
    importView && importPreviewQuery.data?.hash === importView.hash ? importPreviewQuery.data : null;
  const importViewConflict = importView ? importConflict(config, importView) : null;
  const importTakeoverBlocked = (() => {
    if (!importView) return undefined;
    if (!importView.supported) return importView.reason ?? zh.sites.importUnsupported;
    if (importViewConflict) return importViewConflict;
    if (importPreviewQuery.isLoading) return zh.sites.importPreviewWaiting;
    if (importPreview && !importPreview.supported) {
      return importPreview.reason ?? zh.sites.importUnsupported;
    }
    if (importPreview?.validate && !importPreview.validate.ok) {
      return importPreview.validate.message ?? zh.sites.importPreviewValidateFailed;
    }
    return undefined;
  })();
  const [errors, setErrors] = useState<SiteErrors>({});
  const [saveError, setSaveError] = useState<SiteSaveError | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<{ message: string; details: string | null } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<CaddySite | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState<ApplyConfirm | null>(null);
  // P1：Caddy 未安装时的一键安装（仅 Agent 声明 pkgInstall 能力时展示）。
  const [installConfirm, setInstallConfirm] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [installTask, setInstallTask] = useState<TaskResponse | null>(null);

  const [serviceOpen, setServiceOpen] = useState(false);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<ServiceError | null>(null);
  const [serviceInfo, setServiceInfo] = useState<CaddyServiceInfo | null>(null);
  const [serviceValidate, setServiceValidate] = useState<CaddyValidateResult | null>(null);
  const [serviceView, setServiceView] = useState<'status' | 'config'>('status');
  const [serviceConfig, setServiceConfig] = useState<CaddyConfigExport | null>(null);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [startConfirm, setStartConfirm] = useState(false);
  const [exportConfirm, setExportConfirm] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedInstalledKey, setSelectedInstalledKey] = useState<string | null>(null);
  const [pendingSiteNames, setPendingSiteNames] = useState<string[]>([]);

  useEffect(() => {
    if (!unapplied) setPendingSiteNames([]);
  }, [unapplied]);

  const setDrawerSearch = (drawer?: string, replace = true, upstream?: string) => {
    void navigate({
      to: '/hubs/$hubId/sites',
      params: { hubId },
      search: { drawer, ...(upstream ? { upstream } : {}) },
      replace,
    });
  };

  const openCreate = (preset?: { upstreams?: string; process?: string; port?: number }) => {
    const next = createForm();
    const vmDomain = hubQuery.data?.domain?.trim() ?? '';
    const agentPort = parseEndpointPort(hubQuery.data?.endpoint);
    if (vmDomain) {
      next.domains = vmDomain;
      const preferredCertId = pickPreferredCertId(certs, vmDomain, hubQuery.data?.tlsCertId);
      if (preferredCertId) {
        next.tlsMode = 'manual';
        next.certId = preferredCertId;
      }
    }
    if (preset?.upstreams) {
      next.upstreams = preset.upstreams;
      const upstreamPort = preset.port ?? splitUpstreamHostPort(preset.upstreams).port;
      next.sourcePort = upstreamPort;
      next.name = uniqueSiteName(
        preset.process || (upstreamPort ? `app-${upstreamPort}` : 'app'),
        config.sites,
        upstreamPort,
      );
      next.listenPort = pickRecommendedListenPort({
        agentPort,
        localPort: upstreamPort,
        domain: vmDomain,
        existingSites: config.sites,
      });
    } else {
      next.listenPort = pickRecommendedListenPort({
        agentPort,
        domain: vmDomain,
        existingSites: config.sites,
      });
    }
    next.initial = siteSignature(next);
    setWizardOpen(false);
    setServiceOpen(false);
    setImportView(null);
    setSelectedInstalledKey(null);
    setForm(next);
    setErrors({});
    setSaveError(null);
    setDrawerSearch('site:new', false, preset?.upstreams);
  };

  const openEdit = (site: CaddySite) => {
    setWizardOpen(false);
    setServiceOpen(false);
    setImportView(null);
    setSelectedInstalledKey(null);
    setForm(editForm(site));
    setErrors({});
    setSaveError(null);
    setDrawerSearch(`site:${encodeURIComponent(site.name)}`, false);
  };

  const closeDrawer = () => {
    setForm(null);
    setSaveError(null);
    setDrawerSearch(undefined);
  };

  useEffect(() => {
    const drawer = search.drawer;
    if (!drawer) {
      setForm(null);
      return;
    }
    if (drawer === 'site:new') {
      const vmDomain = hubQuery.data?.domain?.trim() ?? '';
      if (form) {
        if (
          form.mode === 'create' &&
          certsQuery.data &&
          vmDomain &&
          form.tlsMode === 'auto' &&
          !form.certId &&
          siteSignature(form) === form.initial
        ) {
          const preferredCertId = pickPreferredCertId(
            certsQuery.data,
            vmDomain,
            hubQuery.data?.tlsCertId,
          );
          if (preferredCertId) {
            const updated: SiteFormState = {
              ...form,
              tlsMode: 'manual',
              certId: preferredCertId,
            };
            updated.initial = siteSignature(updated);
            setForm(updated);
          }
        }
        return;
      }
      const initialForm = createForm();
      const agentPort = parseEndpointPort(hubQuery.data?.endpoint);
      if (vmDomain) {
        initialForm.domains = vmDomain;
        const preferredCertId = pickPreferredCertId(certs, vmDomain, hubQuery.data?.tlsCertId);
        if (preferredCertId) {
          initialForm.tlsMode = 'manual';
          initialForm.certId = preferredCertId;
        }
      }
      if (search.upstream) {
        initialForm.upstreams = search.upstream;
        // D-09：记录发布时端口，后续改 Peer 地址时据此提示「端口被手工改过」。
        initialForm.sourcePort = splitUpstreamHostPort(search.upstream).port;
      }
      if (search.peer) {
        initialForm.name = `${search.peer}-app`;
        initialForm.sourcePeer = search.peer;
      }
      initialForm.listenPort = pickRecommendedListenPort({
        agentPort,
        localPort: initialForm.sourcePort,
        domain: vmDomain,
        existingSites: config.sites,
      });
      // 预填后重算基线，避免一打开就处于 dirty 状态。
      initialForm.initial = siteSignature(initialForm);
      setForm(initialForm);
      return;
    }
    if (drawer.startsWith('site:')) {
      let name = '';
      try {
        name = decodeURIComponent(drawer.slice(5));
      } catch {
        name = drawer.slice(5);
      }
      if (form?.mode === 'edit' && form.originalName === name) return;
      const site = (caddyQuery.data?.config ?? emptyCaddyConfig()).sites.find(
        (item) => item.name === name,
      );
      if (site) setForm(editForm(site));
    }
    // 仅在抽屉参数 / 配置 / 证书加载状态变化时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.drawer, caddyQuery.isSuccess, certsQuery.data, hubQuery.data?.tlsCertId]);

  const invalidateConfig = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP] }),
    ]);
  };

  const invalidateState = async () => {
    await refreshHubRuntime(queryClient, hubId);
  };

  const applyActionOnly = async (showPageError = true) => {
    let envelope;
    try {
      envelope = await runCaddyAction(hubId, 'apply');
    } catch (error) {
      if (showPageError && error instanceof ApiError) {
        setApplyError({
          message: error.message,
          details: formatErrorDetails(error.details, error.fields),
        });
      }
      throw error;
    }
    if (!envelope.ok) {
      if (showPageError) {
        setApplyError({
          message: envelope.error?.message ?? zh.sites.applyFailed,
          details: formatErrorDetails(envelope.error?.details),
        });
      }
      throw new ApiError(
        502,
        envelope.error?.code ?? 'apply_failed',
        envelopeErrorText(envelope) ?? zh.sites.applyFailed,
        undefined,
        envelope.error?.details,
      );
    }
    setApplyError(null);
    setPendingSiteNames([]);
  };

  const refreshAfterApply = async (backgroundProbe = false) => {
    await invalidateConfig();
    if (backgroundProbe) {
      void Promise.all([invalidateConfig(), invalidateState()]);
      return;
    }
    await invalidateState();
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await Promise.all([invalidateConfig(), invalidateState()]);
    }
  };

  const applyNow = async () => {
    await applyActionOnly();
    await refreshAfterApply(false);
  };

  const takeoverExternal = async (block: ExternalSiteBlock) => {
    setImportTakeover(null);
    setImportBusy(true);
    let backupPath: string | null = null;
    let saved = false;
    const site = externalBlockToSite(config, block);
    if (!site) {
      setImportBusy(false);
      toast.show({ message: zh.sites.importTakeoverBuildFailed });
      return;
    }
    const siteName = site.name;
    try {
      // 先落 D1 草稿（尚未 apply，不影响运行中的 Caddy）；再摘块并 apply。
      // 这样任何一步失败都不会让主 Caddyfile 先行缺失站点。
      await saveCaddyConfig(hubId, upsertSite(config, site));
      saved = true;
      await invalidateConfig();
      const taken = await runCaddyAction(hubId, 'caddy_import_takeover', { hash: block.hash });
      if (!taken.ok) throw new Error(envelopeErrorText(taken) ?? zh.sites.importTakeoverFailed);
      const result = (taken.result ?? {}) as Record<string, unknown>;
      backupPath = typeof result.backupPath === 'string' ? result.backupPath : null;
      await applyNow();
      await importScanQuery.refetch();
      setImportPending(null);
      toast.show({
        message: fmt(zh.sites.importTakeoverDone, { domain: site.domains[0] ?? site.name }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : zh.sites.importTakeoverFailed;
      if (backupPath) {
        // 站点块已从主 Caddyfile 摘除：保留面板站点并提供「重试应用 / 恢复 Caddyfile」。
        setImportPending({ backupPath, siteName, reason: message });
      } else {
        if (saved) {
          // 摘块前就失败：回滚 D1 草稿，保持面板期望配置与运行配置一致。
          try {
            await saveCaddyConfig(hubId, config);
            await invalidateConfig();
          } catch {
            // 回滚失败时保留错误提示，由用户手动处理。
          }
        }
        toast.show({ message });
      }
    } finally {
      setImportBusy(false);
    }
  };

  const retryImportedApply = async () => {
    if (!importPending) return;
    setImportBusy(true);
    try {
      await applyNow();
      await Promise.all([importScanQuery.refetch(), invalidateConfig()]);
      setImportPending(null);
      toast.show({ message: zh.sites.importApplied });
    } catch (error) {
      const message = error instanceof Error ? error.message : zh.sites.applyFailed;
      setImportPending({ ...importPending, reason: message });
    } finally {
      setImportBusy(false);
    }
  };

  const restoreCaddyfile = async () => {
    const pending = importPending;
    if (!pending) return;
    setImportRestoreConfirm(false);
    setImportBusy(true);
    try {
      // 顺序很重要：先撤掉面板站点并生效（此时主 Caddyfile 已无旧块），
      // 再恢复旧块，避免两份配置同时声明同一域名导致 validate 冲突。
      if (pending.siteName) {
        await saveCaddyConfig(hubId, removeSite(config, pending.siteName));
        await applyNow();
      }
      const restored = await runCaddyAction(hubId, 'caddy_import_restore', {
        backupPath: pending.backupPath,
      });
      if (!restored.ok) throw new Error(envelopeErrorText(restored) ?? zh.sites.importRestoreFailed);
      await Promise.all([importScanQuery.refetch(), invalidateConfig(), invalidateState()]);
      setImportPending(null);
      toast.show({ message: zh.sites.importRestored });
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : zh.sites.importRestoreFailed });
    } finally {
      setImportBusy(false);
    }
  };

  const submitInstall = async () => {
    setInstallConfirm(false);
    setInstallBusy(true);
    try {
      const envelope = await runCaddyAction(hubId, 'install');
      if (!envelope.ok) throw new Error(envelopeErrorText(envelope) ?? zh.sites.installFailed);
      if (envelope.taskId) {
        const task = await fetchTask(hubId, envelope.taskId);
        setInstallTask(task);
      } else {
        await Promise.all([invalidateState(), invalidateConfig()]);
      }
      toast.show({ message: zh.sites.installSubmitted });
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : zh.sites.installFailed });
    } finally {
      setInstallBusy(false);
    }
  };

  const refreshInstall = async () => {
    if (!installTask) return;
    setInstallBusy(true);
    try {
      const task = await fetchTask(hubId, installTask.task.id);
      setInstallTask(task);
      if (task.task.state === 'done') {
        await Promise.all([invalidateState(), invalidateConfig()]);
      }
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : zh.sites.installFailed });
    } finally {
      setInstallBusy(false);
    }
  };

  const hashPassword = async (password: string): Promise<string> => {
    const envelope = await runCaddyAction(hubId, 'hash_password', { password });
    if (!envelope.ok) {
      throw new Error(envelopeErrorText(envelope) ?? zh.sites.passwordHashFailed);
    }
    const hash = extractPasswordHash(envelope);
    if (!hash) throw new Error(zh.sites.passwordHashFailed);
    return hash;
  };

  const persist = async (nextConfig: CaddyConfig, apply: boolean, onBeforeRefresh?: () => void) => {
    await saveCaddyConfig(hubId, nextConfig);
    if (apply) {
      await applyActionOnly();
      onBeforeRefresh?.();
      toast.show({ message: zh.sites.appliedToast });
      void refreshAfterApply(true);
    } else {
      await invalidateConfig();
      toast.show({ message: zh.sites.savedToast });
    }
  };

  const save = async (apply: boolean) => {
    if (!form) return;
    const nextErrors = validateSite(form, {
      sites: config.sites,
      certIds: certs.map((cert) => cert.id),
      certsLoaded: certsQuery.isSuccess,
      nodeAgentPort: parseEndpointPort(hubQuery.data?.endpoint),
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const site = await buildSite(form, {
        offlineReason: unreachable ? writeDisabledReason : undefined,
        hashPassword,
      });
      const nextConfig = upsertSite(config, site, form.originalName);
      if (apply) {
        // §8.3：不在抽屉上再叠 Dialog；抽屉内直接保存并 apply，失败自动回滚 D1 并原地报错。
        await saveCaddyConfig(hubId, nextConfig);
        try {
          await applyActionOnly(false);
        } catch (err) {
          try {
            await saveCaddyConfig(hubId, config);
            await invalidateConfig();
          } catch {
            /* 保留原始 apply 错误供用户排查 */
          }
          throw err;
        }
        setPendingSiteNames([]);
        setApplyError(null);
        closeDrawer();
        toast.show({ message: zh.sites.appliedToast });
        void refreshAfterApply(true);
        return;
      }
      await saveCaddyConfig(hubId, nextConfig);
      setPendingSiteNames((prev) => [
        ...new Set([
          ...prev.filter((item) => item !== form.originalName),
          site.name,
        ]),
      ]);
      await invalidateConfig();
      setApplyError(null);
      toast.show({ message: zh.sites.savedToast });
      closeDrawer();
    } catch (error) {
      setSaveError(extractSaveError(error, zh.sites.createFailed));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (site: CaddySite) => {
    if (unreachable) return;
    setPageError(null);
    try {
      const nextConfig = setSiteEnabled(config, site.name, !site.enabled);
      await persist(nextConfig, true);
      toast.show({
        message: fmt(site.enabled ? zh.sites.disabledToast : zh.sites.enabledToast, {
          name: site.name,
        }),
      });
    } catch (error) {
      setPageError(message(error, zh.sites.applyFailed));
    }
  };

  const remove = async (site: CaddySite) => {
    try {
      const nextConfig = removeSite(config, site.name);
      await saveCaddyConfig(hubId, nextConfig);
      try {
        await applyActionOnly();
      } catch (err) {
        try {
          await saveCaddyConfig(hubId, config);
          await invalidateConfig();
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
        throw err;
      }
      setConfirmDelete(null);
      toast.show({ message: fmt(zh.sites.deletedToast, { name: site.name }) });
      void refreshAfterApply(true);
    } catch (error) {
      throw new Error(message(error, zh.sites.createFailed));
    }
  };

  const clearSites = async () => {
    try {
      await saveCaddyConfig(hubId, emptyCaddyConfig());
      await applyActionOnly();
      setClearConfirm(false);
      toast.show({ message: zh.sites.clearedToast });
      void refreshAfterApply(true);
    } catch (error) {
      throw new Error(message(error, zh.sites.clearFailed));
    }
  };

  const serviceFailure = (envelope: CaddyEnvelope, fallback: string): ServiceError => ({
    message: envelope.error?.message ?? fallback,
    details: envelope.error?.details
      ? JSON.stringify(envelope.error.details, null, 2)
      : null,
  });

  const loadService = async (options?: { silent?: boolean }): Promise<CaddyServiceInfo | null> => {
    if (!options?.silent) setServiceLoading(true);
    setServiceError(null);
    try {
      const [serviceEnvelope, validateEnvelope] = await Promise.all([
        runCaddyAction(hubId, 'caddy_service'),
        runCaddyAction(hubId, 'caddy_validate'),
      ]);
      if (!serviceEnvelope.ok) {
        const failure = serviceFailure(serviceEnvelope, zh.sites.serviceLoadError);
        setServiceError(failure);
        throw new Error(failure.message);
      }
      const validateResult = extractCaddyValidate(validateEnvelope);
      setServiceValidate(validateResult);
      const info = extractCaddyService(serviceEnvelope, validateResult);
      setServiceInfo(info);
      return info;
    } catch (error) {
      setServiceError((prev) =>
        prev ?? {
          message: message(error, zh.sites.serviceLoadError),
          details:
            error instanceof ApiError && error.fields
              ? JSON.stringify(error.fields, null, 2)
              : null,
        },
      );
      return null;
    } finally {
      if (!options?.silent) setServiceLoading(false);
    }
  };

  const openService = () => {
    closeDrawer();
    setWizardOpen(false);
    setImportView(null);
    setSelectedInstalledKey(null);
    setServiceOpen(true);
    setServiceView('status');
    setServiceConfig(null);
    void loadService();
  };

  const validateService = async () => {
    setServiceBusy('validate');
    setServiceError(null);
    try {
      const envelope = await runCaddyAction(hubId, 'caddy_validate');
      const result = extractCaddyValidate(envelope);
      setServiceValidate(result);
      if (result.ok) toast.show({ message: zh.sites.serviceValidateSuccess });
      else {
        toast.show({ message: zh.sites.serviceValidateFailedToast });
        if (result.message) {
          setServiceError({ message: result.message, details: null });
        }
      }
    } catch (error) {
      setServiceError({
        message: message(error, zh.sites.validateFailed),
        details:
          error instanceof ApiError && error.fields
            ? JSON.stringify(error.fields, null, 2)
            : null,
      });
    } finally {
      setServiceBusy(null);
    }
  };

  const reloadService = async () => {
    setServiceBusy('reload');
    setServiceError(null);
    try {
      const envelope = await runCaddyAction(hubId, 'caddy_reload');
      if (!envelope.ok) {
        const failure = serviceFailure(envelope, zh.sites.serviceReloadFailed);
        setServiceError(failure);
        throw new Error(envelopeErrorText(envelope) ?? zh.sites.serviceReloadFailed);
      }
      setReloadConfirm(false);
      toast.show({ message: zh.sites.serviceReloadSuccess });
      await loadService();
      await invalidateState();
    } catch (error) {
      if (error instanceof ApiError) {
        setServiceError((prev) =>
          prev ?? {
            message: error.message,
            details: error.fields ? JSON.stringify(error.fields, null, 2) : null,
          },
        );
      }
      throw new Error(message(error, zh.sites.serviceReloadFailed));
    } finally {
      setServiceBusy(null);
    }
  };

  const startService = async () => {
    setServiceBusy('start');
    setServiceError(null);
    try {
      const envelope = await runCaddyAction(hubId, 'caddy_start');
      if (!envelope.ok) {
        const failure = serviceFailure(envelope, zh.sites.serviceStartFailed);
        setServiceError(failure);
        throw new Error(envelopeErrorText(envelope) ?? zh.sites.serviceStartFailed);
      }
      setStartConfirm(false);
      toast.show({ message: zh.sites.serviceStartSuccess });
      // systemd 启动是异步的：连续探测几次，避免 Toast 成功但抽屉仍显示「未运行」。
      let info = await loadService();
      for (let i = 0; i < 8 && info && info.active !== true; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        info = await loadService({ silent: true });
      }
      await invalidateState();
    } catch (error) {
      if (error instanceof ApiError) {
        setServiceError((prev) =>
          prev ?? {
            message: error.message,
            details: error.fields ? JSON.stringify(error.fields, null, 2) : null,
          },
        );
      }
      throw new Error(message(error, zh.sites.serviceStartFailed));
    } finally {
      setServiceBusy(null);
    }
  };

  const loadConfig = async () => {
    setServiceBusy('export');
    setServiceError(null);
    try {
      const envelope = await runCaddyAction(hubId, 'caddy_config');
      if (!envelope.ok) {
        const failure = serviceFailure(envelope, zh.sites.serviceLoadError);
        setServiceError(failure);
        throw new Error(failure.message);
      }
      setServiceConfig(extractCaddyConfig(envelope));
      setServiceView('config');
      // 导出确认框是页面级的：确认成功后重新打开同一个服务抽屉展示配置。
      closeDrawer();
      setWizardOpen(false);
      setImportView(null);
      setSelectedInstalledKey(null);
      setServiceOpen(true);
      setExportConfirm(false);
    } catch (error) {
      if (error instanceof ApiError) {
        setServiceError((prev) =>
          prev ?? {
            message: error.message,
            details: error.fields ? JSON.stringify(error.fields, null, 2) : null,
          },
        );
      }
      throw new Error(message(error, zh.sites.serviceLoadError));
    } finally {
      setServiceBusy(null);
    }
  };

  const targetColText = (site: CaddySite): string =>
    site.kind === 'proxy' ? backendText(site) : siteTarget(site);

  const tlsShortLabel = (mode: CaddySite['tls']['mode']): string => {
    if (mode === 'off') return zh.sites.tlsShortOff;
    if (mode === 'manual') return zh.sites.tlsShortManual;
    if (mode === 'internal') return zh.sites.tlsShortInternal;
    return zh.sites.tlsShortAuto;
  };

  const copyAccessUrl = (url: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(url).then(
      () => toast.show({ message: zh.sites.urlCopied }),
      () => undefined,
    );
  };

  const siteInstalledMap = useMemo(() => {
    const bySiteName = new Map<string, InstalledApp>();
    const byInstalledId = new Map<string, CaddySite>();
    for (const entry of installedCatalog.entries) {
      const matched = matchInstalledSite(entry, config.sites);
      if (matched) {
        bySiteName.set(matched.name, entry);
        byInstalledId.set(installedIdentity(entry), matched);
      }
    }
    return { bySiteName, byInstalledId };
  }, [installedCatalog.entries, config.sites]);

  const selectedInstalledEntry = useMemo(
    () =>
      selectedInstalledKey
        ? (installedCatalog.entries.find((e) => installedIdentity(e) === selectedInstalledKey) ??
          null)
        : null,
    [selectedInstalledKey, installedCatalog.entries],
  );

  const unifiedRows: UnifiedAppRow[] = useMemo(() => {
    const siteItems: UnifiedAppRow[] = proxyRows.map((row) => {
      const installed = siteInstalledMap.bySiteName.get(row.site.name);
      return {
        kind: 'site',
        site: row.site,
        health: row.health,
        installed,
        view: installed ? viewMap.get(installed.manifestId) : undefined,
      };
    });
    const standaloneInstalled: UnifiedAppRow[] = installedCatalog.entries
      .filter((entry) => !siteInstalledMap.byInstalledId.has(installedIdentity(entry)))
      .map((entry) => ({
        kind: 'installed',
        installed: entry,
        view: viewMap.get(entry.manifestId),
      }));
    return [...siteItems, ...standaloneInstalled];
  }, [proxyRows, siteInstalledMap, installedCatalog.entries, viewMap]);

  const openInstalled = (entry: InstalledApp) => {
    closeDrawer();
    setWizardOpen(false);
    setServiceOpen(false);
    setImportView(null);
    setSelectedInstalledKey(installedIdentity(entry));
  };

  const publishInstalledEntry = (entry: InstalledApp) => {
    const port = primaryPublishPort(entry);
    openCreate(
      port !== null
        ? { upstreams: `127.0.0.1:${port}`, process: entry.manifestId, port }
        : { process: entry.manifestId },
    );
  };

  const siteSyncProps = (row: Pick<SiteRow, 'site' | 'health'>): SyncStatusProps => {
    if (!unapplied) return { state: 'synced' };
    const rowChanged =
      pendingSiteNames.includes(row.site.name) ||
      (status !== null && !row.health);
    return rowChanged
      ? { state: 'pending', rev: configState?.rev ?? undefined, label: zh.sites.syncPending }
      : { state: 'synced' };
  };

  const columns: ColumnDef<SiteRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.sites.colApp,
      width: '22%',
      value: (row) =>
        row.site.kind === 'proxy'
          ? row.site.name
          : `${row.site.name}（${zh.sites[kindLabelKey(row.site.kind)]}）`,
      dot: (row) => healthBadge(row).tone,
      // <1024 时指向目标列（low）隐藏，并入名称列第二段，保证窄屏不丢目标地址。
      narrow: (row) => targetColText(row.site),
    },
    {
      key: 'url',
      type: 'mono',
      header: zh.sites.colAccessUrl,
      width: '36%',
      value: (row) => siteAccessUrl(row.site) || row.site.domains.join(', '),
      render: (row) => {
        const url = siteAccessUrl(row.site);
        const tlsLabel = tlsShortLabel(row.site.tls.mode);
        const extraDomains = row.site.domains.length > 1 ? ` · +${row.site.domains.length - 1}` : '';
        return (
          <div className="ui-site-url-cell">
            <div className="ui-site-url-row">
              {url ? (
                <a
                  className="ui-site-url-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={url}
                  onClick={(event) => event.stopPropagation()}
                >
                  {url} ↗
                </a>
              ) : (
                <span>—</span>
              )}
              {url ? (
                <span onClick={(event) => event.stopPropagation()}>
                  <Button
                    label={zh.sites.copyUrl}
                    icon="copy"
                    iconOnly
                    variant="ghost"
                    size="sm"
                    onClick={() => copyAccessUrl(url)}
                  />
                </span>
              ) : null}
            </div>
            <span className="ui-site-url-sub">
              {tlsLabel}
              {extraDomains}
            </span>
          </div>
        );
      },
    },
    {
      key: 'target',
      type: 'mono',
      header: zh.sites.colTargetSummary,
      width: '26%',
      value: (row) => targetColText(row.site),
      priority: 'low',
    },
    {
      key: 'sync',
      type: 'sync',
      header: zh.sites.colStatus,
      width: '12%',
      sync: (row): SyncStatusProps => siteSyncProps(row),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const unifiedColumns: ColumnDef<UnifiedAppRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.sites.colApp,
      width: '20%',
      value: (row) =>
        row.kind === 'site'
          ? row.site.name
          : installedDisplayName(row.installed, row.view),
      dot: (row) => {
        if (row.kind === 'installed') {
          return appStatus(row.installed, installedCatalog).tone;
        }
        if (row.health?.state === 'down') return 'danger';
        if (row.installed) {
          const instTone = appStatus(row.installed, installedCatalog).tone;
          if (instTone === 'danger') return 'danger';
          if (!row.health) return instTone;
        }
        return healthBadge({ site: row.site, health: row.health }).tone;
      },
      narrow: (row) =>
        row.kind === 'site' ? targetColText(row.site) : installedTargetText(row.installed),
    },
    {
      key: 'source',
      type: 'status',
      header: '来源',
      width: '12%',
      priority: 'low',
      status: (row) => {
        if (row.installed) return { tone: 'info', label: '托管应用' };
        if (row.kind === 'site') {
          const firstUpstream = row.site.upstreams[0] ?? row.site.upstream ?? '';
          const isPeerProxy =
            Boolean(row.site.sourcePeer) ||
            (row.site.kind === 'proxy' && classifyBackend(firstUpstream, backendContext).kind === 'vm');
          if (isPeerProxy) return { tone: 'neutral', label: 'Peer 反代' };
        }
        return { tone: 'neutral', label: '手动站点' };
      },
    },
    {
      key: 'url',
      type: 'mono',
      header: zh.sites.colAccessUrl,
      width: '32%',
      value: (row) =>
        row.kind === 'site'
          ? siteAccessUrl(row.site) || row.site.domains.join(', ')
          : '仅本机',
      render: (row) => {
        if (row.kind === 'installed') {
          return <span className="ui-text-caption">仅本机（未发布）</span>;
        }
        const url = siteAccessUrl(row.site);
        const tlsLabel = tlsShortLabel(row.site.tls.mode);
        const extraDomains =
          row.site.domains.length > 1 ? ` · +${row.site.domains.length - 1}` : '';
        return (
          <div className="ui-site-url-cell">
            <div className="ui-site-url-row">
              {url ? (
                <a
                  className="ui-site-url-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={url}
                  onClick={(event) => event.stopPropagation()}
                >
                  {url} ↗
                </a>
              ) : (
                <span>—</span>
              )}
              {url ? (
                <span onClick={(event) => event.stopPropagation()}>
                  <Button
                    label={zh.sites.copyUrl}
                    icon="copy"
                    iconOnly
                    variant="ghost"
                    size="sm"
                    onClick={() => copyAccessUrl(url)}
                  />
                </span>
              ) : null}
            </div>
            <span className="ui-site-url-sub">
              {tlsLabel}
              {extraDomains}
            </span>
          </div>
        );
      },
    },
    {
      key: 'target',
      type: 'mono',
      header: zh.sites.colTargetSummary,
      width: '22%',
      value: (row) =>
        row.kind === 'site' ? targetColText(row.site) : installedTargetText(row.installed),
      priority: 'low',
    },
    {
      key: 'sync',
      type: 'sync',
      header: zh.sites.colStatus,
      width: '10%',
      render: (row) => {
        if (row.kind === 'site') {
          return <SyncStatus {...siteSyncProps(row)} />;
        }
        const st = appStatus(row.installed, installedCatalog);
        return <Badge tone={st.tone} label={st.label} />;
      },
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const listeningColumns: ColumnDef<ListeningPort>[] = [
    ...listeningColumnsBase,
    {
      key: 'publish',
      type: 'status',
      header: '',
      width: '18%',
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Button
            label={zh.services.listeningPublish}
            size="sm"
            disabled={unreachable}
            disabledReason={writeDisabledReason}
            onClick={() =>
              openCreate({
                upstreams: listeningUpstream(row),
                process: row.process ?? undefined,
                port: row.port,
              })
            }
          />
        </span>
      ),
    },
  ];

  const rowActions = (row: SiteRow): ActionRef[] => [
    action('site.update'),
    row.site.enabled ? action('site.disable') : action('site.enable'),
    action('site.delete'),
  ];

  const rowActionDisabled = (ref: ActionRef): string | undefined => {
    if (!unreachable) return undefined;
    if (ref.id === 'site.disable' || ref.id === 'site.enable' || ref.id === 'site.delete') {
      return writeDisabledReason;
    }
    return undefined;
  };

  const handleRowAction = (ref: ActionRef, row: SiteRow) => {
    if (ref.id === 'site.update') {
      openEdit(row.site);
      return;
    }
    if (ref.id === 'site.enable' || ref.id === 'site.disable') {
      void toggle(row.site);
      return;
    }
    if (ref.id === 'site.delete') setConfirmDelete(row.site);
  };

  const unifiedRowActions = (row: UnifiedAppRow): ActionRef[] => {
    if (row.kind === 'installed') {
      return [
        action('app.manage'),
        ...(primaryPublishPort(row.installed) !== null ? [action('app.publishSite')] : []),
      ];
    }
    return [
      ...(row.installed ? [action('app.manage')] : []),
      action('site.update'),
      row.site.enabled ? action('site.disable') : action('site.enable'),
      action('site.delete'),
    ];
  };

  const unifiedRowActionDisabled = (ref: ActionRef): string | undefined => {
    if (!unreachable) return undefined;
    if (
      ref.id === 'site.disable' ||
      ref.id === 'site.enable' ||
      ref.id === 'site.delete' ||
      ref.id === 'app.publishSite'
    ) {
      return writeDisabledReason;
    }
    return undefined;
  };

  const handleUnifiedRowAction = (ref: ActionRef, row: UnifiedAppRow) => {
    if (ref.id === 'app.manage' && row.installed) {
      openInstalled(row.installed);
      return;
    }
    if (ref.id === 'app.publishSite' && row.kind === 'installed') {
      publishInstalledEntry(row.installed);
      return;
    }
    if (row.kind === 'site') {
      handleRowAction(ref, row);
    }
  };

  const handlePageAction = (ref: ActionRef) => {
    if (ref.id === 'site.create') {
      openCreate();
      return;
    }
    if (ref.id === 'app.installPublish') {
      closeDrawer();
      setSelectedInstalledKey(null);
      setServiceOpen(false);
      setImportView(null);
      setWizardOpen(true);
      return;
    }
    if (ref.id === 'site.clear') {
      if (config.sites.length === 0) return;
      if (unreachable) {
        setPageError(zh.sites.offlineWriteReason);
        return;
      }
      setClearConfirm(true);
      return;
    }
    if (ref.id === 'caddy.service') {
      openService();
      return;
    }
    if (ref.id === 'app.apply') {
      setApplyConfirm({ kind: 'page' });
    }
  };

  const sync: SyncStatusProps = unreachable
    ? { state: 'queued', label: zh.status.queued, offlineHint: zh.sites.offlineDesc }
    : unapplied
      ? { state: 'pending', rev: configState?.rev ?? undefined, label: zh.sites.unapplied }
      : { state: 'synced' };

  interface PageBanner {
    key: string;
    tone: Tone;
    title: string;
    description?: string;
    action?: ReactNode;
    priority: number;
  }

  const banners: PageBanner[] = [];
  if (pageError) {
    banners.push({
      key: 'page-error',
      tone: 'danger',
      title: zh.sites.actionFailed,
      description: pageError,
      action: <Button label={zh.common.close} size="sm" onClick={() => setPageError(null)} />,
      priority: 0,
    });
  }
  // 只有「明确离线」才提示节点不可达；探测中/请求失败属于未确认，交给按钮的
  // writeDisabledReason 提示「暂时无法确认节点连接」，避免误报离线。
  if (nodeOffline) {
    banners.push({
      key: 'offline',
      tone: 'danger',
      title: zh.sites.offlineTitle,
      description: runtime?.error ?? zh.sites.offlineWriteReason,
      priority: 1,
    });
  }
  if (status?.validateOk === false) {
    banners.push({
      key: 'validate',
      tone: 'danger',
      title: zh.sites.validateFailed,
      description: status.validateMessage ?? undefined,
      priority: 2,
    });
  } else if (status?.error) {
    banners.push({
      key: 'caddy-error',
      tone: 'danger',
      title: zh.sites.serviceReloadFailed,
      description: status.error,
      priority: 2,
    });
  }
  if (adapterMissing || appsQuery.error) {
    banners.push({
      key: 'adapter',
      tone: 'warn',
      title: zh.sites.adapterMissing,
      description:
        friendlyAgentError(appsQuery.error instanceof Error ? appsQuery.error.message : null) ??
        zh.sites.adapterMissingDesc,
      priority: 3,
    });
  }
  if (unapplied) {
    banners.push({
      key: 'unapplied',
      tone: 'info',
      title: zh.sites.unapplied,
      description: zh.sites.unappliedDesc,
      action: (
        <Button
          label="应用到节点"
          size="sm"
          disabled={unreachable}
          disabledReason={writeDisabledReason}
          onClick={() => {
            if (unreachable) return;
            setApplyConfirm({ kind: 'page' });
          }}
        />
      ),
      priority: 4,
    });
  }
  const caddyMissing = Boolean(status && status.installed === false);
  if (!caddyQuery.isLoading && !appsQuery.isLoading && (!configState?.exists || caddyMissing)) {
    banners.push({
      key: caddyMissing ? 'not-installed' : 'not-configured',
      tone: caddyMissing ? 'warn' : 'info',
      title: caddyMissing ? zh.sites.notInstalledTitle : zh.sites.notInstalled,
      description: installTask
        ? installTaskText(installTask, zh.sites.installTaskState)
        : caddyMissing
          ? zh.sites.notInstalledDescInstall
          : zh.sites.notInstalledDesc,
      action:
        canPkgInstall && caddyMissing ? (
          installTask ? (
            <Button
              label={zh.sites.installRefresh}
              size="sm"
              loading={installBusy}
              onClick={() => void refreshInstall()}
            />
          ) : (
            <Button
              label={zh.sites.installCaddyAction}
              size="sm"
              loading={installBusy}
              disabled={unreachable}
              disabledReason={writeDisabledReason}
              onClick={() => setInstallConfirm(true)}
            />
          )
        ) : undefined,
      priority: 5,
    });
  }
  const visibleBanners = banners.sort((a, b) => a.priority - b.priority).slice(0, 2);

  const segmentOptions = [
    { value: 'apps', label: zh.sites.segmentAppsOnly },
    ...(otherRows.length > 0 || segment === 'other'
      ? [{ value: 'other', label: zh.sites.segmentOther }]
      : []),
    ...(hubCerts.length > 0 || segment === 'certs' || search.tab === 'certs'
      ? [{ value: 'certs', label: zh.sites.segmentCerts }]
      : []),
  ];

  const hasActionableExternal =
    hasExternalBlocks(externalBlocks) ||
    Boolean(importPending) ||
    Boolean(importScanQuery.data?.imports.length);

  const externalConfigCard = (
    <Card
      title={zh.sites.importTitle}
      action={
        <Row gap={2}>
          {/* 只有扫描确实发现外部站点块时才这样标注；0 站点不等于未纳管。 */}
          {hasExternalBlocks(externalBlocks) ? (
            <Badge tone="warn" label={zh.hub.appExternal} />
          ) : null}
          <Button
            label={zh.sites.importRefresh}
            variant="ghost"
            size="sm"
            icon="refresh"
            loading={importScanQuery.isFetching}
            disabled={unreachable || adapterMissing}
            disabledReason={zh.sites.importDisabledOffline}
            onClick={() => void importScanQuery.refetch()}
          />
        </Row>
      }
    >
      <Stack gap={2}>
        {importPending ? (
          <>
            <Banner
              tone="warn"
              title={zh.sites.importPendingTitle}
              description={fmt(zh.sites.importPendingDesc, { reason: importPending.reason })}
            />
            <Row gap={2} wrap>
              <Button
                label={zh.sites.importRetryApply}
                size="sm"
                loading={importBusy}
                onClick={() => void retryImportedApply()}
              />
              <Button
                label={zh.sites.importRestore}
                size="sm"
                variant="ghost"
                disabled={importBusy}
                onClick={() => setImportRestoreConfirm(true)}
              />
            </Row>
          </>
        ) : null}
        {unreachable || adapterMissing ? (
          <Banner tone="info" title={zh.sites.importDisabledOffline} />
        ) : importScanQuery.isLoading ? (
          <Stack gap={2}>
            <Skeleton height={12} />
            <Skeleton height={12} />
            <Skeleton height={12} />
          </Stack>
        ) : importScanQuery.isError ? (
          <InlineError
            message={
              friendlyAgentError(
                importScanQuery.error instanceof Error
                  ? importScanQuery.error.message
                  : null,
              ) ?? zh.sites.importScanFailed
            }
          />
        ) : !importScanQuery.data?.exists ? (
          <Banner tone="info" title={zh.sites.importCaddyfileMissing} />
        ) : importRows.length === 0 ? (
          <Banner tone="info" title={zh.sites.importEmpty} />
        ) : (
          <>
            {importScanQuery.data.imports.length > 0 ? (
              <Banner
                tone="warn"
                title={fmt(zh.sites.importImports, {
                  list: importScanQuery.data.imports.join(', '),
                })}
              />
            ) : null}
            <Table
              rows={importRows}
              columns={importColumns}
              rowKey={(row) => row.block.hash}
              objectLabel={zh.sites.importTitle}
              empty={{ icon: 'globe', title: zh.sites.importEmpty }}
              rowActions={importRowActions}
              rowActionDisabled={importRowActionDisabled}
              onRowAction={handleImportRowAction}
              onRowOpen={(row) => setImportView(row.block)}
            />
          </>
        )}
        <span className="ui-field-help">
          {fmt(zh.sites.importDesc, {
            path: importScanQuery.data?.caddyfilePath || 'Caddyfile',
          })}
          {importScanQuery.data?.imports.length ? ` · ${zh.sites.importTruncatedHint}` : ''}
        </span>
      </Stack>
    </Card>
  );

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.sites}
        scope={hubName}
        summary={
          proxyRows.length > 0
            ? fmt(zh.sites.appsSummaryCount, { count: proxyRows.length })
            : undefined
        }
        sync={sync}
        primaryAction={segment === 'certs' ? undefined : action('site.create')}
        secondaryActions={
          segment === 'certs'
            ? undefined
            : segment === 'apps'
              ? [action('app.installPublish'), action('caddy.service')]
              : [action('caddy.service')]
        }
        actionsDisabled={!channels.canApply}
        actionsDisabledReason={zh.channels.controlUnavailableDesc}
        onAction={handlePageAction}
      />

      {segmentOptions.length > 1 ? (
        <Segmented
          value={segment}
          ariaLabel={zh.nav.sites}
          options={segmentOptions}
          onChange={(value) =>
            setSegment(value === 'other' ? 'other' : value === 'certs' ? 'certs' : 'apps')
          }
        />
      ) : null}

      {caddyQuery.error ? (
        <Banner
          tone="danger"
          title={zh.sites.loadError}
          description={(caddyQuery.error as Error).message}
          action={<Button label={zh.common.retry} size="sm" onClick={() => void caddyQuery.refetch()} />}
        />
      ) : null}

      {visibleBanners.map((banner) => (
        <Banner
          key={banner.key}
          tone={banner.tone}
          title={banner.title}
          description={banner.description}
          action={banner.action}
        />
      ))}

      {applyError ? (
        <Card title={zh.sites.detailsTitle}>
          <Stack gap={3}>
            <InlineError message={applyError.message} />
            {applyError.details ? (
              <CodeBlock code={applyError.details} label={zh.sites.detailsTitle} />
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {segment === 'apps' ? (
        <>
          {siteIssues.length > 0 ? (
            <Card
              title={zh.sites.diagTitle}
              action={
                <Badge
                  tone="danger"
                  label={fmt(zh.sites.diagCountBadge, { count: String(siteIssues.length) })}
                  dot
                />
              }
            >
              <Stack gap={3}>
                {siteIssues.map((issue) => (
                  <Stack gap={1} key={issue.site.name}>
                    <Row justify="between" gap={2} align="center" wrap>
                      <Row gap={2} align="center" wrap>
                        <strong>{issue.site.name}</strong>
                        <Badge tone="danger" label={issue.statusLabel} />
                        {issue.site.upstreams[0] ? (
                          <span className="mono ui-muted">{issue.site.upstreams[0]}</span>
                        ) : null}
                      </Row>
                      <Row gap={2} wrap>
                        <Button
                          label={zh.sites.diagEditAction}
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(issue.site)}
                        />
                        <Button
                          label={zh.sites.diagDisableAction}
                          size="sm"
                          variant="ghost"
                          disabled={unreachable}
                          disabledReason={writeDisabledReason}
                          onClick={() => void toggle(issue.site)}
                        />
                        {issue.linkTarget === 'ops' ? (
                          <Link
                            to={paths.hubSection(hubId, 'ops')}
                            label={zh.sites.diagGoOps}
                          />
                        ) : issue.linkTarget === 'wireguard' ? (
                          <Link
                            to={paths.hubSection(hubId, 'wireguard')}
                            label={zh.sites.diagGoNetwork}
                          />
                        ) : null}
                      </Row>
                    </Row>
                    <span className="ui-field-help">{issue.summary}</span>
                  </Stack>
                ))}
              </Stack>
            </Card>
          ) : null}
          {installedCatalog.stale ? (
            <Banner
              tone="warn"
              title="应用状态可能不是最新"
              description="节点采集超时，展示最近一次成功缓存。"
              action={
                <Button
                  label="刷新"
                  size="sm"
                  onClick={() => void refreshHubRuntime(queryClient, hubId, { force: true })}
                />
              }
            />
          ) : null}
          {installedCatalog.pending ? (
            <Banner
              tone="info"
              title="应用状态读取中"
              description="Agent 正在后台采集应用状态，请稍后刷新。"
            />
          ) : null}
          {installedCatalog.error && !installedCatalog.pending ? (
            <InlineError message={installedCatalog.error} />
          ) : null}
          <Table
            rows={caddyQuery.isLoading ? undefined : unifiedRows}
            columns={unifiedColumns}
            rowKey={(row) =>
              row.kind === 'site' ? `site:${row.site.name}` : `app:${installedIdentity(row.installed)}`
            }
            objectLabel={zh.nav.sites}
            search={{ value: searchText, onChange: setSearchText, placeholder: zh.sites.searchPlaceholder }}
            empty={{
              icon: 'globe',
              title: zh.sites.appsEmptyTitle,
              description: zh.sites.appsEmptyHint,
              action: (
                <Button
                  label={zh.sites.addFirstApp}
                  variant="primary"
                  icon="plus"
                  disabled={unreachable}
                  disabledReason={writeDisabledReason}
                  onClick={() => openCreate()}
                />
              ),
            }}
            rowActions={unifiedRowActions}
            rowActionDisabled={unifiedRowActionDisabled}
            onRowAction={handleUnifiedRowAction}
            onRowOpen={(row) =>
              row.installed ? openInstalled(row.installed) : row.kind === 'site' ? openEdit(row.site) : undefined
            }
          />

          {hasActionableExternal ? externalConfigCard : null}

          <AdvancedSection title={zh.common.advancedSection}>
            <Stack gap={3}>
              {listeningPorts.length > 0 ? (
                <Card title={zh.services.listeningTitle}>
                  <Stack gap={2}>
                    <span className="ui-field-help">{zh.services.listeningHint}</span>
                    <Table
                      rows={listeningPorts}
                      columns={listeningColumns}
                      rowKey={(row) => String(row.port)}
                      objectLabel={zh.services.listeningTitle}
                      empty={{
                        icon: 'activity',
                        title: zh.services.listeningEmpty,
                        description: zh.services.listeningHint,
                      }}
                      onRowOpen={(row) =>
                        openCreate({
                          upstreams: listeningUpstream(row),
                          process: row.process ?? undefined,
                          port: row.port,
                        })
                      }
                    />
                  </Stack>
                </Card>
              ) : null}
              {!hasActionableExternal ? externalConfigCard : null}
              <Row gap={2} wrap>
                <Button
                  label={actionLabel(action('site.clear'))}
                  size="sm"
                  variant="danger-text"
                  disabled={config.sites.length === 0 || unreachable}
                  disabledReason={writeDisabledReason}
                  onClick={() => {
                    if (config.sites.length === 0 || unreachable) return;
                    setClearConfirm(true);
                  }}
                />
              </Row>
            </Stack>
          </AdvancedSection>
        </>
      ) : null}

      {segment === 'other' ? (
        <Table
          rows={caddyQuery.isLoading ? undefined : otherRows}
          columns={columns}
          rowKey={(row) => row.site.name}
          objectLabel={zh.sites.segmentOther}
          search={{ value: searchText, onChange: setSearchText, placeholder: zh.sites.colDomain }}
          empty={{
            icon: 'globe',
            title: zh.sites.emptyTitle,
            description: zh.sites.emptyHint,
          }}
          rowActions={rowActions}
          rowActionDisabled={rowActionDisabled}
          onRowAction={handleRowAction}
          onRowOpen={(row) => openEdit(row.site)}
        />
      ) : null}

      {segment === 'certs' ? (
        <Card
          title={zh.sites.segmentCerts}
          action={<Link to={`${paths.settings}?tab=certs`} label={zh.sites.certsManage} />}
        >
          <Stack gap={3}>
            <Table
              rows={certsQuery.isLoading ? undefined : hubCerts}
              columns={certColumns}
              rowKey={(cert) => cert.id}
              objectLabel={zh.sites.segmentCerts}
              empty={{
                icon: 'lock',
                title: zh.sites.certsEmptyTitle,
                description: zh.sites.certsEmptyHint,
              }}
            />
            <span className="ui-field-help">{zh.sites.certsLibraryNote}</span>
          </Stack>
        </Card>
      ) : null}

      {form ? (
        <SiteDrawer
          form={form}
          errors={errors}
          saveError={saveError}
          saving={saving}
          hubId={hubId}
          hubName={hubName}
          node={hubQuery.data}
          hasHostOps={hasHostOps}
          offlineReason={writeDisabledReason}
          certificates={certs}
          peers={peerTargets}
          existingSites={config.sites}
          existingDomains={[
            ...(hubQuery.data?.domain ? [hubQuery.data.domain] : []),
            ...config.sites
              .filter((site) => site.tls.mode !== 'off')
              .flatMap((site) => site.domains),
          ]}
          linkedInstalledApp={(() => {
            if (form.mode !== 'edit') return undefined;
            const linked = siteInstalledMap.bySiteName.get(form.originalName ?? form.name);
            if (!linked) return undefined;
            const st = appStatus(linked, installedCatalog);
            return {
              name: installedDisplayName(linked, viewMap.get(linked.manifestId)),
              statusLabel: st.label,
              statusTone: st.tone,
              onManage: () => openInstalled(linked),
            };
          })()}
          onChange={(patch) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onClose={closeDrawer}
          onSave={(apply) => void save(apply)}
        />
      ) : null}

      {selectedInstalledEntry ? (
        <InstalledAppDrawer
          hubId={hubId}
          hubName={hubName}
          entry={selectedInstalledEntry}
          view={viewMap.get(selectedInstalledEntry.manifestId)}
          state={stateQuery.data?.state ?? null}
          catalogState={installedCatalog}
          offlineReason={writeDisabledReason}
          linkedSite={siteInstalledMap.byInstalledId.get(installedIdentity(selectedInstalledEntry)) ?? null}
          onEditSite={(site) => openEdit(site)}
          onDeleteLinkedSite={remove}
          onPublish={publishInstalledEntry}
          onClose={() => setSelectedInstalledKey(null)}
        />
      ) : null}

      {wizardOpen ? (
        <InstallAndPublishDrawer
          hubId={hubId}
          hubName={hubName}
          node={hubQuery.data}
          state={stateQuery.data?.state ?? null}
          hasHostOps={hasHostOps}
          certificates={certs}
          existingSites={config.sites}
          offlineReason={writeDisabledReason}
          onClose={() => setWizardOpen(false)}
          onPublished={async () => {
            await Promise.all([invalidateConfig(), invalidateState()]);
          }}
        />
      ) : null}

      {serviceOpen ? (
        <ServiceDrawer
          open
          hubName={hubName}
          loading={serviceLoading}
          error={serviceError}
          info={serviceInfo}
          validate={serviceValidate}
          view={serviceView}
          config={serviceConfig}
          busy={serviceBusy}
          offlineReason={writeDisabledReason}
          onClose={() => setServiceOpen(false)}
          onReload={() => {
            // §8.3：先关闭服务抽屉，再走页面级确认，避免抽屉上再盖 Dialog。
            setServiceOpen(false);
            setReloadConfirm(true);
          }}
          onStart={() => {
            setServiceOpen(false);
            setStartConfirm(true);
          }}
          onValidate={() => void validateService()}
          onExport={() => {
            setServiceOpen(false);
            setExportConfirm(true);
          }}
          onBack={() => setServiceView('status')}
          onRetry={() => void loadService()}
        />
      ) : null}

      {installConfirm ? (
        <ConfirmAction
          open
          action={action('app.install')}
          title={zh.sites.installCaddyTitle}
          body={zh.sites.installCaddyBody}
          confirmLabel={zh.sites.installCaddyConfirm}
          onCancel={() => setInstallConfirm(false)}
          onConfirm={submitInstall}
        />
      ) : null}

      {applyConfirm ? (
        <ConfirmAction
          open
          action={action('app.apply')}
          title={zh.sites.applyConfirmTitle}
          body={zh.sites.applyConfirmBody}
          confirmLabel="应用到节点"
          onCancel={() => setApplyConfirm(null)}
          onConfirm={async () => {
            await applyActionOnly();
            setApplyConfirm(null);
            toast.show({ message: zh.sites.appliedToast });
            void refreshAfterApply(true);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmAction
          open
          action={action('site.delete')}
          title={fmt(zh.sites.deleteTitle, { name: confirmDelete.domain })}
          body={zh.sites.deleteBody}
          confirmLabel={zh.sites.deleteConfirm}
          targetName={confirmDelete.name}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove(confirmDelete)}
        />
      ) : null}

      {clearConfirm ? (
        <ConfirmAction
          open
          action={action('site.clear')}
          title={zh.sites.clearTitle}
          body={zh.sites.clearBody}
          confirmLabel={zh.sites.clearConfirm}
          onCancel={() => setClearConfirm(false)}
          onConfirm={clearSites}
        />
      ) : null}

      {startConfirm ? (
        <ConfirmAction
          open
          action={action('caddy.start')}
          title={zh.sites.serviceStartConfirmTitle}
          body={zh.sites.serviceStartConfirmBody}
          confirmLabel={actionLabel(action('caddy.start'))}
          onCancel={() => setStartConfirm(false)}
          onConfirm={startService}
        />
      ) : null}

      {reloadConfirm ? (
        <ConfirmAction
          open
          action={action('caddy.reload')}
          title={zh.sites.serviceReloadConfirmTitle}
          body={zh.sites.serviceReloadConfirmBody}
          confirmLabel={actionLabel(action('caddy.reload'))}
          onCancel={() => setReloadConfirm(false)}
          onConfirm={reloadService}
        />
      ) : null}

      {importTakeover ? (
        <ConfirmAction
          open
          action={action('site.takeover')}
          title={fmt(zh.sites.importTakeoverTitle, {
            domain: importTakeover.domains[0] ?? importTakeover.address,
          })}
          body={zh.sites.importTakeoverBody}
          confirmLabel={importBusy ? zh.sites.importTakeoverBusy : zh.sites.importTakeoverConfirm}
          onCancel={() => setImportTakeover(null)}
          onConfirm={() => takeoverExternal(importTakeover)}
        />
      ) : null}

      {importRestoreConfirm ? (
        <ConfirmAction
          open
          action={action('site.restoreCaddyfile')}
          title={zh.sites.importRestoreTitle}
          body={zh.sites.importRestoreBody}
          confirmLabel={zh.sites.importRestoreConfirm}
          onCancel={() => setImportRestoreConfirm(false)}
          onConfirm={() => restoreCaddyfile()}
        />
      ) : null}

      {importView ? (
        <Drawer
          open
          title={zh.sites.importViewTitle}
          onClose={() => setImportView(null)}
          footer={
            <Row gap={2} justify="end">
              <Button label={zh.common.close} onClick={() => setImportView(null)} />
              {importView.supported ? (
                <Button
                  label={zh.sites.importTakeoverConfirm}
                  variant="primary"
                  disabled={unreachable || unapplied || importBusy || Boolean(importTakeoverBlocked)}
                  disabledReason={
                    unreachable
                      ? zh.sites.importDisabledOffline
                      : unapplied
                        ? zh.sites.importDisabledUnapplied
                        : importTakeoverBlocked
                  }
                  onClick={() => {
                    const block = importView;
                    setImportView(null);
                    setImportTakeover(block);
                  }}
                />
              ) : null}
            </Row>
          }
        >
          <Stack gap={3}>
            <KeyValue
              items={[
                { key: zh.sites.colDomain, value: importView.domains.join(', ') },
                { key: zh.sites.colKind, value: zh.sites[kindLabelKey(importView.kind)] },
                { key: zh.sites.colTarget, value: importTarget(importView) },
                { key: zh.sites.colTls, value: zh.sites[tlsModeLabelKey(importView.tlsMode)] },
                {
                  key: zh.sites.importColSource,
                  value: fmt(zh.sites.importSourceLines, {
                    start: importView.startLine,
                    end: importView.endLine,
                  }),
                },
              ]}
            />
            {!importView.supported ? (
              <Banner tone="warn" title={importView.reason ?? zh.sites.importUnsupported} />
            ) : null}
            {importView.supported && importViewConflict ? (
              <Banner tone="warn" title={importViewConflict} />
            ) : null}
            {importView.supported ? (
              <>
                {importPreviewQuery.isLoading ? (
                  <Banner tone="info" title={zh.sites.importPreviewLoading} />
                ) : null}
                {importPreviewQuery.isError ? (
                  <Banner tone="info" title={zh.sites.importPreviewUnsupportedAgent} />
                ) : null}
                {importPreview ? (
                  <KeyValue
                    items={[
                      {
                        key: zh.sites.importPreviewRemove,
                        value: fmt(zh.sites.importPreviewRemoveValue, {
                          start: importPreview.remove?.startLine ?? importView.startLine,
                          end: importPreview.remove?.endLine ?? importView.endLine,
                        }),
                      },
                      {
                        key: zh.sites.importPreviewImport,
                        value: importPreview.importInfo
                          ? importPreview.importInfo.willAppend
                            ? zh.sites.importPreviewImportAppend
                            : zh.sites.importPreviewImportPresent
                          : '—',
                      },
                      {
                        key: zh.sites.importPreviewValidate,
                        value: importPreview.validate
                          ? importPreview.validate.ok
                            ? zh.sites.importPreviewValidateOk
                            : (importPreview.validate.message ?? zh.sites.importPreviewValidateFailed)
                          : '—',
                      },
                    ]}
                  />
                ) : null}
                {importPreview?.snippet ? (
                  <CodeBlock code={importPreview.snippet} label={zh.sites.importPreviewSnippet} />
                ) : null}
                {importPreview?.validate && !importPreview.validate.ok ? (
                  <Banner
                    tone="danger"
                    title={importPreview.validate.message ?? zh.sites.importPreviewValidateFailed}
                  />
                ) : null}
              </>
            ) : null}
            <CodeBlock code={importView.text} label={zh.sites.importViewTitle} />
          </Stack>
        </Drawer>
      ) : null}

      {exportConfirm ? (
        <ConfirmAction
          open
          action={action('caddy.export')}
          title={zh.sites.serviceExportTitle}
          body={zh.sites.serviceExportSensitive}
          confirmLabel={actionLabel(action('caddy.export'))}
          onCancel={() => setExportConfirm(false)}
          onConfirm={loadConfig}
        />
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------ ServiceDrawer */

function ServiceDrawer({
  open,
  hubName,
  loading,
  error,
  info,
  validate,
  view,
  config,
  busy,
  offlineReason,
  onClose,
  onReload,
  onStart,
  onValidate,
  onExport,
  onBack,
  onRetry,
}: {
  open: boolean;
  hubName: string;
  loading: boolean;
  error: ServiceError | null;
  info: CaddyServiceInfo | null;
  validate: CaddyValidateResult | null;
  view: 'status' | 'config';
  config: CaddyConfigExport | null;
  busy: string | null;
  offlineReason?: string;
  onClose: () => void;
  onReload: () => void;
  onStart: () => void;
  onValidate: () => void;
  onExport: () => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const configText = config
    ? [config.caddyfile, ...config.snippets].filter((item) => item.trim().length > 0).join('\n\n')
    : '';
  const active = info?.active ?? null;
  const validateOk = validate?.ok ?? info?.validateOk ?? null;
  const validateMessage = validate?.message ?? info?.validateMessage ?? null;
  const bannerTone: Tone =
    validateOk === false || active === false ? 'danger' : validateOk === true ? 'info' : 'warn';
  const bannerTitle =
    validateOk === false
      ? zh.sites.serviceValidateFailed
      : active === false && info
        ? zh.sites.serviceStopped
        : validateOk === true
          ? zh.sites.serviceNormal
          : zh.sites.serviceTitle;
  return (
    <Drawer
      open={open}
      title={zh.sites.serviceTitle}
      context={fmt(zh.sites.serviceContext, { hub: hubName })}
      onClose={onClose}
      footer={
        view === 'status' ? (
          <Row gap={2}>
            <Button
              label={zh.sites.serviceValidateAction}
              loading={busy === 'validate'}
              disabled={Boolean(offlineReason)}
              disabledReason={offlineReason}
              onClick={onValidate}
            />
            <Button
              label={actionLabel(action('caddy.export'))}
              icon="download"
              disabled={Boolean(offlineReason)}
              disabledReason={offlineReason}
              onClick={onExport}
            />
            {active === false ? (
              <Button
                label={actionLabel(action('caddy.start'))}
                variant="primary"
                icon="play"
                loading={busy === 'start'}
                disabled={Boolean(offlineReason)}
                disabledReason={offlineReason}
                onClick={onStart}
              />
            ) : (
              <Button
                label={actionLabel(action('caddy.reload'))}
                variant="primary"
                icon="refresh"
                loading={busy === 'reload'}
                disabled={Boolean(offlineReason)}
                disabledReason={offlineReason}
                onClick={onReload}
              />
            )}
          </Row>
        ) : (
          <Row gap={2}>
            <Button label={zh.sites.serviceBack} onClick={onBack} />
            <Button
              label={zh.sites.serviceDownload}
              icon="download"
              variant="primary"
              disabled={!configText}
              disabledReason={zh.sites.serviceConfigEmpty}
              onClick={() => downloadTextFile(configText, 'caddy-config.txt')}
            />
          </Row>
        )
      }
    >
      <Stack gap={4}>
        {view === 'status' ? (
          <>
            <Banner
              tone={bannerTone}
              title={bannerTitle}
              description={validateMessage ?? undefined}
            />
            {error ? (
              <Stack gap={2}>
                <Banner
                  tone="danger"
                  title={error.message}
                  action={
                    <Button
                      label={zh.sites.serviceRetry}
                      size="sm"
                      disabled={Boolean(offlineReason)}
                      disabledReason={offlineReason}
                      onClick={onRetry}
                    />
                  }
                />
                {error.details ? (
                  <CodeBlock code={error.details} label={zh.sites.serviceDetails} />
                ) : null}
              </Stack>
            ) : null}
            {validate?.details ? (
              <CodeBlock code={validate.details} label={zh.sites.detailsTitle} />
            ) : null}
            {loading ? (
              <Stack gap={2}>
                <Skeleton height={10} />
                <Skeleton height={10} />
                <Skeleton height={10} width="70%" />
              </Stack>
            ) : null}
            {info ? (
              <Card title={zh.sites.serviceStatusTitle}>
                <KeyValue
                  items={[
                    { key: zh.sites.serviceVersion, value: info.version ?? '—', mono: true },
                    { key: zh.sites.serviceUnit, value: info.unit ?? '—', mono: true },
                    {
                      key: zh.sites.serviceActive,
                      value:
                        active === null
                          ? '—'
                          : active
                            ? zh.sites.serviceRunning
                            : zh.sites.serviceStopped,
                    },
                    {
                      key: zh.sites.serviceValidate,
                      value:
                        validateOk === null
                          ? '—'
                          : validateOk
                            ? zh.sites.serviceValidateOk
                            : zh.sites.serviceValidateFailed,
                    },
                    {
                      key: zh.sites.serviceLastReload,
                      value: formatServiceTime(info.lastReloadAt),
                    },
                    { key: zh.sites.serviceCaddyfile, value: info.caddyfile ?? '—', mono: true, mode: 'middle' },
                  ]}
                />
              </Card>
            ) : null}
          </>
        ) : (
          <>
            <Banner tone="warn" title={zh.sites.serviceExportSensitive} />
            {config && config.caddyfile ? (
              <CodeBlock code={config.caddyfile} label={zh.sites.serviceCaddyfileLabel} />
            ) : null}
            {config?.snippets.map((snippet, index) => (
              <CodeBlock
                key={`snippet-${index}`}
                code={snippet}
                label={fmt(zh.sites.serviceSnippetLabel, { index: index + 1 })}
              />
            ))}
            {!configText ? (
              <EmptyState icon="terminal" title={zh.sites.serviceConfigEmpty} />
            ) : null}
          </>
        )}
      </Stack>
    </Drawer>
  );
}
