/**
 * 已装应用详情抽屉（V4）：概要、单元启停重启、按需日志、升级、卸载（含强制跳过 hook）。
 *
 * 约定：
 * - 所有确认采用抽屉内行内确认（不叠 Dialog）；
 * - 前端不传 `instance` 字段；
 * - 旧版 recipe（`source !== 'manifest'`）只读展示。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentState, TaskResponse } from '@khc/contracts';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import {
  appStatus,
  canUpgrade,
  installedTime,
  normalizeResultCards,
  uninstallActionForSchema,
  type AppCatalogStatusState,
  type AppView,
  type InstalledApp,
} from '../../data/manifestApps';
import { refreshHubRuntime } from '../../data/queries';
import { zh } from '../../i18n/zh';
import { ApiError } from '../../data/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  Drawer,
  KeyValue,
  LogViewer,
  Row,
  Select,
  Skeleton,
  Stack,
  useToast,
  type KeyValueItem,
} from '../../ui';
import { ManifestErrorAlert } from './ManifestErrorAlert';
import { ResultCardsView } from './ResultCardsView';

type InlineConfirm =
  | { kind: 'stop'; unit: string }
  | { kind: 'upgrade' }
  | { kind: 'uninstall' }
  | { kind: 'force-uninstall' };

export interface InstalledAppDrawerProps {
  hubId: string;
  hubName: string;
  entry: InstalledApp;
  view?: AppView;
  state?: AgentState | null;
  catalogState?: Pick<AppCatalogStatusState, 'stale' | 'pending'>;
  offlineReason?: string;
  pollIntervalMs?: number;
  onClose: () => void;
}

export function InstalledAppDrawer({
  hubId,
  hubName,
  entry,
  view,
  state,
  catalogState,
  offlineReason,
  pollIntervalMs = 800,
  onClose,
}: InstalledAppDrawerProps) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [confirm, setConfirm] = useState<InlineConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [unitBusy, setUnitBusy] = useState<string | null>(null);
  const [lingerDisabled, setLingerDisabled] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);

  const [logsOpen, setLogsOpen] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(() => entry.units[0]?.name ?? '');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSelectedUnit((prev) =>
      entry.units.some((u) => u.name === prev) ? prev : (entry.units[0]?.name ?? ''),
    );
  }, [entry.units]);

  const logsQuery = useQuery({
    queryKey: ['hubs', hubId, 'manifestLogs', entry.manifestId, entry.instance, selectedUnit],
    enabled: logsOpen && Boolean(selectedUnit) && !offlineReason && entry.source === 'manifest',
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const env = await runAppAction(hubId, 'app-catalog', 'manifest_logs', {
        manifestId: entry.manifestId,
        unit: selectedUnit,
        lines: 200,
      });
      if (!env.ok) {
        throw new Error(friendlyAgentError(env.error?.message) ?? '读取日志失败');
      }
      const record = env as unknown as {
        logs?: unknown;
        truncated?: unknown;
        mayContainSecrets?: unknown;
      };
      return {
        logs: typeof record.logs === 'string' ? record.logs : '',
        truncated: Boolean(record.truncated),
        mayContainSecrets: Boolean(record.mayContainSecrets ?? true),
      };
    },
  });

  const displayName =
    (!view?.invalid && view?.def.name ? view.def.name : entry.manifestId) +
    (entry.instance && entry.instance !== entry.manifestId ? ` (${entry.instance})` : '');
  const status = appStatus(entry, catalogState);
  const isManifest = entry.source === 'manifest';
  const isV2 = isManifest && entry.schema === 2;
  const upgradeable = canUpgrade(view, entry, state);
  const hasPreUpgradeHook = Boolean(view && !view.invalid && view.def.hooks?.preUpgrade);
  const actionDisabled = Boolean(offlineReason) || busy || unitBusy !== null;

  const pollTask = async (taskId: string): Promise<TaskResponse> => {
    let current = await fetchTask(hubId, taskId);
    if (!mountedRef.current) return current;
    setTask(current);
    const maxPolls = Math.ceil(90_000 / Math.max(pollIntervalMs, 5));
    for (
      let i = 0;
      i < maxPolls && (current.task.state === 'pending' || current.task.state === 'running');
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      if (!mountedRef.current) return current;
      current = await fetchTask(hubId, taskId);
      if (!mountedRef.current) return current;
      setTask(current);
    }
    return current;
  };

  const controlUnit = async (unitName: string, op: 'start' | 'stop' | 'restart') => {
    setConfirm(null);
    setActionError(null);
    setUnitBusy(`${unitName}:${op}`);
    try {
      const env = await runAppAction(hubId, 'app-catalog', 'manifest_control', {
        manifestId: entry.manifestId,
        unit: unitName,
        op,
      });
      if (!mountedRef.current) return;
      if (!env.ok) {
        throw env.error ?? new Error('单元操作失败');
      }
      const record = env as unknown as { lingerDisabled?: unknown };
      if (record.lingerDisabled === true) {
        setLingerDisabled(true);
      }
      toast.show({
        message: `${unitName} 已${op === 'start' ? '启动' : op === 'stop' ? '停止' : '重启'}`,
      });
      await refreshHubRuntime(queryClient, hubId, { force: true });
    } catch (cause) {
      if (mountedRef.current) setActionError(cause);
    } finally {
      if (mountedRef.current) setUnitBusy(null);
    }
  };

  const runUpgrade = async () => {
    setConfirm(null);
    setBusy(true);
    setActionError(null);
    setTask(null);
    try {
      const env = await runAppAction(hubId, 'app-catalog', 'manifest_upgrade', {
        manifestId: entry.manifestId,
        values: {},
      });
      if (!mountedRef.current) return;
      if (!env.ok || !env.taskId) {
        throw env.error ?? new Error('升级失败');
      }
      const finalTask = await pollTask(env.taskId);
      if (!mountedRef.current) return;
      if (finalTask.task.state !== 'done') {
        throw finalTask.task.error ?? new Error('升级任务失败');
      }
      toast.show({ message: `${displayName} 升级完成` });
      await refreshHubRuntime(queryClient, hubId, { force: true });
    } catch (cause) {
      if (mountedRef.current) setActionError(cause);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const runUninstall = async (skipHooks: boolean) => {
    setConfirm(null);
    setBusy(true);
    setActionError(null);
    setTask(null);
    try {
      const actionName = uninstallActionForSchema(entry.schema);
      const env = await runAppAction(hubId, 'app-catalog', actionName, {
        manifestId: entry.manifestId,
        values: {},
        ...(skipHooks ? { skipHooks: true } : {}),
      });
      if (!mountedRef.current) return;
      if (!env.ok || !env.taskId) {
        throw env.error ?? new Error(zh.catalog.uninstallFailed);
      }
      const finalTask = await pollTask(env.taskId);
      if (!mountedRef.current) return;
      if (finalTask.task.state !== 'done') {
        throw finalTask.task.error ?? new Error(zh.catalog.uninstallFailed);
      }
      toast.show({ message: zh.catalog.uninstallSubmitted });
      await refreshHubRuntime(queryClient, hubId, { force: true });
      if (mountedRef.current) onClose();
    } catch (cause) {
      if (!mountedRef.current) return;
      setActionError(cause);
      if (
        !skipHooks &&
        entry.schema === 2 &&
        cause instanceof ApiError &&
        (cause.code === 'hook_failed' || cause.code === 'hook_extract_failed')
      ) {
        setConfirm({ kind: 'force-uninstall' });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const summaryItems: KeyValueItem[] = [
    {
      key: '版本',
      value: upgradeable && view ? `${entry.version} → ${view.def.version}` : entry.version,
      mono: true,
    },
    { key: '安装时间', value: installedTime(entry.installedAt) },
    ...(entry.upgradedAt ? [{ key: '升级时间', value: installedTime(entry.upgradedAt) }] : []),
    {
      key: '运行身份',
      value: entry.mode === 'root' ? 'root' : (entry.user ?? '新建用户'),
      mono: true,
    },
    ...(entry.lastHealth
      ? [
          {
            key: '最近健康检查',
            value: [
              entry.lastHealth.ok ? '通过' : '失败',
              entry.lastHealth.version ? `v${entry.lastHealth.version}` : '',
              entry.lastHealth.checkedAt ? installedTime(entry.lastHealth.checkedAt) : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
          ...(entry.lastHealth.error
            ? [{ key: '健康错误', value: entry.lastHealth.error }]
            : []),
        ]
      : []),
  ];

  const factItems: KeyValueItem[] = entry.facts
    ? Object.entries(entry.facts).map(([k, v]) => ({
        key: k,
        value: String(v),
        mono: true,
        copyValue: String(v),
      }))
    : [];

  const resultCards = normalizeResultCards(
    entry.schema,
    (task?.task.result as { cards?: unknown } | null | undefined)?.cards,
  );

  return (
    <Drawer
      open
      title={displayName}
      context={`节点 ${hubName}`}
      dirty={busy || unitBusy !== null}
      onClose={onClose}
      footer={<Button label={zh.common.close} onClick={onClose} />}
    >
      <Stack gap={4}>
        <Row gap={2} align="center" wrap>
          <Badge tone={status.tone} label={status.label} />
          <Badge tone="neutral" label={isManifest ? `v${entry.schema}` : '旧版目录'} />
        </Row>

        {offlineReason ? (
          <Banner tone="warn" title={zh.sites.offlineTitle} description={offlineReason} />
        ) : null}

        {!isManifest ? (
          <Banner
            tone="neutral"
            title="旧版目录应用（只读）"
            description="该条记录来自旧版目录，暂不提供生命周期操作。"
          />
        ) : null}

        {actionError ? (
          <ManifestErrorAlert
            error={actionError}
            hubId={hubId}
            manifestId={entry.manifestId}
            onNavigate={onClose}
          />
        ) : null}

        {confirm?.kind === 'force-uninstall' ? (
          <Banner
            tone="warn"
            title="跳过控制面步骤强制卸载"
            description="控制面步骤调用失败；跳过后第三方资源需人工清理。"
            action={
              <Row gap={2}>
                <Button
                  label="跳过控制面步骤强制卸载"
                  variant="danger"
                  size="sm"
                  disabled={actionDisabled}
                  onClick={() => void runUninstall(true)}
                />
                <Button label="取消" size="sm" onClick={() => setConfirm(null)} />
              </Row>
            }
          />
        ) : null}

        <Card title="概要">
          <KeyValue items={summaryItems} />
        </Card>

        {factItems.length > 0 ? (
          <Card title="安装信息">
            <KeyValue items={factItems} />
          </Card>
        ) : null}

        {entry.endpoints.length > 0 ? (
          <Card title="端点">
            <Stack gap={2}>
              {entry.endpoints.map((ep) => (
                <div key={ep.id} className="ui-row-between">
                  <span>{ep.label ?? ep.id}</span>
                  <span className="ui-text-mono">
                    {ep.protocol.toUpperCase()} · {ep.bind === 'any' ? '0.0.0.0' : '127.0.0.1'}
                    {ep.port !== undefined ? `:${ep.port}` : ''}
                    {ep.paths && ep.paths.length > 0 ? ` (${ep.paths.join(', ')})` : ''}
                  </span>
                </div>
              ))}
            </Stack>
          </Card>
        ) : null}

        {isV2 && entry.units.length > 0 ? (
          <Card title="单元">
            <Stack gap={3}>
              {lingerDisabled ? (
                <Banner
                  tone="warn"
                  title="该用户未开启 linger，退出登录后服务会停"
                />
              ) : null}
              {entry.units.map((unit) => {
                const activeTone =
                  unit.active === 'active'
                    ? 'ok'
                    : unit.active === undefined
                      ? 'neutral'
                      : 'danger';
                return (
                  <Stack key={unit.name} gap={2}>
                    <div className="ui-row-between">
                      <Row gap={2} align="center" wrap>
                        <span className="ui-text-mono">{unit.name}</span>
                        <Badge tone="neutral" label={unit.scope} />
                        <Badge tone={activeTone} label={unit.active ?? '未知'} />
                      </Row>
                      <Row gap={1}>
                        <Button
                          label="启动"
                          size="sm"
                          loading={unitBusy === `${unit.name}:start`}
                          disabled={actionDisabled}
                          disabledReason={offlineReason}
                          onClick={() => void controlUnit(unit.name, 'start')}
                        />
                        <Button
                          label="停止"
                          size="sm"
                          loading={unitBusy === `${unit.name}:stop`}
                          disabled={actionDisabled}
                          disabledReason={offlineReason}
                          onClick={() => setConfirm({ kind: 'stop', unit: unit.name })}
                        />
                        <Button
                          label="重启"
                          size="sm"
                          loading={unitBusy === `${unit.name}:restart`}
                          disabled={actionDisabled}
                          disabledReason={offlineReason}
                          onClick={() => void controlUnit(unit.name, 'restart')}
                        />
                      </Row>
                    </div>
                    {confirm?.kind === 'stop' && confirm.unit === unit.name ? (
                      <Banner
                        tone="warn"
                        title={`确认停止 ${unit.name}？`}
                        description="停止后应用将无法响应请求，可随时重新启动。"
                        action={
                          <Row gap={2}>
                            <Button
                              label="确认停止"
                              variant="danger"
                              size="sm"
                              onClick={() => void controlUnit(unit.name, 'stop')}
                            />
                            <Button label="取消" size="sm" onClick={() => setConfirm(null)} />
                          </Row>
                        }
                      />
                    ) : null}
                  </Stack>
                );
              })}
            </Stack>
          </Card>
        ) : null}

        {isV2 && entry.units.length > 0 ? (
          <Card
            title="日志"
            action={
              <Button
                label={logsOpen ? '收起' : '查看日志'}
                size="sm"
                onClick={() => setLogsOpen((prev) => !prev)}
              />
            }
          >
            {logsOpen ? (
              <Stack gap={3}>
                <Banner tone="info" title="日志可能包含应用自己打印的敏感信息" />
                {entry.units.length > 1 ? (
                  <Row gap={2} align="center">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Select
                        id="installed-app-log-unit"
                        value={selectedUnit}
                        options={entry.units.map((u) => ({ value: u.name, label: u.name }))}
                        onChange={setSelectedUnit}
                        ariaLabel="选择单元"
                      />
                    </div>
                    <Button
                      label="刷新"
                      size="sm"
                      disabled={Boolean(offlineReason) || logsQuery.isFetching}
                      onClick={() => void logsQuery.refetch()}
                    />
                  </Row>
                ) : (
                  <Row justify="end">
                    <Button
                      label="刷新"
                      size="sm"
                      disabled={Boolean(offlineReason) || logsQuery.isFetching}
                      onClick={() => void logsQuery.refetch()}
                    />
                  </Row>
                )}
                {logsQuery.isLoading ? (
                  <Skeleton height={80} />
                ) : logsQuery.error ? (
                  <ManifestErrorAlert error={logsQuery.error} hubId={hubId} />
                ) : (
                  <>
                    {logsQuery.data?.truncated ? (
                      <Banner tone="warn" title="日志已截断（仅展示末尾 ≤64KB）" />
                    ) : null}
                    <LogViewer
                      lines={(logsQuery.data?.logs ?? '')
                        .split('\n')
                        .filter((line, idx, arr) => line !== '' || idx < arr.length - 1)
                        .map((text) => ({ text }))}
                      title={selectedUnit}
                      autoscroll={false}
                    />
                  </>
                )}
              </Stack>
            ) : (
              <p className="ui-text-caption">点击「查看日志」按需拉取最近 200 行单元日志。</p>
            )}
          </Card>
        ) : null}

        {task ? (
          <Stack gap={2}>
            <LogViewer
              lines={(task.task.logs ?? []).map((text) => ({ text }))}
              title="任务日志"
            />
            <ResultCardsView cards={resultCards} title="执行结果" />
          </Stack>
        ) : null}

        {isManifest ? (
          <Card title="生命周期操作">
            <Stack gap={3}>
              <Row gap={2} wrap>
                {upgradeable && view ? (
                  <Button
                    label={`升级到 ${view.def.version}`}
                    variant="primary"
                    size="sm"
                    disabled={actionDisabled}
                    disabledReason={offlineReason}
                    onClick={() => setConfirm({ kind: 'upgrade' })}
                  />
                ) : null}
                <Button
                  label={zh.catalog.uninstall}
                  variant="danger-text"
                  size="sm"
                  disabled={actionDisabled}
                  disabledReason={offlineReason}
                  onClick={() => setConfirm({ kind: 'uninstall' })}
                />
              </Row>

              {confirm?.kind === 'upgrade' && view ? (
                <Banner
                  tone="info"
                  title={`确认升级到 ${view.def.version}？`}
                  description={
                    `当前版本 ${entry.version} → 目标版本 ${view.def.version}` +
                    (hasPreUpgradeHook ? '；将执行控制面步骤 preUpgrade' : '')
                  }
                  action={
                    <Row gap={2}>
                      <Button
                        label="确认升级"
                        variant="primary"
                        size="sm"
                        onClick={() => void runUpgrade()}
                      />
                      <Button label="取消" size="sm" onClick={() => setConfirm(null)} />
                    </Row>
                  }
                />
              ) : null}

              {confirm?.kind === 'uninstall' ? (
                <Banner
                  tone="warn"
                  title={`卸载 ${displayName}？`}
                  description={zh.catalog.uninstallConfirmDesc}
                  action={
                    <Row gap={2}>
                      <Button
                        label={zh.catalog.uninstall}
                        variant="danger"
                        size="sm"
                        onClick={() => void runUninstall(false)}
                      />
                      <Button label="取消" size="sm" onClick={() => setConfirm(null)} />
                    </Row>
                  }
                />
              ) : null}
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Drawer>
  );
}
