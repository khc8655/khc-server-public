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
import { compareSemver } from '../../data/agent';
import {
  fetchTask,
  friendlyAgentError,
  isTransientTaskPollError,
  runAppAction,
  taskPollBackoffMs,
} from '../../data/apps';
import {
  appStatus,
  canUpgrade,
  effectiveSchema,
  installedTime,
  normalizeResultCards,
  uninstallActionForSchema,
  unitStatusView,
  validateManifestValues,
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
  Link,
  LogViewer,
  Row,
  Select,
  Skeleton,
  Stack,
  useToast,
  type KeyValueItem,
} from '../../ui';
import { paths } from '../../registry/routes';
import { ManifestErrorAlert } from './ManifestErrorAlert';
import { ResultCardsView } from './ResultCardsView';
import { UpgradeParamsForm, type UpgradeValues } from './UpgradeParamsForm';

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
  const [failedAction, setFailedAction] = useState<'upgrade' | 'uninstall' | null>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);

  // 升级时可选修改的参数：只保存用户改动过的键（含 secret 值，仅存于本组件状态）。
  const [upgradeParamsOpen, setUpgradeParamsOpen] = useState(false);
  const [upgradeValues, setUpgradeValues] = useState<UpgradeValues>({});
  const [upgradeErrors, setUpgradeErrors] = useState<Record<string, string>>({});
  const [upgradeNeedsFill, setUpgradeNeedsFill] = useState(false);

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
  const schema = effectiveSchema(view, entry);
  const isV2 = isManifest && schema === 2;
  const upgradeable = canUpgrade(view, entry, state);
  const hasPreUpgradeHook = Boolean(view && !view.invalid && view.def.hooks?.preUpgrade);
  const actionDisabled = Boolean(offlineReason) || busy || unitBusy !== null;
  const agentVersion = state?.agent?.version;
  // 0.8.1 起 Agent 才保存安装参数值；版本无法解析时不提示。
  const agentForgetsInstallValues = Boolean(
    agentVersion && compareSemver('0.8.1', agentVersion) > 0,
  );

  const pollTask = async (taskId: string): Promise<TaskResponse> => {
    const maxPolls = Math.ceil(90_000 / Math.max(pollIntervalMs, 5));
    let current: TaskResponse | null = null;
    let consecutivePollErrors = 0;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
      if (attempt > 0) {
        const delay = taskPollBackoffMs(pollIntervalMs, consecutivePollErrors);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!mountedRef.current) {
          if (current) return current;
          throw lastError instanceof Error ? lastError : new Error('任务查询已取消');
        }
      }

      try {
        const next = await fetchTask(hubId, taskId);
        if (!mountedRef.current) return next;
        consecutivePollErrors = 0;
        lastError = null;
        current = next;
        setTask(next);
        if (current.task.state !== 'pending' && current.task.state !== 'running') {
          return current;
        }
      } catch (pollErr) {
        if (!mountedRef.current) {
          if (current) return current;
          throw pollErr;
        }
        if (!isTransientTaskPollError(pollErr)) {
          throw pollErr;
        }
        consecutivePollErrors += 1;
        lastError = pollErr;
      }
    }

    if (lastError !== null) {
      throw lastError;
    }
    return current!;
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

  const errorField = (cause: unknown): string | undefined => {
    const details = (cause as { details?: unknown } | null)?.details;
    const field =
      details && typeof details === 'object' ? (details as { field?: unknown }).field : undefined;
    return typeof field === 'string' && field ? field : undefined;
  };

  const setUpgradeValue = (key: string, value: unknown | undefined) => {
    setUpgradeValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setUpgradeErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const resetUpgradeForm = () => {
    setUpgradeParamsOpen(false);
    setUpgradeValues({});
    setUpgradeErrors({});
    setUpgradeNeedsFill(false);
  };

  const runUpgrade = async () => {
    // 只校验用户填了的键；缺失由 Agent 判定。
    if (view && !view.invalid) {
      const all = validateManifestValues(view.def, upgradeValues);
      const errs = Object.fromEntries(Object.entries(all).filter(([key]) => key in upgradeValues));
      if (Object.keys(errs).length > 0) {
        setUpgradeErrors(errs);
        setUpgradeParamsOpen(true);
        return;
      }
    }
    setConfirm(null);
    setBusy(true);
    setActionError(null);
    setFailedAction(null);
    setTask(null);
    setUpgradeErrors({});
    setUpgradeNeedsFill(false);
    try {
      const env = await runAppAction(hubId, 'app-catalog', 'manifest_upgrade', {
        manifestId: entry.manifestId,
        values: upgradeValues,
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
      resetUpgradeForm();
      await refreshHubRuntime(queryClient, hubId, { force: true });
    } catch (cause) {
      if (!mountedRef.current) return;
      setActionError(cause);
      setFailedAction('upgrade');
      // 0.8.0 的「缺少参数」错误 code 是 internal_error：只认 details.field，不看 code 与文本。
      // 任务失败（Agent）与同步错误（Worker 的 param_invalid ApiError）走同一段定位逻辑。
      const field = errorField(cause);
      if (
        field !== undefined &&
        view &&
        !view.invalid &&
        view.def.params.some((param) => param.key === field)
      ) {
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : typeof (cause as { message?: unknown }).message === 'string'
              ? String((cause as { message: string }).message)
              : '该参数缺失，请补填';
        setUpgradeErrors({ [field]: message });
        setUpgradeParamsOpen(true);
        setUpgradeNeedsFill(true);
        setConfirm({ kind: 'upgrade' });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const runUninstall = async (skipHooks: boolean) => {
    setConfirm(null);
    setBusy(true);
    setActionError(null);
    setFailedAction(null);
    setTask(null);
    try {
      const actionName = uninstallActionForSchema(schema);
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
      setFailedAction('uninstall');
      if (
        !skipHooks &&
        schema === 2 &&
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
    schema,
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
          <Badge tone="neutral" label={isManifest ? `v${schema}` : '旧版目录'} />
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

        {actionError && failedAction === 'uninstall' && errorField(actionError) ? (
          <Banner
            tone="warn"
            title={`该应用清单的卸载步骤缺少参数 ${errorField(actionError)}`}
            description="到「设置 → 应用管理」为它设置默认值后重试。"
            action={
              <Link
                to={`${paths.settings}?tab=manifests&manifest=${encodeURIComponent(entry.manifestId)}`}
                label="去应用管理设置默认值"
              />
            }
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
                const unitStatus = unitStatusView(unit);
                return (
                  <Stack key={unit.name} gap={2}>
                    <div className="ui-row-between">
                      <Row gap={2} align="center" wrap>
                        <span className="ui-text-mono">{unit.name}</span>
                        <Badge tone="neutral" label={unit.scope} />
                        <Badge tone={unitStatus.tone} label={unitStatus.label} />
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
                <Stack gap={3}>
                  <Banner
                    tone="info"
                    title={`确认升级到 ${view.def.version}？`}
                    description={
                      `当前版本 ${entry.version} → 目标版本 ${view.def.version}` +
                      (hasPreUpgradeHook ? '；将执行控制面步骤 preUpgrade' : '')
                    }
                  />
                  <Row gap={2}>
                    <Button
                      label={upgradeNeedsFill ? zh.catalog.upgradeRetryAfterFill : '确认升级'}
                      variant="primary"
                      size="sm"
                      onClick={() => void runUpgrade()}
                    />
                    <Button
                      label="取消"
                      size="sm"
                      onClick={() => {
                        resetUpgradeForm();
                        setConfirm(null);
                      }}
                    />
                  </Row>
                  {agentForgetsInstallValues ? (
                    <Banner
                      tone="warn"
                      title={zh.catalog.upgradeOldAgentTitle}
                      description={zh.catalog.upgradeOldAgentHint}
                    />
                  ) : null}
                  {!view.invalid ? (
                    <Stack gap={3}>
                      <Row gap={2}>
                        <Button
                          label={
                            upgradeParamsOpen
                              ? zh.catalog.upgradeParamsHide
                              : zh.catalog.upgradeParamsToggle
                          }
                          size="sm"
                          variant="ghost"
                          onClick={() => setUpgradeParamsOpen((prev) => !prev)}
                        />
                      </Row>
                      {upgradeParamsOpen ? (
                        <UpgradeParamsForm
                          def={view.def}
                          values={upgradeValues}
                          errors={upgradeErrors}
                          onChange={setUpgradeValue}
                        />
                      ) : null}
                    </Stack>
                  ) : null}
                </Stack>
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
