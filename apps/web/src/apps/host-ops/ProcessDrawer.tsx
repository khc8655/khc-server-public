import { useEffect, useState } from 'react';
import {
  callHostOps,
  normalizeProcesses,
  normalizeStatus,
  normalizeVersion,
  type HostOpsError,
  type HostOpsProcess,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Banner,
  Button,
  CodeBlock,
  Dialog,
  Drawer,
  KeyValue,
  Row,
  Segmented,
  Skeleton,
  Stack,
  Table,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime, formatBytes, formatPercent } from '../../i18n/format';
import { HostOpsErrorBanner } from './Common';
import { businessProcesses, countSystemProcesses } from './processFilter';

/**
 * 进程抽屉：只读列表 + 详情。
 * 结束进程能力已移除（经 WG SSH 远程 kill 风险高、需求低），不再提供选择/确认入口。
 */
export function ProcessDrawer({
  open,
  hubId,
  target,
  context,
  onClose,
}: {
  open: boolean;
  hubId: string;
  target: string;
  context: string;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<'cpu' | 'mem'>('cpu');
  // 默认只看业务进程：系统进程在 Web 层过滤，不改协议、不动 Agent。
  const [scope, setScope] = useState<'business' | 'all'>('business');
  const [processes, setProcesses] = useState<HostOpsProcess[] | undefined>(undefined);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [hostUptime, setHostUptime] = useState<number | null>(null);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailTarget, setDetailTarget] = useState<HostOpsProcess | null>(null);

  const load = async (nextSort: 'cpu' | 'mem' = sort) => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await callHostOps(hubId, target, 'snapshot', {
        processes: true,
        sort: nextSort,
        limit: 20,
      });
      if (snapshot.ok) {
        setVersion(normalizeVersion(snapshot.data));
        setHostUptime(normalizeStatus(snapshot.data).uptime);
        setProcesses(normalizeProcesses(snapshot.data));
      } else {
        setError(snapshot.error);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 打开抽屉时按需读取；target/hub 变化由父组件重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <Drawer
      open={open}
      title={zh.hostOps.processesTitle}
      context={context}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.close} onClick={onClose} />
        </Row>
      }
    >
      <Stack gap={4}>
        {version && version.root === false ? <Banner tone="neutral" title={zh.hostOps.process.readOnly} /> : null}
        {error ? <HostOpsErrorBanner error={error} onRetry={() => void load(sort)} /> : null}
        <Row gap={3} wrap>
          <Segmented
            value={sort}
            ariaLabel={zh.hostOps.processesTitle}
            options={[
              { value: 'cpu', label: zh.hostOps.process.sortCpu },
              { value: 'mem', label: zh.hostOps.process.sortMem },
            ]}
            onChange={(value) => {
              const next = value === 'mem' ? 'mem' : 'cpu';
              setSort(next);
              void load(next);
            }}
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
          onRowOpen={setDetailTarget}
          empty={{
            icon: 'activity',
            title:
              scope === 'business' && processes ? zh.hostOps.process.emptyBusiness : zh.hostOps.process.empty,
            action: (
              <Button
                label={zh.common.retry}
                size="sm"
                onClick={() => void load(sort)}
              />
            ),
          }}
        />
      </Stack>

      {detailTarget ? (
        <Dialog
          open
          title={fmt(zh.hostOps.process.detailTitle, {
            name: detailTarget.name,
            pid: String(detailTarget.pid),
          })}
          onClose={() => setDetailTarget(null)}
          footer={<Button label={zh.common.close} onClick={() => setDetailTarget(null)} />}
        >
          <Stack gap={3}>
            <KeyValue
              items={[
                { key: zh.hostOps.process.name, value: detailTarget.name },
                { key: zh.hostOps.process.pid, value: String(detailTarget.pid), mono: true },
                { key: zh.hostOps.process.user, value: detailTarget.user, mono: true },
                { key: zh.hostOps.process.cpu, value: formatPercent(detailTarget.cpu) },
                {
                  key: zh.hostOps.process.mem,
                  value:
                    detailTarget.mem === null
                      ? '—'
                      : formatBytes(detailTarget.mem * 1024 * 1024),
                },
                {
                  key: zh.hostOps.process.start,
                  value: processStartTime(detailTarget.startTime, hostUptime),
                },
              ]}
            />
            <CodeBlock code={detailTarget.cmdline} label={zh.hostOps.process.cmd} />
          </Stack>
        </Dialog>
      ) : null}
    </Drawer>
  );
}

/** /proc 的 startTime 是开机后的 clock ticks（Linux USER_HZ 通常 100）；有 uptime 时换算为墙钟时间。 */
function processStartTime(startTime: number | null, hostUptime: number | null): string {
  if (startTime === null) return '—';
  if (startTime > 1_000_000_000) return formatAbsoluteTime(startTime);
  if (hostUptime === null) return '—';
  const boot = Math.floor(Date.now() / 1000 - hostUptime);
  return formatAbsoluteTime(Math.floor(boot + startTime / 100));
}
