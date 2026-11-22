/** React Query 查询：唯一允许调用 API 的目录。 */
import { useEffect } from 'react';
import { queryOptions, type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { Node, NodeOverviewResponse, NodeStateResponse } from '@khc/contracts';
import { fetchAppConfig, fetchRevisions } from './apps';
import { meQueryOptions } from './auth';
import { fetchHub, fetchHubApps, fetchHubOverview, fetchHubState, fetchHubs } from './hubs';

export { meQueryOptions };

export const hubsQueryOptions = () =>
  queryOptions({
    queryKey: ['hubs'],
    queryFn: fetchHubs,
    staleTime: 30_000,
  });

export const hubQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId],
    queryFn: () => fetchHub(hubId),
    staleTime: 30_000,
    enabled: Boolean(hubId),
  });

export const hubStateQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'state'],
    queryFn: () => fetchHubState(hubId),
    staleTime: 30_000,
    enabled: Boolean(hubId),
  });

export const hubOverviewQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'overview'],
    queryFn: () => fetchHubOverview(hubId),
    staleTime: 30_000,
    enabled: Boolean(hubId),
  });

export const hubAppsQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps'],
    queryFn: () => fetchHubApps(hubId),
    staleTime: 30_000,
    enabled: Boolean(hubId),
  });

export const appConfigQueryOptions = (hubId: string, app: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', app],
    queryFn: () => fetchAppConfig(hubId, app),
    staleTime: 30_000,
    enabled: Boolean(hubId && app),
  });

export const revisionsQueryOptions = (hubId: string, app: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', app, 'revisions'],
    queryFn: () => fetchRevisions(hubId, app),
    staleTime: 5_000,
    enabled: Boolean(hubId && app),
  });

/** 将 `/overview` 返回的节点与控制面状态回填进共享缓存，消除额外 `/nodes/:id` 与 `/state` 请求。 */
export function fillHubOverviewCaches(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  hubId: string,
  data: NodeOverviewResponse,
): void {
  queryClient.setQueryData(['hubs', hubId], data.node);
  queryClient.setQueryData<NodeStateResponse>(['hubs', hubId, 'state'], {
    reachable: data.reachable,
    route: data.route,
    via: data.via,
    error: data.error,
    ...(data.epochStale ? { epochStale: data.epochStale } : {}),
    tls: data.tls,
    state: data.state,
  });
}

/** 写操作后统一刷新工作区运行态（仅经 `/overview`，并回填共享缓存）。 */
export async function refreshHubRuntime(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'setQueryData'>,
  hubId: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (opts?.force) {
    try {
      const fresh = await fetchHubOverview(hubId, { force: true });
      queryClient.setQueryData(['hubs', hubId, 'overview'], fresh);
      fillHubOverviewCaches(queryClient, hubId, fresh);
      return;
    } catch {
      // force 直拉失败时退回失效，由挂载中的 Provider 重试。
    }
  }
  await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'overview'] });
}



/**
 * 打开面板时的 /state 探测成功会更新服务端 lastSeen；同步更新前端节点缓存，
 * 避免列表/侧栏继续显示旧的“离线”。
 */
export function useMarkHubReachable(hubId: string, reachable: boolean | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (reachable === undefined) return;
    const now = Math.floor(Date.now() / 1000);
    const status = reachable ? 'online' : 'offline';
    queryClient.setQueryData<Node | undefined>(['hubs', hubId], (old) =>
      old ? { ...old, status, ...(reachable ? { lastSeenAt: now } : {}) } : old,
    );
    queryClient.setQueryData<Node[] | undefined>(['hubs'], (old) =>
      old?.map((node) =>
        node.id === hubId ? { ...node, status, ...(reachable ? { lastSeenAt: now } : {}) } : node,
      ),
    );
  }, [hubId, queryClient, reachable]);
}
