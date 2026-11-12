/**
 * B3 任务快照：只从现有 10 秒快照派生，不发起请求。
 *
 * 四态（外加首帧读取中）：
 * - ready：有新 Agent 下发的任务摘要；
 * - empty：新 Agent 明确返回 0 个任务；
 * - legacy：旧 Agent 没有 `tasks` 字段；
 * - offline：没有可用快照（转发/直连失败或尚未拿到帧）。
 */
import type { AgentSnapshot, AgentTaskSummary } from '@khc/contracts';
import type { SnapshotStatus } from './snapshot';

export type TaskCenterKind = 'loading' | 'ready' | 'empty' | 'legacy' | 'offline';

export interface TaskCenterView {
  kind: TaskCenterKind;
  items: AgentTaskSummary[];
  total: number;
  truncated: boolean;
  /** 进行中（pending + running）数量，用于顶栏徽标 */
  running: number;
  /** 旧 Agent 自报版本（可能为空） */
  agentVersion: string | null;
}

export function deriveTaskCenter(input: {
  snapshot: AgentSnapshot | null;
  status: SnapshotStatus;
}): TaskCenterView {
  const { snapshot, status } = input;
  const agentVersion = snapshot?.agent?.version ?? null;
  if (snapshot) {
    const tasks = snapshot.tasks;
    if (!tasks) {
      return { kind: 'legacy', items: [], total: 0, truncated: false, running: 0, agentVersion };
    }
    const running = tasks.items.filter(
      (task) => task.state === 'running' || task.state === 'pending',
    ).length;
    const kind: TaskCenterKind =
      tasks.items.length === 0 && tasks.total === 0 ? 'empty' : 'ready';
    return {
      kind,
      items: tasks.items,
      total: tasks.total,
      truncated: tasks.truncated,
      running,
      agentVersion,
    };
  }
  if (status === 'disabled' || status === 'live') {
    return { kind: 'loading', items: [], total: 0, truncated: false, running: 0, agentVersion };
  }
  return { kind: 'offline', items: [], total: 0, truncated: false, running: 0, agentVersion };
}
