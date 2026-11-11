/**
 * 设置 → 应用目录（P2）。
 *
 * 数据来源：构建期生成的 catalog.generated.json（由 agent/recipes/catalog.json 派生）。
 * 安装：POST /nodes/<hubId>/apps/app-catalog/recipe_install → 后台任务 → 手动刷新进度（不轮询）。
 * access 卡片只存在于任务结果，不写 D1；密码字段以 password 输入，不进入日志。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskResponse } from '@khc/contracts';
import catalog from '../catalog.generated.json';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import { hubsQueryOptions } from '../../data/queries';
import { action } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Card,
  CopyButton,
  Drawer,
  Field,
  InlineError,
  LogViewer,
  NumberInput,
  Row,
  Select,
  Stack,
  Table,
  TextInput,
  Toggle,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';

interface RecipeParam {
  key: string;
  label?: string;
  type: 'string' | 'integer' | 'boolean';
  default?: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  secret?: boolean;
}

interface CatalogRecipe {
  id: string;
  name: string;
  version: string;
  description: string;
  requiresRoot: boolean;
  params: RecipeParam[];
  access: unknown;
}

interface AccessItem {
  label: string;
  value: string;
  kind?: string;
  secret?: boolean;
  copy?: boolean;
}

interface InstalledEntry {
  version?: string;
  installedAt?: string;
  accessCount?: number;
}

const recipes = (catalog as { recipes: CatalogRecipe[] }).recipes;

function defaultValues(recipe: CatalogRecipe): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of recipe.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }
  return values;
}

/** recipe 的 installedAt 是 ISO 字符串（Agent 侧 datetime.isoformat）。 */
function installedTime(value?: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatAbsoluteTime(Math.floor(ms / 1000));
}

function taskAccess(task: TaskResponse | null): AccessItem[] {
  const result = task?.task.result as { access?: unknown } | null | undefined;
  if (!Array.isArray(result?.access)) return [];
  return result.access.filter(
    (item): item is AccessItem =>
      Boolean(item) && typeof item === 'object' && typeof (item as AccessItem).label === 'string',
  );
}

/** 与 Agent 侧 recipe 参数校验对齐（agent/khc/recipes.py）：必填、整数、范围、长度、pattern。 */
function validateValues(
  recipe: CatalogRecipe,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const param of recipe.params) {
    const label = param.label ?? param.key;
    const raw = values[param.key];
    if (param.type === 'integer') {
      if (raw === null || raw === undefined || raw === '') {
        if (param.required) errors[param.key] = fmt(zh.catalog.paramRequired, { label });
        continue;
      }
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(value)) {
        errors[param.key] = fmt(zh.catalog.paramInteger, { label });
        continue;
      }
      if (
        (param.min !== undefined && value < param.min) ||
        (param.max !== undefined && value > param.max)
      ) {
        errors[param.key] = fmt(zh.catalog.paramRange, {
          label,
          min: String(param.min ?? '—'),
          max: String(param.max ?? '—'),
        });
      }
      continue;
    }
    if (param.type === 'boolean') continue;
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (!text && param.required) {
      errors[param.key] = fmt(zh.catalog.paramRequired, { label });
      continue;
    }
    if (param.maxLength !== undefined && text.length > param.maxLength) {
      errors[param.key] = fmt(zh.catalog.paramMaxLength, { label, max: String(param.maxLength) });
      continue;
    }
    if (param.pattern) {
      let pattern: RegExp | null = null;
      try {
        // fullmatch 语义，与服务端一致（避免只匹配子串）。
        pattern = new RegExp(`^(?:${param.pattern})$`);
      } catch {
        pattern = null;
      }
      if (pattern && text && !pattern.test(text)) {
        errors[param.key] = fmt(zh.catalog.paramPattern, { label });
      }
    }
  }
  return errors;
}

export function AppCatalog() {
  const hubsQuery = useQuery(hubsQueryOptions());
  const toast = useToast();
  const [target, setTarget] = useState<CatalogRecipe | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<CatalogRecipe | null>(null);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  const nodes = (hubsQuery.data ?? []).map((node) => ({
    value: node.id,
    label: `${node.name}（${node.id}）`,
  }));

  // 已安装清单是节点侧 sync 动作：跟随页面顶部选中的节点读取，不 fan-out。
  const installedQuery = useQuery({
    queryKey: ['appCatalogInstalled', nodeId],
    enabled: Boolean(nodeId),
    retry: false,
    queryFn: async () => {
      try {
        const envelope = await runAppAction(nodeId, 'app-catalog', 'recipe_installed');
        if (!envelope.ok) {
          throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.installedLoadFailed);
        }
        const payload = envelope.result as { installed?: Record<string, InstalledEntry> } | undefined;
        return payload?.installed ?? {};
      } catch (cause) {
        throw new Error(
          friendlyAgentError(cause instanceof Error ? cause.message : null) ??
            zh.catalog.installedLoadFailed,
        );
      }
    },
  });
  const installedEntries = Object.entries(installedQuery.data ?? {});

  useEffect(() => {
    setNodeId((prev) => prev || hubsQuery.data?.[0]?.id || '');
  }, [hubsQuery.data]);

  const openInstall = (recipe: CatalogRecipe) => {
    setTarget(recipe);
    setValues(defaultValues(recipe));
    setNodeId((prev) => prev || nodes[0]?.value || '');
    setTask(null);
    setError(null);
  };

  const close = () => {
    setTarget(null);
    setTask(null);
    setError(null);
  };

  const submit = async () => {
    if (!target || !nodeId) return;
    const paramErrors = validateValues(target, values);
    if (Object.keys(paramErrors).length > 0) {
      setError(zh.catalog.fixParams);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const envelope = await runAppAction(nodeId, 'app-catalog', 'recipe_install', {
        recipeId: target.id,
        values,
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.installFailed);
      }
      if (envelope.taskId) {
        setTask(await fetchTask(nodeId, envelope.taskId));
      }
      toast.show({ message: zh.catalog.submitted });
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.installFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!task || !nodeId) return;
    setBusy(true);
    try {
      const next = await fetchTask(nodeId, task.task.id);
      setTask(next);
      // 安装/卸载完成后再回读已安装清单，避免列表与实际状态不一致。
      if (next.task.state === 'done') await installedQuery.refetch();
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.installFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!uninstallTarget) return;
    setUninstallError(null);
    try {
      const envelope = await runAppAction(nodeId, 'app-catalog', 'recipe_uninstall', {
        recipeId: uninstallTarget.id,
        values: defaultValues(uninstallTarget),
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.uninstallFailed);
      }
      // 复用安装抽屉展示任务日志（同一个 task 视图）。
      setValues(defaultValues(uninstallTarget));
      setTarget(uninstallTarget);
      setUninstallTarget(null);
      if (envelope.taskId) setTask(await fetchTask(nodeId, envelope.taskId));
      toast.show({ message: zh.catalog.uninstallSubmitted });
    } catch (cause) {
      setUninstallError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.uninstallFailed,
      );
    }
  };

  const columns: ColumnDef<CatalogRecipe>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.catalog.colName,
      value: (recipe) => recipe.name,
    },
    { key: 'version', type: 'text', header: '版本', value: (recipe) => recipe.version },
    {
      key: 'description',
      type: 'text',
      header: zh.catalog.colDesc,
      value: (recipe) => recipe.description,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const access = taskAccess(task);
  const paramErrors = target ? validateValues(target, values) : {};
  const hasParamErrors = Object.keys(paramErrors).length > 0;

  return (
    <Stack gap={4}>
      <Banner
        tone="info"
        title={zh.catalog.noticeTitle}
        description={zh.catalog.noticeDesc}
      />

      {hubsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.catalog.loadError}
          description={(hubsQuery.error as Error).message}
          action={<Button label={zh.common.retry} size="sm" onClick={() => void hubsQuery.refetch()} />}
        />
      ) : null}

      <Card
        title={zh.catalog.installedTitle}
        action={
          <Select
            id="catalog-installed-node"
            value={nodeId}
            options={nodes}
            placeholder={zh.catalog.nodeRequired}
            onChange={setNodeId}
            ariaLabel={zh.catalog.nodeLabel}
          />
        }
      >
        <Stack gap={2}>
          {uninstallError ? <InlineError message={uninstallError} /> : null}
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
          ) : hubsQuery.isLoading || (nodeId && installedQuery.isLoading) ? (
            <p className="ui-text-caption">{zh.common.loading}</p>
          ) : installedEntries.length === 0 ? (
            <p className="ui-text-caption">{zh.catalog.installedEmpty}</p>
          ) : (
            installedEntries.map(([id, entry]) => {
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
                    onClick={() => setUninstallTarget(recipe ?? null)}
                  />
                </Row>
              );
            })
          )}
        </Stack>
      </Card>

      <Table
        rows={hubsQuery.isLoading ? undefined : recipes}
        columns={columns}
        rowKey={(recipe) => recipe.id}
        objectLabel={zh.catalog.colName}
        rowActions={() => [{ id: 'catalog.install', label: zh.catalog.install, icon: 'download' }]}
        onRowAction={(_ref, recipe) => openInstall(recipe)}
        onRowOpen={(recipe) => openInstall(recipe)}
        empty={{ icon: 'box', title: zh.catalog.emptyTitle, description: zh.catalog.emptyDesc }}
      />

      {target ? (
        <Drawer
          open
          title={fmt(zh.catalog.drawerTitle, { name: target.name })}
          context={fmt(zh.catalog.drawerContext, { version: target.version })}
          dirty={Boolean(task)}
          onClose={close}
          footer={
            task ? (
              <Stack gap={2}>
                <Button label={zh.catalog.refresh} loading={busy} onClick={() => void refresh()} />
                <Button label={zh.catalog.close} variant="primary" onClick={close} />
              </Stack>
            ) : (
              <Stack gap={2}>
                <Button label={zh.common.cancel} onClick={close} />
                <Button
                  label={zh.catalog.install}
                  variant="primary"
                  loading={busy}
                  disabled={!nodeId || hasParamErrors}
                  disabledReason={
                    !nodeId ? zh.catalog.nodeRequired : hasParamErrors ? zh.catalog.fixParams : undefined
                  }
                  onClick={() => void submit()}
                />
              </Stack>
            )
          }
        >
          <Stack gap={4}>
            <Field id="catalog-node" label={zh.catalog.nodeLabel} help={zh.catalog.nodeHelp}>
              <Select
                id="catalog-node"
                value={nodeId}
                options={nodes}
                placeholder={zh.catalog.nodeRequired}
                onChange={setNodeId}
                ariaLabel={zh.catalog.nodeLabel}
              />
            </Field>

            {task ? (
              <Stack gap={3}>
                <Banner
                  tone={task.task.state === 'done' ? 'ok' : task.task.state === 'error' ? 'danger' : 'info'}
                  title={fmt(zh.catalog.taskState, {
                    state: task.task.state,
                    progress: String(task.task.progress),
                  })}
                  description={friendlyAgentError(task.task.error?.message) ?? undefined}
                />
                <LogViewer
                  lines={(task.task.logs ?? []).map((text) => ({ text }))}
                  title={zh.catalog.taskLogs}
                />
                {access.length > 0 ? (
                  <Stack gap={2}>
                    <span className="ui-text-caption">{zh.catalog.accessTitle}</span>
                    {access.map((item) => (
                      <div key={item.label} className="ui-row-between">
                        <span>{item.label}</span>
                        <span className="ui-row" style={{ gap: 8 }}>
                          <span className="ui-text-mono">{item.value}</span>
                          {item.copy !== false ? <CopyButton value={item.value} label={zh.common.copy} /> : null}
                        </span>
                      </div>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            ) : (
              target.params.map((param) => {
                const id = `catalog-${target.id}-${param.key}`;
                const label = param.label ?? param.key;
                if (param.type === 'boolean') {
                  return (
                    <Field key={param.key} id={id} label={label}>
                      <Toggle
                        checked={Boolean(values[param.key])}
                        onChange={(checked) =>
                          setValues((prev) => ({ ...prev, [param.key]: checked }))
                        }
                        label={label}
                      />
                    </Field>
                  );
                }
                if (param.type === 'integer') {
                  return (
                    <Field key={param.key} id={id} label={label} error={paramErrors[param.key]}>
                      <NumberInput
                        id={id}
                        value={typeof values[param.key] === 'number' ? (values[param.key] as number) : null}
                        min={param.min}
                        max={param.max}
                        invalid={Boolean(paramErrors[param.key])}
                        onChange={(value) => setValues((prev) => ({ ...prev, [param.key]: value }))}
                      />
                    </Field>
                  );
                }
                return (
                  <Field
                    key={param.key}
                    id={id}
                    label={label}
                    help={param.secret ? zh.catalog.secretHelp : undefined}
                    error={paramErrors[param.key]}
                  >
                    <TextInput
                      id={id}
                      type={param.secret ? 'password' : 'text'}
                      mono
                      autoComplete="off"
                      value={String(values[param.key] ?? '')}
                      invalid={Boolean(paramErrors[param.key])}
                      onChange={(value) => setValues((prev) => ({ ...prev, [param.key]: value }))}
                    />
                  </Field>
                );
              })
            )}

            {error ? <InlineError message={error} /> : null}
            {target.requiresRoot ? (
              <Banner tone="warn" title={zh.catalog.rootTitle} description={zh.catalog.rootDesc} />
            ) : null}
          </Stack>
        </Drawer>
      ) : null}

      {uninstallTarget ? (
        <ConfirmAction
          open
          action={action('catalog.uninstall')}
          title={fmt(zh.catalog.uninstallConfirmTitle, { name: uninstallTarget.name })}
          body={zh.catalog.uninstallConfirmDesc}
          confirmLabel={zh.catalog.uninstall}
          targetName={uninstallTarget.name}
          nameLabel={zh.catalog.colName}
          onCancel={() => setUninstallTarget(null)}
          onConfirm={uninstall}
        />
      ) : null}
    </Stack>
  );
}
