/**
 * 设置 → 应用目录（只读脚本库）。
 *
 * 这里回答「我们适配了哪些应用、怎么装（二进制的 install/uninstall 脚本）」，
 * **不装任何东西**：安装只发生在「节点 → 应用 → 发布应用」流程里，落在那台 VM 上。
 * 清单在「应用管理」维护、存 D1；新增脚本不发版即可出现。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appManifestsQueryOptions } from '../../data/appManifests';
import {
  Banner,
  Button,
  Card,
  Drawer,
  Field,
  Stack,
  Table,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { toCatalogRecipe, type CatalogRecipe } from '../hosted-apps/recipes';

export function AppCatalog({ onOpenManifests }: { onOpenManifests?: () => void } = {}) {
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const [detail, setDetail] = useState<CatalogRecipe | null>(null);

  const recipes = (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toCatalogRecipe);

  const columns: ColumnDef<CatalogRecipe>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.catalog.colName,
      value: (recipe) => recipe.name,
    },
    { key: 'version', type: 'text', header: zh.catalog.colVersion, value: (recipe) => recipe.version },
    {
      key: 'runtime',
      type: 'text',
      header: zh.catalog.colRuntime,
      value: (recipe) => recipe.description,
    },
    {
      key: 'publish',
      type: 'text',
      header: zh.catalog.colPublish,
      value: (recipe) =>
        recipe.manifest.publish
          ? fmt(zh.catalog.colPublishValue, {
              label: recipe.manifest.publish.label ?? zh.catalog.publishFallbackLabel,
              port: String(declaredPort(recipe) ?? '—'),
            })
          : zh.catalog.colPublishNone,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <Stack gap={4}>
      <Banner tone="info" title={zh.catalog.noticeTitle} description={zh.catalog.noticeDesc} />

      {manifestsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.catalog.manifestsLoadFailed}
          description={(manifestsQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void manifestsQuery.refetch()} />
          }
        />
      ) : null}

      <Table
        rows={manifestsQuery.isLoading ? undefined : recipes}
        columns={columns}
        rowKey={(recipe) => recipe.id}
        objectLabel={zh.catalog.colName}
        rowActions={() => [{ id: 'catalog.detail', label: zh.catalog.viewDetail, icon: 'info' }]}
        onRowAction={(_ref, recipe) => setDetail(recipe)}
        onRowOpen={(recipe) => setDetail(recipe)}
        empty={
          manifestsQuery.isError
            ? {
                icon: 'alert',
                title: zh.catalog.manifestsLoadFailed,
                description: zh.catalog.manifestsLoadFailedDesc,
              }
            : {
                icon: 'box',
                title: zh.catalog.emptyTitle,
                description: zh.catalog.emptyDesc,
                action: onOpenManifests ? (
                  <Button label={zh.catalog.goManifests} size="sm" onClick={onOpenManifests} />
                ) : undefined,
              }
        }
      />

      {detail ? (
        <Drawer
          open
          title={fmt(zh.catalog.detailTitle, { name: detail.name })}
          context={fmt(zh.catalog.drawerContext, { version: detail.version })}
          onClose={() => setDetail(null)}
          footer={
            <Button label={zh.catalog.close} variant="primary" onClick={() => setDetail(null)} />
          }
        >
          <Stack gap={4}>
            <Banner
              tone="info"
              title={zh.catalog.installElsewhereTitle}
              description={zh.catalog.installElsewhereDesc}
            />
            <Card title={zh.catalog.detailRuntimeTitle}>
              <Stack gap={2}>
                <span className="ui-text-caption">{detail.description}</span>
                <span className="ui-text-caption">{zh.catalog.detailInstallMode}</span>
              </Stack>
            </Card>
            {detail.manifest.publish ? (
              <Card title={zh.catalog.detailPublishTitle}>
                <span className="ui-text-caption">
                  {fmt(zh.catalog.detailPublishDesc, {
                    label: detail.manifest.publish.label ?? zh.catalog.publishFallbackLabel,
                    port: String(declaredPort(detail) ?? '—'),
                  })}
                </span>
              </Card>
            ) : null}
            {detail.params.length > 0 ? (
              <Card title={zh.catalog.detailParamsTitle}>
                {/* 只读：不渲染成输入框，避免看起来能在这里填了装机 */}
                <Stack gap={2}>
                  {detail.params.map((param) => (
                    <Field key={param.key} id={`catalog-p-${param.key}`} label={param.label ?? param.key}>
                      <div className="ui-readonly-field mono">
                        {param.default === undefined
                          ? zh.catalog.detailParamRequired
                          : param.default === ''
                            ? zh.catalog.detailParamOptional
                            : String(param.default)}
                      </div>
                    </Field>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        </Drawer>
      ) : null}
    </Stack>
  );
}

/** 清单声明的本机端口（取参数默认值或固定 port）。 */
function declaredPort(recipe: CatalogRecipe): number | string {
  const decl = recipe.manifest.publish;
  if (!decl) return '—';
  const raw = decl.portParam
    ? recipe.params.find((param) => param.key === decl.portParam)?.default
    : decl.port;
  return typeof raw === 'number' ? raw : '—';
}
