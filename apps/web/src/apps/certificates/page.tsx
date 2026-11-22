import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import type {
  Certificate,
  CertificateSyncTargetResult,
  CreateCertificateRequest,
} from '@khc/contracts';
import { ApiError } from '../../data/client';
import { hubStateQueryOptions, hubsQueryOptions } from '../../data/queries';
import { caddyConfigQueryOptions } from '../../data/sites';
import {
  bindCertificate,
  certificatesQueryOptions,
  createCertificate,
  deleteCertificate,
  extractCertificateResult,
  extractInspectResult,
  fetchCertificateMaterial,
  fetchCertificateUsages,
  issueCfDnsCertificate,
  patchCertificateAutoSync,
  renewCertificate,
  runCertificateAction,
  syncCertificate,
} from '../../data/certs';
import { fetchCfDnsAccounts } from '../../data/cfDns';
import { paths } from '../../registry/routes';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Badge,
  Banner,
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
  Table,
  Tag,
  Textarea,
  TextInput,
  Toggle,
  downloadTextFile,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import {
  daysUntil,
  formatAbsoluteTime,
  formatExpiry,
} from '../../i18n/format';

type CertMode = 'cf-dns01' | 'selfsigned' | 'manual';

interface IssueForm {
  mode: CertMode;
  name: string;
  domains: string;
  nodeId: string;
  accountId: string;
  days: number | null;
  keyType: '' | 'ec' | 'rsa';
  ca: string;
  certPem: string;
  keyPem: string;
  parsedNotAfter: number | null;
  error: string | null;
  busy: boolean;
}

interface ExportDialogState {
  cert: Certificate;
  loading: boolean;
  material: { certPem: string; keyPem: string } | null;
  error: string | null;
}

type ConfirmState = { kind: 'export' | 'delete'; cert: Certificate };

const DOMAIN_RE = /^[A-Za-z0-9*_.-]+(\.[A-Za-z0-9*_.-]+)*$/;

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function parseDomains(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultForm(mode: CertMode, scopeNodeId?: string): IssueForm {
  return {
    mode,
    name: '',
    domains: '',
    // 手动导入默认可全局：只有节点作用域内才预填该节点，用户可显式改回「全局」。
    nodeId: mode === 'manual' ? scopeNodeId ?? '' : '',
    accountId: '',
    days: 365,
    keyType: '',
    ca: mode === 'cf-dns01' ? 'letsencrypt' : '',
    certPem: '',
    keyPem: '',
    parsedNotAfter: null,
    error: null,
    busy: false,
  };
}

function expiryTone(notAfter: number | null): 'ok' | 'warn' | 'danger' | 'neutral' {
  const days = daysUntil(notAfter);
  if (days === null) return 'neutral';
  if (days < 0 || days <= 3) return 'danger';
  if (days <= 14) return 'warn';
  return 'ok';
}

export default function CertificatesPage({
  scopeHubId,
  embedded = false,
  createSignal = 0,
}: {
  scopeHubId?: string;
  embedded?: boolean;
  createSignal?: number;
} = {}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { drawer?: string };

  const certsQuery = useQuery(certificatesQueryOptions());
  const hubsQuery = useQuery(hubsQueryOptions());

  const allCerts = certsQuery.data ?? [];
  const hubs = hubsQuery.data ?? [];
  const onlineHubs = hubs.filter((hub) => hub.status === 'online');

  const [searchText, setSearchText] = useState('');
  const [form, setForm] = useState<IssueForm | null>(null);
  const [detailCert, setDetailCert] = useState<Certificate | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [exportState, setExportState] = useState<ExportDialogState | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [bindTarget, setBindTarget] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindMessage, setBindMessage] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [renewError, setRenewError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [autoSyncBusy, setAutoSyncBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResults, setSyncResults] = useState<CertificateSyncTargetResult[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [detailDeleteArmed, setDetailDeleteArmed] = useState(false);
  const [detailDeleteBusy, setDetailDeleteBusy] = useState(false);
  const [detailDeleteError, setDetailDeleteError] = useState<string | null>(null);
  const lastCreateSignal = useRef(createSignal);

  const usagesQuery = useQuery({
    queryKey: ['certs', detailCert?.id, 'usages'],
    queryFn: () => fetchCertificateUsages(detailCert!.id),
    enabled: Boolean(detailCert),
  });

  const cfAccountsQuery = useQuery({
    queryKey: ['cf-dns', 'accounts'],
    queryFn: fetchCfDnsAccounts,
    enabled: Boolean(form),
  });
  const enabledCfAccounts = useMemo(
    () => (cfAccountsQuery.data ?? []).filter((account) => account.enabled),
    [cfAccountsQuery.data],
  );
  const defaultCreateMode: CertMode = scopeHubId ? 'selfsigned' : 'cf-dns01';

  useEffect(() => {
    if (!form || form.mode !== 'cf-dns01' || form.accountId || enabledCfAccounts.length === 0) {
      return;
    }
    setForm((prev) =>
      prev && prev.mode === 'cf-dns01' && !prev.accountId
        ? { ...prev, accountId: enabledCfAccounts[0]!.id }
        : prev,
    );
  }, [enabledCfAccounts, form]);

  // 请求预算：打开证书库只拉 /certificates + /hubs，不对每个节点 fan-out Caddy 配置。
  // 站点占用只在打开证书详情或删除确认时才按需拉取（用户主动动作，单次）。
  const usageEnabled = Boolean(detailCert) || (confirm !== null && confirm.kind === 'delete');
  const caddyConfigQueries = useQueries({
    queries: (hubsQuery.data ?? []).map((hub) => ({
      ...caddyConfigQueryOptions(hub.id),
      enabled: usageEnabled && Boolean(hub.id),
    })),
  });

  const certUsage = useMemo(() => {
    const usage = new Map<string, { hubId: string; hubName: string; siteName: string; domains: string[] }[]>();
    const hubList = hubsQuery.data ?? [];
    caddyConfigQueries.forEach((query, index) => {
      const hub = hubList[index];
      if (!hub || !query.data) return;
      for (const site of query.data.config.sites) {
        const certId = site.tls.cert?.$cert;
        if (!certId) continue;
        const list = usage.get(certId) ?? [];
        list.push({ hubId: hub.id, hubName: hub.name, siteName: site.name, domains: site.domains });
        usage.set(certId, list);
      }
    });
    return usage;
  }, [caddyConfigQueries, hubsQuery.data]);

  const scopeHubIndex = scopeHubId ? hubs.findIndex((h) => h.id === scopeHubId) : -1;
  const scopeHubName = scopeHubId ? (hubs[scopeHubIndex]?.name ?? scopeHubId) : undefined;
  const scopeSites =
    scopeHubIndex >= 0 ? (caddyConfigQueries[scopeHubIndex]?.data?.config.sites ?? []) : [];

  const certs = useMemo(() => {
    if (!scopeHubId) return allCerts;
    return allCerts.filter(
      (cert) =>
        cert.sourceNodeId === scopeHubId ||
        (certUsage.get(cert.id) ?? []).some((u) => u.hubId === scopeHubId),
    );
  }, [allCerts, certUsage, scopeHubId]);

  const effectiveNodeId = form?.nodeId || scopeHubId || onlineHubs[0]?.id || '';

  const expiryWarnings = certs.filter((cert) => {
    const days = daysUntil(cert.notAfter);
    return days !== null && days <= 14;
  }).length;

  // 节点作用域：读 Agent 自身的 TLS 状态，展示控制通道证书是否已生效/何时到期。
  const scopeStateQuery = useQuery({
    ...hubStateQueryOptions(scopeHubId ?? ''),
    enabled: Boolean(scopeHubId),
  });
  const scopeHub = scopeHubId ? hubs.find((hub) => hub.id === scopeHubId) : undefined;
  const scopeTls = scopeStateQuery.data?.state?.agent?.tls;

  const setDrawerSearch = (_drawer?: string, _replace?: boolean) => {
    // 全局 /certs 独立路由已删除：证书页只在 /settings?tab=certs（embedded）
    // 或节点作用域内使用，抽屉开关由本地状态控制，不再写 URL。
  };

  const openIssue = (mode: CertMode) => {
    setForm(defaultForm(mode, scopeHubId));
    setDrawerSearch(mode === 'manual' ? 'import' : 'issue', false);
  };

  useEffect(() => {
    if (createSignal !== lastCreateSignal.current) {
      lastCreateSignal.current = createSignal;
      openIssue(defaultCreateMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal, defaultCreateMode]);

  const closeIssue = () => {
    setForm(null);
    setDrawerSearch(undefined);
  };

  const openDetail = (cert: Certificate) => {
    setDetailCert(cert);
    setBindTarget(cert.sourceNodeId ?? scopeHubId ?? '');
    setBindMessage(null);
    setBindError(null);
    setRenewError(null);
    setSyncResults(null);
    setSyncError(null);
    setDetailDeleteArmed(false);
    setDetailDeleteError(null);
    setDrawerSearch(`cert:${encodeURIComponent(cert.id)}`, false);
  };

  const closeDetail = () => {
    setDetailCert(null);
    setBindTarget('');
    setBindMessage(null);
    setBindError(null);
    setRenewError(null);
    setSyncResults(null);
    setSyncError(null);
    setDetailDeleteArmed(false);
    setDetailDeleteError(null);
    setDrawerSearch(undefined);
  };

  // 抽屉状态写入 URL（变更单 §003：?drawer=issue|import|cert:<id>）
  useEffect(() => {
    const drawer = search.drawer;
    if (!drawer) {
      setForm(null);
      setDetailCert(null);
      return;
    }
    if (drawer === 'issue' || drawer === 'import') {
      if (!form) setForm(defaultForm(drawer === 'import' ? 'manual' : defaultCreateMode, scopeHubId));
      return;
    }
    if (drawer.startsWith('cert:')) {
      let id = '';
      try {
        id = decodeURIComponent(drawer.slice(5));
      } catch {
        id = drawer.slice(5);
      }
      if (detailCert?.id === id) return;
      const cert = (certsQuery.data ?? []).find((item) => item.id === id);
      if (cert) setDetailCert(cert);
    }
    // 仅在抽屉参数 / 列表加载状态变化时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.drawer, certsQuery.isSuccess]);

  const setFormField = (patch: Partial<IssueForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const bindCertToNode = async (cert: Certificate, nodeId: string) => {
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await bindCertificate(cert.id, nodeId);
      setBindMessage(
        result.restartRequired
          ? (result.message ?? zh.certs.bindRestartRequired)
          : zh.certs.bindSuccess,
      );
      toast.show({
        message: result.restartRequired
          ? (result.message ?? zh.certs.bindRestartRequired)
          : zh.certs.bindSuccess,
      });
    } catch (error) {
      const text = message(error, zh.certs.bindFailed);
      setBindError(text);
      toast.show({ message: text });
    } finally {
      setBindBusy(false);
    }
  };

  const toggleAutoSync = async (cert: Certificate, autoSync: boolean) => {
    const previous = cert.autoSync;
    setAutoSyncBusy(true);
    setSyncError(null);
    setDetailCert((prev) => (prev && prev.id === cert.id ? { ...prev, autoSync } : prev));
    try {
      const updated = await patchCertificateAutoSync(cert.id, autoSync);
      await queryClient.invalidateQueries({ queryKey: ['certs'] });
      setDetailCert(updated);
      toast.show({ message: zh.certs.autoSyncSaved });
    } catch (error) {
      setDetailCert((prev) => (prev && prev.id === cert.id ? { ...prev, autoSync: previous } : prev));
      setSyncError(message(error, zh.certs.actionFailed));
    } finally {
      setAutoSyncBusy(false);
    }
  };

  const runSyncNow = async (cert: Certificate) => {
    setSyncBusy(true);
    setSyncError(null);
    try {
      const results = await syncCertificate(cert.id);
      setSyncResults(results);
      const okCount = results.filter((item) => item.status === 'synced').length;
      const failCount = results.length - okCount;
      if (results.length > 0) {
        toast.show({
          message:
            failCount === 0
              ? fmt(zh.certs.syncAllOk, { ok: String(okCount) })
              : fmt(zh.certs.syncPartial, { ok: String(okCount), fail: String(failCount) }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['certs', cert.id, 'usages'] });
    } catch (error) {
      setSyncError(message(error, zh.certs.actionFailed));
    } finally {
      setSyncBusy(false);
    }
  };

  const startRenew = async (cert: Certificate) => {
    setRenewError(null);
    setRenewing(true);
    try {
      if (cert.acmeProvider !== 'cf-dns01') {
        throw new Error('仅支持控制面 Cloudflare DNS-01 签发证书一键续期');
      }
      const { certificate: updated, syncResults: autoResults } = await renewCertificate(cert.id);
      await queryClient.invalidateQueries({ queryKey: ['certs'] });
      setDetailCert(updated);
      if (autoResults) setSyncResults(autoResults);
      toast.show({ message: zh.certs.renewSuccess });
    } catch (error) {
      setRenewError(message(error, zh.certs.renewFailed));
    } finally {
      setRenewing(false);
    }
  };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim();
    const domains = parseDomains(form.domains);
    if (!name) {
      setFormField({ error: fmt(zh.certs.required, { field: zh.certs.name }) });
      return;
    }
    if (domains.length === 0 || domains.some((domain) => !DOMAIN_RE.test(domain))) {
      setFormField({ error: zh.certs.invalidDomains });
      return;
    }
    if (form.mode === 'selfsigned' && !effectiveNodeId) {
      setFormField({ error: zh.certs.nodeMissing });
      return;
    }
    if (form.mode === 'cf-dns01' && !form.accountId) {
      setFormField({ error: zh.certs.cfAccountMissing });
      return;
    }
    if (form.mode === 'manual' && (!form.certPem.trim() || !form.keyPem.trim())) {
      setFormField({ error: zh.certs.manualMissingPem });
      return;
    }
    setFormField({ busy: true, error: null });
    try {
      if (form.mode === 'cf-dns01') {
        await issueCfDnsCertificate({
          name,
          domains,
          accountId: form.accountId,
          ca: form.ca === 'letsencrypt_staging' ? 'letsencrypt_staging' : 'letsencrypt',
        });
        await queryClient.invalidateQueries({ queryKey: ['certs'] });
        toast.show({ message: zh.certs.issueSuccess });
        closeIssue();
        return;
      }
      if (form.mode === 'manual') {
        await createCertificate({
          name,
          domains,
          issuer: 'manual',
          notAfter: form.parsedNotAfter ?? undefined,
          certPem: form.certPem.trim(),
          keyPem: form.keyPem.trim(),
          // 手动导入不执行签发：节点只是可选的来源标记，留空即全局证书。
          sourceNodeId: form.nodeId || undefined,
        });
        await queryClient.invalidateQueries({ queryKey: ['certs'] });
        toast.show({ message: zh.certs.importSuccess });
        closeIssue();
        return;
      }
      const envelope = await runCertificateAction(effectiveNodeId, 'issue_selfsigned', {
        domains,
        days: form.days ?? undefined,
        keyType: form.keyType || undefined,
      });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.certs.actionFailed);
      const material = extractCertificateResult(envelope);
      if (!material) throw new Error(zh.certs.actionFailed);
      await createCertificate({
        name,
        domains: material.domains.length > 0 ? material.domains : domains,
        issuer: 'selfsigned',
        notAfter: material.notAfter ?? undefined,
        certPem: material.certPem,
        keyPem: material.keyPem,
        sourceNodeId: effectiveNodeId,
      });
      await queryClient.invalidateQueries({ queryKey: ['certs'] });
      toast.show({ message: zh.certs.issueSuccess });
      closeIssue();
    } catch (error) {
      setFormField({ busy: false, error: message(error, zh.certs.submitFailed) });
    }
  };

  const inspect = async () => {
    if (!form) return;
    if (!form.nodeId) {
      setFormField({ error: zh.certs.inspectNeedNode });
      return;
    }
    setInspecting(true);
    try {
      const envelope = await runCertificateAction(form.nodeId, 'inspect', {
        certPem: form.certPem.trim(),
      });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.certs.inspectFailed);
      const parsed = extractInspectResult(envelope);
      if (!parsed) throw new Error(zh.certs.inspectFailed);
      setForm((prev) =>
        prev
          ? {
              ...prev,
              parsedNotAfter: parsed.notAfter,
              domains:
                prev.domains.trim().length > 0 ? prev.domains : parsed.domains.join(', '),
              error: null,
            }
          : prev,
      );
      toast.show({
        message: fmt(zh.certs.parsedExpiry, {
          domains: parsed.domains.join(', ') || '—',
          time: formatAbsoluteTime(parsed.notAfter),
        }),
      });
    } catch (error) {
      setFormField({ error: message(error, zh.certs.inspectFailed) });
    } finally {
      setInspecting(false);
    }
  };

  const startExport = async (cert: Certificate) => {
    const material = await fetchCertificateMaterial(cert.id);
    setConfirm(null);
    setExportState({
      cert,
      loading: false,
      material: { certPem: material.certPem, keyPem: material.keyPem },
      error: null,
    });
    setDetailCert(null);
    setDrawerSearch(undefined);
  };

  const removeCert = async (cert: Certificate) => {
    await deleteCertificate(cert.id);
    await queryClient.invalidateQueries({ queryKey: ['certs'] });
    toast.show({ message: zh.certs.deletedToast });
    setConfirm(null);
    setDetailCert(null);
    setDrawerSearch(undefined);
  };

  const columns: ColumnDef<Certificate>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.certs.colName,
      value: (cert) => cert.name,
      dot: (cert) => expiryTone(cert.notAfter),
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
      value: (cert) =>
        cert.acmeProvider === 'cf-dns01'
          ? zh.certs.issuerCfDns
          : cert.issuer === 'acme'
            ? zh.certs.issuerAcme
            : cert.issuer === 'selfsigned'
              ? zh.certs.issuerSelfsigned
              : cert.issuer === 'manual'
                ? zh.certs.issuerManual
                : zh.certs.issuerUnknown,
    },
    {
      key: 'expiry',
      type: 'status',
      header: zh.certs.colExpiry,
      status: (cert) => {
        const days = daysUntil(cert.notAfter);
        return {
          tone: expiryTone(cert.notAfter),
          label:
            days === null
              ? zh.certs.noExpiry
              : days < 0
                ? fmt(zh.certs.expired, { days: Math.abs(days) })
                : days === 0
                  ? zh.certs.expiresToday
                  : fmt(zh.certs.expiresIn, { days }),
        };
      },
    },
    {
      key: 'sync',
      type: 'text',
      header: '同步方式',
      value: (cert) => (cert.autoSync ? '自动同步' : '手动同步'),
    },
    {
      key: 'source',
      type: 'text',
      header: zh.certs.colSource,
      value: (cert) => {
        if (!cert.sourceNodeId) return zh.certs.sourceGlobal;
        return hubs.find((hub) => hub.id === cert.sourceNodeId)?.name ?? cert.sourceNodeId;
      },
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const handleRowAction = (ref: ActionRef, cert: Certificate) => {
    if (ref.id === 'cert.export') setConfirm({ kind: 'export', cert });
    if (ref.id === 'cert.delete') setConfirm({ kind: 'delete', cert });
  };

  const handlePageAction = (ref: ActionRef) => {
    if (ref.id === 'cert.create') openIssue(defaultCreateMode);
  };

  const nodeOptions = hubs.map((hub) => ({
    value: hub.id,
    label: `${hub.name} · ${hub.status === 'online' ? zh.certs.nodeOnline : zh.certs.nodeOffline}`,
    disabled: hub.status !== 'online',
  }));

  return (
    <Stack gap={4}>
      {!embedded ? (
        <PageHeader
          title={scopeHubId ? '域名与证书' : zh.nav.certs}
          scope={scopeHubName}
          summary={fmt(zh.certs.summaryCount, { count: certs.length })}
          primaryAction={action('cert.create')}
          onAction={handlePageAction}
        />
      ) : (
        <span className="ui-muted">
          {fmt(zh.certs.summaryCount, { count: certs.length })} · 支持控制面 Cloudflare DNS-01 签发/续期、自签与导入 PEM，用于 Caddy 站点共享绑定。
        </span>
      )}

      {expiryWarnings > 0 ? (
        <Banner tone="warn" title={fmt(zh.certs.expiringHint, { count: expiryWarnings })} />
      ) : null}

      {certsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.certs.loadError}
          description={(certsQuery.error as Error).message}
          action={<Button label={zh.common.retry} size="sm" onClick={() => void certsQuery.refetch()} />}
        />
      ) : null}

      {scopeHubId && scopeSites.length > 0 ? (
        <Card
          title={`本节点已发布域名 (${scopeSites.length})`}
          action={<Link to={paths.hubSection(scopeHubId, 'sites')} label="管理 Caddy 站点" />}
        >
          <Stack gap={2}>
            {scopeSites.map((site) => {
              const boundCertId = site.tls.cert?.$cert;
              const boundCert = boundCertId ? allCerts.find((c) => c.id === boundCertId) : null;
              return (
                <Row gap={2} align="center" justify="between" key={site.name}>
                  <Row gap={2} align="center">
                    <Badge
                      tone={site.enabled ? 'ok' : 'neutral'}
                      label={site.enabled ? '已启用' : '已停用'}
                    />
                    <span className="mono">{site.domains.join(', ')}</span>
                    <span className="t3 xs">({site.name})</span>
                  </Row>
                  <Row gap={2} align="center">
                    {site.tls.mode === 'manual' && boundCert ? (
                      <Tag label={`绑定证书：${boundCert.name}`} />
                    ) : site.tls.mode === 'auto' ? (
                      <Tag label="Caddy 自动 ACME 签发" />
                    ) : (
                      <Tag label={`TLS: ${site.tls.mode}`} />
                    )}
                  </Row>
                </Row>
              );
            })}
          </Stack>
        </Card>
      ) : null}

      {scopeHubId ? (
        <Card
          title={zh.certs.nodeTlsTitle}
          action={
            <Button
              label={zh.common.refresh}
              size="sm"
              loading={scopeStateQuery.isFetching}
              onClick={() => void scopeStateQuery.refetch()}
            />
          }
        >
          <Stack gap={3}>
            <KeyValue
              items={[
                {
                  key: zh.certs.accessMode,
                  value:
                    scopeHub?.accessMode === 'tunnel'
                      ? zh.certs.accessTunnel
                      : scopeHub?.accessMode === 'ip'
                        ? zh.certs.accessIp
                        : zh.certs.accessDomain,
                },
                { key: zh.certs.endpoint, value: scopeHub?.endpoint ?? '—', mono: true },
                {
                  key: zh.certs.nodeTlsState,
                  value: scopeTls?.enabled ? zh.certs.nodeTlsEnabled : zh.certs.nodeTlsDisabled,
                },
                {
                  key: zh.certs.nodeTlsExpiry,
                  value: formatExpiry(scopeTls?.notAfter ?? null),
                },
              ]}
            />
            {scopeHub?.accessMode === 'domain' && !scopeTls?.enabled ? (
              <Banner
                tone="warn"
                title={zh.certs.nodeTlsMissing}
                description={zh.certs.nodeTlsMissingHint}
              />
            ) : null}
            {scopeStateQuery.error ? (
              <InlineError message={message(scopeStateQuery.error, zh.certs.loadError)} />
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Table
        rows={certsQuery.isLoading ? undefined : certs}
        columns={columns}
        rowKey={(cert) => cert.id}
        objectLabel={zh.nav.certs}
        search={
          certs.length > 0
            ? { value: searchText, onChange: setSearchText, placeholder: zh.certs.colDomains }
            : undefined
        }
        empty={{
          icon: 'lock',
          title: zh.certs.emptyTitle,
          description: zh.certs.emptyHint,
          ...(embedded
            ? {}
            : {
                action: (
                  <Button
                    label={actionLabel(action('cert.create'))}
                    variant="primary"
                    icon="plus"
                    onClick={() => openIssue(defaultCreateMode)}
                  />
                ),
              }),
        }}
        rowActions={() => [action('cert.export'), action('cert.delete')]}
        onRowAction={handleRowAction}
        onRowOpen={openDetail}
      />

      {form ? (
        <Drawer
          open
          title={form.mode === 'manual' ? zh.certs.importTitle : zh.certs.issueTitle}
          context={zh.certs.context}
          dirty={Boolean(form.name || form.domains || form.certPem || form.keyPem)}
          onClose={closeIssue}
          footer={
            <Row gap={2}>
              <Button label={zh.common.cancel} disabled={form.busy} onClick={closeIssue} />
              <Button
                label={
                  form.mode === 'manual' ? zh.certs.importSubmit : zh.certs.issueSubmit
                }
                loadingLabel={form.mode === 'cf-dns01' ? '签发中（等待 DNS 传播与校验）…' : undefined}
                variant="primary"
                loading={form.busy}
                disabled={
                  (form.mode === 'cf-dns01' && (!form.accountId || cfAccountsQuery.isLoading)) ||
                  (form.mode === 'selfsigned' && !effectiveNodeId)
                }
                disabledReason={
                  form.mode === 'cf-dns01'
                    ? zh.certs.cfAccountMissing
                    : form.mode === 'selfsigned' && !effectiveNodeId
                      ? zh.certs.nodeMissing
                      : undefined
                }
                onClick={() => void submit()}
              />
            </Row>
          }
        >
          <Stack gap={4}>
            <Segmented
              value={form.mode}
              ariaLabel={zh.certs.issueTitle}
              options={[
                { value: 'cf-dns01', label: zh.certs.modeCfDns01 },
                { value: 'selfsigned', label: zh.certs.modeSelfsigned },
                { value: 'manual', label: zh.certs.modeImport },
              ]}
              onChange={(value) => {
                const mode = value as CertMode;
                setFormField({
                  mode,
                  ca: mode === 'cf-dns01' && !form.ca ? 'letsencrypt' : form.ca,
                  error: null,
                });
                setDrawerSearch(mode === 'manual' ? 'import' : 'issue', true);
              }}
            />

            <>
                <Field id="cert-name" label={zh.certs.name} help={zh.certs.nameHelp}>
                  <TextInput
                    id="cert-name"
                    value={form.name}
                    onChange={(value) => setFormField({ name: value })}
                  />
                </Field>
                <Field id="cert-domains" label={zh.fields.domains} help={zh.certs.domainsHelp}>
                  <TextInput
                    id="cert-domains"
                    value={form.domains}
                    mono
                    onChange={(value) => setFormField({ domains: value })}
                  />
                </Field>

                {form.mode === 'cf-dns01' ? (
                  <>
                    <Banner tone="info" title={zh.certs.cfDnsHint} />
                    <Field
                      id="cert-cf-account"
                      label={zh.certs.cfAccountLabel}
                      help={zh.certs.cfAccountHelp}
                      required
                    >
                      <Select
                        id="cert-cf-account"
                        value={form.accountId}
                        disabled={cfAccountsQuery.isLoading}
                        options={enabledCfAccounts.map((account) => ({
                          value: account.id,
                          label: account.accountName
                            ? `${account.name} · ${account.accountName}`
                            : account.name,
                        }))}
                        placeholder={
                          cfAccountsQuery.isLoading ? '正在读取 Cloudflare 账号…' : zh.form.choose
                        }
                        onChange={(value) => setFormField({ accountId: value })}
                      />
                    </Field>
                    {cfAccountsQuery.isSuccess && enabledCfAccounts.length === 0 ? (
                      <Banner
                        tone="warn"
                        title={zh.certs.cfAccountMissing}
                        action={
                          <Link
                            to={`${paths.settings}?tab=accounts`}
                            label={zh.certs.cfAccountLink}
                          />
                        }
                      />
                    ) : null}
                    <Field id="cert-cf-ca" label={zh.certs.caLabel}>
                      <Select
                        id="cert-cf-ca"
                        value={form.ca === 'letsencrypt_staging' ? 'letsencrypt_staging' : 'letsencrypt'}
                        options={[
                          { value: 'letsencrypt', label: zh.certs.caLetsencrypt },
                          { value: 'letsencrypt_staging', label: zh.certs.caStaging },
                        ]}
                        onChange={(value) => setFormField({ ca: value })}
                      />
                    </Field>
                    {form.busy ? (
                      <Banner
                        tone="info"
                        title="正在写入 Cloudflare TXT → 等待公网 DoH 传播 → 向 Let's Encrypt 申请证书…"
                        description="通常耗时 10–30 秒，请勿关闭抽屉；无论成功或失败均会自动清理临时 TXT 记录。"
                      />
                    ) : null}
                  </>
                ) : null}

                {form.mode === 'selfsigned' ? (
                  <Field id="cert-node" label={zh.fields.node} help={zh.certs.nodeHelp}>
                    <Select
                      id="cert-node"
                      value={effectiveNodeId}
                      options={nodeOptions}
                      placeholder={zh.form.choose}
                      onChange={(value) => setFormField({ nodeId: value })}
                    />
                  </Field>
                ) : null}

                {form.mode === 'selfsigned' ? (
                  <>
                    <Field id="cert-days" label={zh.fields.days} help={zh.certs.daysHelp}>
                      <NumberInput
                        id="cert-days"
                        value={form.days}
                        min={1}
                        max={3650}
                        suffix={zh.common.days}
                        onChange={(value) => setFormField({ days: value })}
                      />
                    </Field>
                    <Field id="cert-keytype" label={zh.fields.keyType}>
                      <Select
                        id="cert-keytype"
                        value={form.keyType}
                        options={[
                          { value: '', label: zh.certs.keyTypeDefault },
                          { value: 'ec', label: zh.certs.keyTypeEcdsa },
                          { value: 'rsa', label: zh.certs.keyTypeRsa },
                        ]}
                        onChange={(value) =>
                          setFormField({ keyType: value === 'ec' || value === 'rsa' ? value : '' })
                        }
                      />
                    </Field>
                  </>
                ) : null}

                {form.mode === 'manual' ? (
                  <>
                    <Field
                      id="cert-node-manual"
                      label={zh.certs.nodeBindLabel}
                      help={zh.certs.nodeBindHelp}
                      optional
                    >
                      <Select
                        id="cert-node-manual"
                        value={form.nodeId}
                        options={[{ value: '', label: zh.certs.nodeGlobal }, ...nodeOptions]}
                        onChange={(value) => setFormField({ nodeId: value })}
                      />
                    </Field>
                    <Field id="cert-pem" label={zh.certs.certPem}>
                      <Textarea
                        id="cert-pem"
                        value={form.certPem}
                        mono
                        rows={7}
                        onChange={(value) => setFormField({ certPem: value })}
                      />
                    </Field>
                    <Field id="cert-key" label={zh.certs.keyPem}>
                      <Textarea
                        id="cert-key"
                        value={form.keyPem}
                        mono
                        rows={7}
                        onChange={(value) => setFormField({ keyPem: value })}
                      />
                    </Field>
                    <Row gap={2}>
                      {form.nodeId ? (
                        <Button
                          label={zh.certs.parseCert}
                          size="sm"
                          loading={inspecting}
                          disabled={!form.certPem.trim()}
                          disabledReason={zh.certs.invalidDomains}
                          onClick={() => void inspect()}
                        />
                      ) : (
                        <p className="ui-field-help">{zh.certs.importNoNodeHint}</p>
                      )}
                    </Row>
                    {form.parsedNotAfter !== null ? (
                      <Banner
                        tone="info"
                        title={fmt(zh.certs.parsedExpiry, {
                          domains: form.domains || '—',
                          time: formatAbsoluteTime(form.parsedNotAfter),
                        })}
                      />
                    ) : null}
                  </>
                ) : null}

                {form.error ? <InlineError message={form.error} /> : null}
              </>
          </Stack>
        </Drawer>
      ) : null}

      {detailCert ? (
        <Drawer
          open
          title={zh.certs.detailTitle}
          context={fmt(zh.certs.detailContext, { name: detailCert.name })}
          onClose={closeDetail}
          footer={
            detailDeleteArmed ? (
              <Stack gap={2}>
                <span className="ui-text-caption">
                  {fmt(zh.certs.deleteTitle, { name: detailCert.name })}（
                  {(certUsage.get(detailCert.id)?.length ?? 0) > 0
                    ? fmt(zh.certs.deleteReferencedBody, {
                        count: certUsage.get(detailCert.id)?.length ?? 0,
                      })
                    : zh.certs.deleteBody}
                  ）
                </span>
                {detailDeleteError ? <InlineError message={detailDeleteError} /> : null}
                <Row gap={2}>
                  <Button
                    label={zh.common.cancel}
                    disabled={detailDeleteBusy}
                    onClick={() => {
                      setDetailDeleteArmed(false);
                      setDetailDeleteError(null);
                    }}
                  />
                  <Button
                    label={zh.certs.deleteConfirm}
                    variant="danger"
                    loading={detailDeleteBusy}
                    onClick={() => {
                      setDetailDeleteBusy(true);
                      setDetailDeleteError(null);
                      void removeCert(detailCert)
                        .catch((err) => {
                          setDetailDeleteError(message(err, zh.certs.actionFailed));
                        })
                        .finally(() => setDetailDeleteBusy(false));
                    }}
                  />
                </Row>
              </Stack>
            ) : (
              <Row gap={2}>
                <Button
                  label={actionLabel(action('cert.export'))}
                  icon="download"
                  onClick={() => {
                    const target = detailCert;
                    closeDetail();
                    setConfirm({ kind: 'export', cert: target });
                  }}
                />
                <Button
                  label={actionLabel(action('cert.delete'))}
                  variant="danger-text"
                  onClick={() => {
                    setDetailDeleteArmed(true);
                    setDetailDeleteError(null);
                  }}
                />
              </Row>
            )
          }
        >
          <Stack gap={4}>
            <KeyValue
              items={[
                { key: zh.certs.colName, value: detailCert.name },
                {
                  key: zh.certs.colDomains,
                  value: detailCert.domains.join(', '),
                  mono: true,
                },
                {
                  key: zh.certs.colIssuer,
                  value:
                    detailCert.acmeProvider === 'cf-dns01'
                      ? zh.certs.issuerCfDns
                      : detailCert.issuer === 'acme'
                        ? zh.certs.issuerAcme
                        : detailCert.issuer === 'selfsigned'
                          ? zh.certs.issuerSelfsigned
                          : detailCert.issuer === 'manual'
                            ? zh.certs.issuerManual
                            : zh.certs.issuerUnknown,
                },
                {
                  key: zh.certs.colExpiry,
                  value: formatExpiry(detailCert.notAfter),
                },
                {
                  key: zh.certs.colSource,
                  value: detailCert.sourceNodeId
                    ? (hubs.find((hub) => hub.id === detailCert.sourceNodeId)?.name ??
                      detailCert.sourceNodeId)
                    : zh.certs.sourceGlobal,
                },
                { key: zh.fields.createdAt, value: formatAbsoluteTime(detailCert.createdAt) },
                { key: zh.fields.updatedAt, value: formatAbsoluteTime(detailCert.updatedAt) },
                {
                  key: zh.certs.usedBy,
                  value: fmt(zh.certs.usedByCount, {
                    count: certUsage.get(detailCert.id)?.length ?? 0,
                  }),
                },
              ]}
            />
            <Card title={zh.certs.usagesTitle}>
              <Stack gap={3}>
                <Field
                  id="cert-auto-sync"
                  label={zh.certs.autoSyncLabel}
                  help={zh.certs.autoSyncHelp}
                  variant="row"
                >
                  <Row gap={2} align="center">
                    {autoSyncBusy ? <span className="ui-text-caption">保存中…</span> : null}
                    <Toggle
                      checked={Boolean(detailCert.autoSync)}
                      disabled={autoSyncBusy}
                      label={zh.certs.autoSyncLabel}
                      onChange={(checked) => void toggleAutoSync(detailCert, checked)}
                    />
                  </Row>
                </Field>
                {usagesQuery.isLoading ? (
                  <Skeleton height={36} />
                ) : (usagesQuery.data ?? []).length === 0 ? (
                  <span className="ui-field-help">{zh.certs.usagesEmpty}</span>
                ) : (
                  <Stack gap={2}>
                    {(usagesQuery.data ?? []).map((item) => (
                      <Row gap={2} justify="between" key={item.nodeId}>
                        <span className="mono">{item.nodeName}</span>
                        <Row gap={1}>
                          {item.apps.map((app) => (
                            <Tag key={app} label={app} />
                          ))}
                          {item.isSourceNode ? <Tag label={zh.certs.usagesSourceTag} /> : null}
                        </Row>
                      </Row>
                    ))}
                  </Stack>
                )}
                <Row gap={2}>
                  <Button
                    label={zh.certs.syncNow}
                    size="sm"
                    icon="refresh"
                    loading={syncBusy}
                    disabled={(usagesQuery.data ?? []).length === 0 && !usagesQuery.isError}
                    onClick={() => void runSyncNow(detailCert)}
                  />
                </Row>
                {syncError ? <InlineError message={syncError} /> : null}
                {syncResults && syncResults.length > 0 ? (
                  <Stack gap={2}>
                    {(() => {
                      const okCount = syncResults.filter((item) => item.status === 'synced').length;
                      const failCount = syncResults.length - okCount;
                      return (
                        <Banner
                          tone={failCount === 0 ? 'ok' : 'warn'}
                          title={
                            failCount === 0
                              ? fmt(zh.certs.syncAllOk, { ok: String(okCount) })
                              : fmt(zh.certs.syncPartial, {
                                  ok: String(okCount),
                                  fail: String(failCount),
                                })
                          }
                          action={
                            failCount > 0 ? (
                              <Button
                                label={zh.certs.syncRetry}
                                size="sm"
                                loading={syncBusy}
                                onClick={() => void runSyncNow(detailCert)}
                              />
                            ) : undefined
                          }
                        />
                      );
                    })()}
                    {syncResults.map((item) => (
                      <Row gap={2} justify="between" key={item.nodeId}>
                        <Row gap={2}>
                          <span className="mono">{item.nodeName}</span>
                          <Badge
                            tone={
                              item.status === 'synced'
                                ? 'ok'
                                : item.status === 'offline'
                                  ? 'warn'
                                  : 'danger'
                            }
                            label={
                              item.status === 'synced'
                                ? zh.certs.syncStatusSynced
                                : item.status === 'offline'
                                  ? zh.certs.syncStatusOffline
                                  : zh.certs.syncStatusError
                            }
                          />
                        </Row>
                        <span className="ui-text-caption">
                          {item.error ?? item.appliedApps.join(', ')}
                        </span>
                      </Row>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            </Card>
            <Card title={zh.certs.bindTitle}>
              <Stack gap={3}>
                <Field id="cert-bind-node" label={zh.fields.node} help={zh.certs.bindHelp}>
                  <Select
                    id="cert-bind-node"
                    value={bindTarget}
                    options={nodeOptions}
                    placeholder={zh.form.choose}
                    onChange={setBindTarget}
                  />
                </Field>
                <Row gap={2}>
                  <Button
                    label={zh.certs.bindSubmit}
                    size="sm"
                    loading={bindBusy}
                    disabled={!bindTarget}
                    disabledReason={zh.certs.nodeMissing}
                    onClick={() => void bindCertToNode(detailCert, bindTarget)}
                  />
                  {detailCert.renewable ? (
                    <Button
                      label={zh.certs.renew}
                      size="sm"
                      icon="refresh"
                      loading={renewing}
                      onClick={() => void startRenew(detailCert)}
                    />
                  ) : null}
                </Row>
                <p className="ui-field-help">{zh.certs.bindHelpMore}</p>
                {bindMessage ? <Banner tone="info" title={bindMessage} /> : null}
                {bindError ? <InlineError message={bindError} /> : null}
                {renewError ? <InlineError message={renewError} /> : null}
              </Stack>
            </Card>
            {(certUsage.get(detailCert.id)?.length ?? 0) > 0 ? (
              <Card title={zh.certs.usedBy}>
                <Stack gap={2}>
                  {certUsage.get(detailCert.id)?.map((item: { hubId: string; hubName: string; siteName: string; domains: string[] }) => (
                    <Row gap={2} key={`${item.hubId}-${item.siteName}`}>
                      <span className="mono">{item.hubName}</span>
                      <span>{item.siteName}</span>
                      <span className="ui-muted">{item.domains.join(', ')}</span>
                    </Row>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        </Drawer>
      ) : null}

      {exportState ? (
        <ExportDialog
          state={exportState}
          onClose={() => setExportState(null)}
          onRetry={() => {
            setExportState(null);
            setConfirm({ kind: 'export', cert: exportState.cert });
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmAction
          open
          action={action(confirm.kind === 'export' ? 'cert.export' : 'cert.delete')}
          title={
            confirm.kind === 'export'
              ? fmt(zh.certs.exportConfirmTitle, { name: confirm.cert.name })
              : fmt(zh.certs.deleteTitle, { name: confirm.cert.name })
          }
          body={
            confirm.kind === 'export'
              ? zh.certs.exportConfirmBody
              : (certUsage.get(confirm.cert.id)?.length ?? 0) > 0
                ? fmt(zh.certs.deleteReferencedBody, {
                    count: certUsage.get(confirm.cert.id)?.length ?? 0,
                  })
                : zh.certs.deleteBody
          }
          confirmLabel={
            confirm.kind === 'export' ? zh.certs.exportConfirm : zh.certs.deleteConfirm
          }
          targetName={confirm.cert.name}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === 'export') {
              await startExport(confirm.cert);
              return;
            }
            await removeCert(confirm.cert);
          }}
        />
      ) : null}
    </Stack>
  );
}

function ExportDialog({
  state,
  onClose,
  onRetry,
}: {
  state: ExportDialogState;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <Dialog
      open
      title={zh.certs.exportTitle}
      onClose={onClose}
      footer={
        <>
          <Button
            label={zh.certs.downloadCert}
            icon="download"
            onClick={() => {
              if (state.material) downloadTextFile(state.material.certPem, `${state.cert.name}.crt`);
            }}
          />
          <Button
            label={zh.certs.downloadKey}
            icon="download"
            onClick={() => {
              if (state.material) downloadTextFile(state.material.keyPem, `${state.cert.name}.key`);
            }}
          />
        </>
      }
    >
      <Stack gap={3}>
        <Banner tone="warn" title={zh.certs.exportSensitive} />
        {state.error ? (
          <Banner
            tone="danger"
            title={zh.certs.loadError}
            description={state.error}
            action={<Button label={zh.common.retry} size="sm" onClick={onRetry} />}
          />
        ) : null}
        {state.loading ? (
          <Stack gap={2}>
            <Skeleton height={10} />
            <Skeleton height={10} />
          </Stack>
        ) : null}
        {state.material ? (
          <>
            <CodeBlock code={state.material.certPem} label={zh.certs.certPemLabel} />
            <CodeBlock code={state.material.keyPem} label={zh.certs.keyPemLabel} />
          </>
        ) : null}
      </Stack>
    </Dialog>
  );
}
