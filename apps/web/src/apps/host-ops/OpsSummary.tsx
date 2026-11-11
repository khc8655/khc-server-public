import type { AgentOps } from '@khc/contracts';
import { EmptyState, Grid, KeyValue, Stat } from '../../ui';
import { zh } from '../../i18n/zh';
import { formatBytes, formatDuration, formatPercent } from '../../i18n/format';

/**
 * #007 VM 运维卡片内容，Hub 本机与 Peer 状态共用（status 输出与 /state.ops 同构）。
 */
export function OpsSummary({
  ops,
  host,
  compact = false,
}: {
  ops: AgentOps | null | undefined;
  host?: { hostname?: string | null; uptime?: number | null } | null;
  /** 抽屉里用 2 列，避免服务名/CPU hint 被挤换行。 */
  compact?: boolean;
}) {
  if (!ops) {
    return <EmptyState icon="server" title={zh.ops.noData} />;
  }
  return (
    <>
      <Grid cols={compact ? 2 : 4}>
        <Stat
          label={zh.ops.cpu}
          value={formatPercent(ops.cpu?.usagePercent)}
          hint={
            ops.cpu?.load
              ? `${zh.ops.load} ${ops.cpu.load.map((value) => value.toFixed(2)).join(' / ')}`
              : undefined
          }
          icon="activity"
        />
        <Stat
          label={zh.ops.mem}
          value={formatPercent(ops.mem?.percent)}
          hint={
            ops.mem ? `${formatBytes(ops.mem.used)} / ${formatBytes(ops.mem.total)}` : undefined
          }
          icon="server"
        />
        <Stat
          label={zh.ops.disk}
          value={formatPercent(ops.disks?.[0]?.percent)}
          hint={
            ops.disks?.[0]
              ? `${formatBytes(ops.disks[0].used)} / ${formatBytes(ops.disks[0].total)}`
              : undefined
          }
          icon="box"
        />
        <Stat
          label={zh.ops.services}
          value={
            ops.services?.services
              ? ops.services.services.map((item) => `${item.name}:${item.state}`).join(' · ')
              : '—'
          }
          hint={
            ops.services?.failedUnits?.length
              ? `${zh.ops.failedUnits}: ${ops.services.failedUnits.length}`
              : undefined
          }
          icon="shield"
        />
      </Grid>
      <KeyValue
        items={[
          {
            key: zh.ops.load,
            value: ops.cpu?.load
              ? ops.cpu.load.map((value) => value.toFixed(2)).join(' / ')
              : '—',
            mono: true,
          },
          {
            key: zh.ops.swap,
            value: ops.swap
              ? `${formatPercent((ops.swap as { percent?: number }).percent)} · ${formatBytes((ops.swap as { used?: number }).used)}`
              : '—',
          },
          {
            key: zh.ops.listening,
            value: ops.network?.listening
              ? String((ops.network.listening as { count?: number }).count ?? '—')
              : '—',
          },
          {
            key: zh.ops.dns,
            value: Array.isArray(ops.network?.dns)
              ? (ops.network?.dns as string[]).join(', ')
              : '—',
            mono: true,
          },
          {
            key: zh.ops.route,
            value: ops.network?.defaultRoute
              ? `${(ops.network.defaultRoute as { interface?: string }).interface ?? ''} → ${(ops.network.defaultRoute as { gateway?: string }).gateway ?? ''}`
              : '—',
            mono: true,
          },
          {
            key: zh.ops.uptime,
            value: host?.uptime ? formatDuration(host.uptime) : '—',
          },
          { key: zh.ops.rebootRequired, value: ops.rebootRequired ? zh.common.yes : zh.common.no },
        ]}
      />
    </>
  );
}
