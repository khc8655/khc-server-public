/** 应用配置 / 任务 API 封装。 */
import {
  agentEnvelopeSchema,
  appConfigResponseSchema,
  revisionListResponseSchema,
  rollbackResponseSchema,
  taskResponseSchema,
  type AgentEnvelope,
  type AppConfig,
  type Revision,
  type RollbackResponse,
  type TaskResponse,
} from '@khc/contracts';
import { ApiError, apiRequest } from './client';
import { fmt, zh } from '../i18n/zh';

/**
 * 旧版 Agent 的原始错误 → 可操作提示。
 * 例如直接暴露「未知动作: caddy_import_scan」「recipe 清单不存在或不是 JSON 对象」，
 * 用户看不出这是「Agent 太旧」，这里统一转成升级引导。
 */
export function friendlyAgentError(message: string | null | undefined): string | null {
  const raw = (message ?? '').trim();
  if (!raw) return null;
  const action =
    raw.match(/未知动作[:：]\s*([A-Za-z0-9_.-]+)/)?.[1] ??
    raw.match(/unknown action[:：\s]+([A-Za-z0-9_.-]+)/i)?.[1];
  if (action) return fmt(zh.agentUpgrade.action, { action });
  if (/recipe\s*清单不存在|清单不存在或不是\s*JSON|recipe.*not\s+found/i.test(raw)) {
    return zh.agentUpgrade.recipe;
  }
  return raw;
}

export async function fetchAppConfig(hubId: string, app: string): Promise<AppConfig | null> {
  try {
    const body = await apiRequest(
      `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}`,
    );
    return appConfigResponseSchema.parse(body).app;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function saveAppConfig(
  hubId: string,
  app: string,
  config: Record<string, unknown>,
  note?: string,
): Promise<AppConfig> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ config, note }),
    },
  );
  return appConfigResponseSchema.parse(body).app;
}

export async function runAppAction(
  hubId: string,
  app: string,
  action: string,
  params: Record<string, unknown> = {},
  options: { idempotencyKey?: string } = {},
): Promise<AgentEnvelope> {
  const body: Record<string, unknown> = { params };
  if (options.idempotencyKey) body.idempotencyKey = options.idempotencyKey;
  const response = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}/${action}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return agentEnvelopeSchema.parse(response);
}

export async function fetchTask(hubId: string, taskId: string): Promise<TaskResponse> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/tasks/${encodeURIComponent(taskId)}`,
  );
  return taskResponseSchema.parse(body);
}

/** apply 响应里 hostFw 报告的人话消息（“已自动放行 …”回显，passthrough 字段）。 */
export function hostFwMessages(envelope: AgentEnvelope): string[] {
  const record = envelope as unknown as Record<string, unknown>;
  const hostFw = record?.hostFw as { messages?: unknown } | undefined;
  if (!Array.isArray(hostFw?.messages)) return [];
  return hostFw.messages.filter((message): message is string => typeof message === 'string');
}

export async function fetchRevisions(hubId: string, app: string): Promise<Revision[]> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}/revisions`,
  );
  return revisionListResponseSchema.parse(body).revisions;
}

export async function rollbackApp(
  hubId: string,
  app: string,
  rev: number,
): Promise<RollbackResponse> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}/rollback/${rev}`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return rollbackResponseSchema.parse(body);
}
