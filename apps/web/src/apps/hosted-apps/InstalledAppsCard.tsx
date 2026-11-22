/**
 * 节点 → 应用 → 「已安装的托管应用」（只读 + 卸载）。
 *
 * 安装只发生在「发布应用」流程里；这里负责看得见、删得掉。
 * 卸载走清单自带的 uninstall 脚本（等于把 install 写下的 unit / 二进制 / 配置 / 数据全清掉），
 * 不是简单停服务，所以失败信息原样给出，不做「已卸载」的乐观提示。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import { appManifestsQueryOptions } from '../../data/appManifests';
import { refreshHubRuntime } from '../../data/queries';
import { action } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import { Button, Card, InlineError, Row, Skeleton, Stack, useToast } from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import {
  hostedAppsInstalledQueryKey,
  installedTime,
  parseInstalledRecipes,
  toCatalogRecipe,
  type CatalogRecipe,
} from './recipes';

export function InstalledAppsCard({
  hubId,
  pollIntervalMs = 800,
}: {
  hubId: string;
  /** 测试可注入更短轮询间隔，生产默认 800ms */
  pollIntervalMs?: number;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const installedQuery = useQuery({
    queryKey: hostedAppsInstalledQueryKey(hubId),
    retry: false,
    queryFn: async () => {
      const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_installed');
      if (!envelope.ok) {
        throw new Error(
          friendlyAgentError(envelope.error?.message) ?? zh.catalog.installedLoadFailed,
        );
      }
      return parseInstalledRecipes(envelope);
    },
  });
  const [target, setTarget] = useState<CatalogRecipe | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipes = (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toCatalogRecipe);
  const installed = Object.entries(installedQuery.data ?? {});

  // 没有已安装托管应用时隐藏占位卡，避免把「应用表」和「本机监听端口」隔开。
  if (
    !installedQuery.isLoading &&
    !installedQuery.error &&
    !error &&
    uninstallingId === null &&
    installed.length === 0
  ) {
    return null;
  }

  const uninstall = async () => {
    if (!target) return;
    const recipeToRemove = target;
    setTarget(null);
    setUninstallingId(recipeToRemove.id);
    setError(null);
    try {
      const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_uninstall', {
        manifestId: recipeToRemove.id,
        values: {},
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.uninstallFailed);
      }
      if (envelope.taskId) {
        let current = await fetchTask(hubId, envelope.taskId);
        const maxPolls = Math.ceil(60_000 / Math.max(pollIntervalMs, 5));
        for (
          let i = 0;
          i < maxPolls && (current.task.state === 'pending' || current.task.state === 'running');
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          current = await fetchTask(hubId, envelope.taskId);
        }
        if (current.task.state !== 'done') {
          throw new Error(
            friendlyAgentError(current.task.error?.message) ?? zh.catalog.uninstallFailed,
          );
        }
      }
      toast.show({ message: zh.catalog.uninstallSubmitted });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: hostedAppsInstalledQueryKey(hubId) }),
        refreshHubRuntime(queryClient, hubId),
      ]);
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.uninstallFailed,
      );
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <Card title={zh.hosted.installedTitle}>
      <Stack gap={3}>
        <p className="ui-text-caption">{zh.hosted.installedDesc}</p>
        {error ? <InlineError message={error} /> : null}
        {installedQuery.error ? (
          <Stack gap={2}>
            <InlineError
              message={
                friendlyAgentError((installedQuery.error as Error).message) ??
                zh.catalog.installedLoadFailed
              }
            />
            <Button label={zh.common.retry} size="sm" onClick={() => void installedQuery.refetch()} />
          </Stack>
        ) : installedQuery.isLoading ? (
          <Stack gap={2}>
            <Skeleton height={20} />
            <Skeleton height={20} />
          </Stack>
        ) : installed.length === 0 ? (
          <p className="ui-text-caption">{zh.hosted.installedEmpty}</p>
        ) : (
          installed.map(([id, entry]) => {
            const recipe = recipes.find((item) => item.id === id);
            return (
              <Row key={id} justify="between">
                <Stack gap={1}>
                  <span>{recipe?.name ?? id}</span>
                  <span className="ui-text-caption">
                    {fmt(zh.catalog.installedMeta, {
                      version: entry.version ?? '—',
                      time: installedTime(entry.installedAt),
                    })}
                  </span>
                </Stack>
                <Button
                  label={zh.catalog.uninstall}
                  size="sm"
                  loading={uninstallingId === id}
                  disabled={!recipe || uninstallingId !== null}
                  disabledReason={recipe ? undefined : zh.catalog.installedUnknown}
                  onClick={() => setTarget(recipe ?? null)}
                />
              </Row>
            );
          })
        )}
      </Stack>

      {target ? (
        <ConfirmAction
          open
          action={action('app.uninstall')}
          title={fmt(zh.catalog.uninstallConfirmTitle, { name: target.name })}
          body={zh.catalog.uninstallConfirmDesc}
          confirmLabel={zh.actions['app.uninstall']}
          targetName={target.name}
          nameLabel={zh.catalog.colName}
          onCancel={() => setTarget(null)}
          onConfirm={uninstall}
        />
      ) : null}
    </Card>
  );
}
