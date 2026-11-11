import { fmt, zh } from '../i18n/zh';
import type { LogLine } from '../ui/log';
import { Badge, Card, LogViewer, Stack, Steps } from '../ui';
import type { StepItem } from '../ui/steps';
import type { AgentTask } from '@khc/contracts';

function detectLevel(line: string): LogLine['level'] {
  if (/\b(error|fatal|failed)\b/i.test(line)) return 'error';
  if (/\b(warn|warning)\b/i.test(line)) return 'warn';
  if (/\b(ok|done|success|succeeded)\b/i.test(line)) return 'ok';
  return 'info';
}

function stateBadge(state: AgentTask['state']) {
  if (state === 'done') return { tone: 'ok' as const, label: zh.status.done };
  if (state === 'error') return { tone: 'danger' as const, label: zh.status.error };
  if (state === 'canceled') return { tone: 'neutral' as const, label: zh.status.canceled };
  if (state === 'running') return { tone: 'info' as const, label: zh.status.running };
  return { tone: 'neutral' as const, label: zh.status.pendingTask };
}

/** 任务视图：标题 + 状态 + 步骤 + 实时日志（ui-spec §5.5）。 */
export function TaskView({ task }: { task: AgentTask }) {
  const badge = stateBadge(task.state);
  const done = task.state === 'done';
  const failed = task.state === 'error';
  const running = task.state === 'running' || task.state === 'pending';
  const steps: StepItem[] = [
    {
      label: zh.status.running,
      state: done ? 'done' : failed ? 'failed' : running ? 'running' : 'todo',
    },
  ];
  const logs: LogLine[] = (task.logs ?? []).map((line, index) => ({
    id: String(index),
    level: detectLevel(line),
    text: line,
  }));

  return (
    <Card title={fmt(zh.apps.taskTitle, { id: task.id })} action={<Badge tone={badge.tone} label={badge.label} />}>
      <Stack gap={3}>
        <Steps items={steps} />
        <LogViewer lines={logs} />
      </Stack>
    </Card>
  );
}
