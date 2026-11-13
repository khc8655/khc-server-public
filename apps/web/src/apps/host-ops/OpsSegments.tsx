import { useEffect, useState } from 'react';
import type { AgentOps, SshKey } from '@khc/contracts';
import { AdvancedSection, ConfirmAction } from '../../patterns';
import { fetchSshKeys } from '../../data/sshKeys';
import { action, type ActionRef } from '../../registry/actions';
import {
  callHostOps,
  normalizeCronList,
  normalizeKeys,
  normalizeLogErrors,
  normalizeProcesses,
  normalizeServices,
  normalizeSvcLogs,
  normalizeStatus,
  normalizeVersion,
  validateCronName,
  validateServiceUnit,
  type HostOpsCronEntry,
  type HostOpsCronList,
  type HostOpsError,
  type HostOpsKey,
  type HostOpsLogEntry,
  type HostOpsLogErrors,
  type HostOpsProcess,
  type HostOpsService,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Banner,
  Button,
  CodeBlock,
  Field,
  Row,
  Segmented,
  Select,
  Skeleton,
  Stack,
  Table,
  Textarea,
  TextInput,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime, formatBytes, formatPercent } from '../../i18n/format';
import { businessProcesses, countSystemProcesses } from './processFilter';
import { HostOpsErrorBanner, hostOpsErrorTitle } from './Common';

/* ------------------------------------------------------------------ 服务段 */

/**
 * 服务段（#E1）：进入分段时经 svc.list 实时读取 running/failed 单元；
 * 行内「重启」L2 确认（危险操作级别不降低）、「日志」进页面级抽屉（svc.logs 尾读）。
 */
export function ServicesSegment({
  hubId,
  disabled,
  onOpenLogs,
}: {
  hubId: string;
  disabled: boolean;
  onOpenLogs: (unit: string) => void;
}) {
  const [services, setServices] = useState<HostOpsService[] | undefined>(undefined);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);
  const [restartTarget, setRestartTarget] = useState<HostOpsService | null>(null);
  const toast = useToast();

  const load = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'svc.list');
      if (!result.ok) setError(result.error);
      else setServices(normalizeServices(result.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const restart = async (service: HostOpsService) => {
    const result = await callHostOps(hubId, 'self', 'svc.restart', { unit: service.unit });
    if (!result.ok) {
      if (result.error) setError(result.error);
      throw new Error(hostOpsErrorTitle(result.error));
    }
    setRestartTarget(null);
    toast.show({ message: fmt(zh.hostOps.svc.restarted, { unit: service.unit }) });
    await load();
  };

  const columns: ColumnDef<HostOpsService>[] = [
    {
      key: 'unit',
      type: 'name',
      header: zh.hostOps.svc.unit,
      value: (service) => service.unit,
      dot: (service) =>
        service.active === 'active' ? 'ok' : service.active === 'failed' ? 'danger' : 'neutral',
    },
    {
      key: 'state',
      type: 'status',
      header: zh.fields.status,
      status: (service) => ({
        tone:
          service.active === 'active' ? 'ok' : service.active === 'failed' ? 'danger' : 'neutral',
        label: `${service.active} (${service.sub})`,
      }),
    },
    {
      key: 'description',
      type: 'text',
      header: zh.hostOps.svc.description,
      value: (service) => service.description || '—',
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <Stack gap={3}>
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading && services === undefined ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      <Table
        rows={services}
        columns={columns}
        rowKey={(service) => service.unit}
        objectLabel={zh.hostOps.services}
        rowActions={() => [action('hostOps.svcLogs'), action('hostOps.svcRestart')]}
        rowActionDisabled={(_ref, service) => {
          if (disabled) return zh.channels.controlFailed;
          if (validateServiceUnit(service.unit) === 'protected') return zh.hostOps.svc.protectedUnit;
          return undefined;
        }}
        onRowAction={(ref, service) => {
          if (ref.id === 'hostOps.svcLogs') onOpenLogs(service.unit);
          else setRestartTarget(service);
        }}
        empty={{
          icon: 'shield',
          title: zh.ops.noData,
        }}
      />
      <Row gap={2}>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void load()}
        />
      </Row>

      <AdvancedSection title={zh.hostOps.logsErrors.sectionTitle}>
        <p className="ui-field-help">{zh.hostOps.logsErrors.sectionHint}</p>
        <SystemErrorsSegment hubId={hubId} disabled={disabled} />
      </AdvancedSection>

      {restartTarget ? (
        <ConfirmAction
          open
          action={action('hostOps.svcRestart')}
          title={fmt(zh.hostOps.svc.restartTitle, { unit: restartTarget.unit })}
          body={fmt(zh.hostOps.svc.restartBody, { unit: restartTarget.unit })}
          confirmLabel={zh.hostOps.svc.restart}
          targetName={restartTarget.unit}
          onCancel={() => setRestartTarget(null)}
          onConfirm={() => restart(restartTarget)}
        />
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ cron 段 */

/**
 * 定时任务段（#E2）：只管理 /etc/cron.d/khc-* 白名单条目；
 * 面板外文件只读展示计数；新增/编辑进页面级抽屉，删除 L2 确认。
 */
export function CronSegment({
  hubId,
  disabled,
  onEdit,
  reloadToken,
}: {
  hubId: string;
  disabled: boolean;
  onEdit: (entry: HostOpsCronEntry | null) => void;
  reloadToken: number;
}) {
  const [list, setList] = useState<HostOpsCronList | undefined>(undefined);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HostOpsCronEntry | null>(null);
  const toast = useToast();

  const load = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'cron.list');
      if (!result.ok) setError(result.error);
      else setList(normalizeCronList(result.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, disabled]);

  const remove = async (entry: HostOpsCronEntry) => {
    const result = await callHostOps(hubId, 'self', 'cron.set', {
      name: entry.name,
      remove: true,
    });
    if (!result.ok) {
      if (result.error) setError(result.error);
      throw new Error(hostOpsErrorTitle(result.error));
    }
    setRemoveTarget(null);
    toast.show({ message: fmt(zh.hostOps.cron.removed, { name: entry.name }) });
    await load();
  };

  const toggle = async (entry: HostOpsCronEntry) => {
    const result = await callHostOps(hubId, 'self', 'cron.set', {
      name: entry.name,
      enabled: !entry.enabled,
    });
    if (!result.ok) {
      if (result.error) setError(result.error);
      return;
    }
    toast.show({
      message: fmt(
        !entry.enabled ? zh.hostOps.cron.enabled : zh.hostOps.cron.disabled,
        { name: entry.name },
      ),
    });
    await load();
  };

  const columns: ColumnDef<HostOpsCronEntry>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.fields.name,
      value: (entry) => entry.name,
    },
    {
      key: 'enabled',
      type: 'status',
      header: zh.fields.status,
      status: (entry) => ({
        tone: entry.enabled ? 'ok' : 'neutral',
        label: entry.enabled ? zh.hostOps.cron.stateEnabled : zh.hostOps.cron.stateDisabled,
      }),
    },
    {
      key: 'schedule',
      type: 'mono',
      header: zh.hostOps.cron.firstLine,
      value: (entry) => entry.lines.find((line) => !line.trim().startsWith('#')) || '—',
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <Stack gap={3}>
      {list && !list.available ? (
        <Banner tone="warn" title={fmt(zh.hostOps.cron.unavailable, { dir: list.dir })} />
      ) : null}
      {list && list.available && !list.writable ? (
        <Banner tone="warn" title={zh.hostOps.cron.readOnly} />
      ) : null}
      {list && list.unmanaged.length > 0 ? (
        <Banner
          tone="neutral"
          title={fmt(zh.hostOps.cron.foreignFiles, { count: String(list.unmanaged.length) })}
        />
      ) : null}
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading && list === undefined ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      <Table
        rows={list?.managed}
        columns={columns}
        rowKey={(entry) => entry.name}
        objectLabel={zh.hostOps.cron.title}
        rowActions={() => [action('hostOps.cronToggle'), action('hostOps.cronEdit'), action('hostOps.cronRemove')]}
        rowActionDisabled={(_ref, entry) => {
          if (disabled) return zh.channels.controlFailed;
          if (list && !list.available) return zh.hostOps.cron.unavailableShort;
          return undefined;
        }}
        onRowAction={(ref, entry) => {
          if (ref.id === 'hostOps.cronToggle') void toggle(entry);
          else if (ref.id === 'hostOps.cronEdit') onEdit(entry);
          else setRemoveTarget(entry);
        }}
        empty={{
          icon: 'refresh',
          title: zh.hostOps.cron.empty,
          action: disabled ? undefined : (
            <Button
              label={zh.actions['hostOps.cronAdd']}
              size="sm"
              variant="primary"
              onClick={() => onEdit(null)}
            />
          ),
        }}
      />
      <Row gap={2}>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void load()}
        />
        <Button
          label={zh.actions['hostOps.cronAdd']}
          icon="plus"
          size="sm"
          variant="primary"
          disabled={disabled || (list ? !list.available : false)}
          disabledReason={
            disabled
              ? zh.channels.controlFailed
              : list && !list.available
                ? zh.hostOps.cron.unavailableShort
                : undefined
          }
          onClick={() => onEdit(null)}
        />
      </Row>

      {removeTarget ? (
        <ConfirmAction
          open
          action={action('hostOps.cronRemove')}
          title={fmt(zh.hostOps.cron.removeTitle, { name: removeTarget.name })}
          body={fmt(zh.hostOps.cron.removeBody, { file: removeTarget.file })}
          confirmLabel={zh.hostOps.cron.remove}
          targetName={removeTarget.name}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => remove(removeTarget)}
        />
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------- cron 编辑表单 */

/** cron 条目表单：渲染在页面级唯一抽屉内；新建/编辑共用（#E2）。 */
export function CronEntryForm({
  hubId,
  entry,
  onSaved,
}: {
  hubId: string;
  entry: HostOpsCronEntry | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(entry?.name ?? '');
  const [content, setContent] = useState(entry ? entry.lines.join('\n') : '');
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmedName = name.trim();
    const nameError = validateCronName(trimmedName);
    if (nameError) {
      setFieldError(zh.hostOps.cron.invalidName);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'cron.set', {
        name: trimmedName,
        content,
        enabled,
      });
      if (!result.ok) {
        if (result.error) setError(result.error);
        return;
      }
      toast.show({ message: zh.hostOps.cron.saved });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap={3}>
      <Banner tone="info" title={zh.hostOps.cron.formHint} />
      <Field
        id="hostops-cron-name"
        label={zh.fields.name}
        help={zh.hostOps.cron.nameHelp}
        error={fieldError ?? undefined}
      >
        <TextInput
          id="hostops-cron-name"
          value={name}
          onChange={setName}
          disabled={entry !== null}
        />
      </Field>
      <Field
        id="hostops-cron-content"
        label={zh.hostOps.cron.contentLabel}
        help={zh.hostOps.cron.contentHelp}
        error={undefined}
      >
        <Textarea
          id="hostops-cron-content"
          value={content}
          mono
          rows={6}
          placeholder={'*/5 * * * * root /usr/local/bin/job\n'}
          onChange={setContent}
        />
      </Field>
      <Field id="hostops-cron-enabled" label={zh.hostOps.cron.enabledLabel}>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel={zh.hostOps.cron.enabledLabel}
          options={[
            { value: 'on', label: zh.hostOps.cron.stateEnabled },
            { value: 'off', label: zh.hostOps.cron.stateDisabled },
          ]}
          onChange={(value) => setEnabled(value === 'on')}
        />
      </Field>
      {error ? <HostOpsErrorBanner error={error} /> : null}
      <Row gap={2}>
        <Button
          label={zh.common.save}
          variant="primary"
          loading={saving}
          onClick={() => void save()}
        />
      </Row>
    </Stack>
  );
}

/* ------------------------------------------------------------ svc 日志抽屉 */

/** 服务日志面板（#E1）：挂载即经 svc.logs 尾读 200 行（journalctl short-iso）。 */
export function SvcLogsPanel({ hubId, unit }: { hubId: string; unit: string }) {
  const [logs, setLogs] = useState<{ unit: string; lines: string[] } | undefined>(undefined);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'svc.logs', { unit, lines: 200 });
      if (!result.ok) setError(result.error);
      else setLogs(normalizeSvcLogs(result.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  return (
    <Stack gap={3}>
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading && logs === undefined ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      {logs ? (
        <CodeBlock
          code={logs.lines.join('\n') || zh.hostOps.svc.noLogs}
          label={fmt(zh.hostOps.svc.logsLabel, { unit: logs.unit })}
        />
      ) : null}
      <Row gap={2}>
        <Button label={zh.common.refresh} icon="refresh" size="sm" loading={loading} onClick={() => void load()} />
      </Row>
    </Stack>
  );
}

/* ------------------------------------------------------------------ 进程段 */

/** /proc 的 startTime 是开机后的 clock ticks；有 uptime 时换算为墙钟时间。 */
export function processStartTime(startTime: number | null, hostUptime: number | null): string {
  if (startTime === null) return '—';
  if (startTime > 1_000_000_000) return formatAbsoluteTime(startTime);
  if (hostUptime === null) return '—';
  const boot = Math.floor(Date.now() / 1000 - hostUptime);
  return formatAbsoluteTime(Math.floor(boot + startTime / 100));
}

/**
 * 进程段（ui-redesign §4）：进入分段时按需 snapshot；排序受控（状态带 CPU/内存下钻）；
 * 行点击由页面级唯一抽屉展示详情（不再弹二级 Dialog）。
 */
export function ProcessesSegment({
  hubId,
  disabled,
  sort,
  onSortChange,
  onOpenProcess,
}: {
  hubId: string;
  disabled: boolean;
  sort: 'cpu' | 'mem';
  onSortChange: (sort: 'cpu' | 'mem') => void;
  onOpenProcess: (process: HostOpsProcess, hostUptime: number | null) => void;
}) {
  const [processes, setProcesses] = useState<HostOpsProcess[] | undefined>(undefined);
  const [scope, setScope] = useState<'business' | 'all'>('business');
  const [hostUptime, setHostUptime] = useState<number | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (nextSort: 'cpu' | 'mem') => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await callHostOps(hubId, 'self', 'snapshot', {
        processes: true,
        sort: nextSort,
        limit: 20,
      });
      if (snapshot.ok) {
        const status = normalizeStatus(snapshot.data);
        setReadOnly(normalizeVersion(snapshot.data).root === false);
        setHostUptime(status.uptime);
        setProcesses(normalizeProcesses(snapshot.data));
      } else {
        setError(snapshot.error);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, disabled]);

  // 系统进程数是真实计数：业务视图下即真实隐藏数；「显示全部」时隐藏数为 0。
  const systemCount = processes ? countSystemProcesses(processes) : 0;
  const visibleProcesses = processes
    ? scope === 'business'
      ? businessProcesses(processes)
      : processes
    : undefined;

  const columns: ColumnDef<HostOpsProcess>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.hostOps.process.name,
      value: (process) => process.name,
    },
    {
      key: 'pid',
      type: 'text',
      header: zh.hostOps.process.pid,
      priority: 'low',
      value: (process) => String(process.pid),
    },
    {
      key: 'cpu',
      type: 'text',
      header: zh.hostOps.process.cpu,
      value: (process) => formatPercent(process.cpu),
    },
    {
      key: 'cmd',
      type: 'mono',
      header: zh.hostOps.process.cmd,
      value: (process) => process.cmdline,
    },
    {
      key: 'user',
      type: 'text',
      header: zh.hostOps.process.user,
      value: (process) => process.user,
    },
    {
      key: 'mem',
      type: 'text',
      header: zh.hostOps.process.mem,
      value: (process) =>
        process.mem === null ? '—' : formatBytes(process.mem * 1024 * 1024),
    },
    {
      key: 'start',
      type: 'text',
      header: zh.hostOps.process.start,
      value: (process) => processStartTime(process.startTime, hostUptime),
    },
  ];

  return (
    <Stack gap={3}>
      {readOnly ? <Banner tone="neutral" title={zh.hostOps.process.readOnly} /> : null}
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load(sort)} /> : null}
      <Row gap={3} wrap>
        <Segmented
          value={sort}
          ariaLabel={zh.hostOps.processesTitle}
          options={[
            { value: 'cpu', label: zh.hostOps.process.sortCpu },
            { value: 'mem', label: zh.hostOps.process.sortMem },
          ]}
          onChange={(value) => onSortChange(value === 'mem' ? 'mem' : 'cpu')}
        />
        <Segmented
          value={scope}
          ariaLabel={zh.hostOps.process.filterLabel}
          options={[
            { value: 'business', label: zh.hostOps.process.filterBusiness },
            { value: 'all', label: zh.hostOps.process.filterAll },
          ]}
          onChange={(value) => setScope(value === 'all' ? 'all' : 'business')}
        />
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void load(sort)}
        />
      </Row>
      {processes ? (
        <p className="ui-field-help">
          {scope === 'business'
            ? fmt(zh.hostOps.process.filteredHint, { count: String(systemCount) })
            : fmt(zh.hostOps.process.filterAllHint, { count: String(systemCount) })}
        </p>
      ) : null}
      {loading && processes === undefined ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      <Table
        rows={visibleProcesses}
        columns={columns}
        rowKey={(process) => String(process.pid)}
        objectLabel={zh.hostOps.processes}
        onRowOpen={(process) => onOpenProcess(process, hostUptime)}
        empty={{
          icon: 'activity',
          title:
            scope === 'business' && processes ? zh.hostOps.process.emptyBusiness : zh.hostOps.process.empty,
          action: disabled ? undefined : (
            <Button label={zh.common.retry} size="sm" onClick={() => void load(sort)} />
          ),
        }}
      />
    </Stack>
  );
}

/* ---------------------------------------------------------------- 公钥段 */

/**
 * SSH 公钥段（ui-redesign §4）：列表 + 行内移除（页面级确认）；
 * 添加表单进入页面级唯一抽屉（key-add），添加成功后通过 reloadToken 刷新。
 */
export function KeysSegment({
  hubId,
  disabled,
  onAdd,
  reloadToken,
}: {
  hubId: string;
  disabled: boolean;
  onAdd: () => void;
  reloadToken: number;
}) {
  const [keys, setKeys] = useState<HostOpsKey[] | undefined>(undefined);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HostOpsKey | null>(null);
  const toast = useToast();

  const load = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      // call 是 Agent 写锁动作；读动词也串行，避免并发拿不到锁。
      const versionResult = await callHostOps(hubId, 'self', 'version');
      const keysResult = await callHostOps(hubId, 'self', 'keys.list', {});
      if (versionResult.ok) setVersion(normalizeVersion(versionResult.data));
      if (!keysResult.ok) setError(keysResult.error);
      else setKeys(normalizeKeys(keysResult.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, disabled]);

  const readOnly = version?.root === false;

  const remove = async (key: HostOpsKey) => {
    const result = await callHostOps(hubId, 'self', 'keys.remove', {
      fingerprint: key.fingerprint,
    });
    if (!result.ok) {
      if (result.error) setError(result.error);
      throw new Error(hostOpsErrorTitle(result.error));
    }
    setRemoveTarget(null);
    toast.show({ message: zh.hostOps.keys.removed });
    await load();
  };

  const columns: ColumnDef<HostOpsKey>[] = [
    {
      key: 'fingerprint',
      type: 'name',
      header: zh.hostOps.keys.fingerprint,
      value: (key) => key.fingerprint,
    },
    {
      key: 'type',
      type: 'text',
      header: zh.hostOps.keys.type,
      value: (key) => key.type,
    },
    {
      key: 'comment',
      type: 'text',
      header: zh.hostOps.keys.comment,
      value: (key) => key.comment || '—',
    },
    {
      key: 'source',
      type: 'text',
      header: zh.hostOps.keys.source,
      value: (key) => {
        const source = key.managed ? zh.hostOps.keys.managed : zh.hostOps.keys.manual;
        return key.hubKey ? `${source} · ${zh.hostOps.keys.protected}` : source;
      },
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const rowActionDisabled = (_ref: ActionRef, key: HostOpsKey): string | undefined => {
    if (disabled) return zh.channels.controlFailed;
    if (readOnly) return zh.hostOps.noPriv;
    if (key.hubKey) return zh.hostOps.keys.protected;
    if (!key.managed) return zh.hostOps.keys.managedOnly;
    return undefined;
  };

  return (
    <Stack gap={3}>
      {readOnly ? <Banner tone="warn" title={zh.hostOps.keys.noPriv} /> : null}
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading && keys === undefined ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      <Table
        rows={keys}
        columns={columns}
        rowKey={(key) => key.fingerprint}
        objectLabel={zh.hostOps.sshKeys}
        rowActions={() => [action('hostOps.keyRemove')]}
        rowActionDisabled={rowActionDisabled}
        onRowAction={(_ref, key) => setRemoveTarget(key)}
        empty={{
          icon: 'key',
          title: zh.hostOps.keys.empty,
          action: disabled ? undefined : (
            <Button label={zh.actions['hostOps.keyAdd']} size="sm" variant="primary" onClick={onAdd} />
          ),
        }}
      />
      <Row gap={2}>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void load()}
        />
        <Button
          label={zh.actions['hostOps.keyAdd']}
          icon="plus"
          size="sm"
          variant="primary"
          disabled={disabled || readOnly}
          disabledReason={
            disabled ? zh.channels.controlFailed : readOnly ? zh.hostOps.noPriv : undefined
          }
          onClick={onAdd}
        />
      </Row>

      {removeTarget ? (
        <ConfirmAction
          open
          action={action('hostOps.keyRemove')}
          title={fmt(zh.hostOps.keys.removeTitle, { fingerprint: removeTarget.fingerprint })}
          body={zh.hostOps.keys.removeBody}
          confirmLabel={zh.hostOps.keys.remove}
          targetName={removeTarget.fingerprint}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => remove(removeTarget)}
        />
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------- 公钥添加表单 */

const PUBLIC_KEY_RE =
  /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,2}( .*)?$/;

/** 添加公钥表单：渲染在页面级唯一抽屉内（ui-redesign §4，原 Dialog 改抽屉）。 */
export function KeyAddForm({
  hubId,
  onAdded,
}: {
  hubId: string;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [publicKey, setPublicKey] = useState('');
  const [label, setLabel] = useState('');
  const [addError, setAddError] = useState<HostOpsError | null>(null);
  const [addFieldError, setAddFieldError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // 全局公钥库：抽屉打开时按需读取一次；失败不阻塞手动粘贴。
  const [library, setLibrary] = useState<SshKey[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [selectedKeyId, setSelectedKeyId] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchSshKeys()
      .then((keys) => {
        if (!cancelled) setLibrary(keys);
      })
      .catch(() => {
        if (!cancelled) setLibrary([]);
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickFromLibrary = (id: string) => {
    const key = (library ?? []).find((item) => item.id === id);
    if (key) {
      setPublicKey(key.publicKey);
      setLabel(key.name);
    }
  };

  const add = async () => {
    const text = publicKey.trim();
    if (!PUBLIC_KEY_RE.test(text)) {
      setAddFieldError(zh.hostOps.keys.invalidPublicKey);
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'keys.add', {
        publicKey: text,
        label: label.trim(),
      });
      if (!result.ok) {
        if (result.error) setAddError(result.error);
        return;
      }
      toast.show({ message: zh.hostOps.keys.added });
      onAdded();
    } finally {
      setAdding(false);
    }
  };

  return (
    <Stack gap={3}>
      <Field
        id="hostops-key-library"
        label={zh.hostOps.keys.fromLibrary}
        help={
          library !== null && library.length === 0
            ? zh.hostOps.keys.libraryEmpty
            : zh.hostOps.keys.fromLibraryHelp
        }
      >
        <Select
          id="hostops-key-library"
          value={selectedKeyId}
          disabled={libraryLoading || library === null || library.length === 0}
          placeholder={libraryLoading ? zh.common.loading : zh.hostOps.keys.fromLibraryPlaceholder}
          options={(library ?? []).map((key) => ({
            value: key.id,
            label: `${key.name} · ${key.fingerprint.slice(0, 20)}…`,
          }))}
          onChange={(id) => {
            setSelectedKeyId(id);
            pickFromLibrary(id);
          }}
        />
      </Field>
      <Field
        id="hostops-key-public"
        label={zh.hostOps.keys.publicKey}
        help={zh.hostOps.keys.publicKeyHelp}
        error={addFieldError ?? undefined}
      >
        <Textarea
          id="hostops-key-public"
          value={publicKey}
          mono
          rows={5}
          placeholder="ssh-ed25519 AAAA..."
          onChange={setPublicKey}
        />
      </Field>
      <Field id="hostops-key-label" label={zh.hostOps.keys.label} optional>
        <TextInput id="hostops-key-label" value={label} onChange={setLabel} />
      </Field>
      {addError ? <HostOpsErrorBanner error={addError} /> : null}
      <Row gap={2}>
        <Button
          label={zh.actions['hostOps.keyAdd']}
          variant="primary"
          loading={adding}
          onClick={() => void add()}
        />
      </Row>
    </Stack>
  );
}

/* -------------------------------------------------------- 系统错误折叠区 */

const LOG_LEVEL_LABELS: Record<string, string> = {
  '0': zh.hostOps.logsErrors.levelEmergency,
  '1': zh.hostOps.logsErrors.levelAlert,
  '2': zh.hostOps.logsErrors.levelCritical,
  '3': zh.hostOps.logsErrors.levelError,
};

function logLevelLabel(entry: HostOpsLogEntry): string {
  if (entry.oom) return zh.hostOps.logsErrors.levelOom;
  return LOG_LEVEL_LABELS[entry.priority] ?? zh.hostOps.logsErrors.levelOther;
}

/**
 * 系统错误折叠区（§3.5）：挂在服务分段内，由 AdvancedSection 按需挂载，
 * 只有用户展开时才调用只读动词 logs.errors，不自动轮询。
 * 四态沿用 ServicesSegment；错误日志与 OOM 合并成一张对象表，不新增详情入口。
 */
function SystemErrorsSegment({
  hubId,
  disabled,
}: {
  hubId: string;
  disabled: boolean;
}) {
  const [logs, setLogs] = useState<HostOpsLogErrors | undefined>(undefined);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'logs.errors');
      if (!result.ok) setError(result.error);
      else setLogs(normalizeLogErrors(result.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const columns: ColumnDef<HostOpsLogEntry>[] = [
    {
      key: 'message',
      type: 'name',
      header: zh.hostOps.logsErrors.message,
      value: (entry) => entry.message,
      dot: (entry) => (entry.oom ? 'danger' : undefined),
      narrow: (entry) => `${logLevelLabel(entry)} · ${formatAbsoluteTime(entry.time)}`,
    },
    {
      key: 'level',
      type: 'text',
      header: zh.hostOps.logsErrors.level,
      priority: 'low',
      value: (entry) => logLevelLabel(entry),
    },
    {
      key: 'time',
      type: 'time',
      header: zh.hostOps.logsErrors.time,
      priority: 'low',
      value: (entry) => entry.time,
    },
  ];

  return (
    <Stack gap={3}>
      {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading && logs === undefined && !error ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}
      {logs ? (
        <p className="ui-field-help">
          {fmt(zh.hostOps.logsErrors.summary, {
            hours: logs.windowHours,
            count: logs.count,
            oom: logs.oomCount,
          })}
        </p>
      ) : null}
      {error && logs === undefined ? null : (
        <Table
          rows={logs?.entries}
          columns={columns}
          rowKey={(entry) => entry.id}
          objectLabel={zh.hostOps.logsErrors.title}
          empty={{
            icon: 'alert',
            title: zh.hostOps.logsErrors.empty,
            description: zh.hostOps.logsErrors.emptyDesc,
          }}
        />
      )}
      <Row gap={2}>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void load()}
        />
      </Row>
    </Stack>
  );
}
