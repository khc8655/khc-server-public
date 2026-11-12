import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { Certificate, TaskResponse } from '@khc/contracts';
import { ApiError } from '../../data/client';
import { fetchTask, friendlyAgentError } from '../../data/apps';
import { hubAppsQueryOptions, hubQueryOptions } from '../../data/queries';
import { certificatesQueryOptions } from '../../data/certs';
import { wireGuardConfigQueryOptions, parseWireGuardStatus } from '../../data/wireguard';
import { classifyBackend } from '../../data/services';
import {
  CADDY_SITE_APP,
  DEFAULT_REDIRECT_CODE,
  DEFAULT_TLS_PORT,
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
  formatList,
  healthForSite,
  hasExternalBlocks,
  importConflict,
  kindLabelKey,
  normalizeCaddyConfig,
  parseCaddyStatus,
  parseList,
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
  type CaddyPathRoute,
  type CaddyServiceInfo,
  type CaddySite,
  type CaddySiteHealth,
  type CaddyValidateResult,
  type ExternalSiteBlock,
  type HealthState,
  type LbPolicy,
  type SiteKind,
  type TlsMode,
} from '../../data/sites';
import { paths } from '../../registry/routes';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { AdvancedSection, ConfirmAction } from '../../patterns';
import { pickBackupFile } from '../../data/backup';
import {
  Banner,
  Badge,
  Button,
  Card,
  CodeBlock,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  InlineError,
  KeyValue,
  Link,
  NumberInput,
  PageHeader,
  Row,
  Segmented,
  Select,
  Skeleton,
  Stack,
  SyncStatus,
  Table,
  TextInput,
  Toggle,
  downloadTextFile,
  useToast,
  type ColumnDef,
  type SyncStatusProps,
  type Tone,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { daysUntil, formatAbsoluteTime, formatExpiry } from '../../i18n/format';
import {
  MAX_SITE_IMPORT_BYTES,
  parseSitesImport,
  serializeSites,
  siteExportFilename,
  type SiteImportResult,
} from './siteTransfer';
import { AppsSegment } from './AppsSegment';

const DOMAIN_RE = /^[A-Za-z0-9*_.-]+(\.[A-Za-z0-9*_.-]+)*$/;
const NAME_RE = /^[A-Za-z0-9_.@*-]{1,64}$/;
const UPSTREAM_RE = /^(https?:\/\/[^\s]+|[A-Za-z0-9_.:[\]-]+:\d{1,5})$/;
const IP_RE = /^[0-9A-Fa-f:.]+(\/\d{1,3})?$/;
const PATH_RE = /^\/[^\s]*$/;
const REDIRECT_CODES = [301, 302, 307, 308];

function splitUpstream(value: string): { host: string; port: number | null } {
  const item = parseList(value)[0] ?? '';
  const index = item.lastIndexOf(':');
  if (index <= 0) return { host: item, port: null };
  const port = Number(item.slice(index + 1));
  return {
    host: item.slice(0, index),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

function joinUpstream(host: string, port: number | null): string {
  return `${host}:${port ?? 80}`;
}

type SiteField =
  | 'name'
  | 'domains'
  | 'listenPort'
  | 'upstreams'
  | 'pathRoutes'
  | 'root'
  | 'redirectTo'
  | 'cert'
  | 'headers'
  | 'basic'
  | 'maxBodyBytes'
  | 'ips';
type SiteErrors = Partial<Record<SiteField, string>>;

interface PathRouteRow {
  path: string;
  upstreams: string;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface SiteFormState {
  mode: 'create' | 'edit';
  originalName?: string;
  name: string;
  kind: SiteKind;
  domains: string;
  listenPort: number | null;
  enabled: boolean;
  upstreams: string;
  lbPolicy: LbPolicy;
  healthUri: string;
  pathRoutes: PathRouteRow[];
  root: string;
  browse: boolean;
  spa: boolean;
  index: string;
  tryFiles: string;
  redirectTo: string;
  redirectCode: number;
  tlsMode: TlsMode;
  certId: string;
  forceTls13: boolean;
  basicUser: string;
  basicPassword: string;
  existingHash: string;
  headers: HeaderRow[];
  hsts: boolean;
  securityHeaders: boolean;
  compression: boolean;
  maxBodyBytes: number | null;
  allowedIps: string;
  deniedIps: string;
  logEnabled: boolean;
  logPath: string;
  liveGateway: boolean;
  /** 来源 Peer + 发布时端口（D-09）；旧站点为空，不阻塞编辑。 */
  sourcePeer: string;
  sourcePort: number | null;
  initial: string;
}

interface SiteRow {
  site: CaddySite;
  health: CaddySiteHealth | null;
}

type ApplyConfirm =
  | { kind: 'site'; config: CaddyConfig; siteName: string; form: SiteFormState }
  | { kind: 'page' };

interface ServiceError {
  message: string;
  details: string | null;
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

function siteSignature(form: SiteFormState): string {
  return JSON.stringify([
    form.name,
    form.kind,
    form.domains,
    form.listenPort,
    form.enabled,
    form.upstreams,
    form.lbPolicy,
    form.healthUri,
    form.pathRoutes,
    form.root,
    form.browse,
    form.spa,
    form.index,
    form.tryFiles,
    form.redirectTo,
    form.redirectCode,
    form.tlsMode,
    form.certId,
    form.forceTls13,
    form.basicUser,
    form.basicPassword,
    form.headers,
    form.hsts,
    form.securityHeaders,
    form.compression,
    form.maxBodyBytes,
    form.allowedIps,
    form.deniedIps,
    form.logEnabled,
    form.logPath,
    form.liveGateway,
    form.sourcePeer,
    form.sourcePort,
  ]);
}

function createForm(): SiteFormState {
  const form: SiteFormState = {
    mode: 'create',
    name: '',
    kind: 'proxy',
    domains: '',
    listenPort: DEFAULT_TLS_PORT,
    enabled: true,
    upstreams: '',
    lbPolicy: 'round_robin',
    healthUri: '',
    pathRoutes: [],
    root: '',
    browse: false,
    spa: false,
    index: 'index.html',
    tryFiles: '',
    redirectTo: '',
    redirectCode: DEFAULT_REDIRECT_CODE,
    tlsMode: 'auto',
    certId: '',
    forceTls13: false,
    basicUser: '',
    basicPassword: '',
    existingHash: '',
    headers: [],
    hsts: false,
    securityHeaders: false,
    compression: false,
    maxBodyBytes: null,
    allowedIps: '',
    deniedIps: '',
    logEnabled: false,
    logPath: '',
    liveGateway: false,
    sourcePeer: '',
    sourcePort: null,
    initial: '',
  };
  return { ...form, initial: siteSignature(form) };
}

function editForm(site: CaddySite): SiteFormState {
  const form: SiteFormState = {
    mode: 'edit',
    originalName: site.name,
    name: site.name,
    kind: site.kind,
    domains: formatList(site.domains),
    listenPort: site.listenPort,
    enabled: site.enabled,
    upstreams: formatList(site.upstreams),
    lbPolicy: site.lbPolicy,
    healthUri: site.healthUri,
    pathRoutes: site.pathRoutes.map((route) => ({
      path: route.path,
      upstreams: formatList(route.upstreams),
    })),
    root: site.root,
    browse: site.browse,
    spa: site.spa,
    index: site.index,
    tryFiles: formatList(site.tryFiles),
    redirectTo: site.redirectTo,
    redirectCode: site.redirectCode,
    tlsMode: site.tls.mode,
    certId: site.tls.cert?.$cert ?? '',
    forceTls13: site.forceTls13,
    basicUser: site.basicauth?.user ?? '',
    basicPassword: '',
    existingHash: site.basicauth?.passwordHash ?? '',
    headers: Object.entries(site.headers).map(([key, value]) => ({ key, value })),
    hsts: site.hsts,
    securityHeaders: site.securityHeaders,
    compression: site.compression,
    maxBodyBytes: site.maxBodyBytes,
    allowedIps: formatList(site.allowedIps),
    deniedIps: formatList(site.deniedIps),
    logEnabled: site.log.enabled,
    logPath: site.log.path,
    liveGateway: site.liveGateway,
    sourcePeer: site.sourcePeer ?? '',
    sourcePort: site.sourcePort ?? null,
    initial: '',
  };
  return { ...form, initial: siteSignature(form) };
}

function healthBadge(row: SiteRow): { tone: Tone; label: string } {
  if (!row.site.enabled) return { tone: 'neutral', label: zh.sites.statusDisabled };
  const health = row.health;
  if (health) {
    const labels: Record<HealthState, { tone: Tone; label: string }> = {
      ok: { tone: 'ok', label: zh.sites.healthOk },
      warn: { tone: 'warn', label: zh.sites.healthWarn },
      down: { tone: 'danger', label: zh.sites.healthDown },
      unknown: { tone: 'neutral', label: zh.sites.healthUnknown },
    };
    return labels[health.state];
  }
  return { tone: 'neutral', label: zh.sites.healthUnknown };
}

function siteTarget(site: CaddySite): string {
  if (site.kind === 'static') return site.root || '—';
  if (site.kind === 'redirect') return site.redirectTo || '—';
  return site.upstreams.length > 0 ? site.upstreams.join(', ') : site.upstream || '—';
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

  const hubQuery = useQuery(hubQueryOptions(hubId));
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const caddyQuery = useQuery(caddyConfigQueryOptions(hubId));
  const certsQuery = useQuery(certificatesQueryOptions());
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
  const backendText = (site: (typeof config.sites)[number]): string => {
    if (site.kind !== 'proxy') return '—';
    const upstreams = site.upstreams.length > 0 ? site.upstreams : site.upstream ? [site.upstream] : [];
    const info = classifyBackend(upstreams[0] ?? '', backendContext, Math.max(0, upstreams.length - 1));
    const suffix = info.extra > 0 ? ` +${info.extra}` : '';
    switch (info.kind) {
      case 'unix':
        return zh.sites.backendUnix;
      case 'local':
        return `${zh.sites.backendLocal} ${info.target}${suffix}`;
      case 'vm': {
        const peer =
          info.peerOnline === true
            ? zh.sites.backendPeerOnline
            : info.peerOnline === false
              ? zh.sites.backendPeerOffline
              : zh.sites.backendPeerUnknown;
        return `${zh.sites.backendVm} ${info.peerName ?? ''} ${info.target} · ${peer}${suffix}`.replace(/\s+/g, ' ');
      }
      case 'internal':
        return `${zh.sites.backendInternal} ${info.target}${suffix}`;
      default:
        return `${zh.sites.backendExternal} ${info.target}${suffix}`;
    }
  };
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

  // 分段默认「站点」；支持 ?tab=certs|apps 深链初始定位（节点概况 TodoChip 用）
  const [segment, setSegment] = useState<'sites' | 'apps' | 'certs'>(
    search.tab === 'certs' ? 'certs' : search.tab === 'apps' ? 'apps' : 'sites',
  );
  const importScanQuery = useQuery({
    ...caddyImportScanQueryOptions(hubId),
    enabled: segment === 'sites' && !unreachable && !adapterMissing,
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
  const importRows: ImportRow[] = useMemo(
    () =>
      (importScanQuery.data?.blocks ?? []).map((block) => ({
        block,
        conflict: importConflict(config, block),
      })),
    [importScanQuery.data?.blocks, config],
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
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const [sitesExportError, setSitesExportError] = useState<string | null>(null);
  const [sitesFileLoading, setSitesFileLoading] = useState(false);
  const [sitesImportError, setSitesImportError] = useState<string | null>(null);
  const [sitesPreview, setSitesPreview] = useState<SiteImportResult | null>(null);
  const [sitesSaving, setSitesSaving] = useState(false);

  const exportSites = () => {
    setSitesExportError(null);
    try {
      downloadTextFile(
        serializeSites(config.sites),
        siteExportFilename(hubName, hubId),
      );
      toast.show({ message: zh.sites.exportSuccess });
    } catch (error) {
      setSitesExportError(message(error, zh.sites.exportFailed));
    }
  };

  const importSites = async () => {
    setSitesImportError(null);
    let file: File | null;
    try {
      file = await pickBackupFile();
    } catch (error) {
      setSitesImportError(message(error, zh.sites.importFailed));
      return;
    }
    if (!file) return;
    if (file.size > MAX_SITE_IMPORT_BYTES) {
      setSitesImportError(zh.sites.importFileTooLarge);
      return;
    }
    setSitesFileLoading(true);
    try {
      const text = await file.text();
      setSitesPreview(parseSitesImport(text, config.sites));
    } catch (error) {
      setSitesPreview(null);
      setSitesImportError(message(error, zh.sites.importFailed));
    } finally {
      setSitesFileLoading(false);
    }
  };

  const confirmImportSites = async () => {
    if (!sitesPreview) return;
    setSitesSaving(true);
    setSitesImportError(null);
    try {
      await saveCaddyConfig(hubId, sitesPreview.nextConfig);
      await invalidateConfig();
      setSitesPreview(null);
      toast.show({ message: zh.sites.importSuccess });
    } catch (error) {
      setSitesImportError(message(error, zh.sites.importFailed));
    } finally {
      setSitesSaving(false);
    }
  };

  const setDrawerSearch = (drawer?: string, replace = true) => {
    void navigate({
      to: '/hubs/$hubId/sites',
      params: { hubId },
      search: { drawer },
      replace,
    });
  };

  const openCreate = () => {
    setForm(createForm());
    setErrors({});
    setSaveError(null);
    setDrawerSearch('site:new', false);
  };

  const openEdit = (site: CaddySite) => {
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
      if (form) return;
      const initialForm = createForm();
      if (search.upstream) {
        initialForm.upstreams = search.upstream;
        // D-09：记录发布时端口，后续改 Peer 地址时据此提示「端口被手工改过」。
        initialForm.sourcePort = splitUpstreamHostPort(search.upstream).port;
      }
      if (search.peer) {
        initialForm.name = `${search.peer}-app`;
        initialForm.sourcePeer = search.peer;
      }
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
    // 仅在抽屉参数 / 配置加载状态变化时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.drawer, caddyQuery.isSuccess]);

  const invalidateConfig = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP] }),
    ]);
  };

  const invalidateState = async () => {
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
  };

  const applyNow = async () => {
    let envelope;
    try {
      envelope = await runCaddyAction(hubId, 'apply');
    } catch (error) {
      if (error instanceof ApiError) {
        setApplyError({
          message: error.message,
          details: error.fields ? JSON.stringify(error.fields, null, 2) : null,
        });
      }
      throw error;
    }
    if (!envelope.ok) {
      setApplyError({
        message: envelope.error?.message ?? zh.sites.applyFailed,
        details: envelope.error?.details ? JSON.stringify(envelope.error.details, null, 2) : null,
      });
      throw new Error(envelopeErrorText(envelope) ?? zh.sites.applyFailed);
    }
    setApplyError(null);
    await Promise.all([invalidateConfig(), invalidateState()]);
    // apply 结果写回 D1 可能短暂滞后；再补两次拉取，避免列表停在「待应用」。
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await Promise.all([invalidateConfig(), invalidateState()]);
    }
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

  const validate = (current: SiteFormState): SiteErrors => {
    const next: SiteErrors = {};
    const domains = parseList(current.domains);
    const name = (current.name.trim() || domains[0] || '').trim();
    if (!NAME_RE.test(name)) next.name = zh.sites.invalidName;
    else if (
      config.sites.some((site) => site.name === name && site.name !== current.originalName)
    ) {
      next.name = zh.sites.duplicateName;
    }
    if (domains.length === 0 || domains.some((domain) => !DOMAIN_RE.test(domain))) {
      next.domains = domains.length === 0 ? zh.sites.invalidDomains : zh.sites.invalidDomain;
    } else if (new Set(domains).size !== domains.length) {
      next.domains = zh.sites.invalidDomains;
    }
    if (
      current.listenPort === null ||
      !Number.isInteger(current.listenPort) ||
      current.listenPort < 1 ||
      current.listenPort > 65535
    ) {
      next.listenPort = zh.sites.invalidPort;
    }
    const port = current.listenPort ?? DEFAULT_TLS_PORT;
    if (Array.isArray(domains) && domains.length > 0) {
      const conflict = config.sites.some(
        (site) =>
          site.name !== current.originalName &&
          site.listenPort === port &&
          site.domains.some((domain) => domains.includes(domain)),
      );
      if (conflict) next.domains = zh.sites.duplicateAddress;
    }

    const upstreams = parseList(current.upstreams);
    const pathErrors =
      current.pathRoutes.length > 0 &&
      current.pathRoutes.some((route) => {
        const routeUpstreams = parseList(route.upstreams);
        return (
          !PATH_RE.test(route.path.trim()) ||
          routeUpstreams.length === 0 ||
          routeUpstreams.some((item) => !UPSTREAM_RE.test(item))
        );
      });

    if (current.kind === 'proxy') {
      if (
        upstreams.length === 0 ||
        upstreams.some((item) => !UPSTREAM_RE.test(item))
      ) {
        next.upstreams =
          upstreams.length === 0 ? zh.sites.upstreamRequired : zh.sites.invalidUpstreams;
      }
      if (pathErrors) next.pathRoutes = zh.sites.invalidPath;
    } else if (current.kind === 'static') {
      if (!current.root.trim()) next.root = zh.sites.rootRequired;
    } else {
      if (!current.redirectTo.trim()) next.redirectTo = zh.sites.redirectRequired;
      else if (!/^(https?:\/\/|\/)[^\s]*$/.test(current.redirectTo.trim())) {
        next.redirectTo = zh.sites.invalidRedirect;
      }
    }

    if (current.tlsMode === 'manual') {
      if (!current.certId) next.cert = zh.sites.certMissing;
      else if (certsQuery.isSuccess && !certs.some((cert) => cert.id === current.certId)) {
        next.cert = zh.sites.certMissing;
      }
    }

    const headerRows = current.headers.filter(
      (row) => row.key.trim().length > 0 || row.value.trim().length > 0,
    );
    if (headerRows.some((row) => !row.key.trim() || !row.value.trim())) {
      next.headers = zh.sites.headersInvalid;
    }

    if (!current.basicUser.trim() && current.basicPassword) {
      next.basic = zh.sites.usernameRequired;
    }
    if (current.basicUser.trim() && !current.basicPassword && !current.existingHash) {
      next.basic = zh.sites.passwordRequired;
    }

    if (
      current.maxBodyBytes !== null &&
      (!Number.isInteger(current.maxBodyBytes) || current.maxBodyBytes < 0)
    ) {
      next.maxBodyBytes = zh.sites.invalidMaxBody;
    }
    const ips = [...parseList(current.allowedIps), ...parseList(current.deniedIps)];
    if (ips.some((item) => !IP_RE.test(item))) next.ips = zh.sites.invalidIp;
    return next;
  };

  const buildSite = async (current: SiteFormState): Promise<CaddySite> => {
    let basicauth = null;
    const user = current.basicUser.trim();
    const password = current.basicPassword;
    if (user || password) {
      let hash = current.existingHash;
      if (password) {
        if (unreachable) throw new Error(writeDisabledReason);
        hash = await hashPassword(password);
      }
      if (!user) throw new Error(zh.sites.usernameRequired);
      if (!hash) throw new Error(zh.sites.passwordRequired);
      basicauth = { user, passwordHash: hash };
    }
    const domains = parseList(current.domains);
    const upstreams = parseList(current.upstreams);
    const headers: Record<string, string> = {};
    for (const row of current.headers) {
      const key = row.key.trim();
      if (key) headers[key] = row.value.trim();
    }
    const pathRoutes: CaddyPathRoute[] = current.pathRoutes
      .filter((route) => route.path.trim())
      .map((route) => ({
        path: route.path.trim(),
        upstreams: parseList(route.upstreams),
      }));
    const isProxy = current.kind === 'proxy';
    const isStatic = current.kind === 'static';
    const isRedirect = current.kind === 'redirect';
    return {
      name: (current.name.trim() || domains[0] || '').trim(),
      kind: current.kind,
      domain: domains[0] ?? '',
      domains,
      listenPort: current.listenPort ?? DEFAULT_TLS_PORT,
      enabled: current.enabled,
      upstream: isProxy ? (upstreams[0] ?? '') : '',
      upstreams: isProxy ? upstreams : [],
      lbPolicy: current.lbPolicy,
      healthUri: isProxy ? current.healthUri.trim() : '',
      pathRoutes: isProxy ? pathRoutes : [],
      root: isStatic ? current.root.trim() : '',
      browse: isStatic ? current.browse : false,
      spa: isStatic ? current.spa : false,
      index: isStatic ? current.index.trim() || 'index.html' : 'index.html',
      tryFiles: isStatic ? parseList(current.tryFiles) : [],
      redirectTo: isRedirect ? current.redirectTo.trim() : '',
      redirectCode: isRedirect ? current.redirectCode : DEFAULT_REDIRECT_CODE,
      tls: {
        mode: current.tlsMode,
        cert:
          current.tlsMode === 'manual' && current.certId ? { $cert: current.certId } : null,
      },
      forceTls13: current.forceTls13,
      basicauth,
      headers,
      hsts: current.hsts,
      securityHeaders: current.securityHeaders,
      compression: current.compression,
      allowedIps: parseList(current.allowedIps),
      deniedIps: parseList(current.deniedIps),
      maxBodyBytes: current.maxBodyBytes,
      log: { enabled: current.logEnabled, path: current.logPath.trim() },
      liveGateway: current.liveGateway,
      sourcePeer: current.sourcePeer || undefined,
      sourcePort: current.sourcePort ?? undefined,
    };
  };

  const persist = async (nextConfig: CaddyConfig, apply: boolean) => {
    await saveCaddyConfig(hubId, nextConfig);
    await invalidateConfig();
    if (apply) {
      await applyNow();
      toast.show({ message: zh.sites.appliedToast });
    } else {
      toast.show({ message: zh.sites.savedToast });
    }
  };

  const save = async (apply: boolean) => {
    if (!form) return;
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const site = await buildSite(form);
      const nextConfig = upsertSite(config, site, form.originalName);
      if (apply) {
        // ui-guidelines §8.3：保存变更 → 关闭抽屉 → 页面级 ConfirmAction。
        // 暂存表单快照，取消确认时恢复抽屉与未保存内容。
        setApplyConfirm({
          kind: 'site',
          config: nextConfig,
          siteName: site.name,
          form,
        });
        closeDrawer();
        setSaving(false);
        return;
      }
      await saveCaddyConfig(hubId, nextConfig);
      await invalidateConfig();
      setApplyError(null);
      toast.show({ message: zh.sites.savedToast });
      closeDrawer();
    } catch (error) {
      setSaveError(message(error, zh.sites.createFailed));
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
      await persist(nextConfig, true);
      setConfirmDelete(null);
      toast.show({ message: fmt(zh.sites.deletedToast, { name: site.name }) });
    } catch (error) {
      throw new Error(message(error, zh.sites.createFailed));
    }
  };

  const deleteFromDrawer = async () => {
    if (!form?.originalName) throw new Error(zh.sites.deleteInlineFailed);
    const site = config.sites.find((item) => item.name === form.originalName);
    if (!site) throw new Error(zh.sites.deleteInlineFailed);
    await remove(site);
    closeDrawer();
  };

  const clearSites = async () => {
    try {
      await persist(emptyCaddyConfig(), true);
      setClearConfirm(false);
      toast.show({ message: zh.sites.clearedToast });
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

  const columns: ColumnDef<SiteRow>[] = [
    {
      key: 'domain',
      type: 'name',
      header: zh.sites.colDomain,
      value: (row) => row.site.domains.join(', '),
      dot: (row) => healthBadge(row).tone,
      // <1024 时后端列（low）隐藏，信息并入名称列第二段，避免窄屏丢项。
      narrow: (row) => backendText(row.site),
    },
    {
      key: 'kind',
      type: 'text',
      header: zh.sites.colKind,
      value: (row) => zh.sites[kindLabelKey(row.site.kind)],
    },
    {
      key: 'port',
      type: 'text',
      header: zh.sites.colPort,
      value: (row) => String(row.site.listenPort),
    },
    {
      key: 'target',
      type: 'mono',
      header: zh.sites.colTarget,
      value: (row) => siteTarget(row.site),
    },
    {
      key: 'backend',
      type: 'mono',
      header: zh.sites.colBackend,
      value: (row) => backendText(row.site),
      priority: 'low',
    },
    {
      key: 'tls',
      type: 'text',
      header: zh.sites.colTls,
      value: (row) => zh.sites[tlsModeLabelKey(row.site.tls.mode)],
      priority: 'low',
    },
    {
      key: 'sync',
      type: 'sync',
      header: zh.sites.colSync,
      sync: (): SyncStatusProps =>
        unapplied
          ? { state: 'pending', rev: configState?.rev ?? undefined, label: zh.sites.syncPending }
          : { state: 'synced' },
    },
    { key: 'actions', type: 'actions', header: '' },
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

  const handlePageAction = (ref: ActionRef) => {
    if (ref.id === 'site.create') {
      openCreate();
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
          label={actionLabel(action('app.apply'))}
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
  if (!configState?.exists || caddyMissing) {
    banners.push({
      key: caddyMissing ? 'not-installed' : 'not-configured',
      tone: caddyMissing ? 'warn' : 'info',
      title: caddyMissing ? zh.sites.notInstalledTitle : zh.sites.notInstalled,
      description: installTask
        ? fmt(zh.sites.installTaskState, {
            id: installTask.task.id,
            state: installTask.task.state,
            progress: String(installTask.task.progress),
          })
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

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.sites}
        scope={hubName}
        summary={fmt(zh.sites.summaryCount, { count: config.sites.length })}
        sync={sync}
        primaryAction={segment === 'sites' ? action('site.create') : undefined}
        secondaryActions={segment === 'sites' ? [action('caddy.service')] : undefined}
        actionsDisabled={!channels.canApply}
        actionsDisabledReason={zh.channels.controlUnavailableDesc}
        onAction={handlePageAction}
      />

      <Segmented
        value={segment}
        ariaLabel={zh.nav.sites}
        options={[
          { value: 'sites', label: zh.sites.segmentSites },
          { value: 'apps', label: zh.sites.segmentApps },
          { value: 'certs', label: zh.sites.segmentCerts },
        ]}
        onChange={(value) =>
          setSegment(value === 'apps' ? 'apps' : value === 'certs' ? 'certs' : 'sites')
        }
      />

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

      {segment === 'sites' ? (
        <>
          {sitesExportError ? <InlineError message={sitesExportError} /> : null}
          {sitesImportError ? <InlineError message={sitesImportError} /> : null}

          <Table
            rows={caddyQuery.isLoading ? undefined : rows}
            columns={columns}
            rowKey={(row) => row.site.name}
            objectLabel={zh.nav.sites}
            search={{ value: searchText, onChange: setSearchText, placeholder: zh.sites.colDomain }}
            empty={{
              icon: 'globe',
              title: zh.sites.emptyTitle,
              description: zh.sites.emptyHint,
              action: (
                <Button
                  label={actionLabel(action('site.create'))}
                  variant="primary"
                  icon="plus"
                  disabled={unreachable}
                  disabledReason={writeDisabledReason}
                  onClick={openCreate}
                />
              ),
            }}
            rowActions={rowActions}
            rowActionDisabled={rowActionDisabled}
            onRowAction={handleRowAction}
            onRowOpen={(row) => openEdit(row.site)}
          />

          <Card
            title={zh.sites.importTitle}
            action={
              <Row gap={2}>
                {/* 只有扫描确实发现外部站点块时才这样标注；0 站点不等于未纳管。 */}
                {hasExternalBlocks(importScanQuery.data?.blocks) ? (
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

          <AdvancedSection title={zh.common.advancedSection}>
            <Row gap={2} wrap>
              <Button
                label={zh.sites.exportJson}
                icon="download"
                size="sm"
                variant="ghost"
                disabled={config.sites.length === 0}
                disabledReason={zh.sites.exportEmpty}
                onClick={exportSites}
              />
              <Button
                label={zh.sites.importJson}
                icon="download"
                size="sm"
                variant="ghost"
                loading={sitesFileLoading}
                disabled={unreachable}
                disabledReason={writeDisabledReason}
                onClick={() => void importSites()}
              />
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
          </AdvancedSection>
        </>
      ) : null}

      {segment === 'apps' ? <AppsSegment hubId={hubId} /> : null}

      {segment === 'certs' ? (
        <Card
          title={zh.sites.segmentCerts}
          action={<Link to={`${paths.settings}?tab=certs`} label={zh.sites.certsManage} />}
        >
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
        </Card>
      ) : null}

      {form ? (
        <SiteDrawer
          form={form}
          errors={errors}
          saveError={saveError}
          saving={saving}
          hubName={hubName}
          offlineReason={writeDisabledReason}
          certificates={certs}
          peers={peerTargets}
          existingDomains={config.sites.flatMap((site) => site.domains)}
          onChange={(patch) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onClose={closeDrawer}
          onSave={(apply) => void save(apply)}
          onDelete={deleteFromDrawer}
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
          confirmLabel={actionLabel(action('app.apply'))}
          onCancel={() => {
            const state = applyConfirm;
            setApplyConfirm(null);
            if (state.kind !== 'site') return;
            // 恢复抽屉与未保存内容：用户只是取消了「应用」，不应丢编辑。
            setForm(state.form);
            setDrawerSearch(
              state.form.mode === 'edit' && state.form.originalName
                ? `site:${encodeURIComponent(state.form.originalName)}`
                : 'site:new',
            );
          }}
          onConfirm={async () => {
            if (applyConfirm.kind === 'site') {
              await saveCaddyConfig(hubId, applyConfirm.config);
              await invalidateConfig();
              await applyNow();
              setApplyConfirm(null);
              toast.show({ message: zh.sites.appliedToast });
              return;
            }
            await applyNow();
            setApplyConfirm(null);
            toast.show({ message: zh.sites.appliedToast });
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

      {sitesPreview ? (
        <Dialog
          open
          title={zh.sites.importPreviewTitle}
          onClose={() => setSitesPreview(null)}
          footer={
            <>
              <Button label={zh.common.cancel} onClick={() => setSitesPreview(null)} />
              <Button
                label={sitesSaving ? zh.sites.importSaving : zh.sites.importConfirm}
                variant="primary"
                loading={sitesSaving}
                disabled={
                  sitesPreview.errors.length > 0 ||
                  sitesPreview.rows.some((row) => row.status === 'conflict') ||
                  unreachable
                }
                disabledReason={
                  unreachable
                    ? writeDisabledReason
                    : sitesPreview.rows.some((row) => row.status === 'conflict')
                      ? zh.sites.importConflictHint
                      : zh.sites.importErrorsTitle
                }
                onClick={() => void confirmImportSites()}
              />
            </>
          }
        >
          <Stack gap={3}>
            <Banner tone="info" title={zh.sites.importPreviewDesc} />
            <Banner
              tone="neutral"
              title={fmt(zh.sites.importCounts, {
                total: String(sitesPreview.rows.length + sitesPreview.errors.length),
                created: String(sitesPreview.rows.filter((row) => row.status === 'new').length),
                updated: String(
                  sitesPreview.rows.filter((row) => row.status === 'overwrite').length,
                ),
                conflicts: String(
                  sitesPreview.rows.filter((row) => row.status === 'conflict').length,
                ),
              })}
            />
            {sitesPreview.errors.length > 0 ? (
              <Stack gap={2}>
                <Banner tone="danger" title={zh.sites.importErrorsTitle} />
                {sitesPreview.errors.map((error, index) => (
                  <InlineError key={`${error}-${index}`} message={error} />
                ))}
              </Stack>
            ) : null}
            {sitesPreview.rows.some((row) => row.status === 'conflict') ? (
              <Banner tone="warn" title={zh.sites.importConflictHint} />
            ) : null}
            <Table
              rows={sitesPreview.rows}
              columns={[
                {
                  key: 'name',
                  type: 'name',
                  header: zh.sites.name,
                  value: (row) => row.site.name,
                },
                {
                  key: 'domains',
                  type: 'text',
                  header: zh.sites.colDomain,
                  value: (row) => row.site.domains.join(', '),
                },
                {
                  key: 'reason',
                  type: 'text',
                  header: zh.sites.importReason,
                  value: (row) => row.reason ?? '—',
                },
                {
                  key: 'status',
                  type: 'status',
                  header: zh.sites.importStatus,
                  status: (row) => ({
                    tone:
                      row.status === 'conflict'
                        ? 'danger'
                        : row.status === 'overwrite'
                          ? 'warn'
                          : 'info',
                    label:
                      row.status === 'conflict'
                        ? zh.sites.importStatusConflict
                        : row.status === 'overwrite'
                          ? zh.sites.importStatusOverwrite
                          : zh.sites.importStatusNew,
                  }),
                },
              ]}
              rowKey={(row) => `${row.status}-${row.site.name}`}
              objectLabel={zh.sites.importPreviewTitle}
              empty={{ icon: 'globe', title: zh.sites.importNoRows }}
            />
          </Stack>
        </Dialog>
      ) : null}
    </Stack>
  );
}

/* --------------------------------------------------------------- 表单分组 */

function GroupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <Stack gap={4}>{children}</Stack>
    </Card>
  );
}

function HeaderRows({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  return (
    <Stack gap={2}>
      {rows.map((row, index) => (
        <Row gap={2} key={`header-${index}`}>
          <TextInput
            id={`site-header-key-${index}`}
            ariaLabel={zh.sites.headerKey}
            placeholder={zh.sites.headerKey}
            value={row.key}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, key: value } : item)))
            }
          />
          <TextInput
            id={`site-header-value-${index}`}
            ariaLabel={zh.sites.headerValue}
            placeholder={zh.sites.headerValue}
            value={row.value}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, value } : item)))
            }
          />
          <Button
            label={zh.sites.removeRow}
            icon="x"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </Row>
      ))}
      <Row gap={2}>
        <Button
          label={zh.sites.addHeader}
          icon="plus"
          size="sm"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        />
      </Row>
    </Stack>
  );
}

function PathRouteRows({
  rows,
  onChange,
}: {
  rows: PathRouteRow[];
  onChange: (rows: PathRouteRow[]) => void;
}) {
  return (
    <Stack gap={2}>
      {rows.map((row, index) => (
        <Row gap={2} key={`route-${index}`}>
          <TextInput
            id={`site-route-path-${index}`}
            ariaLabel={zh.sites.pathPlaceholder}
            placeholder={zh.sites.pathPlaceholder}
            value={row.path}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, path: value } : item)))
            }
          />
          <TextInput
            id={`site-route-upstreams-${index}`}
            ariaLabel={zh.sites.upstreamPlaceholder}
            placeholder={zh.sites.upstreamPlaceholder}
            value={row.upstreams}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, upstreams: value } : item)))
            }
          />
          <Button
            label={zh.sites.removeRow}
            icon="x"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </Row>
      ))}
      <Row gap={2}>
        <Button
          label={zh.sites.addRoute}
          icon="plus"
          size="sm"
          onClick={() => onChange([...rows, { path: '', upstreams: '' }])}
        />
      </Row>
    </Stack>
  );
}

/* --------------------------------------------------------------- SiteDrawer */

function SiteDrawer({
  form,
  errors,
  saveError,
  saving,
  hubName,
  offlineReason,
  certificates,
  peers,
  existingDomains,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  form: SiteFormState;
  errors: SiteErrors;
  saveError: string | null;
  saving: boolean;
  hubName: string;
  offlineReason?: string;
  certificates: { id: string; name: string; domains: string[]; notAfter: number | null }[];
  peers: { name: string; host: string }[];
  existingDomains: string[];
  onChange: (patch: Partial<SiteFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(message(error, zh.sites.deleteInlineFailed));
    } finally {
      setDeleting(false);
    }
  };
  const dirty = siteSignature(form) !== form.initial;
  const parsedUpstream = splitUpstream(form.upstreams);
  const upstreamHost = parsedUpstream.host;
  const upstreamPort = parsedUpstream.port;
  const sourcePeerHost = peers.find((peer) => peer.name === form.sourcePeer)?.host ?? '';
  const sourcePeerMismatch = Boolean(
    form.sourcePeer && sourcePeerHost && upstreamHost && upstreamHost !== sourcePeerHost,
  );
  const [customTarget, setCustomTarget] = useState(
    () => !peers.some((peer) => peer.host === upstreamHost) && upstreamHost !== '127.0.0.1',
  );
  const selectedTarget = customTarget
    ? 'custom'
    : peers.some((peer) => peer.host === upstreamHost)
      ? upstreamHost
      : 'local';
  const selectedCert = certificates.find((cert) => cert.id === form.certId) ?? null;
  const siteDomains = parseList(form.domains);
  // 证书跟着域名走：手动模式只列覆盖当前站点域名的证书；还没填域名时保持完整列表。
  const matchingCertificates =
    siteDomains.length === 0
      ? certificates
      : certificates.filter((cert) =>
          siteDomains.every((domain) =>
            cert.domains.some(
              (certDomain) =>
                certDomain === domain ||
                (certDomain.startsWith('*.') && domain.endsWith(certDomain.slice(1))),
            ),
          ),
        );
  const certMismatch =
    form.tlsMode === 'manual' &&
    selectedCert !== null &&
    parseList(form.domains).some(
      (domain) =>
        !selectedCert.domains.some(
          (certDomain) =>
            certDomain === domain ||
            (certDomain.startsWith('*.') && domain.endsWith(certDomain.slice(1))),
        ),
    );
  const domainOptions = [
    ...new Set(
      [...certificates.flatMap((cert) => cert.domains), ...existingDomains].filter(
        (domain) => domain.trim().length > 0,
      ),
    ),
  ];
  const applyTarget = (target: string) => {
    if (target === 'custom') {
      setCustomTarget(true);
      return;
    }
    setCustomTarget(false);
    const host = target === 'local' ? '127.0.0.1' : target;
    onChange({ upstreams: joinUpstream(host, upstreamPort) });
  };
  return (
    <Drawer
      open
      title={form.mode === 'create' ? zh.sites.addTitle : zh.sites.editTitle}
      context={fmt(zh.sites.context, { hub: hubName })}
      dirty={dirty}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.cancel} onClick={onClose} />
          <Button
            label={zh.common.save}
            loading={saving}
            disabled={!dirty || saving || (Boolean(offlineReason) && form.basicPassword.length > 0)}
            disabledReason={
              Boolean(offlineReason) && form.basicPassword.length > 0
                ? offlineReason
                : zh.common.noChanges
            }
            onClick={() => onSave(false)}
          />
          <Button
            label={zh.common.saveAndApply}
            variant="primary"
            loading={saving}
            disabled={!dirty || saving || Boolean(offlineReason)}
            disabledReason={offlineReason ?? zh.common.noChanges}
            onClick={() => onSave(true)}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        <GroupCard title={zh.sites.groupBasic}>
          <Field id="site-kind" label={zh.sites.kind} help={zh.sites.kindHelp}>
            <Select
              id="site-kind"
              value={form.kind}
              options={[
                { value: 'proxy', label: zh.sites.kindProxy },
                { value: 'static', label: zh.sites.kindStatic },
                { value: 'redirect', label: zh.sites.kindRedirect },
              ]}
              onChange={(value) =>
                onChange({ kind: value === 'static' ? 'static' : value === 'redirect' ? 'redirect' : 'proxy' })
              }
            />
          </Field>
          <Field id="site-name" label={zh.sites.name} help={zh.sites.nameHelp} error={errors.name} optional>
            <TextInput
              id="site-name"
              value={form.name}
              onChange={(value) => onChange({ name: value })}
            />
          </Field>
          {domainOptions.length > 0 ? (
            <Field id="site-domain-pick" label={zh.sites.domainPick} help={zh.sites.domainPickHelp} optional>
              <Select
                id="site-domain-pick"
                value={domainOptions.includes(form.domains.trim()) ? form.domains.trim() : ''}
                options={[
                  { value: '', label: zh.sites.domainPickCustom },
                  ...domainOptions.map((domain) => ({ value: domain, label: domain })),
                ]}
                onChange={(value) => {
                  if (value) onChange({ domains: value });
                }}
              />
            </Field>
          ) : null}
          <Field id="site-domains" label={zh.fields.domains} help={zh.sites.domainsHelp} error={errors.domains} required>
            <TextInput
              id="site-domains"
              value={form.domains}
              mono
              onChange={(value) => onChange({ domains: value })}
            />
          </Field>
          <Field
            id="site-port"
            label={zh.sites.listenPort}
            help={zh.sites.listenPortHelp}
            error={errors.listenPort}
            required
          >
            <NumberInput
              id="site-port"
              value={form.listenPort}
              min={1}
              max={65535}
              onChange={(value) => onChange({ listenPort: value })}
            />
          </Field>
          <Field id="site-enabled" label={zh.sites.enabled} variant="row">
            <Toggle
              checked={form.enabled}
              label={zh.sites.enabled}
              onChange={(checked) => onChange({ enabled: checked })}
            />
          </Field>
        </GroupCard>

        {form.kind === 'proxy' ? (
          <GroupCard title={zh.sites.groupProxy}>
            <Field id="site-target" label={zh.sites.target} help={zh.sites.targetHelp} required>
              <Select
                id="site-target"
                value={selectedTarget}
                options={[
                  ...peers.map((peer) => ({ value: peer.host, label: `${peer.name} · ${peer.host}` })),
                  { value: 'local', label: zh.sites.targetLocal },
                  { value: 'custom', label: zh.sites.targetCustom },
                ]}
                onChange={applyTarget}
              />
            </Field>
            {form.sourcePeer ? (
              <Field
                id="site-source-peer"
                label={zh.sites.sourcePeerLabel}
                help={sourcePeerMismatch ? zh.sites.sourcePeerMismatch : zh.sites.sourcePeerHelp}
              >
                <div className="ui-readonly-field mono">
                  {form.sourcePeer}
                  {sourcePeerHost ? ` · ${sourcePeerHost}` : ''}
                </div>
              </Field>
            ) : null}
            <Field id="site-target-port" label={zh.sites.targetPort} help={zh.sites.targetPortHelp} required>
              <NumberInput
                id="site-target-port"
                value={upstreamPort}
                min={1}
                max={65535}
                onChange={(value) =>
                  onChange({ upstreams: joinUpstream(upstreamHost || '127.0.0.1', value) })
                }
              />
            </Field>
            <Field
              id="site-upstreams"
              label={zh.sites.upstreams}
              help={zh.sites.upstreamsHelp}
              error={errors.upstreams}
              required
            >
              {selectedTarget === 'custom' ? (
                <TextInput
                  id="site-upstreams"
                  value={form.upstreams}
                  mono
                  onChange={(value) => onChange({ upstreams: value })}
                />
              ) : (
                <div className="ui-readonly-field mono">{form.upstreams || '—'}</div>
              )}
            </Field>
            <Field id="site-lb" label={zh.sites.lbPolicy}>
              <Select
                id="site-lb"
                value={form.lbPolicy}
                options={[
                  { value: 'round_robin', label: zh.sites.lbRoundRobin },
                  { value: 'random', label: zh.sites.lbRandom },
                  { value: 'least_conn', label: zh.sites.lbLeastConn },
                  { value: 'ip_hash', label: zh.sites.lbIpHash },
                ]}
                onChange={(value) =>
                  onChange({
                    lbPolicy:
                      value === 'random' || value === 'least_conn' || value === 'ip_hash'
                        ? value
                        : 'round_robin',
                  })
                }
              />
            </Field>
            <Field id="site-health-uri" label={zh.sites.healthUri} help={zh.sites.healthUriHelp} optional>
              <TextInput
                id="site-health-uri"
                value={form.healthUri}
                mono
                onChange={(value) => onChange({ healthUri: value })}
              />
            </Field>
            <Field id="site-path-routes" label={zh.sites.pathRoutes} help={zh.sites.pathRoutesHelp} error={errors.pathRoutes} optional>
              <PathRouteRows
                rows={form.pathRoutes}
                onChange={(pathRoutes) => onChange({ pathRoutes })}
              />
            </Field>
          </GroupCard>
        ) : null}

        {form.kind === 'static' ? (
          <GroupCard title={zh.sites.groupStatic}>
            <Field id="site-root" label={zh.sites.root} help={zh.sites.rootHelp} error={errors.root}>
              <TextInput
                id="site-root"
                value={form.root}
                mono
                onChange={(value) => onChange({ root: value })}
              />
            </Field>
            <Field id="site-browse" label={zh.sites.browse} variant="row">
              <Toggle
                checked={form.browse}
                label={zh.sites.browse}
                onChange={(checked) => onChange({ browse: checked })}
              />
            </Field>
            <Field id="site-spa" label={zh.sites.spa} variant="row">
              <Toggle
                checked={form.spa}
                label={zh.sites.spa}
                onChange={(checked) => onChange({ spa: checked })}
              />
            </Field>
            <Field id="site-index" label={zh.sites.index} help={zh.sites.indexHelp} optional>
              <TextInput
                id="site-index"
                value={form.index}
                mono
                onChange={(value) => onChange({ index: value })}
              />
            </Field>
            <Field id="site-tryfiles" label={zh.sites.tryFiles} help={zh.sites.tryFilesHelp} optional>
              <TextInput
                id="site-tryfiles"
                value={form.tryFiles}
                mono
                onChange={(value) => onChange({ tryFiles: value })}
              />
            </Field>
          </GroupCard>
        ) : null}

        {form.kind === 'redirect' ? (
          <GroupCard title={zh.sites.groupRedirect}>
            <Field
              id="site-redirect-to"
              label={zh.sites.redirectTo}
              help={zh.sites.redirectToHelp}
              error={errors.redirectTo}
              required
            >
              <TextInput
                id="site-redirect-to"
                value={form.redirectTo}
                mono
                onChange={(value) => onChange({ redirectTo: value })}
              />
            </Field>
            <Field id="site-redirect-code" label={zh.sites.redirectCode}>
              <Select
                id="site-redirect-code"
                value={String(form.redirectCode)}
                options={REDIRECT_CODES.map((code) => ({
                  value: String(code),
                  label: String(code),
                }))}
                onChange={(value) => onChange({ redirectCode: Number(value) || DEFAULT_REDIRECT_CODE })}
              />
            </Field>
          </GroupCard>
        ) : null}

        <GroupCard title={zh.sites.groupTls}>
          <Field id="site-tls" label={zh.fields.tls} help={zh.sites.tlsHelp}>
            <Select
              id="site-tls"
              value={form.tlsMode}
              options={[
                { value: 'auto', label: zh.sites.tlsAuto },
                { value: 'manual', label: zh.sites.tlsManual },
                { value: 'internal', label: zh.sites.tlsInternal },
                { value: 'off', label: zh.sites.tlsOff },
              ]}
              onChange={(value) =>
                onChange({
                  tlsMode:
                    value === 'manual' || value === 'internal' || value === 'off'
                      ? value
                      : 'auto',
                })
              }
            />
          </Field>
          {form.tlsMode === 'manual' ? (
            <>
              <Field
                id="site-cert"
                label={zh.sites.cert}
                help={zh.sites.certHelp}
                error={errors.cert}
              >
                <Select
                  id="site-cert"
                  value={form.certId}
                  options={matchingCertificates.map((cert) => ({
                    value: cert.id,
                    label: `${cert.domains[0] ?? cert.name} · ${formatExpiry(cert.notAfter)}`,
                  }))}
                  placeholder={zh.form.choose}
                  onChange={(value) => onChange({ certId: value })}
                />
              </Field>
              {certificates.length === 0 ? (
                <Banner
                  tone="warn"
                  title={zh.sites.certMissing}
                  action={<Link to={`${paths.settings}?tab=certs`} label={zh.sites.certManage} />}
                />
              ) : siteDomains.length > 0 && matchingCertificates.length === 0 ? (
                <Banner tone="warn" title={zh.sites.certNoMatch} />
              ) : certMismatch ? (
                <Banner tone="warn" title={zh.sites.certMismatch} />
              ) : null}
            </>
          ) : null}
          <Field id="site-tls13" label={zh.sites.forceTls13} variant="row">
            <Toggle
              checked={form.forceTls13}
              label={zh.sites.forceTls13}
              onChange={(checked) => onChange({ forceTls13: checked })}
            />
          </Field>
        </GroupCard>

        <AdvancedSection title={zh.common.advancedSection}>
        <GroupCard title={zh.sites.groupSecurity}>
          <Field
            id="site-basic-user"
            label={zh.sites.username}
            help={form.existingHash ? zh.sites.basicAuthSet : zh.sites.basicAuthHelp}
            error={errors.basic}
            optional
          >
            <TextInput
              id="site-basic-user"
              value={form.basicUser}
              autoComplete="off"
              onChange={(value) => onChange({ basicUser: value })}
            />
          </Field>
          <Field id="site-basic-password" label={zh.sites.password} optional>
            <TextInput
              id="site-basic-password"
              type="password"
              value={form.basicPassword}
              autoComplete="new-password"
              onChange={(value) => onChange({ basicPassword: value })}
            />
          </Field>
          <Field
            id="site-headers"
            label={zh.sites.headers}
            help={zh.sites.headersHelp}
            error={errors.headers}
            optional
          >
            <HeaderRows rows={form.headers} onChange={(headers) => onChange({ headers })} />
          </Field>
          <Field id="site-hsts" label={zh.sites.hsts} variant="row">
            <Toggle
              checked={form.hsts}
              label={zh.sites.hsts}
              onChange={(checked) => onChange({ hsts: checked })}
            />
          </Field>
          <Field id="site-security-headers" label={zh.sites.securityHeaders} variant="row">
            <Toggle
              checked={form.securityHeaders}
              label={zh.sites.securityHeaders}
              onChange={(checked) => onChange({ securityHeaders: checked })}
            />
          </Field>
          <Field id="site-compression" label={zh.sites.compression} variant="row">
            <Toggle
              checked={form.compression}
              label={zh.sites.compression}
              onChange={(checked) => onChange({ compression: checked })}
            />
          </Field>
          <Field
            id="site-max-body"
            label={zh.sites.maxBodyBytes}
            help={zh.sites.maxBodyBytesHelp}
            error={errors.maxBodyBytes}
            optional
          >
            <NumberInput
              id="site-max-body"
              value={form.maxBodyBytes}
              min={0}
              onChange={(value) => onChange({ maxBodyBytes: value })}
            />
          </Field>
          <Field
            id="site-allowed-ips"
            label={zh.sites.allowedIps}
            help={zh.sites.ipListHelp}
            error={errors.ips}
            optional
          >
            <TextInput
              id="site-allowed-ips"
              value={form.allowedIps}
              mono
              onChange={(value) => onChange({ allowedIps: value })}
            />
          </Field>
          <Field
            id="site-denied-ips"
            label={zh.sites.deniedIps}
            help={zh.sites.ipListHelp}
            error={errors.ips}
            optional
          >
            <TextInput
              id="site-denied-ips"
              value={form.deniedIps}
              mono
              onChange={(value) => onChange({ deniedIps: value })}
            />
          </Field>
        </GroupCard>

        <GroupCard title={zh.sites.groupLog}>
          <Field id="site-log-enabled" label={zh.sites.logEnabled} variant="row">
            <Toggle
              checked={form.logEnabled}
              label={zh.sites.logEnabled}
              onChange={(checked) => onChange({ logEnabled: checked })}
            />
          </Field>
          <Field
            id="site-log-path"
            label={zh.sites.logPath}
            help={zh.sites.logPathHelp}
            optional
          >
            <TextInput
              id="site-log-path"
              value={form.logPath}
              mono
              onChange={(value) => onChange({ logPath: value })}
            />
          </Field>
        </GroupCard>

        <GroupCard title={zh.sites.groupObserve}>
          <Field
            id="site-live"
            label={zh.sites.liveGateway}
            help={zh.sites.liveGatewayHelp}
            variant="row"
          >
            <Toggle
              checked={form.liveGateway}
              label={zh.sites.liveGateway}
              onChange={(checked) => onChange({ liveGateway: checked })}
            />
          </Field>
        </GroupCard>
        </AdvancedSection>

        {saveError ? <InlineError message={saveError} /> : null}

        {form.mode === 'edit' ? (
          <GroupCard title={zh.sites.dangerZone}>
            {deleteConfirm ? (
              <Stack gap={3}>
                <Banner
                  tone="danger"
                  title={fmt(zh.sites.deleteTitle, {
                    name: form.originalName ?? form.domains,
                  })}
                  description={zh.sites.deleteBody}
                />
                <Row gap={2}>
                  <Button
                    label={zh.sites.deleteConfirm}
                    variant="danger"
                    loading={deleting}
                    onClick={() => void handleDelete()}
                  />
                  <Button
                    label={zh.common.cancel}
                    disabled={deleting}
                    onClick={() => setDeleteConfirm(false)}
                  />
                </Row>
                {deleteError ? <InlineError message={deleteError} /> : null}
              </Stack>
            ) : (
              <Button
                label={zh.sites.deleteInForm}
                variant="danger-text"
                disabled={Boolean(offlineReason)}
                disabledReason={offlineReason}
                onClick={() => setDeleteConfirm(true)}
              />
            )}
          </GroupCard>
        ) : null}
      </Stack>
    </Drawer>
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
