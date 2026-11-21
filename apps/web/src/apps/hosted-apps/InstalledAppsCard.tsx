/**
 * 节点 → 应用 → 「已安装的托管应用」（只读 + 卸载）。
 *
 * 安装只发生在「发布应用」流程里；这里负责看得见、删得掉。
 * 卸载走清单自带的 uninstall 脚本（等于把 install 写下的 unit / 二进制 / 配置 / 数据全清掉），
 * 不是简单停服务，所以失败信息原样给出，不做「已卸载」的乐观提示。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { friendlyAgentError, runAppAction } from '../../data/apps';
import { appManifestsQueryOptions } from '../../data/appManifests';
import { action } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import { Button, Card, InlineError, Row, Stack, useToast } from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { installedTime, toCatalogRecipe, type CatalogRecipe, type InstalledEntry } from './recipes';

export function InstalledAppsCard({ hubId }: { hubId: string }) {
  const toast = useToast();
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const installedQuery = useQuery({
    queryKey: ['hostedAppsInstalled', hubId],
    retry: false,
    queryFn: async () => {
      const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_installed');
      if (!envelope.ok) {
        throw new Error(
          friendlyAgentError(envelope.error?.message) ?? zh.catalog.installedLoadFailed,
        );
      }
      const payload = envelope.result as { installed?: Record<string, InstalledEntry> } | undefined;
      return payload?.installed ?? {};
    },
  });
  const [target, setTarget] = useState<CatalogRecipe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipes = (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toCatalogRecipe);
  const installed = Object.entries(installedQuery.data ?? {});

  const uninstall = async () => {
    if (!target) return;
    setError(null);
    try {
      const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_uninstall', {
        manifestId: target.id,
        values: {},
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.uninstallFailed);
      }
      setTarget(null);
      toast.show({ message: zh.catalog.uninstallSubmitted });
      await installedQuery.refetch();
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.uninstallFailed,
      );
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
          <p className="ui-text-caption">{zh.common.loading}</p>
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
                  disabled={!recipe}
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
          action={action('catalog.uninstall')}
          title={fmt(zh.catalog.uninstallConfirmTitle, { name: target.name })}
          body={zh.catalog.uninstallConfirmDesc}
          confirmLabel={zh.catalog.uninstall}
          targetName={target.name}
          nameLabel={zh.catalog.colName}
          onCancel={() => setTarget(null)}
          onConfirm={uninstall}
        />
      ) : null}
    </Card>
  );
}
