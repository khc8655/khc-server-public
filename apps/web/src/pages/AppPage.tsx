import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentState } from '@khc/contracts';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { FileChange, ResultCard, Revision } from '@khc/contracts';
import { ApiError } from '../data/client';
import {
  appConfigQueryOptions,
  hubAppsQueryOptions,
  hubQueryOptions,
  hubStateQueryOptions,
  revisionsQueryOptions,
} from '../data/queries';
import {
  fetchTask,
  rollbackApp,
  runAppAction,
  saveAppConfig,
} from '../data/apps';
import { getAppMeta } from '../apps/registry';
import { SchemaForm, type JsonSchema } from '../apps/widgets/SchemaForm';
import { action, type ActionRef } from '../registry/actions';
import { paths } from '../registry/routes';
import { ConfirmAction, SaveBar, TaskView } from '../patterns';
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  KeyValue,
  PageHeader,
  Row,
  Skeleton,
  Stack,
  Table,
  Tabs,
  useToast,
  type ColumnDef,
  type TabItem,
} from '../ui';
import { zh, fmt } from '../i18n/zh';
import { formatAbsoluteTime } from '../i18n/format';
import { useHubChannelsContext } from '../app/HubChannelsProvider';

type AppTab = 'config' | 'changes' | 'task' | 'history';

export default function AppPage() {
  const { hubId, app } = useParams({ from: '/hubs/$hubId/apps/$app' });
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = useMemo(() => getAppMeta(app), [app]);

  const hubQuery = useQuery(hubQueryOptions(hubId));
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const configQuery = useQuery(appConfigQueryOptions(hubId, app));
  const revisionsQuery = useQuery(revisionsQueryOptions(hubId, app));
  const { stateQuery, channels } = useHubChannelsContext();

  const tab: AppTab =
    search.tab === 'changes' || search.tab === 'task' || search.tab === 'history'
      ? search.tab
      : 'config';

  const [form, setForm] = useState<Record<string, unknown>>({});
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileChange[]>([]);
  const [cards, setCards] = useState<ResultCard[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [rollbackRev, setRollbackRev] = useState<number | null>(null);

  const savedConfig = useMemo(() => configQuery.data?.config ?? meta.defaults ?? {}, [
    configQuery.data,
    meta.defaults,
  ]);

  useEffect(() => {
    if (initialized || !configQuery.isSuccess) return;
    setInitialized(true);
    setForm(configQuery.data?.config ?? meta.defaults ?? {});
  }, [configQuery.isSuccess, configQuery.data, initialized, meta.defaults]);

  const dirty = initialized && JSON.stringify(form) !== JSON.stringify(savedConfig);

  const taskQuery = useQuery({
    queryKey: ['hubs', hubId, 'tasks', taskId],
    queryFn: () => fetchTask(hubId, taskId as string),
    enabled: Boolean(taskId),
    // 执行进度不自动轮询：完成后由用户点「刷新」拉取，避免持续消耗 Worker 请求。
  });

  const adapter = appsQuery.data?.adapters.find((item) => item.name === app);
  const adapterSchema = (adapter?.schema as JsonSchema | undefined) ?? null;
  const currentRev = configQuery.data?.rev ?? null;
  // appliedRev 来自一次性 /state 探测（快照不含适配器状态）。
  const liveState = stateQuery.data?.state as unknown as AgentState | undefined;
  const appliedRev =
    liveState?.adapters.find((item) => item.name === app)?.appliedRev ??
    configQuery.data?.appliedRev ??
    null;

  const setTab = (next: string) => {
    const value: AppTab =
      next === 'changes' || next === 'task' || next === 'history' ? next : 'config';
    void navigate({
      to: '/hubs/$hubId/apps/$app',
      params: { hubId, app },
      search: { tab: value },
    });
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] }),
      queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps', app, 'revisions'] }),
    ]);
  };

  const withBusy = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (quiet = false) => {
    const saved = await saveAppConfig(hubId, app, form);
    setForm(saved.config);
    await invalidate();
    if (!quiet) {
      toast.show({
        message:
          saved.appliedRev !== null && saved.appliedRev < saved.rev
            ? zh.toast.configSavedPending
            : zh.toast.configSaved,
      });
    }
  };

  const run = async (kind: 'plan' | 'apply' | 'install' | 'uninstall') => {
    const envelope = await runAppAction(hubId, app, kind);
    setDiff(envelope.changes ?? []);
    setCards(envelope.result?.cards ?? []);
    if (envelope.taskId) {
      setTaskId(envelope.taskId);
      if (kind !== 'plan') setTab('task');
    }
    if (kind !== 'plan') await invalidate();
  };

  const handleAction = (ref: ActionRef) => {
    // 保存只写控制面仓库（D1），不依赖 Worker→Hub 通道，永远允许。
    if (ref.id === 'app.save') {
      void withBusy('app.save', () => save());
      return;
    }
    if (!channels.canApply) {
      setError(zh.channels.controlUnavailableDesc);
      return;
    }
    if (ref.id === 'app.plan') {
      void withBusy('app.plan', async () => {
        await run('plan');
        setTab('changes');
      });
      return;
    }
    if (ref.id === 'app.apply') {
      void withBusy('app.apply', async () => {
        await save(true);
        await run('apply');
        toast.show({ message: zh.toast.configApplied });
      });
      return;
    }
    if (ref.id === 'app.install') {
      setInstallOpen(true);
      return;
    }
    if (ref.id === 'app.uninstall') {
      setUninstallOpen(true);
    }
  };

  const revisionColumns: ColumnDef<Revision>[] = [
    {
      key: 'rev',
      type: 'number',
      header: zh.apps.colVersion,
      value: (revision) => revision.rev,
    },
    {
      key: 'note',
      type: 'text',
      header: zh.apps.colNote,
      value: (revision) => revision.note ?? '—',
    },
    {
      key: 'time',
      type: 'time',
      header: zh.apps.colTime,
      value: (revision) => revision.createdAt,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const tabs: TabItem[] = [
    { key: 'config', label: zh.apps.tabsConfig },
    { key: 'changes', label: zh.apps.tabsChanges, count: diff.length },
    { key: 'task', label: zh.apps.tabsTask, count: taskId ? 1 : 0 },
    { key: 'history', label: zh.apps.tabsHistory, count: revisionsQuery.data?.length ?? 0 },
  ];

  const hubName = hubQuery.data?.name ?? hubId;
  const pendingApply =
    !dirty && currentRev !== null && appliedRev !== null && currentRev > appliedRev;

  return (
    <Stack gap={4}>
      <PageHeader
        title={meta.title ?? app}
        scope={hubName}
        summary={fmt(zh.apps.versionSummary, {
          config: currentRev === null ? '—' : String(currentRev),
          applied: appliedRev === null ? '—' : String(appliedRev),
        })}
        sync={
          dirty
            ? { state: 'pending', rev: currentRev ?? undefined }
            : pendingApply
              ? { state: 'queued', rev: currentRev ?? undefined }
              : { state: hubQuery.data?.status === 'online' ? 'synced' : 'queued' }
        }
        primaryAction={action('app.apply')}
        secondaryActions={
          currentRev === null
            ? [action('app.install'), action('app.plan')]
            : [action('app.plan')]
        }
        moreActions={[action('app.uninstall')]}
        actionsDisabled={!channels.canApply}
        actionsDisabledReason={zh.channels.controlUnavailableDesc}
        pendingAction={(busy as ActionRef['id'] | null) ?? undefined}
        onAction={handleAction}
      />

      {channels.presence === 'live-only' ? (
        <Banner tone="warn" title={zh.channels.liveOnlyTitle} description={zh.channels.liveOnlyDesc} />
      ) : null}
      {configQuery.isError ? (
        <Banner tone="danger" title={zh.apps.loadError} description={(configQuery.error as Error).message} />
      ) : null}
      {error ? <Banner tone="danger" title={zh.apps.loadError} description={error} /> : null}
      {appsQuery.data?.adaptersError ? (
        <Banner tone="warn" title={zh.hub.adaptersError} description={appsQuery.data.adaptersError} />
      ) : null}
      {dirty ? <Banner tone="warn" title={zh.apps.dirty} /> : null}
      {pendingApply ? (
        <Banner tone="warn" title={zh.apps.pendingApplyTitle} description={zh.apps.pendingApplyDesc} />
      ) : null}

      <Tabs items={tabs} active={tab} onChange={setTab} />

      {tab === 'config' ? (
        <Card title={zh.apps.configTitle}>
          {configQuery.isLoading ? (
            <Stack gap={3}>
              <Skeleton height={32} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </Stack>
          ) : (
            <Stack gap={4}>
              <SchemaForm schema={adapterSchema} value={form} onChange={setForm} />
              <SaveBar
                note={dirty ? zh.apps.applyNote : zh.apps.saveNote}
                dirty={dirty}
                saving={busy === 'app.save'}
                onDiscard={() => setForm(savedConfig)}
                onSave={() => void withBusy('app.save', save)}
              />
            </Stack>
          )}
        </Card>
      ) : null}

      {tab === 'changes' ? (
        cards.length > 0 || diff.length > 0 ? (
          <Stack gap={4}>
            {cards.length > 0 ? (
              <Card title={zh.apps.resultTitle}>
                <KeyValue
                  items={cards.map((card, index) => ({
                    key: `${card.title}-${index}`,
                    value: card.value,
                    mono: true,
                    mode: 'middle',
                    copyValue: card.copy ? card.value : undefined,
                  }))}
                />
              </Card>
            ) : null}
            <Card title={fmt(zh.apps.changesCount, { count: diff.length })}>
              <Stack gap={3}>
                {diff.map((change) => (
                  <CodeBlock key={change.path} code={change.diff} label={change.path} />
                ))}
              </Stack>
            </Card>
          </Stack>
        ) : (
          <Card>
            <EmptyState
              icon="terminal"
              title={zh.apps.changesEmpty}
              description={zh.apps.changesEmptyHint}
            />
          </Card>
        )
      ) : null}

      {tab === 'task' ? (
        taskQuery.data ? (
          <Stack gap={2}>
            <TaskView task={taskQuery.data.task} />
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
          <Card>
            <EmptyState icon="terminal" title={zh.apps.taskEmpty} description={zh.apps.taskEmptyHint} />
          </Card>
        )
      ) : null}

      {tab === 'history' ? (
        <Table
          rows={revisionsQuery.data}
          columns={revisionColumns}
          rowKey={(revision) => String(revision.rev)}
          objectLabel={zh.apps.tabsHistory}
          empty={{ icon: 'box', title: zh.apps.historyEmpty, description: zh.apps.historyEmptyHint }}
          rowActions={(revision) =>
            revision.rev === currentRev ? [] : [action('app.rollback')]
          }
          onRowAction={(_ref, revision) => setRollbackRev(revision.rev)}
        />
      ) : null}

      {installOpen ? (
        <ConfirmAction
          open
          action={action('app.install')}
          title={fmt(zh.apps.installTitle, { app })}
          body={zh.apps.installBody}
          confirmLabel={zh.apps.installConfirm}
          onCancel={() => setInstallOpen(false)}
          onConfirm={async () => {
            await run('install');
            setInstallOpen(false);
          }}
        />
      ) : null}

      {uninstallOpen ? (
        <ConfirmAction
          open
          action={action('app.uninstall')}
          title={fmt(zh.apps.uninstallTitle, { app })}
          body={zh.apps.uninstallBody}
          confirmLabel={zh.apps.uninstallConfirm}
          targetName={app}
          nameLabel={fmt(zh.apps.uninstallNameLabel, { app })}
          onCancel={() => setUninstallOpen(false)}
          onConfirm={async () => {
            await run('uninstall');
            setUninstallOpen(false);
          }}
        />
      ) : null}

      {rollbackRev !== null ? (
        <ConfirmAction
          open
          action={action('app.rollback')}
          title={fmt(zh.apps.rollbackTitle, { rev: rollbackRev })}
          body={zh.apps.rollbackBody}
          confirmLabel={zh.apps.rollbackConfirm}
          onCancel={() => setRollbackRev(null)}
          onConfirm={async () => {
            const result = await rollbackApp(hubId, app, rollbackRev);
            setForm(result.app.config);
            setRollbackRev(null);
            await invalidate();
          }}
        />
      ) : null}
    </Stack>
  );
}
