import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, type ActionRef } from '../../registry/actions';
import {
  HOST_OPS_TARGET_SELF,
  HostOpsQueryError,
  callHostOpsTask,
  hostOpsQueryKey,
  hostOpsQueryOptions,
  normalizeTuneStatus,
  type HostOpsError,
  type HostOpsTuneStatus,
  type HostOpsVerb,
} from '../../data/hostOps';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  KeyValue,
  Row,
  Segmented,
  Skeleton,
  Stack,
  Table,
  useToast,
  type ColumnDef,
  type Tone,
} from '../../ui';
import { fmt, zh } from '../../i18n/zh';
import { formatBytes } from '../../i18n/format';
import { SNAPSHOT_DEDUPE_DELAY_MS } from './refreshAfterWrite';

export type TuneItemId = 'swap' | 'bbr' | 'journal' | 'apt';

interface TunePrimaryAction {
  actionRef: ActionRef;
  verb: HostOpsVerb;
  params: Record<string, unknown>;
  buttonLabel: string;
  danger?: boolean;
  disabledReason?: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
  toastText: (data: unknown) => string;
}

interface TuneItemSpec {
  id: TuneItemId;
  name: string;
  openable?: boolean;
  dot: (status: HostOpsTuneStatus) => Tone;
  statusBadge: (status: HostOpsTuneStatus) => { tone: Tone; label: string };
  summary: (status: HostOpsTuneStatus) => string;
  primaryAction: (status: HostOpsTuneStatus) => TunePrimaryAction | null;
}

export interface TuneRow {
  id: TuneItemId;
  name: string;
  openable: boolean;
  dot: Tone;
  status: { tone: Tone; label: string };
  summary: string;
  action: TunePrimaryAction | null;
}

/** 声明式主机优化注册表：后续新增 zram、时区等只需在此追加定义与对应白名单动词。 */
export const HOST_TUNE_ITEMS: readonly TuneItemSpec[] = [
  {
    id: 'swap',
    name: zh.hostOps.tune.swapName,
    openable: true,
    dot: (s) => (s.swap.active ? 'ok' : 'neutral'),
    statusBadge: (s) => {
      if (!s.swap.active) return { tone: 'neutral', label: zh.hostOps.tune.swapOff };
      const size = formatBytes(s.swap.totalBytes);
      if (s.swap.external && !s.swap.managed) {
        return { tone: 'ok', label: fmt(zh.hostOps.tune.swapExternal, { size }) };
      }
      return { tone: 'ok', label: fmt(zh.hostOps.tune.swapOn, { size }) };
    },
    summary: (s) => {
      if (!s.swap.active) return zh.hostOps.tune.swapRecommend;
      return s.swap.percent > 0
        ? fmt(zh.hostOps.tune.swapUsed, { percent: String(Math.round(s.swap.percent)) })
        : zh.hostOps.tune.swapUsedZero;
    },
    primaryAction: (s) => {
      if (s.swap.external && !s.swap.managed) return null;
      if (!s.swap.active) {
        return {
          actionRef: action('hostOps.tuneSwap'),
          verb: 'tune.swap',
          params: { action: 'create', sizeGb: 2 },
          buttonLabel: zh.hostOps.tune.swapEnable2g,
          confirmTitle: fmt(zh.hostOps.tune.swapCreateTitle, { size: '2' }),
          confirmBody: fmt(zh.hostOps.tune.swapCreateBody, { size: '2' }),
          confirmLabel: zh.hostOps.tune.swapEnable2g,
          toastText: () => fmt(zh.hostOps.tune.swapCreated, { size: '2' }),
        };
      }
      return {
        actionRef: action('hostOps.tuneSwap'),
        verb: 'tune.swap',
        params: { action: 'remove' },
        buttonLabel: zh.hostOps.tune.swapDisable,
        danger: true,
        confirmTitle: zh.hostOps.tune.swapRemoveTitle,
        confirmBody: zh.hostOps.tune.swapRemoveBody,
        confirmLabel: zh.hostOps.tune.swapDisable,
        toastText: () => zh.hostOps.tune.swapRemoved,
      };
    },
  },
  {
    id: 'bbr',
    name: zh.hostOps.tune.bbrName,
    dot: (s) => (s.bbr.enabled ? 'ok' : 'neutral'),
    statusBadge: (s) => {
      if (!s.bbr.supported) return { tone: 'neutral', label: zh.hostOps.tune.bbrUnsupported };
      return s.bbr.enabled
        ? { tone: 'ok', label: zh.hostOps.tune.bbrOn }
        : { tone: 'neutral', label: zh.hostOps.tune.bbrOff };
    },
    summary: (s) => (s.bbr.enabled ? zh.hostOps.tune.bbrSummary : zh.hostOps.tune.bbrSummaryTcp),
    primaryAction: (s) => {
      if (!s.bbr.supported) {
        return {
          actionRef: action('hostOps.tuneBbr'),
          verb: 'tune.bbr',
          params: { enabled: true },
          buttonLabel: zh.hostOps.tune.bbrEnable,
          disabledReason: zh.hostOps.tune.bbrUnsupportedReason,
          confirmTitle: zh.hostOps.tune.bbrEnableTitle,
          confirmBody: zh.hostOps.tune.bbrEnableBody,
          confirmLabel: zh.hostOps.tune.bbrEnable,
          toastText: () => zh.hostOps.tune.bbrEnabled,
        };
      }
      if (!s.bbr.enabled) {
        return {
          actionRef: action('hostOps.tuneBbr'),
          verb: 'tune.bbr',
          params: { enabled: true },
          buttonLabel: zh.hostOps.tune.bbrEnable,
          confirmTitle: zh.hostOps.tune.bbrEnableTitle,
          confirmBody: zh.hostOps.tune.bbrEnableBody,
          confirmLabel: zh.hostOps.tune.bbrEnable,
          toastText: () => zh.hostOps.tune.bbrEnabled,
        };
      }
      return {
        actionRef: action('hostOps.tuneBbr'),
        verb: 'tune.bbr',
        params: { enabled: false },
        buttonLabel: zh.hostOps.tune.bbrDisable,
        confirmTitle: zh.hostOps.tune.bbrDisableTitle,
        confirmBody: zh.hostOps.tune.bbrDisableBody,
        confirmLabel: zh.hostOps.tune.bbrDisable,
        toastText: () => zh.hostOps.tune.bbrDisabled,
      };
    },
  },
  {
    id: 'journal',
    name: zh.hostOps.tune.journalName,
    dot: (s) => (s.journal.managed ? 'ok' : 'neutral'),
    statusBadge: (s) => {
      if (!s.journal.available) return { tone: 'neutral', label: zh.hostOps.tune.journalUnavailable };
      const used = s.journal.usedBytes === null ? '—' : formatBytes(s.journal.usedBytes);
      return { tone: 'neutral', label: fmt(zh.hostOps.tune.journalUsed, { size: used }) };
    },
    summary: (s) =>
      s.journal.maxUse
        ? fmt(zh.hostOps.tune.journalCap, { cap: s.journal.maxUse })
        : zh.hostOps.tune.journalUncapped,
    primaryAction: (s) => {
      if (!s.journal.available) return null;
      return {
        actionRef: action('hostOps.tuneJournal'),
        verb: 'tune.journal-vacuum',
        params: { maxSizeMb: 100 },
        buttonLabel: zh.hostOps.tune.journalAction,
        confirmTitle: zh.hostOps.tune.journalTitle,
        confirmBody: zh.hostOps.tune.journalBody,
        confirmLabel: zh.hostOps.tune.journalAction,
        toastText: () => zh.hostOps.tune.journalDone,
      };
    },
  },
  {
    id: 'apt',
    name: zh.hostOps.tune.aptName,
    dot: () => 'neutral',
    statusBadge: (s) => {
      if (!s.apt.available) return { tone: 'neutral', label: zh.hostOps.tune.aptUnavailable };
      return { tone: 'neutral', label: fmt(zh.hostOps.tune.aptUsed, { size: formatBytes(s.apt.cacheBytes) }) };
    },
    summary: () => zh.hostOps.tune.aptSummary,
    primaryAction: (s) => {
      if (!s.apt.available) return null;
      return {
        actionRef: action('hostOps.tuneApt'),
        verb: 'tune.apt-clean',
        params: {},
        buttonLabel: zh.hostOps.tune.aptAction,
        confirmTitle: zh.hostOps.tune.aptTitle,
        confirmBody: zh.hostOps.tune.aptBody,
        confirmLabel: zh.hostOps.tune.aptAction,
        toastText: (data) => {
          const freed =
            data && typeof data === 'object' && 'freedBytes' in data && typeof data.freedBytes === 'number'
              ? data.freedBytes
              : null;
          return freed !== null && freed > 0
            ? fmt(zh.hostOps.tune.aptDone, { freed: formatBytes(freed) })
            : zh.hostOps.tune.aptDoneSimple;
        },
      };
    },
  },
];

function buildTuneRows(status: HostOpsTuneStatus): TuneRow[] {
  return HOST_TUNE_ITEMS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    openable: Boolean(spec.openable),
    dot: spec.dot(status),
    status: spec.statusBadge(status),
    summary: spec.summary(status),
    action: spec.primaryAction(status),
  }));
}

function queryTuneError(error: unknown): HostOpsError | null {
  if (!error) return null;
  if (error instanceof HostOpsQueryError) return error.hostOpsError;
  return {
    code: 'request_failed',
    message: error instanceof Error ? error.message : String(error),
    details: null,
  };
}

function refreshAfterTune(
  queryClient: ReturnType<typeof useQueryClient>,
  hubId: string,
  live: { lastAt: number | null; refresh: () => void },
) {
  void queryClient.invalidateQueries({
    queryKey: hostOpsQueryKey(hubId, HOST_OPS_TARGET_SELF, 'tune.status', {}),
  });
  const elapsed = live.lastAt === null ? SNAPSHOT_DEDUPE_DELAY_MS : Math.max(0, Date.now() - live.lastAt);
  const remaining = SNAPSHOT_DEDUPE_DELAY_MS - elapsed;
  if (remaining <= 0) live.refresh();
  else setTimeout(() => live.refresh(), remaining);
}

/**
 * 主机「优化」分段（P2）：标准 4 列 Table + 可扩展 HOST_TUNE_ITEMS 注册表，
 * 零说明堆砌、默认单表即用，低频 Swap 档位收进唯一抽屉。
 */
export function TuneSegment({
  hubId,
  disabled,
  onOpenSwapDrawer,
}: {
  hubId: string;
  disabled: boolean;
  onOpenSwapDrawer: () => void;
}) {
  const [actionError, setActionError] = useState<HostOpsError | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ row: TuneRow; spec: TunePrimaryAction } | null>(null);
  const [busyId, setBusyId] = useState<TuneItemId | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { live } = useHubChannelsContext();

  const tuneQuery = useQuery({
    ...hostOpsQueryOptions(hubId, HOST_OPS_TARGET_SELF, 'tune.status', {}),
    enabled: !disabled,
  });

  const tuneStatus = useMemo(
    () => (tuneQuery.data ? normalizeTuneStatus(tuneQuery.data.data) : undefined),
    [tuneQuery.data],
  );
  const rows = useMemo(() => (tuneStatus ? buildTuneRows(tuneStatus) : undefined), [tuneStatus]);
  const error = actionError ?? queryTuneError(tuneQuery.error);
  const showSkeleton = tuneQuery.isPending && tuneQuery.isFetching && rows === undefined;

  const reload = async () => {
    if (disabled) return;
    setActionError(null);
    await tuneQuery.refetch();
  };

  const execute = async (row: TuneRow, spec: TunePrimaryAction) => {
    setBusyId(row.id);
    try {
      const result = await callHostOpsTask(hubId, HOST_OPS_TARGET_SELF, spec.verb, spec.params);
      if (!result.ok) {
        const err = result.error ?? {
          code: 'E_UNKNOWN',
          message: zh.hostOps.tune.actionFailed,
          details: null,
        };
        setActionError(err);
        throw new Error(err.message || zh.hostOps.tune.actionFailed);
      }
      setActionError(null);
      setConfirmTarget(null);
      toast.show({ message: spec.toastText(result.data) });
      await queryClient.invalidateQueries({
        queryKey: hostOpsQueryKey(hubId, HOST_OPS_TARGET_SELF, 'tune.status', {}),
      });
      refreshAfterTune(queryClient, hubId, live);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnDef<TuneRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.hostOps.tune.colItem,
      width: '26%',
      value: (row) => row.name,
      dot: (row) => row.dot,
    },
    {
      key: 'status',
      type: 'status',
      header: zh.fields.status,
      width: '26%',
      status: (row) => row.status,
    },
    {
      key: 'summary',
      type: 'text',
      header: zh.hostOps.tune.colSummary,
      value: (row) => row.summary,
    },
    {
      key: 'actions',
      type: 'actions',
      header: '',
      width: '156px',
      render: (row) => {
        const spec = row.action;
        if (!spec) return <span className="ui-cell-muted">—</span>;
        const disabledReason = disabled ? zh.channels.controlFailed : spec.disabledReason;
        return (
          <span className="ui-cell-actions" onClick={(event) => event.stopPropagation()}>
            <Button
              label={spec.buttonLabel}
              size="sm"
              variant={spec.danger ? 'danger' : 'default'}
              loading={busyId === row.id}
              disabled={Boolean(disabledReason) || (busyId !== null && busyId !== row.id)}
              disabledReason={disabledReason}
              onClick={() => setConfirmTarget({ row, spec })}
            />
          </span>
        );
      },
    },
  ];

  return (
    <Stack gap={3}>
      {error ? (
        <Banner
          tone="danger"
          title={error.message || zh.hostOps.tune.loadFailed}
          action={<Button label={zh.common.retry} size="sm" onClick={() => void reload()} />}
        />
      ) : null}

      {showSkeleton ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}

      <Table
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        objectLabel={zh.hostOps.tune.title}
        onRowOpen={(row) => {
          if (row.openable) onOpenSwapDrawer();
        }}
        rowActions={(row) => (row.action ? [row.action.actionRef] : [])}
        rowActionDisabled={(_ref, row) =>
          disabled ? zh.channels.controlFailed : row.action?.disabledReason
        }
        onRowAction={(_ref, row) => {
          if (row.action) setConfirmTarget({ row, spec: row.action });
        }}
        empty={{
          icon: 'settings',
          title: zh.ops.noData,
        }}
      />

      <Row gap={2}>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          size="sm"
          loading={tuneQuery.isFetching}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void reload()}
        />
      </Row>

      {confirmTarget ? (
        <ConfirmAction
          open
          action={confirmTarget.spec.actionRef}
          title={confirmTarget.spec.confirmTitle}
          body={confirmTarget.spec.confirmBody}
          confirmLabel={confirmTarget.spec.confirmLabel}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => execute(confirmTarget.row, confirmTarget.spec)}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Swap 档位抽屉（唯一 Drawer 内容：可选 1G/2G/4G 或关闭；抽屉内不弹 Dialog）。
 */
export function SwapTuneDrawerBody({
  hubId,
  disabled,
  onDone,
}: {
  hubId: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [sizeGb, setSizeGb] = useState<'1' | '2' | '4'>('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { live } = useHubChannelsContext();

  const tuneQuery = useQuery({
    ...hostOpsQueryOptions(hubId, HOST_OPS_TARGET_SELF, 'tune.status', {}),
    enabled: !disabled,
  });
  const swap = tuneQuery.data ? normalizeTuneStatus(tuneQuery.data.data).swap : null;

  const submit = async (payload: { action: 'create' | 'remove'; sizeGb?: number }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await callHostOpsTask(hubId, HOST_OPS_TARGET_SELF, 'tune.swap', payload);
      if (!result.ok) {
        setError(result.error?.message || zh.hostOps.tune.actionFailed);
        return;
      }
      toast.show({
        message:
          payload.action === 'create'
            ? fmt(zh.hostOps.tune.swapCreated, { size: String(payload.sizeGb ?? 2) })
            : zh.hostOps.tune.swapRemoved,
      });
      refreshAfterTune(queryClient, hubId, live);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  if (tuneQuery.isPending && !swap) {
    return (
      <Stack gap={2}>
        <Skeleton height={10} width="50%" />
        <Skeleton height={10} />
      </Stack>
    );
  }

  return (
    <Stack gap={3}>
      {error ? <Banner tone="danger" title={error} /> : null}

      {swap ? (
        <KeyValue
          items={[
            {
              key: zh.hostOps.tune.kvState,
              value: !swap.active
                ? zh.hostOps.tune.swapOff
                : swap.external && !swap.managed
                  ? fmt(zh.hostOps.tune.swapExternal, { size: formatBytes(swap.totalBytes) })
                  : fmt(zh.hostOps.tune.swapOn, { size: formatBytes(swap.totalBytes) }),
            },
            ...(swap.active
              ? [
                  { key: zh.hostOps.tune.kvTotal, value: formatBytes(swap.totalBytes), mono: true },
                  { key: zh.hostOps.tune.kvUsed, value: formatBytes(swap.usedBytes), mono: true },
                ]
              : []),
            {
              key: zh.hostOps.tune.kvSwappiness,
              value: swap.swappiness === null ? '—' : String(swap.swappiness),
              mono: true,
            },
            {
              key: zh.hostOps.tune.kvRootFree,
              value: swap.rootFreeBytes === null ? '—' : formatBytes(swap.rootFreeBytes),
              mono: true,
            },
          ]}
        />
      ) : null}

      {!swap?.active ? (
        <Stack gap={2}>
          <Segmented
            value={sizeGb}
            ariaLabel={zh.hostOps.tune.swapSizeLabel}
            options={[
              { value: '1', label: fmt(zh.hostOps.tune.swapSizeOption, { size: '1' }) },
              { value: '2', label: fmt(zh.hostOps.tune.swapSizeOption, { size: '2' }) },
              { value: '4', label: fmt(zh.hostOps.tune.swapSizeOption, { size: '4' }) },
            ]}
            onChange={(value) => {
              if (value === '1' || value === '2' || value === '4') setSizeGb(value);
            }}
          />
          <p className="ui-field-help">{zh.hostOps.tune.swapSizeTip}</p>
          <Row gap={2}>
            <Button
              label={fmt(zh.hostOps.tune.swapEnableSize, { size: sizeGb })}
              variant="primary"
              loading={busy}
              disabled={disabled || busy}
              disabledReason={disabled ? zh.channels.controlFailed : undefined}
              onClick={() => void submit({ action: 'create', sizeGb: Number(sizeGb) })}
            />
          </Row>
        </Stack>
      ) : swap.external && !swap.managed ? (
        <p className="ui-field-help">{zh.hostOps.tune.swapExternalTip}</p>
      ) : (
        <Row gap={2}>
          <Button
            label={zh.hostOps.tune.swapDisable}
            variant="danger"
            loading={busy}
            disabled={disabled || busy}
            disabledReason={disabled ? zh.channels.controlFailed : undefined}
            onClick={() => void submit({ action: 'remove' })}
          />
        </Row>
      )}
    </Stack>
  );
}
