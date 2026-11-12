import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import type { AgentTaskSummary, TaskState } from '@khc/contracts';
import { useHubChannelsContext } from './HubChannelsProvider';
import { deriveTaskCenter } from '../data/tasks';
import { Badge, Card, Drawer, EmptyState, Row, Stack, StatusDot, type Tone } from '../ui';
import { fmt, zh } from '../i18n/zh';
import { formatAbsoluteTime } from '../i18n/format';

function badgeFor(state: TaskState): { tone: Tone; label: string } {
  if (state === 'done') return { tone: 'ok', label: zh.status.done };
  if (state === 'error') return { tone: 'danger', label: zh.status.error };
  if (state === 'canceled') return { tone: 'neutral', label: zh.status.canceled };
  if (state === 'running') return { tone: 'info', label: zh.status.running };
  return { tone: 'neutral', label: zh.status.pendingTask };
}

function TaskCard({ task }: { task: AgentTaskSummary }) {
  const badge = badgeFor(task.state);
  return (
    <Card title={`${task.app} · ${task.action}`} action={<Badge tone={badge.tone} label={badge.label} />}>
      <Stack gap={3}>
        <Row justify="between" gap={2}>
          <span className="ui-muted">{fmt(zh.tasks.updatedAt, { time: formatAbsoluteTime(task.updatedAt) })}</span>
          <span className="ui-muted">{fmt(zh.tasks.progress, { progress: task.progress })}</span>
        </Row>
        {task.errorMessage ? (
          <p className="ui-inline-error">
            {zh.tasks.errorLabel}：{task.errorMessage}
          </p>
        ) : null}
        {task.logs.length > 0 ? (
          <pre className="ui-code">{task.logs.join('\n')}</pre>
        ) : (
          <p className="ui-muted">{zh.tasks.noLogs}</p>
        )}
      </Stack>
    </Card>
  );
}

/**
 * 顶栏任务入口 + 只读任务抽屉（B3）。
 *
 * 只在节点上下文挂载（由 AppShell 控制）；数据全部来自现有 10 秒快照，
 * 不新增请求、不轮询、不提供任何危险动作。
 */
export function TaskCenter() {
  const { hubId, live } = useHubChannelsContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  const view = deriveTaskCenter({ snapshot: live.snapshot, status: live.status });

  // 切节点或换页时收起，避免 shell 抽屉叠在页面抽屉上（全页唯一抽屉）。
  useEffect(() => {
    setOpen(false);
  }, [hubId, pathname]);

  const context = view.agentVersion
    ? `${zh.tasks.subtitle} · Agent ${view.agentVersion}`
    : zh.tasks.subtitle;

  return (
    <>
      <button
        type="button"
        className="ui-task-pill ui-task-pill-btn"
        aria-label={zh.tasks.entry}
        onClick={() => setOpen(true)}
      >
        {view.running > 0 ? <StatusDot tone="info" pulse /> : null}
        {view.running > 0 ? fmt(zh.tasks.running, { count: view.running }) : zh.tasks.entry}
      </button>
      <Drawer open={open} title={zh.tasks.title} context={context} onClose={() => setOpen(false)}>
        {view.kind === 'loading' ? (
          <EmptyState icon="activity" title={zh.tasks.loading} description={zh.tasks.loadingHint} />
        ) : null}
        {view.kind === 'offline' ? (
          <EmptyState icon="activity" title={zh.tasks.offline} description={zh.tasks.offlineHint} />
        ) : null}
        {view.kind === 'legacy' ? (
          <EmptyState icon="box" title={zh.tasks.legacy} description={zh.tasks.legacyHint} />
        ) : null}
        {view.kind === 'empty' ? (
          <EmptyState icon="activity" title={zh.tasks.empty} description={zh.tasks.emptyHint} />
        ) : null}
        {view.kind === 'ready' ? (
          <Stack gap={3}>
            {view.truncated ? (
              <p className="ui-muted">
                {fmt(zh.tasks.truncated, { shown: view.items.length, total: view.total })}
              </p>
            ) : null}
            {view.items.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </Stack>
        ) : null}
      </Drawer>
    </>
  );
}
