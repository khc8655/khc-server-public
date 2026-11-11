import { useQuery } from '@tanstack/react-query';
import { nodeAuditQueryOptions, type NodeAuditEntry } from '../../data/audit';
import { Card, EmptyState, Skeleton, Stack, Table, type ColumnDef } from '../../ui';
import { zh } from '../../i18n/zh';

function columns(): ColumnDef<NodeAuditEntry>[] {
  return [
    { key: 'at', type: 'time', header: zh.recentOps.colTime, value: (row) => row.at },
    { key: 'actor', type: 'name', header: zh.recentOps.colActor, value: (row) => row.actor || '—' },
    { key: 'action', type: 'mono', header: zh.recentOps.colAction, value: (row) => row.action || '—' },
  ];
}

export function RecentOperations({ hubId, offline }: { hubId: string; offline: boolean }) {
  const query = useQuery(nodeAuditQueryOptions(hubId, 5));
  const rows = query.data ?? [];

  return (
    <Card title={zh.recentOps.title}>
      {query.isLoading ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} width="80%" />
          <Skeleton height={10} width="60%" />
        </Stack>
      ) : query.error ? (
        <EmptyState icon="activity" title={zh.recentOps.errorTitle} description={zh.recentOps.errorHint} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="activity"
          title={zh.recentOps.emptyTitle}
          description={offline ? zh.recentOps.offlineHint : zh.recentOps.emptyHint}
        />
      ) : (
        <Table
          rows={rows}
          columns={columns()}
          rowKey={(row) => String(row.id)}
          objectLabel={zh.recentOps.objectLabel}
          empty={{ icon: 'activity', title: zh.recentOps.emptyTitle }}
        />
      )}
    </Card>
  );
}
