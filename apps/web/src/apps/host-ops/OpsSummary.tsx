import type { AgentOps } from '@khc/contracts';
import { EmptyState, Grid, KeyValue, Stat } from '../../ui';
import { fmt, zh } from '../../i18n/zh';
import { formatBytes, formatDuration, formatPercent } from '../../i18n/format';
import { splitFailedUnits } from '../../data/managedUnits';

/**
 * 服务统计的副标题（2026-11-20）：受管失败才叫「失败单元」。
 *
 * 系统自带单元（fwupd / apt-daily-upgrade / cloud-final 等）的失败由发行版负责，
 * 面板既不能修也不该催；全量计数会让这张卡片常年挂着与运维无关的红色。
 * 仍如实给条数，只是换成中性文案并与受管失败分开。
 */
function servicesHint(failedUnits: readonly string[] | undefined): string | undefined {
  if (!Array.isArray(failedUnits)) return undefined;
  const { managed, system } = splitFailedUnits(failedUnits);
  const systemHint =
    system.length > 0 ? fmt(zh.ops.systemFailedUnits, { count: String(system.length) }) : '';
  if (managed.length > 0) {
    return systemHint
      ? `${zh.ops.failedUnits}: ${managed.length} · ${systemHint}`
      : `${zh.ops.failedUnits}: ${managed.length}`;
  }
  return systemHint || undefined;
}

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
          hint={servicesHint(ops.services?.failedUnits)}
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
