/** 节点最近操作（最小版：只读 audit，不做全局活动页）。 */
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from './client';

export interface NodeAuditEntry {
  id: number;
  at: number;
  actor: string | null;
  nodeId: string | null;
  app: string | null;
  action: string | null;
  detail?: Record<string, unknown> | null;
}

interface NodeAuditResponse {
  entries: NodeAuditEntry[];
}

export async function fetchNodeAudit(hubId: string, limit = 5): Promise<NodeAuditEntry[]> {
  const data = await apiRequest<NodeAuditResponse>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/audit?limit=${limit}`,
  );
  return Array.isArray(data.entries) ? data.entries : [];
}

export const nodeAuditQueryOptions = (hubId: string, limit = 5) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'audit', limit],
    queryFn: () => fetchNodeAudit(hubId, limit),
    staleTime: 30_000,
    retry: false,
  });
