/** 站点页「扩展应用」分段（ui-redesign ⑤）：从 HubAppsPage 迁入的只读应用表。 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { AppConfig } from '@khc/contracts';
import { hubAppsQueryOptions } from '../../data/queries';
import { paths } from '../../registry/routes';
import { isBuiltinApp } from '../../registry/apps';
import { Banner, Card, Table, type ColumnDef } from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatRelativeTime } from '../../i18n/format';

interface AppRow {
  name: string;
  version: string;
  config: AppConfig | null;
}

function appStatus(config: AppConfig | null): { tone: 'ok' | 'warn' | 'neutral'; label: string } {
  if (!config) return { tone: 'neutral', label: zh.apps.notInstalled };
  if (config.appliedRev === null) return { tone: 'warn', label: zh.apps.notApplied };
  if (config.appliedRev !== config.rev) return { tone: 'warn', label: zh.apps.pendingApply };
  return { tone: 'ok', label: zh.apps.applied };
}

export function AppsSegment({ hubId }: { hubId: string }) {
  const navigate = useNavigate();
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const [search, setSearch] = useState('');

  const rows: AppRow[] = useMemo(() => {
    const adapters = appsQuery.data?.adapters ?? [];
    const configs = new Map((appsQuery.data?.apps ?? []).map((item) => [item.app, item]));
    const names = new Set([...adapters.map((item) => item.name), ...configs.keys()]);
    const externalNames = [...names].filter((name) => !isBuiltinApp(name));
    return externalNames
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        version: adapters.find((item) => item.name === name)?.version ?? '—',
        config: configs.get(name) ?? null,
      }));
  }, [appsQuery.data]);

  const columns: ColumnDef<AppRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.fields.apps,
      value: (row) => row.name,
      dot: (row) => (row.config ? 'ok' : 'neutral'),
    },
    {
      key: 'version',
      type: 'mono',
      header: zh.fields.version,
      value: (row) => row.version,
    },
    {
      key: 'status',
      type: 'status',
      header: zh.fields.status,
      status: (row) => appStatus(row.config),
    },
    {
      key: 'rev',
      type: 'text',
      header: zh.fields.configVersion,
      value: (row) =>
        row.config
          ? fmt(zh.apps.versionSummary, {
              config: row.config.rev,
              applied: row.config.appliedRev ?? '—',
            })
          : '—',
      priority: 'low',
    },
    {
      key: 'updated',
      type: 'time',
      header: zh.fields.updatedAt,
      value: (row) => (row.config ? formatRelativeTime(row.config.updatedAt) : '—'),
      priority: 'low',
    },
  ];

  return (
    <Card title={zh.sites.segmentApps}>
      {appsQuery.data?.adaptersError ? (
        <Banner tone="warn" title={appsQuery.data.adaptersError} />
      ) : null}
      <Table
        rows={appsQuery.isLoading ? undefined : rows}
        columns={columns}
        rowKey={(row) => row.name}
        onRowOpen={(row) => void navigate({ href: paths.hubApp(hubId, row.name) })}
        empty={{
          icon: 'box',
          title: zh.apps.empty,
          description: zh.apps.emptyHint,
        }}
        objectLabel={zh.sites.segmentApps}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: zh.common.search,
        }}
      />
    </Card>
  );
}
