import type { TaskResponse } from '@khc/contracts';
import { fmt, zh } from '../i18n/zh';

/** 失败原因在卡片里最多占的长度；完整内容仍可在「任务」抽屉查看。 */
const REASON_MAX = 140;

/**
 * 安装任务的一行摘要，**失败时必须带上原因**。
 *
 * 之前的实现只拼 `任务 {id}：{state} · {progress}%`，任务失败时用户只能看到
 * 「error · 1%」，必须另点顶栏「任务」才知道为什么 —— 2026-11-20 wireguard
 * 安装恒失败时，这条让排查多绕了一圈。任务响应里本来就有 `error.message`
 * （`taskResponseSchema` 是完整任务，不是摘要），没有理由不显示。
 */
export function installTaskText(task: TaskResponse, template: string): string {
  const base = fmt(template, {
    id: task.task.id,
    state: task.task.state,
    progress: String(task.task.progress),
  });
  if (task.task.state !== 'error') return base;
  const reason = (task.task.error?.message ?? '').trim();
  if (!reason) return base;
  const short = reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason;
  return `${base} · ${zh.tasks.errorLabel}：${short}`;
}
