import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentState, TaskResponse } from '@khc/contracts';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ApiError } from '../../data/client';
import { fetchAppConfig, fetchTask, hostFwMessages } from '../../data/apps';
import {
  CADDY_SITE_APP,
  envelopeErrorText,
  findSitesImpactedByPeer,
  normalizeCaddyConfig,
  runCaddyAction,
  saveCaddyConfig,
  syncSitesToPeer,
  type CaddyConfig,
  type PeerSiteImpact,
} from '../../data/sites';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { hubAppsQueryOptions, hubQueryOptions, hubsQueryOptions } from '../../data/queries';
import {
  WIREGUARD_APP,
  clientConfigText,
  clientPrivateKey,
  isValidCidr,
  migrationPeer,
  nextPeerAddress,
  normalizeWgConfig,
  removePeer,
  runWireGuardAction,
  saveWireGuardConfig,
  parseWireGuardStatus,
  setPeerEnabled,
  splitAllowedIps,
  upsertPeer,
  wireGuardConfigQueryOptions,
  type WgConfig,
  type WgInterface,
  type WgPeer,
  type WgPeerRuntime,
  type WgRotation,
} from '../../data/wireguard';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { AdvancedSection, ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  Tabs,
  Drawer,
  Field,
  KeyValue,
  NumberInput,
  PageHeader,
  Row,
  SecretField,
  Select,
  Skeleton,
  Stack,
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
import { formatAbsoluteTime, formatRelativeTime, shortFingerprint } from '../../i18n/format';
import { PeerOpsPanel } from '../host-ops/PeerOpsPanel';
import { ForwardsCard } from './ForwardsCard';
import { nodeModeQueryOptions } from '../../data/mode';

const EMPTY_CONFIG = normalizeWgConfig(null);
const PEER_NAME_RE = /^[A-Za-z0-9_.@-]{1,32}$/;

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const IFACE_NAME_RE = /^[A-Za-z0-9_=+.-]{1,15}$/;
const IFACE_ADDRESS_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const EXT_IFACE_RE = /^[A-Za-z0-9_.:-]{1,32}$/;
const ENDPOINT_RE = /^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9_.-]+):\d{1,5}$/;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function primaryPeerIp(peer: { allowedIps: string[] }): string {
  return (peer.allowedIps[0] ?? '').split('/')[0] ?? '';
}

interface PeerSiteSyncPrompt {
  nextConfig: WgConfig;
  peer: WgPeer;
  existing: WgPeer;
  form: PeerFormState;
  isCreate: boolean;
  apply: boolean;
  caddyConfig: CaddyConfig;
  impacts: PeerSiteImpact[];
}

type PeerField = 'name' | 'allowedIps' | 'keepalive' | 'publicKey';
type PeerErrors = Partial<Record<PeerField, string>>;

interface PeerFormState {
  mode: 'create' | 'edit';
  originalName?: string;
  name: string;
  allowedIps: string;
  keepalive: number | null;
  publicKey: string;
  enabled: boolean;
  initial: string;
}

type IfaceField = 'name' | 'address' | 'listenPort' | 'mtu' | 'extIface' | 'publicEndpoint';
type IfaceErrors = Partial<Record<IfaceField, string>>;

interface IfaceFormState {
  name: string;
  address: string;
  listenPort: number | null;
  mtu: number | null;
  extIface: string;
  publicEndpoint: string;
  initial: string;
}

interface PeerRow {
  peer: WgPeer;
  runtime: WgPeerRuntime | null;
  rotation: WgRotation | null;
}

interface ExportState {
  peer: WgPeer;
  loading: boolean;
  text: string;
  error: string | null;
  tab: 'conf' | 'script' | 'uninstall';
  script: string;
  scriptError: string | null;
  uninstall: string;
  uninstallError: string | null;
  /** B-1：暂存态（有未应用的改动）——Peer 尚未下发到节点，导出走引导而不是报"peer 不存在" */
  staged: boolean;
}

interface RotationState {
  peerName: string;
  text: string;
  privateKey: string;
  rotation: WgRotation;
  error: string | null;
  saving: boolean;
  busy: boolean;
}

type ConfirmTarget = { kind: 'delete'; peer: WgPeer } | { kind: 'rotate'; peer: WgPeer };

type ApplyConfirm =
  | { kind: 'interface'; config: WgConfig; form: IfaceFormState }
  | { kind: 'page' };

function peerSignature(form: PeerFormState): string {
  return JSON.stringify([form.name, form.allowedIps, form.keepalive, form.publicKey, form.enabled]);
}

function createPeerForm(config: WgConfig): PeerFormState {
  const form: PeerFormState = {
    mode: 'create',
    name: '',
    allowedIps: nextPeerAddress(config),
    keepalive: 25,
    publicKey: '',
    enabled: true,
    initial: '',
  };
  return { ...form, initial: peerSignature(form) };
}

function editPeerForm(peer: WgPeer): PeerFormState {
  const form: PeerFormState = {
    mode: 'edit',
    originalName: peer.name,
    name: peer.name,
    allowedIps: peer.allowedIps.join(', '),
    keepalive: peer.keepalive,
    publicKey: peer.publicKey,
    enabled: peer.enabled,
    initial: '',
  };
  return { ...form, initial: peerSignature(form) };
}

function interfaceForm(config: WgConfig): IfaceFormState {
  const form: IfaceFormState = {
    name: config.interface.name,
    address: config.interface.address,
    listenPort: config.interface.listenPort,
    mtu: config.interface.mtu,
    extIface: config.interface.extIface,
    publicEndpoint: config.interface.publicEndpoint,
    initial: '',
  };
  return { ...form, initial: JSON.stringify([form.name, form.address, form.listenPort, form.mtu, form.extIface, form.publicEndpoint]) };
}

function interfaceSignature(form: IfaceFormState): string {
  return JSON.stringify([form.name, form.address, form.listenPort, form.mtu, form.extIface, form.publicEndpoint]);
}

function derivePeerFromForm(form: PeerFormState, existing: WgPeer | undefined): WgPeer {
  const publicKey = form.publicKey.trim();
  const privateKey = publicKey === (existing?.publicKey ?? '') ? (existing?.privateKey ?? '') : '';
  return {
    name: form.name.trim(),
    publicKey,
    privateKey,
    allowedIps: splitAllowedIps(form.allowedIps),
    keepalive: form.keepalive ?? 25,
    endpoint: existing?.endpoint ?? null,
    enabled: form.enabled,
  };
}

function peerBadge(row: PeerRow, unapplied: boolean): { tone: Tone; label: string } {
  if (row.rotation?.state === 'cutover') {
    const grace = (row.rotation.graceUntil ?? 0) * 1000 > Date.now();
    return {
      tone: 'warn',
      label: grace ? zh.wireguard.rotateBadgeGrace : zh.wireguard.rotateBadgeCutover,
    };
  }
  if (row.rotation?.state === 'pending') return { tone: 'info', label: zh.wireguard.rotateBadgePending };
  if (!row.peer.enabled) return { tone: 'neutral', label: zh.wireguard.statusDisabled };
  if (!row.runtime) {
    return { tone: 'neutral', label: unapplied ? zh.wireguard.statusPendingApply : zh.wireguard.statusUnknown };
  }
  return row.runtime.online
    ? { tone: 'ok', label: zh.wireguard.statusOnline }
    : { tone: 'neutral', label: zh.wireguard.statusOffline };
}

function peerTone(row: PeerRow): Tone {
  if (row.rotation?.state === 'cutover') return 'warn';
  if (row.rotation?.state === 'pending') return 'info';
  if (!row.peer.enabled) return 'neutral';
  return row.runtime?.online ? 'ok' : 'neutral';
}

export default function WireGuardPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId/wireguard' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { drawer?: string };

  const hubQuery = useQuery(hubQueryOptions(hubId));
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const configQuery = useQuery(wireGuardConfigQueryOptions(hubId));
  const modeQuery = useQuery(nodeModeQueryOptions(hubId));
  const { channels, stateQuery } = useHubChannelsContext();
  const caddyMode = modeQuery.data?.mode === 'caddy';

  const configState = configQuery.data;
  const config = configState?.config ?? EMPTY_CONFIG;
  // 适配器运行态来自打开页面时的 /state 一次性探测（不随 10s 快照轮询）。
  const liveState = stateQuery.data?.state as AgentState | undefined;
  const runtime = liveState
    ? { reachable: true, error: null, status: parseWireGuardStatus(liveState.adapters ?? []) }
    : null;
  const status = runtime?.status ?? null;
  const hubName = hubQuery.data?.name ?? hubId;
  // 以控制面探测结果为准：节点列表状态可能是旧缓存，不能单独判定离线。
  const nodeOffline = channels.presence === 'offline';
  const unreachable = nodeOffline || !channels.canApply;
  const writeDisabledReason = unreachable
    ? nodeOffline
      ? zh.wireguard.offlineWriteReason
      : zh.channels.unknownWriteReason
    : undefined;
  const adapterMissing = Boolean(
    appsQuery.data && !appsQuery.data.adapters.some((adapter) => adapter.name === WIREGUARD_APP),
  );
  // 能力驱动：仅新 Agent 声明 pkgInstall 时展示「安装 wireguard-tools」。
  const canPkgInstall = Boolean(
    (appsQuery.data?.adapters.find((adapter) => adapter.name === WIREGUARD_APP)?.capabilities as
      | Record<string, boolean>
      | undefined)?.pkgInstall,
  );
  const unapplied =
    configState !== undefined &&
    configState.rev !== null &&
    configState.appliedRev !== configState.rev;

  const rotations = status?.rotations ?? [];
  const rows: PeerRow[] = useMemo(
    () =>
      config.peers.map((peer) => {
        const rotation = rotations.find((item) => item.peer === peer.name) ?? null;
        const runtime =
          status?.peers.find(
            (item) =>
              item.name === peer.name &&
              (!peer.publicKey ||
                item.publicKey === peer.publicKey ||
                item.publicKey === rotation?.oldPublicKey),
          ) ?? null;
        return { peer, runtime, rotation };
      }),
    [config.peers, rotations, status],
  );

  const [searchText, setSearchText] = useState('');
  const [peerForm, setPeerForm] = useState<PeerFormState | null>(null);
  const [peerErrors, setPeerErrors] = useState<PeerErrors>({});
  const [peerError, setPeerError] = useState<string | null>(null);
  const [peerSaving, setPeerSaving] = useState(false);
  const [peerSiteSync, setPeerSiteSync] = useState<PeerSiteSyncPrompt | null>(null);
  const [syncSitesChecked, setSyncSitesChecked] = useState(true);
  const [ifaceForm, setIfaceForm] = useState<IfaceFormState | null>(null);
  const [ifaceErrors, setIfaceErrors] = useState<IfaceErrors>({});
  const [ifaceError, setIfaceError] = useState<string | null>(null);
  const [ifaceSaving, setIfaceSaving] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [rotationState, setRotationState] = useState<RotationState | null>(null);
  const [migrationSource, setMigrationSource] = useState<WgPeer | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [applyConfirm, setApplyConfirm] = useState<ApplyConfirm | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // P1：wireguard-tools 未安装时的一键安装（能力驱动）。
  const [installConfirm, setInstallConfirm] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [installTask, setInstallTask] = useState<TaskResponse | null>(null);

  const liveRotation = rotationState
    ? (rotations.find((item) => item.peer === rotationState.peerName) ?? rotationState.rotation)
    : null;

  useEffect(() => {
    if (!caddyMode) return;
    setPeerForm(null);
    setIfaceForm(null);
    setExportState(null);
    setRotationState(null);
    setMigrationSource(null);
    setConfirmTarget(null);
    setApplyConfirm(null);
    setDrawerSearch(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caddyMode]);

  const invalidateConfig = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', WIREGUARD_APP] }),
    ]);
  };

  const invalidateState = async () => {
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
  };

  const applyNow = async () => {
    const envelope = await runWireGuardAction(hubId, 'apply');
    if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.applyFailed);
    // 回显主机 iptables 自动放行结果（“已自动放行 …”，批次 S）。
    hostFwMessages(envelope).forEach((message) => toast.show({ message }));
    await Promise.all([invalidateConfig(), invalidateState()]);
    // apply 结果写回 D1 可能短暂滞后；后台再补两次拉取，避免页面停在「有未应用的改动」。
    // 不阻塞当前动作（删除/保存的成功提示要立即出现）。
    void (async () => {
      for (let i = 0; i < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await Promise.all([invalidateConfig(), invalidateState()]);
      }
    })();
  };

  const submitInstall = async () => {
    setInstallConfirm(false);
    setInstallBusy(true);
    try {
      const envelope = await runWireGuardAction(hubId, 'install');
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.installFailed);
      if (envelope.taskId) {
        const task = await fetchTask(hubId, envelope.taskId);
        setInstallTask(task);
      } else {
        await Promise.all([invalidateConfig(), invalidateState()]);
      }
      toast.show({ message: zh.wireguard.installSubmitted });
    } catch (error) {
      toast.show({ message: errorMessage(error, zh.wireguard.installFailed) });
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
        await Promise.all([invalidateConfig(), invalidateState()]);
      }
    } catch (error) {
      toast.show({ message: errorMessage(error, zh.wireguard.installFailed) });
    } finally {
      setInstallBusy(false);
    }
  };

  const setDrawerSearch = (drawer?: string, replace = true) => {
    void navigate({
      to: '/hubs/$hubId/wireguard',
      params: { hubId },
      search: { drawer },
      replace,
    });
  };

  const openPeerCreate = () => {
    if (caddyMode) return;
    setExportState(null);
    setPeerForm(createPeerForm(config));
    setPeerErrors({});
    setPeerError(null);
    setDrawerSearch('new', false);
  };

  const openPeerEdit = (peer: WgPeer) => {
    if (caddyMode) return;
    setExportState(null);
    setPeerForm(editPeerForm(peer));
    setPeerErrors({});
    setPeerError(null);
    setDrawerSearch(`peer:${encodeURIComponent(peer.name)}`, false);
  };

  const closePeerDrawer = () => {
    setPeerForm(null);
    setPeerError(null);
    setDrawerSearch(undefined);
  };

  const openInterface = () => {
    if (caddyMode) return;
    setPeerForm(null);
    setExportState(null);
    setIfaceForm(interfaceForm(config));
    setIfaceErrors({});
    setIfaceError(null);
  };

  // 无损换钥入口在 Peer 抽屉「高级」区（ui-redesign §2.4）：先回列表再全局 L2 确认
  const requestRotate = (peer: WgPeer) => {
    if (caddyMode) return;
    closePeerDrawer();
    setConfirmTarget({ kind: 'rotate', peer });
  };

  // 跨节点迁移同样从抽屉「高级」区进入：关闭 Peer 抽屉，改开唯一迁移抽屉。
  const requestMigrate = (peer: WgPeer) => {
    if (caddyMode) return;
    closePeerDrawer();
    setMigrationSource(peer);
  };

  // 抽屉状态写入查询串（变更单 §2：?drawer=new / ?drawer=peer:<name>）
  useEffect(() => {
    if (caddyMode) {
      setPeerForm(null);
      return;
    }
    const drawer = search.drawer;
    if (!drawer) {
      setPeerForm(null);
      return;
    }
    if (drawer === 'new') {
      if (peerForm) return;
      const form = createPeerForm(configState?.config ?? EMPTY_CONFIG);
      setPeerForm(form);
      return;
    }
    if (drawer.startsWith('peer:')) {
      let name = '';
      try {
        name = decodeURIComponent(drawer.slice(5));
      } catch {
        name = drawer.slice(5);
      }
      if (peerForm?.mode === 'edit' && peerForm.originalName === name) return;
      const peer = (configState?.config ?? EMPTY_CONFIG).peers.find((item) => item.name === name);
      if (peer) setPeerForm(editPeerForm(peer));
    }
    // 仅在抽屉参数或配置加载状态变化时同步；表单编辑不触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.drawer, configQuery.isSuccess, caddyMode]);

  async function savePeer(apply: boolean) {
    if (!peerForm) return;
    const errors: PeerErrors = {};
    const name = peerForm.name.trim();
    if (!PEER_NAME_RE.test(name)) errors.name = zh.wireguard.invalidName;
    else if (
      config.peers.some((peer) => peer.name === name && peer.name !== peerForm.originalName)
    ) {
      errors.name = zh.wireguard.duplicateName;
    }
    const allowedIps = splitAllowedIps(peerForm.allowedIps);
    if (allowedIps.length === 0 || allowedIps.some((item) => !isValidCidr(item))) {
      errors.allowedIps = zh.wireguard.invalidAddress;
    }
    if (
      peerForm.keepalive === null ||
      !Number.isInteger(peerForm.keepalive) ||
      peerForm.keepalive < 0 ||
      peerForm.keepalive > 65535
    ) {
      errors.keepalive = zh.wireguard.invalidKeepalive;
    }
    const publicKey = peerForm.publicKey.trim();
    if (publicKey && !KEY_RE.test(publicKey)) errors.publicKey = zh.wireguard.invalidPublicKey;
    setPeerErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const existing = config.peers.find((peer) => peer.name === peerForm.originalName);
    const peer = derivePeerFromForm(peerForm, existing);
    const nextConfig = upsertPeer(config, peer, peerForm.originalName);
    const isCreate = peerForm.mode === 'create';

    // D-09：改 Peer 地址前先看有没有站点上游仍指向旧地址；有则先确认再保存。
    if (!isCreate && existing) {
      const oldIp = primaryPeerIp(existing);
      const newIp = primaryPeerIp(peer);
      if (oldIp && newIp && oldIp !== newIp) {
        let caddyConfig: CaddyConfig | null = null;
        try {
          const app = await fetchAppConfig(hubId, CADDY_SITE_APP);
          caddyConfig = normalizeCaddyConfig((app?.config ?? {}) as Record<string, unknown>);
        } catch {
          toast.show({ message: zh.wireguard.syncSitesReadFailed });
        }
        const impacts = caddyConfig ? findSitesImpactedByPeer(caddyConfig, existing) : [];
        if (caddyConfig && impacts.length > 0) {
          setPeerSiteSync({
            nextConfig,
            peer,
            existing,
            form: { ...peerForm },
            isCreate,
            apply,
            caddyConfig,
            impacts,
          });
          setSyncSitesChecked(true);
          setPeerError(null);
          // 抽屉内不叠 Dialog：先收起抽屉，确认框取消时再恢复。
          setPeerForm(null);
          setDrawerSearch(undefined);
          return;
        }
      }
    }
    await commitPeer({ nextConfig, peer, isCreate, apply });
  }

  async function commitPeer(input: {
    nextConfig: WgConfig;
    peer: WgPeer;
    isCreate: boolean;
    apply: boolean;
    /** 从同步确认框进入时抽屉已收起；保存失败要恢复抽屉才能看到错误。 */
    form?: PeerFormState;
    siteSync?: { caddyConfig: CaddyConfig; existing: WgPeer; newIp: string };
  }) {
    setPeerSaving(true);
    setPeerError(null);
    try {
      await saveWireGuardConfig(hubId, input.nextConfig);
    } catch (error) {
      setPeerError(errorMessage(error, zh.wireguard.saveFailed));
      if (input.form) {
        setPeerForm(input.form);
        setDrawerSearch(
          `peer:${encodeURIComponent(input.form.originalName ?? input.form.name)}`,
        );
      }
      setPeerSaving(false);
      return;
    }
    // 配置已入库：后续是「应用」。失败不能留在抽屉里重试——同名 Peer 已经存在，
    // 「添加」模式的表单再保存会被名称占用拦住（P0：提示重试却无法重试）。
    if (input.siteSync) {
      try {
        const result = syncSitesToPeer(
          input.siteSync.caddyConfig,
          input.siteSync.existing,
          input.siteSync.newIp,
        );
        if (result.updated.length > 0) {
          await saveCaddyConfig(hubId, result.config);
          await queryClient.invalidateQueries({
            queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP],
          });
          if (input.apply) {
            const envelope = await runCaddyAction(hubId, 'apply');
            if (!envelope.ok) {
              throw new Error(envelopeErrorText(envelope) ?? zh.wireguard.applyFailed);
            }
          }
          toast.show({
            message: fmt(zh.wireguard.syncSitesUpdated, { count: result.updated.length }),
          });
        }
        if (result.skipped.length > 0) {
          toast.show({
            message: fmt(zh.wireguard.syncSitesSkipped, { count: result.skipped.length }),
          });
        }
      } catch (error) {
        toast.show({
          message: fmt(zh.wireguard.syncSitesFailed, {
            error: errorMessage(error, zh.wireguard.applyFailed),
          }),
        });
      }
    }
    // 两个写请求（Peer 配置、受影响站点上游）都发出后再统一重拉配置：
    // 之前把它排在站点 PUT 之前，跨区 GET 会让站点写请求推迟数秒。
    await invalidateConfig();
    if (input.apply) {
      try {
        await applyNow();
      } catch (error) {
        closePeerDrawer();
        setPageError(errorMessage(error, zh.wireguard.applyFailed));
        setPeerSaving(false);
        return;
      }
      toast.show({ message: zh.wireguard.appliedToast });
    } else {
      toast.show({ message: zh.wireguard.savedToast });
    }
    setPeerSaving(false);
    closePeerDrawer();
    // 新建成功后在同一抽屉同屏展示 .conf（ui-redesign §2.4）
    if (input.isCreate) await openExport(input.peer);
  }

  async function saveInterface(apply: boolean) {
    if (!ifaceForm) return;
    const errors: IfaceErrors = {};
    const name = ifaceForm.name.trim();
    if (!IFACE_NAME_RE.test(name)) errors.name = zh.wireguard.invalidIfaceName;
    const address = ifaceForm.address.trim();
    if (!IFACE_ADDRESS_RE.test(address)) errors.address = zh.wireguard.invalidIfaceAddress;
    if (
      ifaceForm.listenPort === null ||
      !Number.isInteger(ifaceForm.listenPort) ||
      ifaceForm.listenPort < 1 ||
      ifaceForm.listenPort > 65535
    ) {
      errors.listenPort = zh.wireguard.invalidPort;
    }
    if (
      ifaceForm.mtu === null ||
      !Number.isInteger(ifaceForm.mtu) ||
      ifaceForm.mtu < 576 ||
      ifaceForm.mtu > 9000
    ) {
      errors.mtu = zh.wireguard.invalidMtu;
    }
    const extIface = ifaceForm.extIface.trim();
    if (extIface && !EXT_IFACE_RE.test(extIface)) errors.extIface = zh.wireguard.invalidExtIface;
    const publicEndpoint = ifaceForm.publicEndpoint.trim();
    if (publicEndpoint && !ENDPOINT_RE.test(publicEndpoint)) {
      errors.publicEndpoint = zh.wireguard.invalidEndpoint;
    }
    setIfaceErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const nextInterface: WgInterface = {
      ...config.interface,
      name,
      address,
      listenPort: ifaceForm.listenPort ?? 51820,
      mtu: ifaceForm.mtu ?? 1420,
      extIface,
      publicEndpoint,
    };
    const nextConfig: WgConfig = { ...config, interface: nextInterface };
    if (apply) {
      // 接口级改动会重启服务：ui-guidelines §8.3 保存变更 → 关闭抽屉 → 页面级确认。
      // 暂存表单，取消确认时恢复抽屉与未保存内容。
      setIfaceForm(null);
      setApplyConfirm({ kind: 'interface', config: nextConfig, form: ifaceForm });
      return;
    }
    setIfaceSaving(true);
    setIfaceError(null);
    try {
      await saveWireGuardConfig(hubId, nextConfig);
      await invalidateConfig();
      toast.show({ message: zh.wireguard.savedToast });
      setIfaceForm(null);
    } catch (error) {
      setIfaceError(errorMessage(error, zh.wireguard.saveFailed));
    } finally {
      setIfaceSaving(false);
    }
  }

  const openExport = async (peer: WgPeer) => {
    // 导出配置在 Peer 抽屉内同屏展示（ui-redesign §2.4：新建保存成功后不再回列表另找导出）
    setPeerForm(null);
    // B-1：暂存态（rev ≠ appliedRev）导出不走 Agent——D1 侧无私钥、Agent 侧还没有
    // 这个 Peer，硬调只会报"peer 不存在"；改为明确引导先「应用配置」。
    // 注意保存后本函数闭包里的 unapplied 是保存前渲染的旧值（新建后必为 true 的场景
    // 会被误判为 false），这里从 queryClient 读最新配置态。
    const fresh = queryClient.getQueryData(wireGuardConfigQueryOptions(hubId).queryKey) as
      | { rev: number | null; appliedRev: number | null }
      | undefined;
    const stagedNow =
      fresh == null ? unapplied : fresh.rev !== null && fresh.appliedRev !== fresh.rev;
    if (stagedNow) {
      setExportState({
        peer,
        loading: false,
        text: '',
        error: null,
        tab: 'conf',
        script: '',
        scriptError: null,
        uninstall: '',
        uninstallError: null,
        staged: true,
      });
      return;
    }
    setExportState({
      peer,
      loading: true,
      text: '',
      error: null,
      tab: 'conf',
      script: '',
      scriptError: null,
      uninstall: '',
      uninstallError: null,
      staged: false,
    });
    // 兜底转译：已应用态下 Peer 若被并发删除/未 apply，Agent 会报
    // "peer 不存在 / 尚未 apply"——转成可操作引导，不允许原始文案直出。
    const translateExportError = (message: string) =>
      message.includes('peer 不存在') || message.includes('尚未 apply')
        ? zh.wireguard.exportStagedDesc
        : message;
    // 一键安装/卸载脚本独立加载：失败不影响 .conf 展示（如设备自持私钥的 peer 无脚本可用）
    void runWireGuardAction(hubId, 'peer_install_script', { peer: peer.name })
      .then((scriptEnvelope) => {
        setExportState((prev) =>
          prev
            ? {
                ...prev,
                script: scriptEnvelope.ok ? clientConfigText(scriptEnvelope) : '',
                scriptError: scriptEnvelope.ok
                  ? null
                  : translateExportError(scriptEnvelope.error?.message ?? ''),
              }
            : prev,
        );
      })
      .catch((error: unknown) => {
        setExportState((prev) =>
          prev
            ? {
                ...prev,
                script: '',
                scriptError: translateExportError(errorMessage(error, zh.wireguard.scriptUnavailable)),
              }
            : prev,
        );
      });
    void runWireGuardAction(hubId, 'peer_uninstall_script', { peer: peer.name })
      .then((uninstallEnvelope) => {
        setExportState((prev) =>
          prev
            ? {
                ...prev,
                uninstall: uninstallEnvelope.ok ? clientConfigText(uninstallEnvelope) : '',
                uninstallError: uninstallEnvelope.ok
                  ? null
                  : translateExportError(uninstallEnvelope.error?.message ?? ''),
              }
            : prev,
        );
      })
      .catch((error: unknown) => {
        setExportState((prev) =>
          prev
            ? {
                ...prev,
                uninstall: '',
                uninstallError: translateExportError(
                  errorMessage(error, zh.wireguard.uninstallUnavailable),
                ),
              }
            : prev,
        );
      });
    try {
      const envelope = await runWireGuardAction(hubId, 'client_config', { peer: peer.name });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.exportFailed);
      const text = clientConfigText(envelope);
      if (!text) throw new Error(zh.wireguard.exportNeedApply);
      setExportState((prev) => (prev ? { ...prev, loading: false, text } : prev));
    } catch (error) {
      setExportState((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: translateExportError(errorMessage(error, zh.wireguard.exportFailed)),
            }
          : prev,
      );
    }
  };

  const writeBackRotation = async (
    peerName: string,
    rotation: WgRotation,
    privateKey: string,
  ) => {
    const base = configQuery.data?.config ?? EMPTY_CONFIG;
    const peer = base.peers.find((item) => item.name === peerName);
    if (!peer) return;
    const nextConfig = upsertPeer(base, {
      ...peer,
      publicKey: rotation.newPublicKey,
      privateKey,
    });
    await saveWireGuardConfig(hubId, nextConfig);
    await invalidateConfig();
  };

  const startRotation = async (peer: WgPeer) => {
    setBusy(`rotate:${peer.name}`);
    setPageError(null);
    try {
      const envelope = await runWireGuardAction(hubId, 'rotate_peer', { peer: peer.name });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.rotateFailed);
      const rotation = envelope.rotation;
      const text = clientConfigText(envelope);
      const privateKey = clientPrivateKey(envelope);
      if (!rotation || !text) throw new Error(zh.wireguard.rotateFailed);
      setConfirmTarget(null);
      setRotationState({
        peerName: peer.name,
        text,
        privateKey,
        rotation,
        error: null,
        saving: true,
        busy: false,
      });
      try {
        await writeBackRotation(peer.name, rotation, privateKey);
        setRotationState((prev) => (prev ? { ...prev, saving: false } : prev));
        toast.show({ message: zh.wireguard.rotationConfigSaved });
      } catch (error) {
        setRotationState((prev) =>
          prev
            ? { ...prev, saving: false, error: errorMessage(error, zh.wireguard.rotationConfigSaveFailed) }
            : prev,
        );
      }
    } catch (error) {
      setConfirmTarget(null);
      setPageError(errorMessage(error, zh.wireguard.rotateFailed));
    } finally {
      setBusy(null);
    }
  };

  const retryRotationSave = async () => {
    if (!rotationState) return;
    setRotationState((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      await writeBackRotation(rotationState.peerName, rotationState.rotation, rotationState.privateKey);
      setRotationState((prev) => (prev ? { ...prev, saving: false } : prev));
      toast.show({ message: zh.wireguard.rotationConfigSaved });
    } catch (error) {
      setRotationState((prev) =>
        prev
          ? { ...prev, saving: false, error: errorMessage(error, zh.wireguard.rotationConfigSaveFailed) }
          : prev,
      );
    }
  };

  const ensureRotationSaved = async (peerName: string, rotation: WgRotation) => {
    let loaded = configQuery.data?.config;
    if (!loaded) {
      const result = await configQuery.refetch();
      loaded = result.data?.config;
    }
    const base = loaded ?? EMPTY_CONFIG;
    const peer = base.peers.find((item) => item.name === peerName);
    if (peer?.publicKey === rotation.newPublicKey) return;
    if (
      rotationState &&
      rotationState.rotation.newPublicKey === rotation.newPublicKey &&
      rotationState.privateKey
    ) {
      await writeBackRotation(peerName, rotation, rotationState.privateKey);
      return;
    }
    throw new Error(zh.wireguard.rotationNeedSave);
  };

  const confirmRotation = async (peerName: string) => {
    setRotationState((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    setBusy(`confirm:${peerName}`);
    setPageError(null);
    try {
      const rotation = rotations.find((item) => item.peer === peerName) ?? rotationState?.rotation;
      if (!rotation) throw new Error(zh.wireguard.confirmFailed);
      await ensureRotationSaved(peerName, rotation);
      const envelope = await runWireGuardAction(hubId, 'confirm_rotation', { peer: peerName });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.confirmFailed);
      setRotationState(null);
      await invalidateState();
      await invalidateConfig();
      try {
        await applyNow();
        toast.show({ message: zh.wireguard.rotateConfirmedToast });
      } catch (error) {
        setPageError(errorMessage(error, zh.wireguard.applyFailed));
      }
    } catch (error) {
      setPageError(errorMessage(error, zh.wireguard.confirmFailed));
      setRotationState((prev) => (prev ? { ...prev, busy: false } : prev));
    } finally {
      setBusy(null);
    }
  };

  const cancelRotation = async (peerName: string) => {
    setRotationState((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    setBusy(`cancel:${peerName}`);
    setPageError(null);
    try {
      const envelope = await runWireGuardAction(hubId, 'cancel_rotation', { peer: peerName });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.cancelFailed);
      const oldRotation =
        rotations.find((item) => item.peer === peerName) ?? rotationState?.rotation ?? null;
      // 回滚 D1：仅当 D1 仍是新钥对（rotate 时的立即写回）时才需要恢复旧钥；
      // 旧私钥来自取消响应（Agent 在轮换记录中留存），设备自持私钥时为空。
      const oldPublicKey = oldRotation?.oldPublicKey ?? '';
      const oldPrivateKey = envelope.client?.privateKey ?? '';
      try {
        const base = configQuery.data?.config ?? EMPTY_CONFIG;
        const peer = base.peers.find((item) => item.name === peerName);
        if (peer && oldPublicKey && oldRotation && peer.publicKey === oldRotation.newPublicKey) {
          const nextConfig = upsertPeer(base, {
            ...peer,
            publicKey: oldPublicKey,
            privateKey: oldPrivateKey,
          });
          await saveWireGuardConfig(hubId, nextConfig);
          await invalidateConfig();
        }
      } catch {
        /* D1 回滚失败不阻断取消；下一次保存/应用会重新对齐 */
      }
      setRotationState(null);
      await invalidateState();
      toast.show({ message: zh.wireguard.rotateCanceledToast });
    } catch (error) {
      setPageError(errorMessage(error, zh.wireguard.cancelFailed));
      setRotationState((prev) => (prev ? { ...prev, busy: false } : prev));
    } finally {
      setBusy(null);
    }
  };

  const togglePeer = async (row: PeerRow) => {
    if (unreachable) return;
    setBusy(`toggle:${row.peer.name}`);
    setPageError(null);
    try {
      const nextConfig = setPeerEnabled(config, row.peer.name, !row.peer.enabled);
      await saveWireGuardConfig(hubId, nextConfig);
      await invalidateConfig();
      await applyNow();
      toast.show({
        message: fmt(row.peer.enabled ? zh.wireguard.disabledToast : zh.wireguard.enabledToast, {
          name: row.peer.name,
        }),
      });
    } catch (error) {
      setPageError(errorMessage(error, zh.wireguard.saveFailed));
    } finally {
      setBusy(null);
    }
  };

  const deletePeer = async (peer: WgPeer) => {
    setBusy(`delete:${peer.name}`);
    setPageError(null);
    try {
      await saveWireGuardConfig(hubId, removePeer(config, peer.name));
      await invalidateConfig();
      await applyNow();
      setConfirmTarget(null);
      toast.show({ message: fmt(zh.wireguard.deletedToast, { name: peer.name }) });
    } catch (error) {
      throw new Error(errorMessage(error, zh.wireguard.saveFailed));
    } finally {
      setBusy(null);
    }
  };

  const handleRowAction = (ref: ActionRef, row: PeerRow) => {
    if (ref.id === 'peer.update') {
      openPeerEdit(row.peer);
      return;
    }
    if (ref.id === 'peer.publishSite') {
      const peerIp = (row.peer.allowedIps[0] ?? '').split('/')[0] ?? '';
      void navigate({
        to: '/hubs/$hubId/sites',
        params: { hubId },
        search: {
          drawer: 'site:new',
          upstream: peerIp ? `${peerIp}:80` : undefined,
          peer: row.peer.name,
        },
      });
      return;
    }
    if (ref.id === 'peer.exportConfig') {
      void openExport(row.peer);
      return;
    }
    if (ref.id === 'peer.disable' || ref.id === 'peer.enable') {
      void togglePeer(row);
      return;
    }
    if (ref.id === 'peer.delete') {
      setConfirmTarget({ kind: 'delete', peer: row.peer });
    }
  };

  const handlePageAction = (ref: ActionRef) => {
    if (caddyMode) return;
    if (!channels.canApply) {
      toast.show({ message: zh.channels.controlUnavailableDesc });
      return;
    }
    if (ref.id === 'peer.create') {
      openPeerCreate();
      return;
    }
    if (ref.id === 'wg.interface.update') {
      openInterface();
      return;
    }
    if (ref.id === 'wg.apply') {
      setApplyConfirm({ kind: 'page' });
    }
  };

  const columns: ColumnDef<PeerRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.wireguard.colName,
      value: (row) => row.peer.name,
      dot: (row) => peerTone(row),
    },
    {
      key: 'address',
      type: 'mono',
      header: zh.wireguard.colAddress,
      value: (row) => row.peer.allowedIps.join(', ') || '—',
    },
    {
      key: 'status',
      type: 'status',
      header: zh.wireguard.colStatus,
      status: (row) => peerBadge(row, unapplied),
    },
    {
      key: 'handshake',
      type: 'time',
      header: zh.wireguard.colHandshake,
      value: (row) => (row.runtime?.latestHandshake ? row.runtime.latestHandshake : 0),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const rowActions = (row: PeerRow): ActionRef[] => {
    const items: ActionRef[] = [
      action('peer.update'),
      action('peer.publishSite'),
      action('peer.exportConfig'),
    ];
    items.push(row.peer.enabled ? action('peer.disable') : action('peer.enable'));
    items.push(action('peer.delete'));
    return items;
  };

  const rowActionDisabled = (ref: ActionRef): string | undefined => {
    if (caddyMode) return zh.mode.wireguardReadOnly;
    const nodeWrite =
      ref.id === 'peer.exportConfig' ||
      ref.id === 'peer.disable' ||
      ref.id === 'peer.enable' ||
      ref.id === 'peer.delete';
    if (unreachable && nodeWrite) return writeDisabledReason;
    return undefined;
  };

  const sync: SyncStatusProps = unreachable
    ? { state: 'queued', label: zh.status.queued, offlineHint: zh.wireguard.offlineDesc }
    : unapplied
      ? { state: 'pending', rev: configState?.rev ?? undefined, label: zh.wireguard.unapplied }
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
  if (caddyMode) {
    banners.push({
      key: 'caddy-mode',
      tone: 'neutral',
      title: zh.mode.wireguardDisabledTitle,
      description: zh.mode.wireguardDisabledDesc,
      priority: -1,
    });
  }
  if (pageError) {
    banners.push({
      key: 'page-error',
      tone: 'danger',
      title: zh.wireguard.actionFailed,
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
      title: zh.wireguard.offlineTitle,
      description: runtime?.error ?? zh.wireguard.offlineDesc,
      priority: 1,
    });
  }
  for (const rotation of rotations) {
    if (rotation.state === 'finalized') continue; // 等待下一次 apply 自动清理，无需提示
    if (rotation.state === 'expired') {
      // 超时已自动取消（R2）：Agent 侧新 peer 已删，D1 仍是新公钥，需要一键恢复旧钥。
      banners.push({
        key: `rotation-expired:${rotation.peer}`,
        tone: 'warn',
        title: zh.wireguard.rotationExpiredTitle,
        description: `${rotation.peer}：${zh.wireguard.rotationExpiredDesc}`,
        action: (
          <Button
            label={zh.wireguard.rotationRestoreKey}
            size="sm"
            disabled={unreachable}
            disabledReason={writeDisabledReason}
            onClick={() => void cancelRotation(rotation.peer)}
          />
        ),
        priority: 2,
      });
      continue;
    }
    banners.push({
      key: `rotation:${rotation.peer}`,
      tone: rotation.state === 'cutover' ? 'warn' : 'info',
      title: fmt(
        rotation.state === 'cutover'
          ? zh.wireguard.rotationCutoverTitle
          : zh.wireguard.rotationPendingTitle,
        {},
      ),
      description:
        rotation.state === 'cutover'
          ? fmt(zh.wireguard.rotationCutoverDesc, {
              time: formatAbsoluteTime(rotation.graceUntil),
            })
          : `${rotation.peer}：${zh.wireguard.rotationPendingDesc}`,
      action: (
        <Row gap={2}>
          <Button
            label={actionLabel(action('peer.cancelRotation'))}
            size="sm"
            onClick={() => void cancelRotation(rotation.peer)}
          />
          <Button
            label={actionLabel(action('peer.confirmRotation'))}
            variant="primary"
            size="sm"
            disabled={rotation.state !== 'cutover' || unreachable}
            disabledReason={
              unreachable ? writeDisabledReason : zh.wireguard.confirmDisabledPending
            }
            onClick={() => void confirmRotation(rotation.peer)}
          />
        </Row>
      ),
      priority: rotation.state === 'cutover' ? 2 : 3,
    });
  }
  if (adapterMissing || appsQuery.error) {
    banners.push({
      key: 'adapter',
      tone: 'warn',
      title: zh.wireguard.adapterMissing,
      description:
        appsQuery.error instanceof Error
          ? appsQuery.error.message
          : zh.wireguard.adapterMissingDesc,
      priority: 4,
    });
  }
  const wireguardMissing = Boolean(status && !status.installed);
  if (!configState?.exists || wireguardMissing) {
    banners.push({
      key: wireguardMissing ? 'not-installed' : 'not-configured',
      // 未安装 = 中性事实（按需安装，不是告警）；只有未配置才是信息提示。
      tone: wireguardMissing ? 'neutral' : 'info',
      title: wireguardMissing ? zh.wireguard.notInstalledTitle : zh.wireguard.notConfiguredTitle,
      description: installTask
        ? fmt(zh.wireguard.installTaskState, {
            id: installTask.task.id,
            state: installTask.task.state,
            progress: String(installTask.task.progress),
          })
        : wireguardMissing
          ? zh.wireguard.notInstalledDesc
          : status?.running
            ? zh.wireguard.notConfiguredRunningDesc
            : zh.wireguard.notConfiguredDesc,
      action:
        canPkgInstall && wireguardMissing ? (
          installTask ? (
            <Button
              label={zh.wireguard.installRefresh}
              size="sm"
              loading={installBusy}
              onClick={() => void refreshInstall()}
            />
          ) : (
            <Button
              label={zh.wireguard.installAction}
              size="sm"
              loading={installBusy}
              disabled={unreachable || caddyMode}
              disabledReason={caddyMode ? zh.mode.wireguardReadOnly : writeDisabledReason}
              onClick={() => setInstallConfirm(true)}
            />
          )
        ) : undefined,
      priority: 5,
    });
  }
  if (unapplied) {
    banners.push({
      key: 'unapplied',
      tone: 'info',
      title: zh.wireguard.unapplied,
      description: zh.wireguard.unappliedDesc,
      action: (
        <Button
          label={actionLabel(action('wg.apply'))}
          size="sm"
          loading={busy === 'wg.apply'}
          disabled={unreachable || caddyMode}
          disabledReason={caddyMode ? zh.mode.wireguardReadOnly : writeDisabledReason}
          onClick={() => handlePageAction(action('wg.apply'))}
        />
      ),
      priority: 6,
    });
  }
  if (!config.interface.publicEndpoint.trim()) {
    banners.push({
      key: 'endpoint',
      tone: 'warn',
      title: zh.wireguard.publicEndpointMissing,
      description: zh.wireguard.publicEndpointMissingDesc,
      priority: 7,
    });
  }
  const visibleBanners = banners.sort((a, b) => a.priority - b.priority).slice(0, 2);

  const drawerPeer =
    peerForm?.mode === 'edit' && peerForm.originalName
      ? (config.peers.find((peer) => peer.name === peerForm.originalName) ?? null)
      : null;

  // 端口转发卡：目标来源下拉用（与原 /forwards 页同源逻辑）
  const peerTargets = config.peers
    .map((peer) => ({ name: peer.name, host: (peer.allowedIps[0] ?? '').split('/')[0] ?? '' }))
    .filter((peer) => peer.host);
  const peerDrawerActive = Boolean(peerForm || exportState || ifaceForm);

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.wireguard}
        scope={hubName}
        summary={fmt(zh.wireguard.summaryPeers, { count: config.peers.length })}
        sync={sync}
        primaryAction={caddyMode ? undefined : action('peer.create')}
        secondaryActions={caddyMode ? undefined : [action('wg.interface.update')]}
        actionsDisabled={!channels.canApply}
        actionsDisabledReason={zh.channels.controlUnavailableDesc}
        onAction={handlePageAction}
      />

      {configQuery.error ? (
        <Banner
          tone="danger"
          title={fmt(zh.errors.loadTitle, { page: zh.nav.wireguard })}
          description={(configQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void configQuery.refetch()} />
          }
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

      <Table
        rows={configQuery.isLoading ? undefined : rows}
        columns={columns}
        rowKey={(row) => row.peer.name}
        objectLabel={zh.nav.wireguard}
        search={{
          value: searchText,
          onChange: setSearchText,
          placeholder: zh.wireguard.searchPlaceholder,
        }}
        empty={{
          icon: 'users',
          title: zh.wireguard.emptyTitle,
          description: zh.wireguard.emptyHint,
          action: (
            <Button
              label={actionLabel(action('peer.create'))}
              variant="primary"
              icon="plus"
              onClick={openPeerCreate}
            />
          ),
        }}
        rowActions={rowActions}
        rowActionDisabled={rowActionDisabled}
        onRowAction={handleRowAction}
        onRowOpen={caddyMode ? undefined : (row) => openPeerEdit(row.peer)}
      />

      <ForwardsCard
        hubId={hubId}
        hubName={hubName}
        peers={peerTargets}
        peerDrawerActive={peerDrawerActive}
        onOpen={() => {
          setPeerForm(null);
          setExportState(null);
          setDrawerSearch(undefined);
        }}
      />

      {peerForm ? (
        <PeerDrawer
          form={peerForm}
          errors={peerErrors}
          error={peerError}
          saving={peerSaving}
          offlineReason={writeDisabledReason}
          hubName={hubName}
          hubId={hubId}
          peer={drawerPeer}
          rotationActive={Boolean(
            drawerPeer &&
              rotations.some(
                (item) =>
                  item.peer === drawerPeer.name &&
                  (item.state === 'pending' || item.state === 'cutover'),
              ),
          )}
          onChange={(next) => setPeerForm({ ...peerForm, ...next })}
          onClose={closePeerDrawer}
          onSave={(apply) => void savePeer(apply)}
          onRotate={requestRotate}
          onMigrate={requestMigrate}
        />
      ) : null}

      {migrationSource ? (
        <MigrationDrawer
          peer={migrationSource}
          sourceHubId={hubId}
          sourceHubName={hubName}
          onClose={() => setMigrationSource(null)}
          onDone={invalidateConfig}
        />
      ) : null}

      {ifaceForm ? (
        <InterfaceDrawer
          form={ifaceForm}
          errors={ifaceErrors}
          error={ifaceError}
          saving={ifaceSaving}
          offlineReason={writeDisabledReason}
          hubName={hubName}
          publicKey={config.interface.publicKey}
          onChange={(next) => setIfaceForm({ ...ifaceForm, ...next })}
          onClose={() => setIfaceForm(null)}
          onSave={(apply) => void saveInterface(apply)}
        />
      ) : null}

      {exportState && !peerForm ? (
        <ExportDrawer
          state={exportState}
          canApply={channels.canApply}
          onClose={() => setExportState(null)}
          onRetry={() => void openExport(exportState.peer)}
          onTabChange={(tab) =>
            setExportState((prev) => (prev && prev.tab !== tab ? { ...prev, tab } : prev))
          }
          onGoApply={() => {
            // B-1：引导直达「应用配置」确认（复用页头同一动作，不新增第二种入口）
            setExportState(null);
            setApplyConfirm({ kind: 'page' });
          }}
        />
      ) : null}

      {rotationState && liveRotation ? (
        <RotationDrawer
          state={rotationState}
          rotation={liveRotation}
          offlineReason={writeDisabledReason}
          onClose={() => setRotationState(null)}
          onRetrySave={() => void retryRotationSave()}
          onConfirm={() => void confirmRotation(rotationState.peerName)}
          onCancel={() => void cancelRotation(rotationState.peerName)}
        />
      ) : null}

      {installConfirm ? (
        <ConfirmAction
          open
          action={action('app.install')}
          title={zh.wireguard.installTitle}
          body={zh.wireguard.installBody}
          confirmLabel={zh.wireguard.installConfirm}
          onCancel={() => setInstallConfirm(false)}
          onConfirm={submitInstall}
        />
      ) : null}

      {applyConfirm ? (
        <ConfirmAction
          open
          action={action('wg.apply')}
          title={zh.wireguard.applyConfirmTitle}
          body={
            applyConfirm.kind === 'interface'
              ? zh.wireguard.applyConfirmBody
              : zh.wireguard.unappliedDesc
          }
          confirmLabel={actionLabel(action('wg.apply'))}
          onCancel={() => {
            const state = applyConfirm;
            setApplyConfirm(null);
            // 恢复抽屉与未保存内容：用户只是取消了「应用」。
            if (state.kind === 'interface') setIfaceForm(state.form);
          }}
          onConfirm={async () => {
            if (applyConfirm.kind === 'interface') {
              await saveWireGuardConfig(hubId, applyConfirm.config);
              await invalidateConfig();
            }
            await applyNow();
            toast.show({ message: zh.wireguard.appliedToast });
            setApplyConfirm(null);
          }}
        />
      ) : null}

      {peerSiteSync ? (
        <ConfirmAction
          open
          action={action('wg.apply')}
          title={zh.wireguard.syncSitesTitle}
          body={fmt(zh.wireguard.syncSitesDesc, {
            peer: peerSiteSync.existing.name,
            oldIp: primaryPeerIp(peerSiteSync.existing),
            newIp: primaryPeerIp(peerSiteSync.peer),
          })}
          confirmLabel={zh.wireguard.syncSitesConfirm}
          onCancel={() => {
            const prompt = peerSiteSync;
            setPeerSiteSync(null);
            if (prompt) {
              setPeerForm(prompt.form);
              setDrawerSearch(`peer:${encodeURIComponent(prompt.existing.name)}`);
            }
          }}
          onConfirm={async () => {
            const prompt = peerSiteSync;
            if (!prompt) return;
            setPeerSiteSync(null);
            await commitPeer({
              nextConfig: prompt.nextConfig,
              peer: prompt.peer,
              isCreate: prompt.isCreate,
              apply: prompt.apply,
              form: prompt.form,
              siteSync: syncSitesChecked
                ? {
                    caddyConfig: prompt.caddyConfig,
                    existing: prompt.existing,
                    newIp: primaryPeerIp(prompt.peer),
                  }
                : undefined,
            });
          }}
        >
          <Stack gap={2}>
            <Checkbox
              checked={syncSitesChecked}
              onChange={setSyncSitesChecked}
              label={zh.wireguard.syncSitesCheckbox}
            />
            {peerSiteSync.impacts.map((impact) => (
              <div key={impact.site.name} className="ui-muted">
                {impact.site.name}
                {impact.site.domains.length > 0 ? ` · ${impact.site.domains.join(', ')}` : ''}
                {` · ${impact.currentHost}:${impact.currentPort ?? 80}`}
                {!impact.hostMatchesOld
                  ? ` · ${fmt(zh.wireguard.syncSitesHostChanged, {
                      host: impact.currentHost,
                    })}`
                  : ''}
                {impact.portManuallyChanged
                  ? ` · ${fmt(zh.wireguard.syncSitesPortChanged, {
                      port: impact.currentPort ?? 80,
                      sourcePort: impact.site.sourcePort ?? 80,
                    })}`
                  : ''}
                {!impact.site.sourcePeer ? ` · ${zh.wireguard.syncSitesLegacy}` : ''}
              </div>
            ))}
          </Stack>
        </ConfirmAction>
      ) : null}

      {confirmTarget ? (
        <ConfirmAction
          open
          action={action(confirmTarget.kind === 'delete' ? 'peer.delete' : 'peer.rotate')}
          title={
            confirmTarget.kind === 'delete'
              ? fmt(zh.wireguard.deleteTitle, { name: confirmTarget.peer.name })
              : fmt(zh.wireguard.rotateConfirmTitle, { name: confirmTarget.peer.name })
          }
          body={confirmTarget.kind === 'delete' ? zh.wireguard.deleteBody : zh.wireguard.rotateConfirmBody}
          confirmLabel={
            confirmTarget.kind === 'delete'
              ? zh.wireguard.deleteConfirm
              : actionLabel(action('peer.rotate'))
          }
          targetName={confirmTarget.peer.name}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={async () => {
            if (confirmTarget.kind === 'delete') {
              await deletePeer(confirmTarget.peer);
              return;
            }
            await startRotation(confirmTarget.peer);
          }}
        />
      ) : null}
    </Stack>
  );
}

/* -------------------------------------------------------------- PeerDrawer */

function PeerDrawer({
  form,
  errors,
  error,
  saving,
  offlineReason,
  hubName,
  hubId,
  peer,
  rotationActive,
  onChange,
  onClose,
  onSave,
  onRotate,
  onMigrate,
}: {
  form: PeerFormState;
  errors: PeerErrors;
  error: string | null;
  saving: boolean;
  offlineReason?: string;
  hubName: string;
  hubId: string;
  peer: WgPeer | null;
  rotationActive: boolean;
  onChange: (patch: Partial<PeerFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
  onRotate: (peer: WgPeer) => void;
  onMigrate: (peer: WgPeer) => void;
}) {
  const [tab, setTab] = useState<'config' | 'ops'>('config');
  useEffect(() => {
    if (form.mode === 'create' || !peer) setTab('config');
  }, [form.mode, peer]);
  const dirty = peerSignature(form) !== form.initial;
  const showTabs = form.mode === 'edit' && Boolean(peer);
  return (
    <Drawer
      open
      title={form.mode === 'create' ? zh.wireguard.addTitle : zh.wireguard.editTitle}
      context={fmt(zh.wireguard.peerContext, { hub: hubName })}
      dirty={dirty}
      onClose={onClose}
      footer={
        tab === 'config' ? (
          <Row gap={2}>
            <Button label={zh.common.cancel} onClick={onClose} />
            <Button
              label={zh.common.save}
              loading={saving}
              disabled={!dirty || saving}
              disabledReason={zh.common.noChanges}
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
        ) : (
          <Row gap={2}>
            <Button label={zh.common.close} onClick={onClose} />
          </Row>
        )
      }
    >
      <Stack gap={4}>
        {showTabs ? (
          <Tabs
            items={[
              { key: 'config', label: zh.hostOps.tabConfig },
              { key: 'ops', label: zh.hostOps.tab },
            ]}
            active={tab}
            onChange={(key) => setTab(key === 'ops' ? 'ops' : 'config')}
          />
        ) : null}
        {tab === 'ops' && peer ? (
          <PeerOpsPanel hubId={hubId} peer={peer} offlineReason={offlineReason} />
        ) : (
          <>
            <Field id="peer-name" label={zh.wireguard.colName} help={zh.wireguard.nameHelp} error={errors.name}>
              <TextInput
                id="peer-name"
                value={form.name}
                autoComplete="off"
                onChange={(value) => onChange({ name: value })}
              />
            </Field>
            <Field
              id="peer-allowed-ips"
              label={zh.wireguard.allowedIps}
              help={zh.wireguard.allowedIpsHelp}
              error={errors.allowedIps}
            >
              <TextInput
                id="peer-allowed-ips"
                value={form.allowedIps}
                mono
                onChange={(value) => onChange({ allowedIps: value })}
              />
            </Field>
            <Field id="peer-enabled" label={zh.wireguard.enabled} help={zh.wireguard.enabledHelp} variant="row">
              <Toggle
                checked={form.enabled}
                label={zh.wireguard.enabled}
                onChange={(checked) => onChange({ enabled: checked })}
              />
            </Field>
            <AdvancedSection title={zh.common.advancedSection}>
              <Stack gap={4}>
                <Field
                  id="peer-keepalive"
                  label={zh.wireguard.keepalive}
                  help={zh.wireguard.keepaliveHelp}
                  error={errors.keepalive}
                >
                  <NumberInput
                    id="peer-keepalive"
                    value={form.keepalive}
                    min={0}
                    max={65535}
                    suffix={zh.common.seconds}
                    onChange={(value) => onChange({ keepalive: value })}
                  />
                </Field>
                <Field
                  id="peer-public-key"
                  label={zh.wireguard.publicKey}
                  help={zh.wireguard.publicKeyHelp}
                  error={errors.publicKey}
                  optional
                >
                  <TextInput
                    id="peer-public-key"
                    value={form.publicKey}
                    mono
                    onChange={(value) => onChange({ publicKey: value })}
                  />
                </Field>
                {form.mode === 'edit' && peer ? (
                  <>
                    <Button
                      label={actionLabel(action('peer.rotate'))}
                      icon="refresh"
                      disabled={rotationActive || Boolean(offlineReason)}
                      disabledReason={offlineReason ?? zh.wireguard.rotateActiveReason}
                      onClick={() => onRotate(peer)}
                    />
                    <Button
                      label={actionLabel(action('peer.migrate'))}
                      icon="arrow"
                      disabled={rotationActive}
                      disabledReason={zh.wireguard.rotateActiveReason}
                      onClick={() => onMigrate(peer)}
                    />
                  </>
                ) : null}
              </Stack>
            </AdvancedSection>
            <Banner tone="info" title={zh.wireguard.privateKeyNote} />
            {error ? <Banner tone="danger" title={zh.wireguard.saveFailed} description={error} /> : null}
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/* -------------------------------------------------------- MigrationDrawer */

interface MigrationResult {
  nodeName: string;
  peerName: string;
  address: string;
  script: string;
}

function MigrationDrawer({
  peer,
  sourceHubId,
  sourceHubName,
  onClose,
  onDone,
}: {
  peer: WgPeer;
  sourceHubId: string;
  sourceHubName: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const nodesQuery = useQuery(hubsQueryOptions());
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);

  const targetConfigQuery = useQuery(wireGuardConfigQueryOptions(targetId));
  const targetModeQuery = useQuery(nodeModeQueryOptions(targetId));

  const nodes = (nodesQuery.data ?? []).filter((node) => node.id !== sourceHubId);
  const options = nodes.map((node) => ({
    value: node.id,
    label: node.status === 'offline' ? `${node.name}（离线）` : node.name,
    disabled: node.status === 'offline',
  }));
  const targetName = nodes.find((node) => node.id === targetId)?.name ?? targetId;
  const targetState = targetConfigQuery.data;
  const targetMissing = Boolean(targetId) && targetConfigQuery.isSuccess && !targetState?.exists;
  const targetCaddy = targetModeQuery.data?.mode === 'caddy';
  const endpointMissing = Boolean(targetState?.exists) && !targetState?.config.interface.publicEndpoint.trim();
  const planned =
    targetState?.exists && targetState.config ? migrationPeer(targetState.config, peer) : null;
  const reason = !targetId
    ? zh.wireguard.migrateTargetPlaceholder
    : targetMissing
      ? zh.wireguard.migrateTargetConfigMissing
      : targetCaddy
        ? zh.wireguard.migrateTargetCaddy
        : endpointMissing
          ? zh.wireguard.migrateTargetEndpointMissing
          : !targetState || !planned
            ? zh.wireguard.migrateTargetPlaceholder
            : undefined;

  async function run() {
    if (!targetId || !targetState?.exists || !planned) return;
    setBusy(true);
    setError(null);
    try {
      await saveWireGuardConfig(targetId, upsertPeer(targetState.config, planned));
      const applied = await runWireGuardAction(targetId, 'apply');
      if (!applied.ok) throw new Error(applied.error?.message ?? zh.wireguard.applyFailed);
      const envelope = await runWireGuardAction(targetId, 'peer_install_script', {
        peer: planned.name,
      });
      if (!envelope.ok) throw new Error(envelope.error?.message ?? zh.wireguard.scriptUnavailable);
      const script = clientConfigText(envelope);
      if (!script) throw new Error(zh.wireguard.scriptUnavailable);
      setResult({
        nodeName: targetName,
        peerName: planned.name,
        address: planned.allowedIps[0] ?? '',
        script,
      });
      await queryClient.invalidateQueries({ queryKey: ['hubs', targetId] });
      await onDone();
    } catch (err) {
      setError(errorMessage(err, zh.wireguard.migrateFailed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={zh.wireguard.migrateTitle}
      context={fmt(zh.wireguard.migrateContext, { name: peer.name })}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.close} onClick={onClose} />
          {result ? (
            <Button
              label={zh.wireguard.downloadScript}
              icon="download"
              variant="primary"
              onClick={() => downloadTextFile(result.script, `${result.peerName}-install.sh`)}
            />
          ) : (
            <Button
              label={zh.wireguard.migrateStart}
              variant="primary"
              loading={busy}
              disabled={Boolean(reason) || busy}
              disabledReason={reason}
              onClick={() => void run()}
            />
          )}
        </Row>
      }
    >
      <Stack gap={4}>
        <Banner
          tone="info"
          title={zh.wireguard.migrateIntro}
          description={fmt(zh.wireguard.migrateSourceNode, { name: sourceHubName })}
        />
        {result ? (
          <>
            <Banner tone="ok" title={zh.wireguard.migrateDoneTitle} description={zh.wireguard.migrateDoneDesc} />
            <KeyValue
              items={[
                { key: zh.wireguard.migrateTarget, value: result.nodeName },
                { key: zh.wireguard.colName, value: result.peerName, mono: true },
                { key: zh.wireguard.colAddress, value: result.address, mono: true },
              ]}
            />
            <CodeBlock code={result.script} label={`${result.peerName}-install.sh`} />
            <Banner tone="warn" title={zh.wireguard.migrateSourceHint} />
          </>
        ) : (
          <>
            <Field
              id="migrate-target"
              label={zh.wireguard.migrateTarget}
              help={nodesQuery.isSuccess && options.length === 0 ? zh.wireguard.migrateNoTargets : undefined}
            >
              <Select
                id="migrate-target"
                value={targetId}
                options={options}
                placeholder={zh.wireguard.migrateTargetPlaceholder}
                onChange={setTargetId}
              />
            </Field>
            {targetMissing ? (
              <Banner tone="warn" title={zh.wireguard.migrateTargetConfigMissing} />
            ) : null}
            {targetCaddy ? <Banner tone="warn" title={zh.wireguard.migrateTargetCaddy} /> : null}
            {endpointMissing ? (
              <Banner tone="warn" title={zh.wireguard.migrateTargetEndpointMissing} />
            ) : null}
            {targetState?.exists && targetState.appliedRev !== targetState.rev ? (
              <Banner tone="info" title={zh.wireguard.migrateUnappliedHint} />
            ) : null}
            {planned ? (
              <KeyValue
                items={[
                  { key: zh.wireguard.colName, value: planned.name, mono: true },
                  { key: zh.wireguard.colAddress, value: planned.allowedIps[0] ?? '', mono: true },
                ]}
              />
            ) : null}
            {error ? (
              <Banner tone="danger" title={zh.wireguard.migrateFailed} description={error} />
            ) : null}
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/* --------------------------------------------------------- InterfaceDrawer */

function InterfaceDrawer({
  form,
  errors,
  error,
  saving,
  offlineReason,
  hubName,
  publicKey,
  onChange,
  onClose,
  onSave,
}: {
  form: IfaceFormState;
  errors: IfaceErrors;
  error: string | null;
  saving: boolean;
  offlineReason?: string;
  hubName: string;
  publicKey: string;
  onChange: (patch: Partial<IfaceFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
}) {
  const dirty = interfaceSignature(form) !== form.initial;
  return (
    <Drawer
      open
      title={zh.wireguard.interfaceTitle}
      context={fmt(zh.wireguard.interfaceContext, { hub: hubName })}
      dirty={dirty}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.cancel} onClick={onClose} />
          <Button
            label={zh.common.save}
            loading={saving}
            disabled={!dirty || saving}
            disabledReason={zh.common.noChanges}
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
        <Banner tone="warn" title={zh.wireguard.interfaceHint} />
        <Field
          id="iface-name"
          label={zh.wireguard.ifaceName}
          help={zh.wireguard.ifaceNameFixedHelp}
          error={errors.name}
        >
          <TextInput id="iface-name" value={form.name} mono readOnly onChange={() => undefined} />
        </Field>
        <Field
          id="iface-address"
          label={zh.wireguard.address}
          help={zh.wireguard.ifaceAddressHelp}
          error={errors.address}
        >
          <TextInput
            id="iface-address"
            value={form.address}
            mono
            onChange={(value) => onChange({ address: value })}
          />
        </Field>
        <Field id="iface-port" label={zh.wireguard.listenPort} error={errors.listenPort}>
          <NumberInput
            id="iface-port"
            value={form.listenPort}
            min={1}
            max={65535}
            onChange={(value) => onChange({ listenPort: value })}
          />
        </Field>
        <Field id="iface-mtu" label={zh.wireguard.mtu} error={errors.mtu}>
          <NumberInput
            id="iface-mtu"
            value={form.mtu}
            min={576}
            max={9000}
            onChange={(value) => onChange({ mtu: value })}
          />
        </Field>
        <Field id="iface-ext" label={zh.wireguard.extIface} help={zh.wireguard.extIfaceHelp} error={errors.extIface}>
          <TextInput
            id="iface-ext"
            value={form.extIface}
            mono
            onChange={(value) => onChange({ extIface: value })}
          />
        </Field>
        <Field
          id="iface-endpoint"
          label={zh.wireguard.publicEndpoint}
          help={zh.wireguard.publicEndpointHelp}
          error={errors.publicEndpoint}
          optional
        >
          <TextInput
            id="iface-endpoint"
            value={form.publicEndpoint}
            mono
            onChange={(value) => onChange({ publicEndpoint: value })}
          />
        </Field>
        <SecretField
          kind="agent"
          nodeName={hubName}
          publicKey={publicKey || '—'}
        />
        {error ? <Banner tone="danger" title={zh.wireguard.saveFailed} description={error} /> : null}
      </Stack>
    </Drawer>
  );
}

/* ------------------------------------------------------------ ExportDrawer */

function ExportDrawer({
  state,
  canApply,
  onClose,
  onRetry,
  onTabChange,
  onGoApply,
}: {
  state: ExportState;
  canApply: boolean;
  onClose: () => void;
  onRetry: () => void;
  onTabChange: (tab: 'conf' | 'script' | 'uninstall') => void;
  onGoApply: () => void;
}) {
  return (
    <Drawer
      open
      title={zh.wireguard.exportTitle}
      context={fmt(zh.wireguard.exportContext, { name: state.peer.name })}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.close} onClick={onClose} />
          {state.staged ? (
            <Button
              label={zh.wireguard.exportStagedAction}
              variant="primary"
              disabled={!canApply}
              disabledReason={zh.wireguard.exportStagedOffline}
              onClick={onGoApply}
            />
          ) : state.tab === 'conf' ? (
            <Button
              label={zh.wireguard.downloadConf}
              icon="download"
              variant="primary"
              disabled={!state.text}
              disabledReason={zh.wireguard.exportFailed}
              onClick={() => downloadTextFile(state.text, `${state.peer.name}.conf`)}
            />
          ) : state.tab === 'script' ? (
            <Button
              label={zh.wireguard.downloadScript}
              icon="download"
              variant="primary"
              disabled={!state.script}
              disabledReason={state.scriptError ?? zh.wireguard.scriptUnavailable}
              onClick={() => downloadTextFile(state.script, `${state.peer.name}-install.sh`)}
            />
          ) : (
            <Button
              label={zh.wireguard.downloadScript}
              icon="download"
              disabled={!state.uninstall}
              disabledReason={state.uninstallError ?? zh.wireguard.uninstallUnavailable}
              onClick={() => downloadTextFile(state.uninstall, `${state.peer.name}-uninstall.sh`)}
            />
          )}
        </Row>
      }
    >
      <Stack gap={3}>
        <KeyValue items={[{ key: zh.fields.name, value: state.peer.name, mode: 'end' }]} />
        <Banner tone="warn" title={zh.wireguard.exportSensitive} />
        {state.staged ? (
          /* B-1：暂存态导出——明确引导先应用，不再把 Agent 的"peer 不存在"直出 */
          <>
            <Banner tone="info" title={zh.wireguard.exportStagedTitle} description={zh.wireguard.exportStagedDesc} />
          </>
        ) : (
          <>
            <Tabs
          active={state.tab}
          onChange={(key) =>
            onTabChange(key === 'script' ? 'script' : key === 'uninstall' ? 'uninstall' : 'conf')
          }
          items={[
            { key: 'conf', label: zh.wireguard.exportTabConf },
            { key: 'script', label: zh.wireguard.exportTabScript },
            { key: 'uninstall', label: zh.wireguard.exportTabUninstall },
          ]}
        />
        {state.tab === 'conf' ? (
          <>
            {state.loading ? (
              <Stack gap={2}>
                <Skeleton height={10} />
                <Skeleton height={10} />
                <Skeleton height={10} width="70%" />
              </Stack>
            ) : null}
            {state.error ? (
              <Banner
                tone="danger"
                title={zh.wireguard.exportFailed}
                description={state.error}
                action={<Button label={zh.common.retry} size="sm" onClick={onRetry} />}
              />
            ) : null}
            {state.text ? <CodeBlock code={state.text} label={`${state.peer.name}.conf`} /> : null}
            <Banner tone="info" title={zh.wireguard.exportHint} />
          </>
        ) : state.tab === 'uninstall' ? (
          state.uninstall ? (
            <>
              <Banner tone="info" title={zh.wireguard.uninstallUsage} />
              <CodeBlock code={state.uninstall} label={`${state.peer.name}-uninstall.sh`} />
            </>
          ) : state.uninstallError ? (
            <Banner tone="warn" title={zh.wireguard.uninstallUnavailable} description={state.uninstallError} />
          ) : (
            <Stack gap={2}>
              <Skeleton height={10} />
              <Skeleton height={10} />
              <Skeleton height={10} width="70%" />
            </Stack>
          )
        ) : state.script ? (
          <>
            <Banner tone="info" title={zh.wireguard.scriptUsage} />
            <CodeBlock code={state.script} label={`${state.peer.name}-install.sh`} />
          </>
        ) : state.scriptError ? (
          <Banner tone="warn" title={zh.wireguard.scriptUnavailable} description={state.scriptError} />
        ) : (
          <Stack gap={2}>
            <Skeleton height={10} />
            <Skeleton height={10} />
            <Skeleton height={10} width="70%" />
          </Stack>
        )}
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/* ---------------------------------------------------------- RotationDrawer */

function RotationDrawer({
  state,
  rotation,
  offlineReason,
  onClose,
  onRetrySave,
  onConfirm,
  onCancel,
}: {
  state: RotationState;
  rotation: WgRotation;
  offlineReason?: string;
  onClose: () => void;
  onRetrySave: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const pending = rotation.state !== 'cutover';
  const confirmDisabled = pending || Boolean(offlineReason) || Boolean(state.error) || state.saving;
  return (
    <Drawer
      open
      title={zh.wireguard.rotateTitle}
      context={fmt(zh.wireguard.rotateContext, { name: state.peerName })}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button
            label={actionLabel(action('peer.cancelRotation'))}
            variant="danger-text"
            loading={state.busy}
            onClick={onCancel}
          />
          <Button
            label={actionLabel(action('peer.confirmRotation'))}
            variant="primary"
            loading={state.busy}
            disabled={confirmDisabled}
            disabledReason={
              offlineReason ??
              (state.error
                ? zh.wireguard.rotationConfigSaveFailed
                : zh.wireguard.confirmDisabledPending)
            }
            onClick={onConfirm}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        <Banner
          tone={pending ? 'info' : 'warn'}
          title={pending ? zh.wireguard.rotationPendingTitle : zh.wireguard.rotationCutoverTitle}
          description={
            pending
              ? zh.wireguard.rotationPendingDesc
              : fmt(zh.wireguard.rotationCutoverDesc, { time: formatAbsoluteTime(rotation.graceUntil) })
          }
        />
        {pending ? (
          <Banner
            tone="neutral"
            title={fmt(zh.wireguard.rotationExpireHint, {
              time: formatAbsoluteTime(rotation.expiresAt),
            })}
          />
        ) : null}
        {state.error ? (
          <Banner
            tone="danger"
            title={zh.wireguard.rotationConfigSaveFailed}
            description={state.error}
            action={<Button label={zh.wireguard.retrySave} size="sm" onClick={onRetrySave} />}
          />
        ) : null}
        <Banner tone="warn" title={zh.wireguard.exportSensitive} />
        <CodeBlock code={state.text} label={zh.wireguard.rotationNewConfig} />
        <KeyValue
          items={[
            {
              key: zh.wireguard.rotationOldKey,
              value: shortFingerprint(rotation.oldPublicKey),
              mono: true,
              copyValue: rotation.oldPublicKey,
            },
            {
              key: zh.wireguard.rotationNewKey,
              value: shortFingerprint(rotation.newPublicKey),
              mono: true,
              copyValue: rotation.newPublicKey,
            },
            {
              key: zh.wireguard.colHandshake,
              value: formatRelativeTime(rotation.latestHandshake),
            },
            { key: zh.wireguard.rotationStartedAt, value: formatAbsoluteTime(rotation.startedAt) },
            { key: zh.wireguard.rotationGrace, value: formatAbsoluteTime(rotation.graceUntil) },
          ]}
        />
      </Stack>
    </Drawer>
  );
}
