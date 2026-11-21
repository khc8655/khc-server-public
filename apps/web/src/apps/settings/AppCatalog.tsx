/**
 * 设置 → 应用目录（R1 起运行时读取 D1 应用清单）。
 *
 * 数据来源：GET /api/v1/app-manifests（不再构建期生成），新增脚本不发版即可出现。
 * 安装：POST /nodes/<hubId>/apps/app-catalog/recipe_install 带 manifestId，
 * Worker 从 D1 读出正文附到请求里；后台任务 → 手动刷新进度（不轮询）。
 * access 卡片只存在于任务结果，不写 D1；密码字段以 password 输入，不进入日志。
 *
 * 清单声明了 `publish` 时，安装完成后可以就地发布：安装任务 done → 面板建 Caddy 站点
 * （域名来自节点、发布端口由用户选、上游 = 清单声明的本机端口）→ apply，与应用页手动
 * 加站点走同一条 `publishProxySite`。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskResponse } from '@khc/contracts';
import { appManifestsQueryOptions } from '../../data/appManifests';
import type { AppManifest, AppRuntimeMode, Node } from '@khc/contracts';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import { publishProxySite } from '../../data/sites';
import { HTTPS_PORT_OPTIONS } from '../../data/endpoint';
import { hubsQueryOptions } from '../../data/queries';
import { action } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Card,
  Checkbox,
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
import {
  DEFAULT_AGENT_PORT,
  DEFAULT_PUBLISH_PORT,
  suggestPublishPort,
} from '../node-settings/AccessForm';
import {
  appPublishTarget,
  appPublishUpstream,
  appPublishUrl,
  deriveAppPublishPlan,
  nodeAgentPort,
  nodePublishDomain,
} from './appPublish';

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
  runtimeMode: AppRuntimeMode;
  runtimeUser?: string;
  /** 原始清单：发布计划要读 `publish` 声明与参数默认值 */
  manifest: AppManifest['manifest'];
}

/** 列表与卡片里的运行身份文案；旧值 shared 按「新建用户」显示。 */
export function runtimeLabel(runtime: AppManifest['manifest']['runtime']): string {
  if (runtime.mode === 'root') return zh.catalog.runtimeRootShort;
  return runtime.user
    ? fmt(zh.catalog.runtimeCreateShort, { user: runtime.user })
    : zh.catalog.runtimeCreate;
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

function toCatalogRecipe(item: AppManifest): CatalogRecipe {
  return {
    id: item.id,
    name: item.manifest.name,
    version: item.manifest.version,
    description: runtimeLabel(item.manifest.runtime),
    requiresRoot: false,
    runtimeMode: item.manifest.runtime.mode === 'root' ? 'root' : 'create',
    runtimeUser: item.manifest.runtime.user,
    manifest: item.manifest,
    params: item.manifest.params.map((param) => ({
      key: param.key,
      label: param.label,
      type: param.type,
      default: param.default,
      required: param.default === undefined,
      min: param.min,
      max: param.max,
      maxLength: param.maxLength,
      pattern: param.pattern,
      secret: param.secret,
    })),
    access: [],
  };
}

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

export function AppCatalog({ onOpenManifests }: { onOpenManifests?: () => void } = {}) {
  const hubsQuery = useQuery(hubsQueryOptions());
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const toast = useToast();
  const [target, setTarget] = useState<CatalogRecipe | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [runtimeMode, setRuntimeMode] = useState<AppRuntimeMode>('create');
  const [runtimeUser, setRuntimeUser] = useState('');
  const [runtimePassword, setRuntimePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);
  /** 同一个抽屉既跑安装也跑卸载：只有安装完成后才接发布 */
  const [taskMode, setTaskMode] = useState<'install' | 'uninstall'>('install');
  const [uninstallTarget, setUninstallTarget] = useState<CatalogRecipe | null>(null);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const [publishEnabled, setPublishEnabled] = useState(false);
  const [publishPort, setPublishPort] = useState<string>(DEFAULT_PUBLISH_PORT);
  const [publishState, setPublishState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);
  /** 面板自动填进 public_url 的值；用户手改过（值不相等）就不再覆盖 */
  const autoPublicUrl = useRef<string | null>(null);

  const recipes = (manifestsQuery.data ?? [])
    .filter((item) => item.enabled)
    .map(toCatalogRecipe);

  const nodes = (hubsQuery.data ?? []).map((node) => ({
    value: node.id,
    label: `${node.name}（${node.id}）`,
  }));

  const selectedNode: Node | undefined = (hubsQuery.data ?? []).find((node) => node.id === nodeId);
  const publishDecl = target?.manifest.publish;
  const publishResult =
    target && publishDecl
      ? deriveAppPublishPlan({
          manifest: target.manifest,
          node: selectedNode,
          values,
          publishPort: Number(publishPort),
        })
      : null;
  const publishPlan = publishResult?.plan ?? null;
  /** 勾了发布但端口撞 Agent：挡住安装，避免装完注定发布失败 */
  const publishBlocked = publishEnabled && publishResult?.issue === 'port-conflict';
  /** 清单声明了 public_url 时，安装前就把它填成发布地址，安装回传的登录链接才是对外链接 */
  const hasPublicUrlParam = Boolean(target?.params.some((param) => param.key === 'public_url'));
  const computedPublishUrl = publishPlan ? appPublishUrl(publishPlan) : null;

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

  // 发布地址变了就同步 public_url（只在用户没手改过时）。写进表单里可见，不做暗改。
  useEffect(() => {
    if (!hasPublicUrlParam || !publishEnabled || !computedPublishUrl) return;
    setValues((prev) => {
      const current = String(prev.public_url ?? '');
      if (current && current !== autoPublicUrl.current) return prev;
      if (current === computedPublishUrl) return prev;
      autoPublicUrl.current = computedPublishUrl;
      return { ...prev, public_url: computedPublishUrl };
    });
  }, [computedPublishUrl, hasPublicUrlParam, publishEnabled]);

  const defaultPublishPort = (node: Node | undefined): string =>
    suggestPublishPort(String(nodeAgentPort(node) || DEFAULT_AGENT_PORT));

  const openInstall = (recipe: CatalogRecipe) => {
    const activeNode =
      (hubsQuery.data ?? []).find((node) => node.id === nodeId) ?? (hubsQuery.data ?? [])[0];
    setTarget(recipe);
    setValues(defaultValues(recipe));
    setRuntimeMode(recipe.runtimeMode);
    setRuntimeUser(recipe.runtimeUser ?? '');
    setRuntimePassword('');
    setNodeId((prev) => prev || activeNode?.id || nodes[0]?.value || '');
    setTask(null);
    setTaskMode('install');
    setError(null);
    setPublishEnabled(Boolean(recipe.manifest.publish) && Boolean(nodePublishDomain(activeNode)));
    setPublishPort(defaultPublishPort(activeNode));
    setPublishState('idle');
    setPublishError(null);
    autoPublicUrl.current = null;
  };

  /** 换节点会换域名与 Agent 端口：没域名的节点直接关掉发布，端口撞了就换一条。 */
  const changeNode = (id: string) => {
    setNodeId(id);
    const next = (hubsQuery.data ?? []).find((node) => node.id === id);
    if (!next) return;
    const domain = nodePublishDomain(next);
    setPublishEnabled(Boolean(publishDecl) && Boolean(domain));
    const agentPort = nodeAgentPort(next);
    if (Number(publishPort) === agentPort) setPublishPort(defaultPublishPort(next));
  };

  const close = () => {
    setTarget(null);
    setTask(null);
    setError(null);
    setPublishState('idle');
    setPublishError(null);
  };

  const submit = async () => {
    if (!target || !nodeId) return;
    const paramErrors = validateValues(target, values);
    if (Object.keys(paramErrors).length > 0) {
      setError(zh.catalog.fixParams);
      return;
    }
    if (publishEnabled && publishResult?.issue === 'port-conflict') {
      setError(zh.access.publishPortConflictIssue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const envelope = await runAppAction(nodeId, 'app-catalog', 'recipe_install', {
        manifestId: target.id,
        values,
        runtimeMode,
        ...(runtimeMode === 'create'
          ? { runtimeUser: runtimeUser.trim(), runtimePassword }
          : {}),
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.installFailed);
      }
      setTaskMode('install');
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

  /** 建站点 + apply（域名来自节点、上游来自清单声明），失败会回滚站点配置。 */
  const runPublish = async (id: string, plan: NonNullable<typeof publishPlan>) => {
    setPublishState('running');
    setPublishError(null);
    try {
      await publishProxySite(id, {
        domain: plan.domain,
        listenPort: plan.publishPort,
        upstream: plan.upstream,
      });
      setPublishState('done');
    } catch (cause) {
      setPublishState('error');
      setPublishError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.publishFailed,
      );
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
      // 安装完成才发布：应用没起来之前建站点只会得到 502。
      if (
        next.task.state === 'done' &&
        taskMode === 'install' &&
        publishEnabled &&
        publishPlan &&
        publishState === 'idle'
      ) {
        await runPublish(nodeId, publishPlan);
      }
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
        manifestId: uninstallTarget.id,
        values: defaultValues(uninstallTarget),
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.uninstallFailed);
      }
      // 复用安装抽屉展示任务日志（同一个 task 视图）；卸载不接发布。
      setValues(defaultValues(uninstallTarget));
      setTarget(uninstallTarget);
      setTaskMode('uninstall');
      setPublishEnabled(false);
      setPublishState('idle');
      setPublishError(null);
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

      {manifestsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.catalog.manifestsLoadFailed}
          description={(manifestsQuery.error as Error).message}
          action={<Button label={zh.common.retry} size="sm" onClick={() => void manifestsQuery.refetch()} />}
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
        rows={hubsQuery.isLoading || manifestsQuery.isLoading ? undefined : recipes}
        columns={columns}
        rowKey={(recipe) => recipe.id}
        objectLabel={zh.catalog.colName}
        rowActions={() => [{ id: 'catalog.install', label: zh.catalog.install, icon: 'download' }]}
        onRowAction={(_ref, recipe) => openInstall(recipe)}
        onRowOpen={(recipe) => openInstall(recipe)}
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
                  disabled={
                    !nodeId ||
                    hasParamErrors ||
                    (runtimeMode === 'create' && (!runtimeUser.trim() || !runtimePassword)) ||
                    publishBlocked
                  }
                  disabledReason={
                    !nodeId
                      ? zh.catalog.nodeRequired
                      : hasParamErrors
                        ? zh.catalog.fixParams
                        : runtimeMode === 'create' && !runtimeUser.trim()
                          ? zh.catalog.runtimeUserRequired
                          : runtimeMode === 'create' && !runtimePassword
                            ? zh.catalog.runtimePasswordRequired
                            : publishBlocked
                              ? zh.access.publishPortConflictIssue
                              : undefined
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
                onChange={changeNode}
                ariaLabel={zh.catalog.nodeLabel}
              />
            </Field>

            <Field
              id="catalog-runtime-mode"
              label={zh.catalog.runtimeLabel}
              help={runtimeMode === 'create' ? zh.catalog.runtimeCreateHelp : undefined}
            >
              <Select
                id="catalog-runtime-mode"
                value={runtimeMode}
                options={[
                  { value: 'create', label: zh.catalog.runtimeCreate },
                  { value: 'root', label: zh.catalog.runtimeRoot },
                ]}
                onChange={(value) => setRuntimeMode(value as AppRuntimeMode)}
                ariaLabel={zh.catalog.runtimeLabel}
              />
            </Field>
            {runtimeMode === 'root' ? (
              <Banner
                tone="warn"
                title={zh.catalog.runtimeRootWarnTitle}
                description={zh.catalog.runtimeRootWarnDesc}
              />
            ) : null}

            {runtimeMode === 'create' ? (
              <>
                <Field id="catalog-runtime-user" label={zh.catalog.runtimeUserLabel}>
                  <TextInput
                    id="catalog-runtime-user"
                    value={runtimeUser}
                    mono
                    autoComplete="off"
                    placeholder="khc-app-demo"
                    onChange={setRuntimeUser}
                  />
                </Field>
                <Field
                  id="catalog-runtime-password"
                  label={zh.catalog.runtimePasswordLabel}
                  help={zh.catalog.secretHelp}
                >
                  <TextInput
                    id="catalog-runtime-password"
                    type="password"
                    value={runtimePassword}
                    autoComplete="new-password"
                    onChange={setRuntimePassword}
                  />
                </Field>
              </>
            ) : null}

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
                {taskMode === 'install' && publishDecl && publishPlan && publishState !== 'idle' ? (
                  <Banner
                    tone={
                      publishState === 'done' ? 'ok' : publishState === 'error' ? 'danger' : 'info'
                    }
                    title={
                      publishState === 'done'
                        ? fmt(zh.catalog.publishDoneTitle, { url: appPublishUrl(publishPlan) })
                        : publishState === 'error'
                          ? zh.catalog.publishFailed
                          : zh.catalog.publishRunning
                    }
                    description={
                      publishState === 'done'
                        ? fmt(zh.catalog.publishDoneHint, { url: appPublishUrl(publishPlan) })
                        : publishState === 'error'
                          ? (publishError ?? undefined)
                          : fmt(zh.catalog.publishRunningHint, { url: appPublishUrl(publishPlan) })
                    }
                    action={
                      publishState === 'error' ? (
                        <Button
                          size="sm"
                          label={zh.catalog.publishRetry}
                          onClick={() => void runPublish(nodeId, publishPlan)}
                        />
                      ) : undefined
                    }
                  />
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

            {publishDecl && !task ? (
              <Stack gap={3}>
                <span className="ui-text-caption">
                  {fmt(zh.catalog.publishSection, {
                    label: publishDecl.label ?? zh.catalog.publishFallbackLabel,
                  })}
                </span>
                {publishResult?.issue === 'no-domain' ? (
                  <Banner
                    tone="warn"
                    title={zh.catalog.publishNoDomainTitle}
                    description={zh.catalog.publishNoDomainDesc}
                  />
                ) : (
                  <>
                    <Checkbox
                      checked={publishEnabled}
                      onChange={(checked) => {
                        setPublishEnabled(checked);
                        setPublishState('idle');
                        setPublishError(null);
                        // 关掉发布就把面板自动填的对外地址撤掉，别让它留在参数里误导人。
                        if (
                          !checked &&
                          autoPublicUrl.current &&
                          String(values.public_url ?? '') === autoPublicUrl.current
                        ) {
                          autoPublicUrl.current = null;
                          setValues((prev) => ({ ...prev, public_url: '' }));
                        }
                      }}
                      label={zh.catalog.publishToggle}
                      description={fmt(zh.catalog.publishToggleDesc, {
                        upstream: publishResult?.upstream ?? '—',
                      })}
                    />
                    {publishEnabled ? (
                      <>
                        <Field
                          id="catalog-publish-port"
                          label={zh.catalog.publishPortLabel}
                          help={fmt(zh.catalog.publishPortHelp, {
                            port: String(publishResult?.agentPort ?? 0),
                          })}
                        >
                          <Select
                            id="catalog-publish-port"
                            value={publishPort}
                            options={HTTPS_PORT_OPTIONS.map((port) => ({ value: port, label: port }))}
                            onChange={(value) => {
                              setPublishPort(value);
                              setPublishState('idle');
                              setPublishError(null);
                            }}
                            ariaLabel={zh.catalog.publishPortLabel}
                          />
                        </Field>
                        {publishResult?.issue === 'port-conflict' ? (
                          <Banner
                            tone="warn"
                            title={zh.access.publishPortConflictTitle}
                            description={fmt(zh.access.publishPortConflictHint, { port: publishPort })}
                            action={
                              <Button
                                size="sm"
                                label={fmt(zh.access.publishPortConflictCta, {
                                  port: defaultPublishPort(selectedNode),
                                })}
                                onClick={() => setPublishPort(defaultPublishPort(selectedNode))}
                              />
                            }
                          />
                        ) : null}
                        {publishResult?.issue === 'no-port' ? (
                          <InlineError message={zh.catalog.publishNoPort} />
                        ) : null}
                        {publishPlan ? (
                          <Field
                            id="catalog-publish-target"
                            label={zh.catalog.publishTargetLabel}
                            help={zh.catalog.publishTargetHelp}
                          >
                            <TextInput
                              id="catalog-publish-target"
                              value={appPublishTarget(publishPlan)}
                              mono
                              readOnly
                              onChange={() => {}}
                            />
                          </Field>
                        ) : null}
                      </>
                    ) : null}
                  </>
                )}
              </Stack>
            ) : null}

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
