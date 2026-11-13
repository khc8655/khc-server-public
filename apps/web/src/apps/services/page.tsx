/**
 * 对外服务（page-specs §2.2a / 第 4 批）：
 * 只读聚合 + 复用站点/转发抽屉；零新增请求、无轮询、无新 D1 表。
 * 后端识别与状态推导唯一来源：data/services.ts + caddy/siteForm.ts。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { Node } from '@khc/contracts';
import { hubAppsQueryOptions, hubQueryOptions } from '../../data/queries';
import { certificatesQueryOptions } from '../../data/certs';
import { hostFwMessages } from '../../data/apps';
import { parseWireGuardStatus, wireGuardConfigQueryOptions } from '../../data/wireguard';
import {
  PORT_FORWARD_APP,
  emptyForwardConfig,
  findForwardStatus,
  forwardApiError,
  forwardConfigQueryOptions,
  forwardEnvelopeError,
  normalizeForwardStatus,
  removeForward,
  runForwardAction,
  saveForwardConfig,
  upsertForward,
  type ForwardConfig,
  type ForwardRule,
  type ForwardStatus,
} from '../../data/forwards';
import {
  CADDY_SITE_APP,
  caddyConfigQueryOptions,
  emptyCaddyConfig,
  envelopeErrorText,
  healthForSite,
  parseCaddyStatus,
  removeSite,
  runCaddyAction,
  saveCaddyConfig,
  upsertSite,
  type CaddyConfig,
  type CaddySite,
  type CaddyStatus,
} from '../../data/sites';
import {
  classifyBackend,
  listeningUpstream,
  unpublishedListeningPorts,
  type BackendContext,
  type BackendInfo,
  type ListeningPort,
} from '../../data/services';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  InlineError,
  PageHeader,
  Row,
  Stack,
  Table,
  useToast,
  type ColumnDef,
  type Tone,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { SiteDrawer } from '../caddy/SiteDrawer';
import {
  buildSite,
  createForm,
  editForm,
  siteBackendText,
  siteSignature,
  validateSite,
  type SiteErrors,
  type SiteFormState,
} from '../caddy/siteForm';
import {
  ForwardDrawer,
  buildForward,
  createForwardForm,
  editForwardForm,
  validateForward,
  type ForwardErrors,
  type ForwardFormState,
} from '../wireguard/forwardDrawer';

interface ServiceStatus {
  tone: Tone;
  label: string;
}

interface SiteRowView {
  site: CaddySite;
}

interface ForwardRowView {
  forward: ForwardRule;
}

const applyNowLabel = '生效';

function addressOfSite(site: CaddySite): string {
  const domain = site.domains[0] ?? '';
  if (!domain) return '—';
  return site.listenPort === 443 ? domain : `${domain}:${site.listenPort}`;
}

function hubHost(hub: Node | undefined): string {
  if (hub?.domain) return hub.domain;
  const endpoint = hub?.endpoint ?? '';
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint.replace(/^https?:\/\//, '').split(':')[0] ?? '';
  }
}

function forwardName(forward: ForwardRule): string {
  return forward.note.trim() || forward.name;
}

function forwardCommand(forward: ForwardRule, host: string): string {
  if (forward.targetPort === 22) return `ssh -p ${forward.listenPort} ${host}`;
  return `${host}:${forward.listenPort}`;
}

function siteBackend(site: CaddySite, ctx: BackendContext): BackendInfo {
  const upstreams = site.upstreams.length > 0 ? site.upstreams : site.upstream ? [site.upstream] : [];
  return classifyBackend(upstreams[0] ?? '', ctx, Math.max(0, upstreams.length - 1));
}

function targetBackend(forward: ForwardRule, ctx: BackendContext): BackendInfo {
  return classifyBackend(`${forward.targetHost}:${forward.targetPort}`, ctx);
}

function targetText(forward: ForwardRule, ctx: BackendContext): string {
  const info = targetBackend(forward, ctx);
  switch (info.kind) {
    case 'local':
      return `${zh.sites.backendLocal} ${info.target}`;
    case 'vm': {
      const peer =
        info.peerOnline === true
          ? zh.sites.backendPeerOnline
          : info.peerOnline === false
            ? zh.sites.backendPeerOffline
            : zh.sites.backendPeerUnknown;
      return `${zh.sites.backendVm} ${info.peerName ?? ''} ${info.target} · ${peer}`.replace(/\s+/g, ' ');
    }
    case 'internal':
      return `${zh.sites.backendInternal} ${info.target}`;
    default:
      return `${zh.sites.backendExternal} ${info.target}`;
  }
}

function siteStatus(
  site: CaddySite,
  ctx: BackendContext,
  params: {
    unapplied: boolean;
    stateRead: boolean;
    caddy: CaddyStatus | null;
  },
): ServiceStatus {
  if (!site.enabled) return { tone: 'neutral', label: zh.services.statusDisabled };
  if (params.unapplied) return { tone: 'warn', label: zh.services.statusUnapplied };
  if (!params.stateRead) return { tone: 'neutral', label: zh.services.statusUnread };
  if (params.caddy?.installed === false) return { tone: 'neutral', label: zh.services.statusNotInstalled };
  const backend = siteBackend(site, ctx);
  if (backend.kind === 'vm' && backend.peerOnline === false) {
    return { tone: 'danger', label: zh.services.statusBackendDown };
  }
  const health = healthForSite(params.caddy, site);
  if (health?.state === 'down') return { tone: 'danger', label: zh.services.statusSiteDown };
  if (health?.state === 'warn') return { tone: 'warn', label: zh.services.statusWarn };
  if (health?.latencyMs !== null && health?.latencyMs !== undefined) {
    return { tone: 'ok', label: fmt(zh.services.statusNormalLatency, { ms: health.latencyMs }) };
  }
  return { tone: 'ok', label: zh.services.statusNormal };
}

function forwardStatusView(
  forward: ForwardRule,
  ctx: BackendContext,
  status: ForwardStatus | null,
  params: { unapplied: boolean; stateRead: boolean },
): ServiceStatus {
  if (!forward.enabled) return { tone: 'neutral', label: zh.services.statusDisabled };
  if (params.unapplied) return { tone: 'warn', label: zh.services.statusUnapplied };
  if (!params.stateRead) return { tone: 'neutral', label: zh.services.statusUnread };
  if (status?.installed === false) return { tone: 'neutral', label: zh.services.statusNotInstalled };
  const target = targetBackend(forward, ctx);
  if (target.kind === 'vm' && target.peerOnline === false) {
    return { tone: 'danger', label: zh.services.statusTargetDown };
  }
  const rule = findForwardStatus(status, forward);
  if (rule?.error) return { tone: 'danger', label: zh.services.statusForwardDown };
  if (rule?.active !== true) return { tone: 'danger', label: zh.services.statusForwardDown };
  return { tone: 'ok', label: zh.services.statusConnectable };
}

export default function HubServicesPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId/services' });
  const queryClient = useQueryClient();
  const toast = useToast();

  const hubQuery = useQuery(hubQueryOptions(hubId));
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const caddyQuery = useQuery(caddyConfigQueryOptions(hubId));
  const forwardConfigured = appsQuery.data?.apps.some((item) => item.app === PORT_FORWARD_APP);
  const forwardQuery = useQuery({
    ...forwardConfigQueryOptions(hubId),
    enabled: appsQuery.isError ? true : Boolean(forwardConfigured),
  });
  const { channels, stateQuery } = useHubChannelsContext();
  const liveState = stateQuery.data?.state as
    | { adapters?: { name: string; status?: Record<string, unknown> }[] }
    | undefined;
  const stateRead = liveState !== undefined && liveState !== null;
  const caddyStatus = liveState ? parseCaddyStatus(liveState.adapters ?? []) : null;
  const forwardStatus = liveState ? normalizeForwardStatus(liveState.adapters ?? []) : null;
  const wgRuntime = parseWireGuardStatus(liveState?.adapters);
  const backendContext: BackendContext = {
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

  const hubName = hubQuery.data?.name ?? hubId;
  const host = hubHost(hubQuery.data);
  const nodeOffline = channels.presence === 'offline';
  const writeDisabledReason = nodeOffline ? zh.sites.offlineWriteReason : undefined;

  const configState = caddyQuery.data;
  const config = configState?.config ?? emptyCaddyConfig();
  const sitesUnapplied =
    configState !== undefined && configState.rev !== null && configState.appliedRev !== configState.rev;
  const forwardState = forwardQuery.data;
  const forwardConfig = forwardState?.config ?? emptyForwardConfig();
  const forwardsUnapplied =
    forwardState !== undefined && forwardState.rev !== null && forwardState.appliedRev !== forwardState.rev;

  const siteRows: SiteRowView[] = config.sites
    .filter((site) => site.kind === 'proxy')
    .map((site) => ({ site }));
  const forwardRows: ForwardRowView[] = forwardConfig.forwards.map((forward) => ({ forward }));
  const otherSiteCount = config.sites.filter((site) => site.kind !== 'proxy').length;
  const listeningPorts = unpublishedListeningPorts(
    stateQuery.data?.state?.ops,
    config.sites,
    forwardConfig.forwards,
  );
  const listeningLoading = stateQuery.isLoading || caddyQuery.isLoading;
  const listeningError = stateQuery.isError;

  const loading =
    caddyQuery.isLoading || (forwardConfigured !== false && !appsQuery.isLoading && forwardQuery.isLoading);

  /* ------------------------------------------------------------ 站点抽屉 */
  const [siteForm, setSiteForm] = useState<SiteFormState | null>(null);
  const [siteErrors, setSiteErrors] = useState<SiteErrors>({});
  const [siteSaveError, setSiteSaveError] = useState<string | null>(null);
  const [siteSaving, setSiteSaving] = useState(false);
  const [pendingSiteApply, setPendingSiteApply] = useState<{
    config: CaddyConfig;
    form: SiteFormState;
  } | null>(null);
  const [confirmDeleteSite, setConfirmDeleteSite] = useState<CaddySite | null>(null);
  const [pendingApply, setPendingApply] = useState<'site' | 'forward' | null>(null);

  const certsQuery = useQuery({ ...certificatesQueryOptions(), enabled: Boolean(siteForm) });

  const invalidateApps = async (app: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', app] }),
    ]);
  };

  const applyCaddyNow = async () => {
    const envelope = await runCaddyAction(hubId, 'apply');
    if (!envelope.ok) {
      throw new Error(envelopeErrorText(envelope) ?? zh.sites.applyFailed);
    }
    await invalidateApps(CADDY_SITE_APP);
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await invalidateApps(CADDY_SITE_APP);
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
    }
  };

  const hashPassword = async (password: string): Promise<string> => {
    const envelope = await runCaddyAction(hubId, 'hash_password', { password });
    if (!envelope.ok) {
      throw new Error(envelopeErrorText(envelope) ?? zh.sites.passwordHashFailed);
    }
    const result = (envelope.result ?? {}) as Record<string, unknown>;
    const hash = typeof result.hash === 'string' ? result.hash : '';
    if (!hash) throw new Error(zh.sites.passwordHashFailed);
    return hash;
  };

  const openSiteCreate = (upstreams?: string) => {
    const form = createForm();
    if (upstreams) {
      form.upstreams = upstreams;
      form.initial = siteSignature(form);
    }
    setSiteForm(form);
    setSiteErrors({});
    setSiteSaveError(null);
  };

  const openSiteEdit = (site: CaddySite) => {
    setSiteForm(editForm(site));
    setSiteErrors({});
    setSiteSaveError(null);
  };

  const saveSite = async (apply: boolean) => {
    if (!siteForm) return;
    const nextErrors = validateSite(siteForm, {
      sites: config.sites,
      certIds: certs.map((cert) => cert.id),
      certsLoaded: certsQuery.isSuccess,
    });
    setSiteErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSiteSaving(true);
    setSiteSaveError(null);
    try {
      const site = await buildSite(siteForm, {
        offlineReason: writeDisabledReason,
        hashPassword,
      });
      const nextConfig = upsertSite(config, site, siteForm.originalName);
      if (apply) {
        setPendingSiteApply({ config: nextConfig, form: siteForm });
        setSiteForm(null);
        setSiteSaving(false);
        return;
      }
      await saveCaddyConfig(hubId, nextConfig);
      await invalidateApps(CADDY_SITE_APP);
      toast.show({ message: zh.sites.savedToast });
      setSiteForm(null);
    } catch (error) {
      setSiteSaveError(error instanceof Error && error.message ? error.message : zh.sites.createFailed);
    } finally {
      setSiteSaving(false);
    }
  };

  const deleteSiteFromDrawer = async () => {
    if (!siteForm?.originalName) throw new Error(zh.sites.deleteInlineFailed);
    const site = config.sites.find((item) => item.name === siteForm.originalName);
    if (!site) throw new Error(zh.sites.deleteInlineFailed);
    await saveCaddyConfig(hubId, removeSite(config, site.name));
    await applyCaddyNow();
    toast.show({ message: fmt(zh.sites.deletedToast, { name: site.name }) });
    setSiteForm(null);
  };

  const deleteSite = async (site: CaddySite) => {
    await saveCaddyConfig(hubId, removeSite(config, site.name));
    await applyCaddyNow();
    setConfirmDeleteSite(null);
    toast.show({ message: fmt(zh.sites.deletedToast, { name: site.name }) });
  };

  /* ------------------------------------------------------------ 转发抽屉 */
  const [forwardForm, setForwardForm] = useState<ForwardFormState | null>(null);
  const [forwardErrors, setForwardErrors] = useState<ForwardErrors>({});
  const [forwardSaveError, setForwardSaveError] = useState<string | null>(null);
  const [forwardSaving, setForwardSaving] = useState(false);
  const [confirmDeleteForward, setConfirmDeleteForward] = useState<ForwardRule | null>(null);
  const wgQuery = useQuery({
    ...wireGuardConfigQueryOptions(hubId),
    enabled: Boolean(siteForm) || Boolean(forwardForm),
  });
  const certs = certsQuery.data ?? [];
  const peerTargets = (wgQuery.data?.config.peers ?? [])
    .map((peer) => ({
      name: peer.name,
      host: (peer.allowedIps[0] ?? '').split('/')[0] ?? '',
    }))
    .filter((peer) => peer.host);

  const applyForward = async (nextConfig?: ForwardConfig) => {
    if (nextConfig) {
      await saveForwardConfig(hubId, nextConfig);
      await invalidateApps(PORT_FORWARD_APP);
    }
    const plan = await runForwardAction(hubId, 'plan');
    const planError = forwardEnvelopeError(plan, zh.forwards.applyFailed);
    if (planError) throw new Error(planError.message);
    const applyResult = await runForwardAction(hubId, 'apply');
    const applyError = forwardEnvelopeError(applyResult, zh.forwards.applyFailed);
    if (applyError) throw new Error(applyError.message);
    hostFwMessages(applyResult).forEach((message) => toast.show({ message }));
    await invalidateApps(PORT_FORWARD_APP);
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
  };

  const applyForwardNow = async () => {
    try {
      await applyForward();
      toast.show({ message: zh.forwards.appliedToast });
    } catch (error) {
      toast.show({ message: forwardApiError(error, zh.forwards.applyFailed).message });
    }
  };

  const openForwardCreate = () => {
    setForwardForm(createForwardForm());
    setForwardErrors({});
    setForwardSaveError(null);
  };

  const openForwardEdit = (forward: ForwardRule) => {
    setForwardForm(editForwardForm(forward));
    setForwardErrors({});
    setForwardSaveError(null);
  };

  const saveForward = async (apply: boolean) => {
    if (!forwardForm) return;
    const nextErrors = validateForward(forwardForm, forwardConfig);
    setForwardErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setForwardSaving(true);
    setForwardSaveError(null);
    try {
      const forward = buildForward(forwardForm);
      const nextConfig = upsertForward(forwardConfig, forward, forwardForm.originalName);
      await saveForwardConfig(hubId, nextConfig);
      await invalidateApps(PORT_FORWARD_APP);
      if (apply) {
        setForwardForm(null);
        setPendingApply('forward');
      } else {
        toast.show({ message: zh.forwards.savedToast });
        setForwardForm(null);
      }
    } catch (error) {
      setForwardSaveError(forwardApiError(error, zh.forwards.createFailed).message);
    } finally {
      setForwardSaving(false);
    }
  };

  const deleteForward = async (forward: ForwardRule) => {
    await applyForward(removeForward(forwardConfig, forward.name));
    setConfirmDeleteForward(null);
    toast.show({ message: fmt(zh.forwards.deletedToast, { name: forward.name }) });
  };

  /* -------------------------------------------------------------- 行操作 */
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.show({ message: zh.services.copied }),
      () => undefined,
    );
  };

  const siteColumns: ColumnDef<SiteRowView>[] = [
    {
      key: 'service',
      type: 'name',
      header: zh.services.colService,
      width: '18%',
      value: (row) => row.site.name,
      dot: (row) =>
        siteStatus(row.site, backendContext, {
          unapplied: sitesUnapplied,
          stateRead,
          caddy: caddyStatus,
        }).tone,
      narrow: (row) => siteBackendText(row.site, backendContext),
    },
    {
      key: 'address',
      type: 'mono',
      header: zh.services.colAddress,
      width: '18%',
      value: (row) => addressOfSite(row.site),
    },
    {
      key: 'backend',
      type: 'mono',
      header: zh.services.colBackend,
      value: (row) => siteBackendText(row.site, backendContext),
      width: '28%',
      priority: 'low',
    },
    {
      key: 'status',
      type: 'status',
      header: zh.services.colStatus,
      width: '14%',
      status: (row) =>
        siteStatus(row.site, backendContext, {
          unapplied: sitesUnapplied,
          stateRead,
          caddy: caddyStatus,
        }),
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Row gap={2}>
            <Badge
              tone={
                siteStatus(row.site, backendContext, {
                  unapplied: sitesUnapplied,
                  stateRead,
                  caddy: caddyStatus,
                }).tone
              }
              label={
                siteStatus(row.site, backendContext, {
                  unapplied: sitesUnapplied,
                  stateRead,
                  caddy: caddyStatus,
                }).label
              }
            />
            {sitesUnapplied ? (
              <Button
                label={applyNowLabel}
                size="sm"
                disabled={nodeOffline}
                disabledReason={writeDisabledReason}
                onClick={() => setPendingApply('site')}
              />
            ) : null}
          </Row>
        </span>
      ),
    },
    {
      key: 'cert',
      type: 'text',
      header: zh.services.colCertAccess,
      value: (row) => certAccessText(row.site),
      width: '10%',
      priority: 'low',
    },
    { key: 'actions', type: 'actions', header: '', width: '56px' },
  ];

  const forwardColumns: ColumnDef<ForwardRowView>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.services.colService,
      width: '22%',
      value: (row) => forwardName(row.forward),
      dot: (row) =>
        forwardStatusView(row.forward, backendContext, forwardStatus, {
          unapplied: forwardsUnapplied,
          stateRead,
        }).tone,
      narrow: (row) => targetText(row.forward, backendContext),
    },
    {
      key: 'address',
      type: 'mono',
      header: zh.services.colAddress,
      width: '20%',
      value: (row) => `${host}:${row.forward.listenPort}`,
    },
    {
      key: 'target',
      type: 'mono',
      header: zh.services.colTarget,
      value: (row) => targetText(row.forward, backendContext),
      width: '24%',
      priority: 'low',
    },
    {
      key: 'status',
      type: 'status',
      header: zh.services.colStatus,
      width: '12%',
      status: (row) =>
        forwardStatusView(row.forward, backendContext, forwardStatus, {
          unapplied: forwardsUnapplied,
          stateRead,
        }),
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Row gap={2}>
            <Badge
              tone={
                forwardStatusView(row.forward, backendContext, forwardStatus, {
                  unapplied: forwardsUnapplied,
                  stateRead,
                }).tone
              }
              label={
                forwardStatusView(row.forward, backendContext, forwardStatus, {
                  unapplied: forwardsUnapplied,
                  stateRead,
                }).label
              }
            />
            {forwardsUnapplied ? (
              <Button
                label={applyNowLabel}
                size="sm"
                disabled={nodeOffline}
                disabledReason={writeDisabledReason}
                onClick={() => setPendingApply('forward')}
              />
            ) : null}
          </Row>
        </span>
      ),
    },
    {
      key: 'protocol',
      type: 'text',
      header: zh.services.colProtocol,
      value: (row) => (row.forward.protocol === 'udp' ? zh.forwards.protocolUdp : zh.forwards.protocolTcp),
      width: '10%',
      priority: 'low',
    },
    { key: 'actions', type: 'actions', header: '', width: '56px' },
  ];

  const listeningColumns: ColumnDef<ListeningPort>[] = [
    {
      key: 'port',
      type: 'name',
      header: zh.services.listeningColPort,
      width: '28%',
      value: (row) => (row.process ? `${row.port} · ${row.process}` : String(row.port)),
    },
    {
      key: 'address',
      type: 'mono',
      header: zh.services.listeningColAddress,
      width: '40%',
      value: (row) => row.address,
    },
    {
      key: 'proto',
      type: 'text',
      header: zh.services.listeningColProto,
      width: '18%',
      value: (row) => row.proto,
    },
  ];

  const siteActions = (): ActionRef[] => [
    action('site.update'),
    action('site.copyAddress'),
    action('site.delete'),
  ];

  const forwardActions = (): ActionRef[] => [
    action('forward.update'),
    action('forward.copyCommand'),
    action('forward.delete'),
  ];

  const handleSiteAction = (ref: ActionRef, row: SiteRowView) => {
    if (ref.id === 'site.update') openSiteEdit(row.site);
    else if (ref.id === 'site.copyAddress') copy(`https://${addressOfSite(row.site)}`);
    else if (ref.id === 'site.delete') setConfirmDeleteSite(row.site);
  };

  const handleForwardAction = (ref: ActionRef, row: ForwardRowView) => {
    if (ref.id === 'forward.update') openForwardEdit(row.forward);
    else if (ref.id === 'forward.copyCommand') copy(forwardCommand(row.forward, host));
    else if (ref.id === 'forward.delete') setConfirmDeleteForward(row.forward);
  };

  const actionsDisabledReason = (ref: ActionRef): string | undefined => {
    if (!nodeOffline) return undefined;
    if (ref.id === 'site.delete' || ref.id === 'forward.delete') return writeDisabledReason;
    return undefined;
  };

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.services.title}
        scope={hubName}
        actions={
          <Row gap={2}>
            <Button label={zh.services.createForward} onClick={openForwardCreate} />
            <Button
              label={zh.services.createSite}
              variant="primary"
              icon="plus"
              onClick={() => openSiteCreate()}
            />
          </Row>
        }
      />

      {caddyQuery.error ? (
        <Banner
          tone="danger"
          title={zh.sites.loadError}
          description={(caddyQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void caddyQuery.refetch()} />
          }
        />
      ) : null}

      {forwardQuery.error ? (
        <Banner
          tone="danger"
          title={zh.forwards.loadError}
          description={(forwardQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void forwardQuery.refetch()} />
          }
        />
      ) : null}

      {nodeOffline || stateQuery.isError ? (
        <div className="ui-field-help">{zh.services.offlineNote}</div>
      ) : null}

      {siteRows.length > 0 ? (
        <Card title={zh.services.webTitle}>
          <Table
            rows={loading ? undefined : siteRows}
            columns={siteColumns}
            rowKey={(row) => row.site.name}
            objectLabel={zh.services.webTitle}
            empty={{ icon: 'globe', title: zh.services.emptyTitle }}
            rowActions={siteActions}
            rowActionDisabled={actionsDisabledReason}
            onRowAction={handleSiteAction}
            onRowOpen={(row) => openSiteEdit(row.site)}
          />
        </Card>
      ) : null}

      {forwardRows.length > 0 ? (
        <Card title={zh.services.remoteTitle}>
          <Table
            rows={loading ? undefined : forwardRows}
            columns={forwardColumns}
            rowKey={(row) => row.forward.name}
            objectLabel={zh.services.remoteTitle}
            empty={{ icon: 'arrow', title: zh.services.emptyTitle }}
            rowActions={forwardActions}
            rowActionDisabled={actionsDisabledReason}
            onRowAction={handleForwardAction}
            onRowOpen={(row) => openForwardEdit(row.forward)}
          />
        </Card>
      ) : null}

      {!loading && siteRows.length === 0 && forwardRows.length === 0 ? (
        <EmptyState
          icon="activity"
          title={zh.services.emptyTitle}
          description={zh.services.emptyHint}
          action={
            <Row gap={2}>
              <Button label={zh.services.createForward} onClick={openForwardCreate} />
              <Button
                label={zh.services.createSite}
                variant="primary"
                icon="plus"
                onClick={() => openSiteCreate()}
              />
            </Row>
          }
        />
      ) : null}

      {otherSiteCount > 0 ? (
        <span className="ui-field-help">
          {fmt(zh.services.otherSites, { count: otherSiteCount })}
        </span>
      ) : null}

      <Card title={zh.services.listeningTitle}>
        {listeningError ? (
          <Row gap={2}>
            <InlineError message={zh.services.listeningLoadError} />
            <Button label={zh.common.retry} size="sm" onClick={() => void stateQuery.refetch()} />
          </Row>
        ) : !listeningLoading && !stateRead ? (
          <div className="ui-field-help">{zh.services.listeningUnread}</div>
        ) : (
          <Stack gap={2}>
            {!listeningLoading && listeningPorts.length > 0 ? (
              <span className="ui-field-help">{zh.services.listeningHint}</span>
            ) : null}
            <Table
              rows={listeningLoading ? undefined : listeningPorts}
              columns={listeningColumns}
              rowKey={(row) => String(row.port)}
              objectLabel={zh.services.listeningTitle}
              empty={{
                icon: 'activity',
                title: zh.services.listeningEmpty,
                description: zh.services.listeningHint,
              }}
              onRowOpen={(row) => openSiteCreate(listeningUpstream(row))}
            />
          </Stack>
        )}
      </Card>

      {siteForm ? (
        <SiteDrawer
          form={siteForm}
          errors={siteErrors}
          saveError={siteSaveError}
          saving={siteSaving}
          hubName={hubName}
          offlineReason={writeDisabledReason}
          certificates={certs}
          peers={peerTargets}
          existingDomains={config.sites.flatMap((site) => site.domains)}
          onChange={(patch) => setSiteForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onClose={() => setSiteForm(null)}
          onSave={(apply) => void saveSite(apply)}
          onDelete={deleteSiteFromDrawer}
        />
      ) : null}

      {forwardForm ? (
        <ForwardDrawer
          form={forwardForm}
          errors={forwardErrors}
          saveError={forwardSaveError ? { message: forwardSaveError, details: null } : null}
          saving={forwardSaving}
          hubName={hubName}
          offlineReason={writeDisabledReason}
          peers={peerTargets}
          onChange={(patch) => setForwardForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onClose={() => setForwardForm(null)}
          onSave={(apply) => void saveForward(apply)}
        />
      ) : null}

      {pendingSiteApply ? (
        <ConfirmAction
          open
          action={action('app.apply')}
          title={zh.sites.applyConfirmTitle}
          body={zh.sites.applyConfirmBody}
          confirmLabel={actionLabel(action('app.apply'))}
          onCancel={() => {
            const state = pendingSiteApply;
            setPendingSiteApply(null);
            setSiteForm(state.form);
          }}
          onConfirm={async () => {
            try {
              await saveCaddyConfig(hubId, pendingSiteApply.config);
              await applyCaddyNow();
              setPendingSiteApply(null);
              toast.show({ message: zh.sites.appliedToast });
            } catch (error) {
              setPendingSiteApply(null);
              toast.show({ message: error instanceof Error ? error.message : zh.sites.applyFailed });
            }
          }}
        />
      ) : null}

      {pendingApply ? (
        <ConfirmAction
          open
          action={action('app.apply')}
          title={pendingApply === 'site' ? zh.sites.applyConfirmTitle : zh.forwards.applyConfirmTitle}
          body={pendingApply === 'site' ? zh.sites.applyConfirmBody : zh.forwards.applyConfirmBody}
          confirmLabel={actionLabel(action('app.apply'))}
          onCancel={() => setPendingApply(null)}
          onConfirm={async () => {
            const kind = pendingApply;
            setPendingApply(null);
            if (kind === 'site') await applyCaddyNow();
            else await applyForwardNow();
          }}
        />
      ) : null}

      {confirmDeleteSite ? (
        <ConfirmAction
          open
          action={action('site.delete')}
          title={fmt(zh.sites.deleteTitle, { name: confirmDeleteSite.domain })}
          body={zh.sites.deleteBody}
          confirmLabel={zh.sites.deleteConfirm}
          targetName={confirmDeleteSite.name}
          onCancel={() => setConfirmDeleteSite(null)}
          onConfirm={() => deleteSite(confirmDeleteSite)}
        />
      ) : null}

      {confirmDeleteForward ? (
        <ConfirmAction
          open
          action={action('forward.delete')}
          title={fmt(zh.forwards.deleteTitle, { name: confirmDeleteForward.name })}
          body={zh.forwards.deleteBody}
          confirmLabel={zh.forwards.deleteConfirm}
          targetName={confirmDeleteForward.name}
          onCancel={() => setConfirmDeleteForward(null)}
          onConfirm={() => deleteForward(confirmDeleteForward)}
        />
      ) : null}
    </Stack>
  );
}

function certAccessText(site: CaddySite): string {
  const cert =
    site.tls.mode === 'manual'
      ? fmt(zh.services.certLibrary, { name: site.tls.cert?.$cert ?? '' })
      : site.tls.mode === 'off'
        ? zh.services.certOff
        : zh.services.certAutoPublic;
  return `${cert}${site.basicauth ? ` · ${zh.services.basicAuth}` : ''}`;
}
