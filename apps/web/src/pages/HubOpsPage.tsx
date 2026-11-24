import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiagnosticCheck } from '@khc/contracts';
import { useParams } from '@tanstack/react-router';
import { hubQueryOptions } from '../data/queries';
import {
  diagnosticCounts,
  diagnosticHintFor,
  diagnosticHintsQueryOptions,
  diagnosticIssueChecks,
  indexDiagnosticHints,
  nodeDiagnosticsQueryOptions,
} from '../data/diagnostics';
import {
  HOST_OPS_TARGET_SELF,
  hostOpsQueryKey,
  type HostOpsCronEntry,
  type HostOpsProcess,
} from '../data/hostOps';
import { useHubChannelsContext } from '../app/HubChannelsProvider';
import { StatusBar, type StatusTile } from '../apps/host-ops/StatusBar';
import { pickFailedUnits } from '../data/failedUnits';
import { servicesTile } from '../apps/host-ops/serviceStatus';
import {
  CronEntryForm,
  CronSegment,
  KeyAddForm,
  KeysSegment,
  ProcessesSegment,
  ServicesSegment,
  SvcLogsPanel,
  processStartTime,
} from '../apps/host-ops/OpsSegments';
import { useFirewallState, FirewallSegment } from '../apps/host-ops/FirewallSegment';
import { FirewallRulesEditor } from '../apps/host-ops/FirewallRulesEditor';
import {
  DiagnosticsCheckDetail,
  DiagnosticsIssueList,
  formatCheckTitle,
} from '../apps/diagnostics/DiagnosticsPanel';
import { SaveBar } from '../patterns';
import { action, actionLabel } from '../registry/actions';
import {
  Banner,
  Button,
  CodeBlock,
  Drawer,
  KeyValue,
  PageHeader,
  Row,
  Segmented,
  Skeleton,
  Stack,
} from '../ui';
import { zh, fmt } from '../i18n/zh';
import { formatBytes, formatDuration, formatPercent } from '../i18n/format';

type Segment = 'services' | 'processes' | 'firewall' | 'keys' | 'cron';

type OpsDrawer =
  | { kind: 'process'; process: HostOpsProcess; hostUptime: number | null }
  | { kind: 'fw-edit' }
  | { kind: 'key-add' }
  | { kind: 'svc-logs'; unit: string; user?: string | null }
  | { kind: 'cron-edit'; entry: HostOpsCronEntry | null }
  | { kind: 'diag' }
  | { kind: 'diag-check'; check: DiagnosticCheck };

/**
 * 主机运维页（ui-redesign §4）：状态带 + Segmented 对象表 + 页面级唯一抽屉；
 * 诊断降级为状态带右侧入口；svc / cron 经 khc-host 白名单动词实时读写（#E1/E2）。
 */
export default function HubOpsPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId/ops' });
  const queryClient = useQueryClient();
  const hubQuery = useQuery({ ...hubQueryOptions(hubId), enabled: false });
  const { live, channels, stateQuery } = useHubChannelsContext();
  // 指标走 10s 快照；服务/进程等重数据来自进入工作区时的一次性 /overview 回填（不周期轮询）。
  const state = stateQuery.data?.state;
  const metrics = live.snapshot?.ops ?? state?.ops ?? null;
  const uptime = live.snapshot?.host?.uptime ?? state?.host?.uptime ?? null;
  const hubName = hubQuery.data?.name ?? hubId;
  const opsDisabled = !channels.canApply;
  // 快照拉取失败（fallback）且节点并非明确离线时，给出手动重试入口。
  const snapshotMissing = live.status === 'fallback' && channels.control.reachable !== false;

  const [segment, setSegment] = useState<Segment>('services');
  const [processSort, setProcessSort] = useState<'cpu' | 'mem'>('cpu');
  const [drawer, setDrawer] = useState<OpsDrawer | null>(null);
  const fw = useFirewallState(hubId, opsDisabled, segment === 'firewall');

  // 诊断是控制面动作：只在用户打开诊断抽屉时请求一次，打开运维页不自动拉取。
  const diagOpen = drawer?.kind === 'diag' || drawer?.kind === 'diag-check';
  const diagnosticsQuery = useQuery({
    ...nodeDiagnosticsQueryOptions(hubId),
    enabled: diagOpen,
  });
  const hintsQuery = useQuery({ ...diagnosticHintsQueryOptions(), enabled: diagOpen });
  const hints = useMemo(() => indexDiagnosticHints(hintsQuery.data?.hints), [hintsQuery.data]);

  const diagnosticsData = diagnosticsQuery.data;
  const diagnosticsOffline = opsDisabled || diagnosticsData?.reachable === false;
  const issues = diagnosticIssueChecks(diagnosticsData);
  const counts = diagnosticCounts(issues);

  /* ------------------------------------------------------------- 状态带 */

  const tiles = useMemo<StatusTile[]>(() => {
    const ops = metrics;
    // 失败单元取快照优先（2026-11-16 U2）：只读 /state 会让计数冻在打开页面那一刻，
    // 用户重启修好服务后状态带还显示旧数字。null 表示读不到，不谎报 0。
    const failedUnits = pickFailedUnits(ops, state?.ops?.services);
    // 服务瓦片只把面板受管的失败算成「异常」（口径见 apps/host-ops/serviceStatus.ts）：
    // Ubuntu 云镜像自带 fwupd / apt-daily-upgrade / cloud-final 这类单元的失败与面板无关，
    // 全算进来就是一块永远消不掉的红色告警，用户很快学会无视它。
    const diskPercent = ops?.disks?.[0]?.percent ?? null;
    const list: StatusTile[] = [
      {
        key: 'agent',
        label: zh.hostOps.statusAgent,
        value:
          channels.control.reachable === true
            ? zh.common.online
            : channels.control.reachable === false
              ? zh.common.offline
              : zh.common.unknown,
        tone:
          channels.control.reachable === true
            ? 'ok'
            : channels.control.reachable === false
              ? 'danger'
              : 'neutral',
      },
      {
        key: 'cpu',
        label: zh.ops.cpu,
        value: formatPercent(ops?.cpu?.usagePercent),
        tone: (ops?.cpu?.usagePercent ?? 0) >= 90 ? 'danger' : 'neutral',
        onClick: () => {
          setProcessSort('cpu');
          setSegment('processes');
        },
      },
      {
        key: 'mem',
        label: zh.ops.mem,
        value: formatPercent(ops?.mem?.percent),
        tone: (ops?.mem?.percent ?? 0) >= 90 ? 'danger' : 'neutral',
        onClick: () => {
          setProcessSort('mem');
          setSegment('processes');
        },
      },
      {
        key: 'disk',
        label: zh.ops.disk,
        value: formatPercent(diskPercent),
        tone: (diskPercent ?? 0) >= 85 ? 'warn' : 'neutral',
      },
      {
        key: 'services',
        label: zh.hostOps.services,
        // 受管失败才算异常；系统自带单元降级为中性文字；读不到显示「未知」而不是「正常」。
        ...servicesTile(failedUnits),
        onClick: () => setSegment('services'),
      },
      {
        key: 'uptime',
        label: zh.hostOps.uptimeTile,
        value: uptime ? formatDuration(uptime) : '—',
        tone: state?.ops?.rebootRequired ? 'warn' : 'neutral',
      },
    ];
    return list;
  }, [metrics, uptime, state, channels.control.reachable]);

  const diagAction = (
    <Button
      label={
        diagnosticsQuery.error
          ? zh.hostOps.diagEntryError
          : diagnosticsQuery.data && counts.error + counts.warn > 0
            ? fmt(zh.hostOps.diagEntry, { count: String(counts.error + counts.warn) })
            : zh.hostOps.diagEntryIdle
      }
      size="sm"
      variant="ghost"
      onClick={() => setDrawer({ kind: 'diag' })}
    />
  );

  /* --------------------------------------------------------------- 渲染 */

  const segmentOptions = [
    { value: 'services', label: zh.hostOps.services },
    { value: 'processes', label: zh.hostOps.processes },
    { value: 'firewall', label: zh.hostOps.firewall },
    { value: 'keys', label: zh.hostOps.sshKeys },
    { value: 'cron', label: zh.hostOps.cron.title },
  ];

  const drawerContext = hubName;
  const diagRefetch = async () => {
    await diagnosticsQuery.refetch();
  };

  const renderDrawerContent = () => {
    if (!drawer) return null;
    switch (drawer.kind) {
      case 'process': {
        const proc = drawer.process;
        return (
          <Drawer
            open
            title={fmt(zh.hostOps.process.detailTitle, {
              name: proc.name,
              pid: String(proc.pid),
            })}
            context={drawerContext}
            onClose={() => setDrawer(null)}
            footer={<Button label={zh.common.close} onClick={() => setDrawer(null)} />}
          >
            <Stack gap={3}>
              <KeyValue
                items={[
                  { key: zh.hostOps.process.name, value: proc.name },
                  { key: zh.hostOps.process.pid, value: String(proc.pid), mono: true },
                  { key: zh.hostOps.process.user, value: proc.user, mono: true },
                  { key: zh.hostOps.process.cpu, value: formatPercent(proc.cpu) },
                  {
                    key: zh.hostOps.process.mem,
                    value: proc.mem === null ? '—' : formatBytes(proc.mem * 1024 * 1024),
                  },
                  {
                    key: zh.hostOps.process.start,
                    value: processStartTime(proc.startTime, drawer.hostUptime),
                  },
                ]}
              />
              <CodeBlock code={proc.cmdline} label={zh.hostOps.process.cmd} />
            </Stack>
          </Drawer>
        );
      }
      case 'fw-edit':
        return (
          <Drawer
            open
            title={zh.hostOps.fwEditTitle}
            context={drawerContext}
            dirty={fw.dirtyDraft}
            onClose={() => setDrawer(null)}
            footer={
              <SaveBar
                note={
                  fw.changedCount > 0
                    ? fmt(zh.hostOps.firewallRules.draftNoteCount, {
                        count: String(fw.changedCount),
                      })
                    : zh.hostOps.firewallRules.draftNote
                }
                dirty={fw.dirtyDraft}
                saving={fw.applying}
                onDiscard={() => {
                  fw.discardDraft();
                  setDrawer(null);
                }}
                onSave={() => {
                  if (fw.saveDraft()) setDrawer(null);
                }}
              />
            }
          >
            <FirewallRulesEditor
              draft={fw.draft}
              onUpdate={fw.updateRule}
              onRemove={fw.removeRule}
              onAdd={fw.addRule}
            />
          </Drawer>
        );
      case 'key-add':
        return (
          <Drawer
            open
            title={zh.hostOps.keys.addTitle}
            context={drawerContext}
            onClose={() => setDrawer(null)}
            footer={<Button label={zh.common.close} onClick={() => setDrawer(null)} />}
          >
            <KeyAddForm
              hubId={hubId}
              onAdded={() => {
                setDrawer(null);
                void queryClient.invalidateQueries({
                  queryKey: hostOpsQueryKey(hubId, HOST_OPS_TARGET_SELF, 'keys.list', {}),
                });
              }}
            />
          </Drawer>
        );
      case 'svc-logs':
        return (
          <Drawer
            open
            title={fmt(zh.hostOps.svc.logsTitle, { unit: drawer.unit })}
            context={drawerContext}
            onClose={() => setDrawer(null)}
            footer={<Button label={zh.common.close} onClick={() => setDrawer(null)} />}
          >
            <SvcLogsPanel hubId={hubId} unit={drawer.unit} user={drawer.user} />
          </Drawer>
        );
      case 'cron-edit':
        return (
          <Drawer
            open
            title={drawer.entry ? zh.hostOps.cron.editTitle : zh.hostOps.cron.addTitle}
            context={drawerContext}
            onClose={() => setDrawer(null)}
            footer={<Button label={zh.common.close} onClick={() => setDrawer(null)} />}
          >
            <CronEntryForm
              hubId={hubId}
              entry={drawer.entry}
              onSaved={() => {
                setDrawer(null);
                void queryClient.invalidateQueries({
                  queryKey: hostOpsQueryKey(hubId, HOST_OPS_TARGET_SELF, 'cron.list', {}),
                });
              }}
            />
          </Drawer>
        );
      case 'diag': {
        const ageSeconds = diagnosticsData
          ? Math.max(0, Math.floor(Date.now() / 1000 - diagnosticsData.generatedAt))
          : 0;
        return (
          <Drawer
            open
            title={zh.diagnostics.title}
            context={drawerContext}
            onClose={() => setDrawer(null)}
            footer={
              <Row gap={2} wrap>
                <Button label={zh.common.close} onClick={() => setDrawer(null)} />
                <Button
                  label={actionLabel(action('node.diagnostics.check'))}
                  icon="refresh"
                  size="sm"
                  loading={diagnosticsQuery.isFetching}
                  onClick={() => void diagRefetch()}
                />
              </Row>
            }
          >
            {diagnosticsQuery.isLoading && !diagnosticsData ? (
              <Stack gap={2}>
                <Skeleton height={10} width="45%" />
                <Skeleton height={10} />
                <Skeleton height={10} width="70%" />
              </Stack>
            ) : null}
            {diagnosticsQuery.error ? (
              <Banner
                tone="danger"
                title={zh.diagnostics.loadError}
                description={
                  diagnosticsQuery.error instanceof Error
                    ? diagnosticsQuery.error.message
                    : zh.diagnostics.loadErrorHint
                }
                action={
                  <Button label={zh.common.retry} size="sm" onClick={() => void diagRefetch()} />
                }
              />
            ) : null}
            {diagnosticsData ? (
              <DiagnosticsIssueList
                issues={issues}
                counts={counts}
                hints={hints}
                truncated={Boolean(diagnosticsData.truncated)}
                staleMinutes={Math.floor(ageSeconds / 60)}
                offline={diagnosticsOffline}
                generatedAt={diagnosticsData.generatedAt}
                onOpenCheck={(check) => setDrawer({ kind: 'diag-check', check })}
              />
            ) : null}
          </Drawer>
        );
      }
      case 'diag-check': {
        const check = drawer.check;
        const hint = diagnosticHintFor(hints, check);
        return (
          <Drawer
            open
            title={
              check.code === 'khc.config.pending_apply'
                ? formatCheckTitle(check)
                : (hint?.title ?? check.title)
            }
            context={drawerContext}
            onClose={() => setDrawer({ kind: 'diag' })}
            footer={
              <Row gap={2} wrap>
                <Button label={zh.hostOps.backToList} onClick={() => setDrawer({ kind: 'diag' })} />
              </Row>
            }
          >
            <DiagnosticsCheckDetail
              hubId={hubId}
              check={check}
              hint={hint}
              offline={diagnosticsOffline}
              onRefetch={diagRefetch}
            />
          </Drawer>
        );
      }
    }
  };

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.ops}
        scope={hubName}
        summary={zh.hostOps.intro}
      />
      {snapshotMissing ? (
        <Banner
          tone="warn"
          title={zh.hostOps.liveDisconnectedTitle}
          description={zh.hostOps.liveDisconnectedDesc}
          action={<Button label={zh.hostOps.liveReconnect} size="sm" onClick={live.reconnect} />}
        />
      ) : null}
      {channels.control.reachable === false && channels.control.error ? (
        <Banner tone="warn" title={channels.control.error} description={zh.channels.controlFailed} />
      ) : null}
      {opsDisabled ? <Banner tone="neutral" title={zh.hostOps.offlineBanner} /> : null}

      <StatusBar tiles={tiles} action={diagAction} />

      <Row gap={3} wrap>
        <Segmented
          value={segment}
          ariaLabel={zh.hostOps.title}
          options={segmentOptions}
          onChange={(value) => {
            if (
              value === 'processes' ||
              value === 'firewall' ||
              value === 'keys' ||
              value === 'services' ||
              value === 'cron'
            ) {
              setSegment(value);
            }
          }}
        />
      </Row>

      {segment === 'services' ? (
        <ServicesSegment
          hubId={hubId}
          disabled={opsDisabled}
          onOpenLogs={(unit, user) => setDrawer({ kind: 'svc-logs', unit, user })}
        />
      ) : null}
      {segment === 'processes' ? (
        <ProcessesSegment
          hubId={hubId}
          disabled={opsDisabled}
          sort={processSort}
          onSortChange={setProcessSort}
          onOpenProcess={(process, hostUptime) => setDrawer({ kind: 'process', process, hostUptime })}
        />
      ) : null}
      {segment === 'firewall' ? (
        <FirewallSegment
          fw={fw}
          disabled={opsDisabled}
          onOpenEdit={() => setDrawer({ kind: 'fw-edit' })}
        />
      ) : null}
      {segment === 'keys' ? (
        <KeysSegment
          hubId={hubId}
          disabled={opsDisabled}
          onAdd={() => setDrawer({ kind: 'key-add' })}
        />
      ) : null}
      {segment === 'cron' ? (
        <CronSegment
          hubId={hubId}
          disabled={opsDisabled}
          onEdit={(entry) => setDrawer({ kind: 'cron-edit', entry })}
        />
      ) : null}

      {renderDrawerContent()}
    </Stack>
  );
}
