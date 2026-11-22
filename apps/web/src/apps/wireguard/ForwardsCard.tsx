import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTask, hostFwMessages } from '../../data/apps';
import type { TaskResponse } from '@khc/contracts';
import { hubAppsQueryOptions } from '../../data/queries';
import {
  PORT_FORWARD_APP,
  emptyForwardConfig,
  findForwardStatus,
  forwardApiError,
  forwardConfigQueryOptions,
  forwardEnvelopeError,
  forwardTarget,
  normalizeForwardStatus,
  removeForward,
  runForwardAction,
  saveForwardConfig,
  setForwardEnabled,
  upsertForward,
  type ForwardConfig,
  type ForwardError,
  type ForwardRule,
  type ForwardStatus,
} from '../../data/forwards';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  InlineError,
  Stack,
  Table,
  Skeleton,
  useToast,
  type ColumnDef,
  type Tone,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { installTaskText } from '../installTaskText';
import {
  ForwardDrawer,
  buildForward,
  createForwardForm,
  editForwardForm,
  forwardStatusBadge,
  validateForward,
  type ForwardErrors,
  type ForwardFormState,
  type ForwardRow,
} from './forwardDrawer';

type ApplyConfirm = { kind: 'forward'; config: ForwardConfig; name: string } | { kind: 'page' };

function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

/**
 * 判断转发目标是否落在当前节点 WireGuard 网段内但没有对应的已配置 Peer（孤儿目标）。
 * 跳过 Hub 自身接口 IP、合法已接入 Peer 及网段外目标。
 */
export function isOrphanPeerTarget(
  targetHost: string,
  peers: readonly { host: string }[],
  wgSubnet?: string,
): boolean {
  if (!wgSubnet) return false;
  const [hubIpRaw, prefixRaw] = wgSubnet.trim().split('/');
  if (!hubIpRaw || prefixRaw === undefined || !/^\d{1,2}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  if (prefix < 0 || prefix > 32) return false;
  const hubIpInt = parseIpv4(hubIpRaw);
  const targetInt = parseIpv4(targetHost);
  if (hubIpInt === null || targetInt === null) return false;
  if (targetHost.trim() === hubIpRaw.trim()) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  if (((targetInt & mask) >>> 0) !== ((hubIpInt & mask) >>> 0)) return false;
  return !peers.some((peer) => peer.host.trim() === targetHost.trim());
}

/**
 * 内网穿透页的「端口转发」卡（ui-redesign §2.4）：
 * 原 /hubs/:id/forwards 整页（apps/forward/page.tsx）原样收敛为页内卡。
 * 抽屉状态为组件内部状态，不进 URL；peerDrawerActive 为真时让位给 Peer 抽屉。
 */
export function ForwardsCard({
  hubId,
  hubName,
  peers,
  wgSubnet,
  peerDrawerActive,
  onOpen,
}: {
  hubId: string;
  hubName: string;
  /** 当前节点的 Peer 列表，供「目标来源」下拉选择 */
  peers: { name: string; host: string }[];
  /** 当前节点 WireGuard 接口地址/CIDR（如 10.99.0.1/24），用于识别孤儿转发目标 */
  wgSubnet?: string;
  /** Peer 抽屉打开时关闭转发抽屉，保证全页同一时刻只有一个抽屉 */
  peerDrawerActive: boolean;
  /** 打开转发抽屉前回调（页面侧关闭 Peer 抽屉） */
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  // 未配置 port-forward 时不预取配置（避免每次打开内网穿透页产生 404 噪音）；
  // 已配置或应用清单读取失败时才按需拉取。
  const forwardConfigured = appsQuery.data?.apps.some((item) => item.app === PORT_FORWARD_APP);
  const configQuery = useQuery({
    ...forwardConfigQueryOptions(hubId),
    enabled: appsQuery.isError ? true : Boolean(forwardConfigured),
  });
  const { channels, stateQuery } = useHubChannelsContext();
  const liveState = stateQuery.data?.state as
    | { adapters?: { name: string; status?: Record<string, unknown> }[] }
    | undefined;
  const runtime = liveState
    ? { reachable: true, error: null, status: normalizeForwardStatus(liveState.adapters ?? []) }
    : null;
  const status = runtime?.status ?? null;

  const configState = configQuery.data;
  const config = configState?.config ?? emptyForwardConfig();
  const nodeOffline = !channels.canApply;
  const writeDisabledReason = nodeOffline ? zh.forwards.offlineWriteReason : undefined;
  const adapterMissing = Boolean(
    appsQuery.data && !appsQuery.data.adapters.some((adapter) => adapter.name === PORT_FORWARD_APP),
  );
  const unapplied =
    configState !== undefined &&
    configState.rev !== null &&
    configState.appliedRev !== configState.rev;

  const rows: ForwardRow[] = config.forwards.map((forward) => ({
    forward,
    status: findForwardStatus(status, forward),
  }));
  const orphanForwards = config.forwards.filter(
    (rule) => rule.enabled && isOrphanPeerTarget(rule.targetHost, peers, wgSubnet),
  );

  const [form, setForm] = useState<ForwardFormState | null>(null);
  const [errors, setErrors] = useState<ForwardErrors>({});
  const [saveError, setSaveError] = useState<ForwardError | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<ForwardError | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ForwardRule | null>(null);
  const [applyConfirm, setApplyConfirm] = useState<ApplyConfirm | null>(null);
  // socat 缺失时的安装任务回执（与 WireGuard / Caddy 的安装卡同一范式：手动刷新，不轮询）
  const [socatTask, setSocatTask] = useState<TaskResponse | null>(null);
  const [socatBusy, setSocatBusy] = useState(false);

  // Peer 抽屉打开时让位（全页唯一抽屉）
  useEffect(() => {
    if (peerDrawerActive) {
      setForm(null);
      setSaveError(null);
    }
  }, [peerDrawerActive]);

  const installSocat = async () => {
    setSocatBusy(true);
    try {
      const envelope = await runForwardAction(hubId, 'install');
      if (envelope.taskId) {
        setSocatTask(await fetchTask(hubId, envelope.taskId));
      } else {
        await stateQuery.refetch();
      }
      toast.show({ message: zh.forwards.installSocatSubmitted });
    } catch (error) {
      toast.show({
        message: `${zh.forwards.installSocatFailed}：${forwardApiError(error, zh.forwards.installSocatFailed).message}`,
      });
    } finally {
      setSocatBusy(false);
    }
  };

  const refreshSocat = async () => {
    if (!socatTask) return;
    setSocatBusy(true);
    try {
      const task = await fetchTask(hubId, socatTask.task.id);
      setSocatTask(task);
      if (task.task.state === 'done') await stateQuery.refetch();
    } catch (error) {
      toast.show({
        message: `${zh.forwards.installSocatFailed}：${forwardApiError(error, zh.forwards.installSocatFailed).message}`,
      });
    } finally {
      setSocatBusy(false);
    }
  };

  const openCreate = () => {
    onOpen();
    setForm(createForwardForm());
    setErrors({});
    setSaveError(null);
  };

  const openEdit = (forward: ForwardRule) => {
    onOpen();
    setForm(editForwardForm(forward));
    setErrors({});
    setSaveError(null);
  };

  const closeDrawer = () => {
    setForm(null);
    setSaveError(null);
  };

  const invalidateConfig = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', PORT_FORWARD_APP] }),
    ]);
  };

  const invalidateState = async () => {
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
  };

  const applyConfig = async (nextConfig?: ForwardConfig) => {
    let failure: ForwardError | null = null;
    try {
      if (nextConfig) {
        await saveForwardConfig(hubId, nextConfig);
        await invalidateConfig();
      }
      const plan = await runForwardAction(hubId, 'plan');
      const planError = forwardEnvelopeError(plan, zh.forwards.applyFailed);
      if (planError) {
        failure = planError;
        throw new Error(planError.message);
      }
      const apply = await runForwardAction(hubId, 'apply');
      const applyFailure = forwardEnvelopeError(apply, zh.forwards.applyFailed);
      if (applyFailure) {
        failure = applyFailure;
        throw new Error(applyFailure.message);
      }
      // 回显主机 iptables 自动放行结果（“已自动放行 …”，批次 S）。
      hostFwMessages(apply).forEach((message) => toast.show({ message }));
      setApplyError(null);
      await Promise.all([invalidateConfig(), invalidateState()]);
      // apply 结果写回 D1 可能短暂滞后；再补两次拉取，避免行状态停在「待应用」。
      for (let i = 0; i < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await Promise.all([invalidateConfig(), invalidateState()]);
      }
    } catch (error) {
      const next = failure ?? forwardApiError(error, zh.forwards.applyFailed);
      setApplyError(next);
      throw new Error(next.message);
    }
  };

  const save = async (apply: boolean) => {
    if (!form) return;
    const nextErrors = validateForward(form, config);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const forward = buildForward(form);
      const nextConfig = upsertForward(config, forward, form.originalName);
      if (apply) {
        // 先落草稿，再关闭抽屉走页面级确认；取消确认时至少保留已保存的改动。
        await saveForwardConfig(hubId, nextConfig);
        await invalidateConfig();
        setApplyError(null);
        const pending = { kind: 'forward' as const, config: nextConfig, name: forward.name };
        closeDrawer();
        setApplyConfirm(pending);
        setSaving(false);
        return;
      }
      await saveForwardConfig(hubId, nextConfig);
      await invalidateConfig();
      setApplyError(null);
      toast.show({ message: zh.forwards.savedToast });
      closeDrawer();
    } catch (error) {
      setSaveError(forwardApiError(error, zh.forwards.createFailed));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (forward: ForwardRule) => {
    if (nodeOffline) return;
    setPageError(null);
    try {
      const nextConfig = setForwardEnabled(config, forward.name, !forward.enabled);
      await applyConfig(nextConfig);
      toast.show({
        message: fmt(forward.enabled ? zh.forwards.disabledToast : zh.forwards.enabledToast, {
          name: forward.name,
        }),
      });
    } catch (error) {
      setPageError(forwardApiError(error, zh.forwards.applyFailed).message);
    }
  };

  const remove = async (forward: ForwardRule) => {
    try {
      const nextConfig = removeForward(config, forward.name);
      await applyConfig(nextConfig);
      setConfirmDelete(null);
      toast.show({ message: fmt(zh.forwards.deletedToast, { name: forward.name }) });
    } catch (error) {
      throw error instanceof Error ? error : new Error(zh.forwards.createFailed);
    }
  };

  const columns: ColumnDef<ForwardRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.forwards.colName,
      value: (row) => row.forward.name,
      dot: (row) => forwardStatusBadge(row, unapplied, status).tone,
    },
    {
      key: 'listen',
      type: 'text',
      header: zh.forwards.colListen,
      value: (row) => `${row.forward.listenHost}:${row.forward.listenPort}`,
    },
    {
      key: 'target',
      type: 'mono',
      header: zh.forwards.colTarget,
      value: (row) => forwardTarget(row.forward),
    },
    {
      key: 'protocol',
      type: 'text',
      header: zh.forwards.colProtocol,
      value: (row) =>
        row.forward.protocol === 'udp' ? zh.forwards.protocolUdp : zh.forwards.protocolTcp,
    },
    {
      key: 'status',
      type: 'status',
      header: zh.forwards.colStatus,
      status: (row) => forwardStatusBadge(row, unapplied, status),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const rowActions = (): ActionRef[] => [
    action('forward.update'),
    action('forward.toggle'),
    action('forward.delete'),
  ];

  const rowActionDisabled = (ref: ActionRef): string | undefined => {
    if (!nodeOffline) return undefined;
    if (ref.id === 'forward.toggle' || ref.id === 'forward.delete') {
      return writeDisabledReason;
    }
    return undefined;
  };

  const handleRowAction = (ref: ActionRef, row: ForwardRow) => {
    if (ref.id === 'forward.update') {
      openEdit(row.forward);
      return;
    }
    if (ref.id === 'forward.toggle') {
      void toggle(row.forward);
      return;
    }
    if (ref.id === 'forward.delete') {
      setConfirmDelete(row.forward);
    }
  };

  return (
    <Card
      title={zh.wireguard.forwardsCard}
      action={
        <Button
          label={actionLabel(action('forward.create'))}
          size="sm"
          icon="plus"
          disabled={!channels.canApply}
          disabledReason={zh.channels.controlUnavailableDesc}
          onClick={openCreate}
        />
      }
    >
      <Stack gap={3}>
        {configQuery.error ? (
          <Banner
            tone="danger"
            title={zh.forwards.loadError}
            description={(configQuery.error as Error).message}
            action={
              <Button label={zh.common.retry} size="sm" onClick={() => void configQuery.refetch()} />
            }
          />
        ) : null}
        {pageError ? (
          <Banner
            tone="danger"
            title={zh.forwards.applyFailed}
            description={pageError}
            action={<Button label={zh.common.close} size="sm" onClick={() => setPageError(null)} />}
          />
        ) : null}
        {adapterMissing || appsQuery.error ? (
          <Banner
            tone="warn"
            title={zh.forwards.adapterMissing}
            description={
              appsQuery.error instanceof Error
                ? appsQuery.error.message
                : zh.forwards.adapterMissingDesc
            }
          />
        ) : null}
        {status?.error ? (
          <Banner tone="danger" title={zh.forwards.statusError} description={status.error} />
        ) : null}
        {status?.socatAvailable === false ? (
          <Banner
            tone="neutral"
            title={zh.forwards.socatMissing}
            description={
              socatTask
                ? installTaskText(socatTask, zh.forwards.installSocatTaskState)
                : zh.forwards.socatMissingDesc
            }
            action={
              socatTask ? (
                <Button
                  label={zh.forwards.installSocatRefresh}
                  size="sm"
                  loading={socatBusy}
                  onClick={() => void refreshSocat()}
                />
              ) : (
                <Button
                  label={zh.forwards.installSocat}
                  size="sm"
                  loading={socatBusy}
                  disabled={nodeOffline}
                  disabledReason={writeDisabledReason}
                  onClick={() => void installSocat()}
                />
              )
            }
          />
        ) : null}
        {unapplied ? (
          <Banner
            tone="info"
            title={zh.forwards.unapplied}
            description={zh.forwards.unappliedDesc}
            action={
              <Button
                label={actionLabel(action('app.apply'))}
                size="sm"
                disabled={nodeOffline || !channels.canApply}
                disabledReason={writeDisabledReason ?? zh.channels.controlUnavailableDesc}
                onClick={() => setApplyConfirm({ kind: 'page' })}
              />
            }
          />
        ) : null}
        {applyError ? (
          <Stack gap={2}>
            <InlineError message={applyError.message} />
            {applyError.details ? (
              <CodeBlock code={applyError.details} label={zh.forwards.detailsTitle} />
            ) : null}
          </Stack>
        ) : null}
        {orphanForwards.length > 0 ? (
          <Banner
            tone="warn"
            title={fmt(zh.forwards.orphanPeerTitle, { count: String(orphanForwards.length) })}
            description={fmt(zh.forwards.orphanPeerDesc, {
              list: orphanForwards.map((rule) => `${rule.name} (${forwardTarget(rule)})`).join('、'),
            })}
            action={
              orphanForwards.length === 1 ? (
                <Button
                  label={zh.forwards.orphanDisableAction}
                  size="sm"
                  disabled={nodeOffline}
                  disabledReason={writeDisabledReason}
                  onClick={() => void toggle(orphanForwards[0]!)}
                />
              ) : undefined
            }
          />
        ) : null}

        {configQuery.isLoading ? (
          <Stack gap={2}>
            <Skeleton height={10} />
            <Skeleton height={10} />
            <Skeleton height={10} width="70%" />
          </Stack>
        ) : (
          <Table
            rows={rows}
            columns={columns}
            rowKey={(row) => row.forward.name}
            objectLabel={zh.wireguard.forwardsCard}
            empty={{
              icon: 'arrow',
              title: zh.forwards.emptyTitle,
              description: zh.forwards.emptyHint,
            }}
            rowActions={rowActions}
            rowActionDisabled={rowActionDisabled}
            onRowAction={handleRowAction}
            onRowOpen={(row) => openEdit(row.forward)}
          />
        )}
      </Stack>

      {form ? (
        <ForwardDrawer
          form={form}
          errors={errors}
          saveError={saveError}
          saving={saving}
          hubName={hubName}
          offlineReason={writeDisabledReason}
          peers={peers}
          onChange={(patch) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))}
          onClose={closeDrawer}
          onSave={(apply) => void save(apply)}
        />
      ) : null}

      {applyConfirm ? (
        <ConfirmAction
          open
          action={action('app.apply')}
          title={zh.forwards.applyConfirmTitle}
          body={zh.forwards.applyConfirmBody}
          confirmLabel={actionLabel(action('app.apply'))}
          onCancel={() => setApplyConfirm(null)}
          onConfirm={async () => {
            try {
              if (applyConfirm.kind === 'forward') {
                await applyConfig(applyConfirm.config);
                closeDrawer();
              } else {
                await applyConfig();
              }
              setApplyConfirm(null);
              toast.show({ message: zh.forwards.appliedToast });
            } catch {
              setApplyConfirm(null);
            }
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmAction
          open
          action={action('forward.delete')}
          title={fmt(zh.forwards.deleteTitle, { name: confirmDelete.name })}
          body={zh.forwards.deleteBody}
          confirmLabel={zh.forwards.deleteConfirm}
          targetName={confirmDelete.name}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove(confirmDelete)}
        />
      ) : null}
    </Card>
  );
}