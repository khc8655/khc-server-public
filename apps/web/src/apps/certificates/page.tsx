import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Certificate, CreateCertificateRequest, TaskResponse } from '@khc/contracts';
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
  extractTaskCertificateResult,
  fetchCertificateMaterial,
  fetchCertificateTask,
  runCertificateAction,
  updateCertificate,
  type CertActionEnvelope,
} from '../../data/certs';
import { settingsQueryOptions } from '../../data/settings';
import { paths } from '../../registry/routes';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction, TaskView } from '../../patterns';
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

type CertMode = 'selfsigned' | 'acme' | 'manual';

interface IssueForm {
  mode: CertMode;
  name: string;
  domains: string;
  nodeId: string;
  days: number | null;
  keyType: '' | 'ec' | 'rsa';
  provider: string;
  credentialsKey: string;
  ca: string;
  certPem: string;
  keyPem: string;
  parsedNotAfter: number | null;
  error: string | null;
  busy: boolean;
}

interface AcmeTask {
  nodeId: string;
  taskId: string;
  name: string;
  domains: string[];
  provider: string;
  credentialsKey: string;
  ca: string;
  keyType: '' | 'ec' | 'rsa';
}

interface RenewTask {
  nodeId: string;
  taskId: string;
  cert: Certificate;
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
    days: 365,
    keyType: '',
    provider: '',
    credentialsKey: '',
    ca: '',
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
}: {
  scopeHubId?: string;
  embedded?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { drawer?: string };

  const certsQuery = useQuery(certificatesQueryOptions());
  const hubsQuery = useQuery(hubsQueryOptions());
  const settingsQuery = useQuery(settingsQueryOptions());

  const allCerts = certsQuery.data ?? [];
  const hubs = hubsQuery.data ?? [];
  const onlineHubs = hubs.filter((hub) => hub.status === 'online');
  const settings = settingsQuery.data ?? [];

  const [searchText, setSearchText] = useState('');
  const [form, setForm] = useState<IssueForm | null>(null);
  const [detailCert, setDetailCert] = useState<Certificate | null>(null);
  const [acmeTask, setAcmeTask] = useState<AcmeTask | null>(null);
  const [renewTask, setRenewTask] = useState<RenewTask | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [exportState, setExportState] = useState<ExportDialogState | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [bindTarget, setBindTarget] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindMessage, setBindMessage] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [renewError, setRenewError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const formRef = useRef<IssueForm | null>(null);
  formRef.current = form;

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

  const taskQuery = useQuery({
    queryKey: ['hubs', acmeTask?.nodeId, 'tasks', acmeTask?.taskId],
    queryFn: () => fetchCertificateTask(acmeTask?.nodeId as string, acmeTask?.taskId as string),
    enabled: Boolean(acmeTask),
    // 签发进度不自动轮询：用户点「刷新」再拉取，避免持续消耗 Worker 请求。
    retry: false,
  });

  const renewTaskQuery = useQuery({
    queryKey: ['hubs', renewTask?.nodeId, 'tasks', renewTask?.taskId],
    queryFn: () =>
      fetchCertificateTask(renewTask?.nodeId as string, renewTask?.taskId as string),
    enabled: Boolean(renewTask),
    retry: false,
  });

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

  const closeIssue = () => {
    setForm(null);
    // ACME 任务在后台继续，完成后仍会入库并提示
    setDrawerSearch(undefined);
  };

  const openDetail = (cert: Certificate) => {
    setDetailCert(cert);
    setBindTarget(cert.sourceNodeId ?? scopeHubId ?? '');
    setBindMessage(null);
    setBindError(null);
    setRenewError(null);
    setRenewTask(null);
    setDrawerSearch(`cert:${encodeURIComponent(cert.id)}`, false);
  };

  const closeDetail = () => {
    setDetailCert(null);
    setBindTarget('');
    setBindMessage(null);
    setBindError(null);
    setRenewError(null);
    setRenewTask(null);
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
      if (!form) setForm(defaultForm(drawer === 'import' ? 'manual' : 'selfsigned', scopeHubId));
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

  // ACME 任务完成 → 自动入库
  useEffect(() => {
    const task = taskQuery.data?.task;
    if (!acmeTask || !task) return;
    if (task.state === 'error' || task.state === 'canceled') {
      setForm((prev) =>
        prev && prev.mode === 'acme'
          ? { ...prev, busy: false, error: task.error?.message ?? zh.certs.actionFailed }
          : prev,
      );
      if (formRef.current?.mode !== 'acme') {
        toast.show({ message: task.error?.message ?? zh.certs.actionFailed });
      }
      setAcmeTask(null);
      return;
    }
    if (task.state !== 'done' || finishing) return;
    setFinishing(true);
    void (async () => {
      try {
        const material = extractTaskCertificateResult(task);
        if (!material) throw new Error(zh.certs.actionFailed);
        await createAndMaybeBind(
          {
            name: acmeTask.name,
            domains: material.domains.length > 0 ? material.domains : acmeTask.domains,
            issuer: 'acme',
            notAfter: material.notAfter ?? undefined,
            certPem: material.certPem,
            keyPem: material.keyPem,
            sourceNodeId: acmeTask.nodeId,
            acme: {
              provider: acmeTask.provider,
              credentialKey: acmeTask.credentialsKey,
              ...(acmeTask.ca ? { ca: acmeTask.ca } : {}),
              ...(acmeTask.keyType ? { keyType: acmeTask.keyType } : {}),
            },
          },
          acmeTask.nodeId,
        );
        await queryClient.invalidateQueries({ queryKey: ['certs'] });
        toast.show({ message: zh.certs.issueSuccess });
        setAcmeTask(null);
        if (formRef.current?.mode === 'acme') {
          setForm(null);
          setDrawerSearch(undefined);
        }
      } catch (error) {
        const text = message(error, zh.certs.createFailed);
        setForm((prev) => (prev ? { ...prev, busy: false, error: text } : prev));
        if (formRef.current?.mode !== 'acme') toast.show({ message: text });
        setAcmeTask(null);
      } finally {
        setFinishing(false);
      }
    })();
  }, [acmeTask, finishing, queryClient, taskQuery.data?.task, toast]);

  const setFormField = (patch: Partial<IssueForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  /** 签发成功后：域名为接入方式的节点自动把证书装到 Agent 并热重载。 */
  const createAndMaybeBind = async (input: CreateCertificateRequest, nodeId: string) => {
    const cert = await createCertificate(input);
    const hub = (hubsQuery.data ?? []).find((item) => item.id === nodeId);
    if (cert.issuer === 'acme' && hub?.accessMode === 'domain') {
      try {
        const bind = await bindCertificate(cert.id, nodeId);
        toast.show({
          message: bind.restartRequired
            ? (bind.message ?? zh.certs.bindRestartRequired)
            : zh.certs.bindSuccess,
        });
      } catch (error) {
        toast.show({
          message: fmt(zh.certs.bindAfterIssueFailed, {
            error: message(error, zh.certs.bindFailed),
          }),
        });
      }
    }
    return cert;
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

  const applyRenewMaterial = async (
    cert: Certificate,
    material: NonNullable<ReturnType<typeof extractCertificateResult>>,
    nodeId: string,
  ) => {
    const updated = await updateCertificate(cert.id, {
      certPem: material.certPem,
      keyPem: material.keyPem,
      ...(material.notAfter === null ? {} : { notAfter: material.notAfter }),
      ...(material.domains.length === 0 ? {} : { domains: material.domains }),
      issuer: 'acme',
    });
    await queryClient.invalidateQueries({ queryKey: ['certs'] });
    setDetailCert(updated);
    toast.show({ message: zh.certs.renewSuccess });
    // 续期后自动重新安装到原节点，保持控制通道证书最新
    await bindCertToNode(updated, nodeId);
  };

  const startRenew = async (cert: Certificate) => {
    if (!cert.sourceNodeId || !cert.acmeProvider || !cert.acmeCredentialKey) return;
    setRenewError(null);
    setRenewing(true);
    try {
      const envelope = await runCertificateAction(cert.sourceNodeId, 'issue_acme', {
        domains: cert.domains,
        provider: cert.acmeProvider,
        credentials: { $dnsCred: cert.acmeCredentialKey },
        ca: cert.acmeCa ?? undefined,
        keyType: cert.acmeKeyType ?? undefined,
      });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.certs.actionFailed);
      if (envelope.taskId) {
        setRenewTask({ nodeId: cert.sourceNodeId, taskId: envelope.taskId, cert });
        return;
      }
      const material = extractCertificateResult(envelope);
      if (!material) throw new Error(zh.certs.actionFailed);
      await applyRenewMaterial(cert, material, cert.sourceNodeId);
    } catch (error) {
      setRenewError(message(error, zh.certs.renewFailed));
    } finally {
      setRenewing(false);
    }
  };

  // 续期任务完成 → 替换材料并重新安装到节点
  useEffect(() => {
    const task = renewTaskQuery.data?.task;
    if (!renewTask || !task || renewing) return;
    if (task.state === 'error' || task.state === 'canceled') {
      setRenewError(task.error?.message ?? zh.certs.renewFailed);
      setRenewTask(null);
      return;
    }
    if (task.state !== 'done') return;
    setRenewing(true);
    void (async () => {
      try {
        const material = extractTaskCertificateResult(task);
        if (!material) throw new Error(zh.certs.actionFailed);
        await applyRenewMaterial(renewTask.cert, material, renewTask.nodeId);
        setRenewTask(null);
      } catch (error) {
        setRenewError(message(error, zh.certs.renewFailed));
        setRenewTask(null);
      } finally {
        setRenewing(false);
      }
    })();
    // applyRenewMaterial 依赖 queryClient/toast（稳定引用），不放进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renewTask, renewTaskQuery.data?.task, renewing]);

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
    if (form.mode !== 'manual' && !effectiveNodeId) {
      setFormField({ error: zh.certs.nodeMissing });
      return;
    }
    if (form.mode === 'acme' && !form.provider.trim()) {
      setFormField({ error: fmt(zh.certs.required, { field: zh.fields.provider }) });
      return;
    }
    if (form.mode === 'acme' && !form.credentialsKey) {
      setFormField({ error: zh.certs.credentialsMissing });
      return;
    }
    if (form.mode === 'manual' && (!form.certPem.trim() || !form.keyPem.trim())) {
      setFormField({ error: zh.certs.manualMissingPem });
      return;
    }
    setFormField({ busy: true, error: null });
    try {
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
      if (form.mode === 'selfsigned') {
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
        return;
      }
      const envelope: CertActionEnvelope = await runCertificateAction(
        effectiveNodeId,
        'issue_acme',
        {
          domains,
          provider: form.provider.trim(),
          credentials: { $dnsCred: form.credentialsKey },
          ca: form.ca.trim() || undefined,
          keyType: form.keyType || undefined,
        },
      );
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.certs.actionFailed);
      if (envelope.taskId) {
        setAcmeTask({
          nodeId: effectiveNodeId,
          taskId: envelope.taskId,
          name,
          domains,
          provider: form.provider.trim(),
          credentialsKey: form.credentialsKey,
          ca: form.ca.trim(),
          keyType: form.keyType,
        });
        setFormField({ busy: true, error: null, name });
        return;
      }
      const material = extractCertificateResult(envelope);
      if (!material) throw new Error(zh.certs.actionFailed);
      await createAndMaybeBind(
        {
          name,
          domains: material.domains.length > 0 ? material.domains : domains,
          issuer: 'acme',
          notAfter: material.notAfter ?? undefined,
          certPem: material.certPem,
          keyPem: material.keyPem,
          sourceNodeId: effectiveNodeId,
          acme: {
            provider: form.provider.trim(),
            credentialKey: form.credentialsKey,
            ...(form.ca.trim() ? { ca: form.ca.trim() } : {}),
            ...(form.keyType ? { keyType: form.keyType } : {}),
          },
        },
        effectiveNodeId,
      );
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
        cert.issuer === 'acme'
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
    if (ref.id === 'cert.create') openIssue('selfsigned');
  };

  const task = taskQuery.data?.task;
  const acmeBusy = Boolean(acmeTask && form?.mode === 'acme');
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
        <Card
          title="证书库"
          action={
            <Button
              label={actionLabel(action('cert.create'))}
              variant="primary"
              size="sm"
              icon="plus"
              onClick={() => openIssue('selfsigned')}
            />
          }
        >
          <p className="t3 sm">
            {fmt(zh.certs.summaryCount, { count: certs.length })} · 支持自动 ACME 签发、自签名证书与手动导入 PEM，用于 Caddy 站点与域名绑定。
          </p>
        </Card>
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
        search={{ value: searchText, onChange: setSearchText, placeholder: zh.certs.colDomains }}
        empty={{
          icon: 'lock',
          title: zh.certs.emptyTitle,
          description: zh.certs.emptyHint,
          action: (
            <Button
              label={actionLabel(action('cert.create'))}
              variant="primary"
              icon="plus"
              onClick={() => openIssue('selfsigned')}
            />
          ),
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
          dirty={!acmeBusy && Boolean(form.name || form.domains || form.certPem || form.keyPem)}
          onClose={closeIssue}
          footer={
            acmeBusy ? (
              <Row gap={2}>
                <Button label={zh.common.close} onClick={closeIssue} />
              </Row>
            ) : (
              <Row gap={2}>
                <Button label={zh.common.cancel} onClick={closeIssue} />
                <Button
                  label={
                    form.mode === 'manual' ? zh.certs.importSubmit : zh.certs.issueSubmit
                  }
                  variant="primary"
                  loading={form.busy}
                  disabled={
                    (form.mode !== 'manual' && !effectiveNodeId) ||
                    (form.mode === 'acme' && !form.credentialsKey)
                  }
                  disabledReason={
                    form.mode !== 'manual' && !effectiveNodeId
                      ? zh.certs.nodeMissing
                      : zh.certs.credentialsMissing
                  }
                  onClick={() => void submit()}
                />
              </Row>
            )
          }
        >
          <Stack gap={4}>
            {!acmeBusy ? (
              <Segmented
                value={form.mode}
                ariaLabel={zh.certs.issueTitle}
                options={[
                  { value: 'selfsigned', label: zh.certs.modeSelfsigned },
                  { value: 'acme', label: zh.certs.modeAcme },
                  { value: 'manual', label: zh.certs.modeImport },
                ]}
                onChange={(value) => {
                  const mode = value as CertMode;
                  setFormField({ mode, error: null });
                  setDrawerSearch(mode === 'manual' ? 'import' : 'issue', true);
                }}
              />
            ) : null}

            {acmeBusy ? (
              <Stack gap={3}>
                <Banner tone="info" title={zh.certs.taskRunningHint} />
                {taskQuery.error ? (
                  <Banner
                    tone="danger"
                    title={zh.certs.actionFailed}
                    description={(taskQuery.error as Error).message}
                  />
                ) : task ? (
                  <TaskView task={task as TaskResponse['task']} />
                ) : (
                  <Skeleton height={80} />
                )}
                <Row gap={2}>
                  <Button
                    label={zh.common.refresh}
                    size="sm"
                    loading={taskQuery.isFetching}
                    onClick={() => void taskQuery.refetch()}
                  />
                </Row>
              </Stack>
            ) : (
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

                {form.mode !== 'manual' ? (
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

                {form.mode === 'acme' ? (
                  <>
                    <Field id="cert-provider" label={zh.fields.provider} help={zh.certs.providerHelp}>
                      <TextInput
                        id="cert-provider"
                        value={form.provider}
                        mono
                        onChange={(value) => setFormField({ provider: value })}
                      />
                    </Field>
                    <Field
                      id="cert-credentials"
                      label={zh.fields.credentials}
                      help={zh.certs.credentialsHelp}
                    >
                      <Select
                        id="cert-credentials"
                        value={form.credentialsKey}
                        options={settings.map((setting) => ({
                          value: setting.key,
                          label: setting.key,
                        }))}
                        placeholder={zh.form.choose}
                        onChange={(value) => setFormField({ credentialsKey: value })}
                      />
                    </Field>
                    {settings.length === 0 ? (
                      <Banner
                        tone="warn"
                        title={zh.certs.credentialsMissing}
                        action={<LinkToSettings />}
                      />
                    ) : null}
                    <Field id="cert-ca" label={zh.fields.ca} help={zh.certs.caHelp} optional>
                      <TextInput
                        id="cert-ca"
                        value={form.ca}
                        mono
                        onChange={(value) => setFormField({ ca: value })}
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
            )}
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
            <Row gap={2}>
              <Button
                label={actionLabel(action('cert.export'))}
                icon="download"
                onClick={() => setConfirm({ kind: 'export', cert: detailCert })}
              />
              <Button
                label={actionLabel(action('cert.delete'))}
                variant="danger-text"
                onClick={() => setConfirm({ kind: 'delete', cert: detailCert })}
              />
            </Row>
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
                  mode: 'middle',
                },
                {
                  key: zh.certs.colIssuer,
                  value:
                    detailCert.issuer === 'acme'
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
                {renewTask ? (
                  <Stack gap={2}>
                    <Banner tone="info" title={zh.certs.taskRunningHint} />
                    {renewTaskQuery.data?.task ? (
                      <TaskView task={renewTaskQuery.data.task} />
                    ) : (
                      <Skeleton height={80} />
                    )}
                    <Row gap={2}>
                      <Button
                        label={zh.common.refresh}
                        size="sm"
                        loading={renewTaskQuery.isFetching}
                        onClick={() => void renewTaskQuery.refetch()}
                      />
                    </Row>
                  </Stack>
                ) : null}
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

function LinkToSettings() {
  const navigate = useNavigate();
  return (
    <Button
      label={zh.certs.manageCredentials}
      size="sm"
      // 直接落到「系统变量」分段，避免跳到证书库自身形成死路。
      onClick={() => void navigate({ href: `${paths.settings}?tab=system` })}
    />
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
