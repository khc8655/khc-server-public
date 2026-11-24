/**
 * 节点 → 应用 → 「已安装的托管应用」（V4）。
 *
 * 数据源：读 `/overview` 回填的 `state.adapters[app-catalog]` 聚合状态。
 * 条目定位：按 `manifestId` 与 `instance` 字段，不解析键字符串。
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentState } from '@khc/contracts';
import { appManifestsQueryOptions } from '../../data/appManifests';
import {
  appStatus,
  installedCatalogState,
  toAppView,
  type InstalledApp,
} from '../../data/manifestApps';
import { refreshHubRuntime } from '../../data/queries';
import { zh } from '../../i18n/zh';
import { Banner, Button, Card, InlineError, Stack, Table, type ColumnDef } from '../../ui';
import { InstalledAppDrawer } from './InstalledAppDrawer';

function entryIdentity(entry: Pick<InstalledApp, 'manifestId' | 'instance'>): string {
  return `${entry.manifestId}::${entry.instance}`;
}

export function InstalledAppsCard({
  hubId,
  hubName,
  state: effectiveState,
  stateLoading: effectiveLoading,
  offlineReason,
  pollIntervalMs = 800,
  selectedKey: controlledKey,
  onSelectEntry,
  onCloseDrawer,
}: {
  hubId: string;
  hubName?: string;
  /** 来自 /overview 的节点状态，调用方必传 */
  state: AgentState | null;
  stateLoading: boolean;
  offlineReason?: string;
  /** 测试可注入更短轮询间隔，生产默认 800ms */
  pollIntervalMs?: number;
  selectedKey?: string | null;
  onSelectEntry?: (key: string) => void;
  onCloseDrawer?: () => void;
}) {
  const queryClient = useQueryClient();
  const manifestsQuery = useQuery(appManifestsQueryOptions());

  const appViews = useMemo(
    () => (manifestsQuery.data ?? []).map(toAppView),
    [manifestsQuery.data],
  );
  const viewMap = useMemo(() => new Map(appViews.map((v) => [v.id, v])), [appViews]);

  const catalogState = useMemo(() => installedCatalogState(effectiveState), [effectiveState]);
  const [internalSelectedKey, setInternalSelectedKey] = useState<string | null>(null);

  const isControlled = controlledKey !== undefined;
  const activeKey = isControlled ? controlledKey : internalSelectedKey;

  const selectedEntry = useMemo(
    () =>
      activeKey
        ? (catalogState.entries.find((e) => entryIdentity(e) === activeKey) ?? null)
        : null,
    [activeKey, catalogState.entries],
  );

  const openEntry = (entry: InstalledApp) => {
    const key = entryIdentity(entry);
    if (onSelectEntry) {
      onSelectEntry(key);
    } else {
      setInternalSelectedKey(key);
    }
  };

  const closeDrawer = () => {
    if (onCloseDrawer) {
      onCloseDrawer();
    } else {
      setInternalSelectedKey(null);
    }
  };

  if (
    !effectiveLoading &&
    !catalogState.stale &&
    !catalogState.pending &&
    !catalogState.error &&
    catalogState.entries.length === 0
  ) {
    return null;
  }

  const columns: ColumnDef<InstalledApp>[] = [
    {
      key: 'name',
      type: 'name',
      header: '应用',
      width: '30%',
      value: (entry) => {
        const view = viewMap.get(entry.manifestId);
        const base = !view?.invalid && view?.def.name ? view.def.name : entry.manifestId;
        return entry.instance !== entry.manifestId ? `${base} (${entry.instance})` : base;
      },
      dot: (entry) => appStatus(entry, catalogState).tone,
    },
    {
      key: 'version',
      type: 'mono',
      header: '版本',
      width: '34%',
      value: (entry) => entry.version,
    },
    {
      key: 'status',
      type: 'status',
      header: '状态',
      width: '20%',
      value: (entry) => appStatus(entry, catalogState).label,
      status: (entry) => appStatus(entry, catalogState),
    },
    {
      key: 'detail',
      type: 'actions',
      header: '',
      width: '16%',
      render: (entry) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Button label="详情" size="sm" variant="ghost" onClick={() => openEntry(entry)} />
        </span>
      ),
    },
  ];

  return (
    <>
      <Card
        title={zh.hosted.installedTitle}
        action={
          catalogState.stale || catalogState.pending ? (
            <Button
              label="刷新"
              size="sm"
              onClick={() => void refreshHubRuntime(queryClient, hubId, { force: true })}
            />
          ) : undefined
        }
      >
        <Stack gap={3}>
          <p className="ui-text-caption">{zh.hosted.installedDesc}</p>
          {catalogState.stale ? (
            <Banner
              tone="warn"
              title="状态可能不是最新"
              description="节点采集超时，展示最近一次成功缓存。"
              action={
                <Button
                  label="刷新"
                  size="sm"
                  onClick={() => void refreshHubRuntime(queryClient, hubId, { force: true })}
                />
              }
            />
          ) : null}
          {catalogState.pending ? (
            <Banner tone="info" title="状态读取中" description="Agent 正在后台采集应用状态，请稍后刷新。" />
          ) : null}
          {catalogState.error && !catalogState.pending ? (
            <InlineError message={catalogState.error} />
          ) : null}

          {catalogState.entries.length > 0 || effectiveLoading ? (
            <Table
              rows={effectiveLoading ? undefined : catalogState.entries}
              columns={columns}
              rowKey={entryIdentity}
              objectLabel="已装应用"
              openRowKey={activeKey ?? undefined}
              onRowOpen={openEntry}
              empty={{
                icon: 'box',
                title: zh.hosted.installedEmpty,
              }}
            />
          ) : null}
        </Stack>
      </Card>

      {selectedEntry ? (
        <InstalledAppDrawer
          hubId={hubId}
          hubName={hubName ?? hubId}
          entry={selectedEntry}
          view={viewMap.get(selectedEntry.manifestId)}
          state={effectiveState}
          catalogState={catalogState}
          offlineReason={offlineReason}
          pollIntervalMs={pollIntervalMs}
          onClose={closeDrawer}
        />
      ) : null}
    </>
  );
}
