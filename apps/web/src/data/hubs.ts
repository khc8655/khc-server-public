/** 节点（Hub）API 封装。 */
import {
  appConfigListResponseSchema,
  nodeListResponseSchema,
  nodeProbeResponseSchema,
  nodeResponseSchema,
  nodeStateResponseSchema,
  nodeWithTokenResponseSchema,
  type AppConfigListResponse,
  type CreateNodeRequest,
  type Node,
  type NodeProbeResponse,
  type UpdateNodeRequest,
  type NodeStateResponse,
  type NodeWithTokenResponse,
} from '@khc/contracts';
import { apiRequest } from './client';

export async function fetchHubs(): Promise<Node[]> {
  const body = await apiRequest('/api/v1/nodes');
  return nodeListResponseSchema.parse(body).nodes;
}

export async function fetchHub(hubId: string): Promise<Node> {
  const body = await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}`);
  return nodeResponseSchema.parse(body).node;
}

export async function updateHub(hubId: string, patch: UpdateNodeRequest): Promise<Node> {
  const body = await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return nodeResponseSchema.parse(body).node;
}

export async function createHub(input: CreateNodeRequest): Promise<NodeWithTokenResponse> {
  const body = await apiRequest('/api/v1/nodes', { method: 'POST', body: JSON.stringify(input) });
  return nodeWithTokenResponseSchema.parse(body);
}

export async function deleteHub(hubId: string): Promise<void> {
  await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}`, { method: 'DELETE' });
}

export async function fetchHubState(
  hubId: string,
  options: { force?: boolean } = {},
): Promise<NodeStateResponse> {
  // force=1 跳过 Agent 侧 ops 采集的 5 秒缓存：写操作成功后要立刻看到真值。
  const query = options.force ? '?force=1' : '';
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/state${query}`,
  );
  return nodeStateResponseSchema.parse(body);
}

/** 一次性轻量探测全部节点（只消耗 1 次 Worker 请求）。 */
export async function probeHubs(): Promise<NodeProbeResponse> {
  const body = await apiRequest('/api/v1/nodes/probe', { method: 'POST' });
  return nodeProbeResponseSchema.parse(body);
}

export async function fetchHubApps(hubId: string): Promise<AppConfigListResponse> {
  const body = await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}/apps`);
  return appConfigListResponseSchema.parse(body);
}
