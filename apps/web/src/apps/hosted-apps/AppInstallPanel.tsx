/**
 * 「发布应用」时从应用目录安装（节点作用域）。
 *
 * 流程：站点抽屉里选「上游来源 = 应用目录」→ 选我们适配过的应用 → 填参数 → 安装到本机
 * （Agent 所在 VM）→ 装完把上游端口填成清单声明的端口 → 保存并应用即发布出去。
 *
 * 安装入口只出现在发布流程里：设置 → 应用管理/应用目录只放适配过的脚本，不装东西。
 * 清单声明了 `public_url` 时用当前站点的对外地址预填（表单里可见），装完回传的登录链接
 * 就是对外链接。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppRuntimeMode, Node, TaskResponse } from '@khc/contracts';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import { appManifestsQueryOptions } from '../../data/appManifests';
import { Banner, Button, Field, InlineError, LogViewer, NumberInput, Select, Stack, TextInput, Toggle } from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import {
  defaultValues,
  taskAccess,
  toCatalogRecipe,
  validateValues,
  type CatalogRecipe,
} from './recipes';

/** 清单声明的本机端口（取参数默认值或固定 port）。 */
export function declaredPort(recipe: CatalogRecipe): number | null {
  const decl = recipe.manifest.publish;
  if (!decl) return null;
  const raw = decl.portParam
    ? recipe.params.find((param) => param.key === decl.portParam)?.default
    : decl.port;
  const port = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function AppInstallPanel({
  hubId,
  node,
  publicUrl,
  onInstalled,
}: {
  hubId: string;
  node: Node | undefined;
  /** 当前站点的对外地址（域名 + 发布端口），用于预填 public_url */
  publicUrl: string;
  onInstalled: (port: number, appName: string) => void;
}) {
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const recipes = (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toCatalogRecipe);
  const [appId, setAppId] = useState('');
  const recipe = recipes.find((item) => item.id === appId) ?? null;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [runtimeMode, setRuntimeMode] = useState<AppRuntimeMode>('create');
  const [runtimeUser, setRuntimeUser] = useState('');
  const [runtimePassword, setRuntimePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [installedApp, setInstalledApp] = useState<string | null>(null);
  const autoPublicUrl = useRef<string | null>(null);

  // 换应用就重置表单与任务视图，避免把上一份参数带过去。
  useEffect(() => {
    if (!recipe) return;
    setValues(defaultValues(recipe));
    setRuntimeMode(recipe.runtimeMode);
    setRuntimeUser(recipe.runtimeUser ?? '');
    setRuntimePassword('');
    setTask(null);
    setError(null);
    setInstalledApp(null);
    autoPublicUrl.current = null;
  }, [recipe?.id]);

  // 站点地址变了同步 public_url（只在用户没手改过时）。
  useEffect(() => {
    if (!recipe || !publicUrl) return;
    if (!recipe.params.some((param) => param.key === 'public_url')) return;
    setValues((prev) => {
      const current = String(prev.public_url ?? '');
      if (current && current !== autoPublicUrl.current) return prev;
      if (current === publicUrl) return prev;
      autoPublicUrl.current = publicUrl;
      return { ...prev, public_url: publicUrl };
    });
  }, [publicUrl, recipe?.id]);

  if (manifestsQuery.error) {
    return (
      <InlineError
        message={
          friendlyAgentError((manifestsQuery.error as Error).message) ?? zh.catalog.manifestsLoadFailed
        }
      />
    );
  }
  if (recipes.length === 0) {
    return <p className="ui-text-caption">{zh.hosted.catalogEmpty}</p>;
  }

  const submit = async () => {
    if (!recipe) return;
    const paramErrors = validateValues(recipe, values);
    if (Object.keys(paramErrors).length > 0) {
      setError(zh.catalog.fixParams);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_install', {
        manifestId: recipe.id,
        values,
        runtimeMode,
        ...(runtimeMode === 'create'
          ? { runtimeUser: runtimeUser.trim(), runtimePassword }
          : {}),
      });
      if (!envelope.ok) {
        throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.catalog.installFailed);
      }
      if (envelope.taskId) setTask(await fetchTask(hubId, envelope.taskId));
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.installFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!task || !recipe) return;
    setBusy(true);
    try {
      const next = await fetchTask(hubId, task.task.id);
      setTask(next);
      if (next.task.state === 'done' && installedApp !== recipe.id) {
        setInstalledApp(recipe.id);
        const port = declaredPort(recipe);
        if (port) onInstalled(port, recipe.name);
      }
    } catch (cause) {
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? zh.catalog.installFailed,
      );
    } finally {
      setBusy(false);
    }
  };

  const access = taskAccess(task);
  const paramErrors = recipe ? validateValues(recipe, values) : {};
  const hasParamErrors = Object.keys(paramErrors).length > 0;
  const credentialsMissing =
    runtimeMode === 'create' && (!runtimeUser.trim() || !runtimePassword);

  return (
    <Stack gap={3}>
      <p className="ui-text-caption">{fmt(zh.hosted.installHint, { hub: node?.name ?? hubId })}</p>
      <Field id="site-app-id" label={zh.hosted.appLabel} help={zh.hosted.appHelp} required>
        <Select
          id="site-app-id"
          value={appId}
          options={recipes.map((item) => ({
            value: item.id,
            label: fmt(zh.hosted.recipeOption, { name: item.name, version: item.version }),
          }))}
          placeholder={zh.hosted.appPlaceholder}
          onChange={(value) => {
            setAppId(value);
            setInstalledApp(null);
          }}
          ariaLabel={zh.hosted.appLabel}
        />
      </Field>

      {recipe ? (
        <>
          <Field
            id="site-app-runtime"
            label={zh.catalog.runtimeLabel}
            help={runtimeMode === 'create' ? zh.catalog.runtimeCreateHelp : undefined}
          >
            <Select
              id="site-app-runtime"
              value={runtimeMode}
              options={[
                { value: 'create', label: zh.catalog.runtimeCreate },
                { value: 'root', label: zh.catalog.runtimeRoot },
              ]}
              onChange={(value) => setRuntimeMode(value as AppRuntimeMode)}
              ariaLabel={zh.catalog.runtimeLabel}
            />
          </Field>
          {runtimeMode === 'create' ? (
            <>
              <Field id="site-app-user" label={zh.catalog.runtimeUserLabel}>
                <TextInput
                  id="site-app-user"
                  value={runtimeUser}
                  mono
                  autoComplete="off"
                  placeholder="khc-app-demo"
                  onChange={setRuntimeUser}
                />
              </Field>
              <Field
                id="site-app-password"
                label={zh.catalog.runtimePasswordLabel}
                help={zh.catalog.secretHelp}
              >
                <TextInput
                  id="site-app-password"
                  type="password"
                  value={runtimePassword}
                  autoComplete="new-password"
                  onChange={setRuntimePassword}
                />
              </Field>
            </>
          ) : (
            <Banner
              tone="warn"
              title={zh.catalog.runtimeRootWarnTitle}
              description={zh.catalog.runtimeRootWarnDesc}
            />
          )}

          {recipe.params.map((param) => {
            const id = `site-app-${recipe.id}-${param.key}`;
            const label = param.label ?? param.key;
            if (param.type === 'boolean') {
              return (
                <Field key={param.key} id={id} label={label}>
                  <Toggle
                    checked={Boolean(values[param.key])}
                    onChange={(checked) => setValues((prev) => ({ ...prev, [param.key]: checked }))}
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
          })}

          <Banner
            tone="info"
            title={zh.hosted.declaredPortTitle}
            description={fmt(zh.hosted.declaredPortDesc, {
              port: String(declaredPort(recipe) ?? '—'),
            })}
          />

          {task ? (
            <Stack gap={3}>
              <Banner
                tone={task.task.state === 'done' ? 'ok' : task.task.state === 'error' ? 'danger' : 'info'}
                title={fmt(zh.catalog.taskState, {
                  state: task.task.state,
                  progress: String(task.task.progress),
                })}
                description={friendlyAgentError(task.task.error?.message) ?? undefined}
                action={
                  <Button label={zh.catalog.refresh} size="sm" loading={busy} onClick={() => void refresh()} />
                }
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
                      <span className="ui-text-mono">{item.value}</span>
                    </div>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          ) : (
            <Button
              label={fmt(zh.hosted.installAction, { name: recipe.name })}
              loading={busy}
              disabled={hasParamErrors || credentialsMissing}
              disabledReason={
                hasParamErrors
                  ? zh.catalog.fixParams
                  : runtimeMode === 'create' && !runtimeUser.trim()
                    ? zh.catalog.runtimeUserRequired
                    : runtimeMode === 'create' && !runtimePassword
                      ? zh.catalog.runtimePasswordRequired
                      : undefined
              }
              onClick={() => void submit()}
            />
          )}
        </>
      ) : null}

      {error ? <InlineError message={error} /> : null}
    </Stack>
  );
}
