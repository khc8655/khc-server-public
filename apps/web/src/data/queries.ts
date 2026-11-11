/** React Query 查询：唯一允许调用 API 的目录。 */
import { useEffect } from 'react';
import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@khc/contracts';
import { fetchAppConfig, fetchRevisions } from './apps';
import { meQueryOptions } from './auth';
import { fetchHub, fetchHubApps, fetchHubState, fetchHubs } from './hubs';

export { meQueryOptions };

export const hubsQueryOptions = () =>
  queryOptions({
    queryKey: ['hubs'],
    queryFn: fetchHubs,
    staleTime: 10_000,
  });

export const hubQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId],
    queryFn: () => fetchHub(hubId),
    staleTime: 10_000,
    enabled: Boolean(hubId),
  });

export const hubStateQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'state'],
    queryFn: () => fetchHubState(hubId),
    staleTime: 5_000,
    enabled: Boolean(hubId),
  });

export const hubAppsQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps'],
    queryFn: () => fetchHubApps(hubId),
    staleTime: 10_000,
    enabled: Boolean(hubId),
  });

export const appConfigQueryOptions = (hubId: string, app: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', app],
    queryFn: () => fetchAppConfig(hubId, app),
    staleTime: 5_000,
    enabled: Boolean(hubId && app),
  });

export const revisionsQueryOptions = (hubId: string, app: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', app, 'revisions'],
    queryFn: () => fetchRevisions(hubId, app),
    staleTime: 5_000,
    enabled: Boolean(hubId && app),
  });



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
