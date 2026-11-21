/**
 * 三步「安装并发布应用」向导抽屉（S2）：
 * 1. 从设置 → 应用管理中已启用的清单选择应用；
 * 2. 配置应用参数 + 发布域名 / 端口 / TLS（Caddy 自动或绑定全局证书）；
 * 3. 安装到本地（等待任务完成并实时查看日志）→ 读取监听端口 → 创建并应用 Caddy 站点。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppRuntimeMode, Certificate, Node, TaskResponse } from '@khc/contracts';
import { fetchTask, friendlyAgentError, runAppAction } from '../../data/apps';
import { appManifestsQueryOptions } from '../../data/appManifests';
import { buildDomainEndpoint, normalizeDomain } from '../../data/endpoint';
import { DEFAULT_TLS_PORT, publishProxySite, type CaddySite } from '../../data/sites';
import { paths } from '../../registry/routes';
import { formatExpiry } from '../../i18n/format';
import { fmt, zh } from '../../i18n/zh';
import {
  Badge,
  Banner,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  InlineError,
  Link,
  LogViewer,
  NumberInput,
  Row,
  Select,
  Skeleton,
  Stack,
  Stepper,
  Steps,
  TextInput,
  Toggle,
  type StepState,
} from '../../ui';
import {
  certMatchesDomain,
  declaredPort,
  defaultValues,
  taskAccess,
  toCatalogRecipe,
  validateValues,
  type CatalogRecipe,
  type InstalledEntry,
} from '../hosted-apps/recipes';
import { DOMAIN_RE } from './siteForm';

export interface InstallAndPublishDrawerProps {
  hubId: string;
  hubName: string;
  node: Node | undefined;
  certificates: Certificate[];
  existingSites: CaddySite[];
  offlineReason?: string;
  /** 测试可注入更短轮询间隔，生产默认 800ms */
  pollIntervalMs?: number;
  onClose: () => void;
  onPublished: () => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;
type WizardTlsMode = 'auto' | 'manual';

export function InstallAndPublishDrawer({
  hubId,
  hubName,
  node,
  certificates,
  existingSites,
  offlineReason,
  pollIntervalMs = 800,
  onClose,
  onPublished,
}: InstallAndPublishDrawerProps) {
  const queryClient = useQueryClient();
  const manifestsQuery = useQuery(appManifestsQueryOptions());
  const installedQuery = useQuery({
    queryKey: ['hubs', hubId, 'app-catalog', 'installed'],
    enabled: !offlineReason,
    retry: false,
    queryFn: async (): Promise<Record<string, InstalledEntry>> => {
      const env = await runAppAction(hubId, 'app-catalog', 'recipe_installed');
      if (!env.ok) return {};
      const nested = env.result as { installed?: Record<string, InstalledEntry> } | undefined;
      return nested?.installed ?? {};
    },
  });

  const recipes = useMemo(
    () => (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toCatalogRecipe),
    [manifestsQuery.data],
  );
  const installed = installedQuery.data ?? {};

  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    if (node?.domain) set.add(node.domain);
    for (const site of existingSites) {
      for (const item of site.domains) {
        if (item && !item.startsWith('*.')) set.add(item);
      }
    }
    for (const cert of certificates) {
      for (const item of cert.domains) {
        if (item && !item.startsWith('*.')) set.add(item);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [node?.domain, existingSites, certificates]);

  const [step, setStep] = useState<WizardStep>(1);
  const [selectedId, setSelectedId] = useState('');
  const recipe = recipes.find((item) => item.id === selectedId) ?? null;

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [runtimeMode, setRuntimeMode] = useState<AppRuntimeMode>('create');
  const [runtimeUser, setRuntimeUser] = useState('');
  const [runtimePassword, setRuntimePassword] = useState('');
  const [domain, setDomain] = useState('');
  const [listenPort, setListenPort] = useState<number | null>(DEFAULT_TLS_PORT);
  const [tlsMode, setTlsMode] = useState<WizardTlsMode>('auto');
  const [certId, setCertId] = useState('');
  const autoPublicUrl = useRef<string | null>(null);

  const [phase, setPhase] = useState<'idle' | 'installing' | 'publishing' | 'done' | 'failed'>('idle');
  const [installDone, setInstallDone] = useState(false);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishedUpstream, setPublishedUpstream] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const normalizedDomain = normalizeDomain(domain);
  const publicUrlPreview = normalizedDomain
    ? buildDomainEndpoint(normalizedDomain, String(listenPort ?? DEFAULT_TLS_PORT))
    : '';

  const pickRecipe = (picked: CatalogRecipe) => {
    setSelectedId(picked.id);
    setValues(defaultValues(picked));
    setRuntimeMode(picked.runtimeMode);
    setRuntimeUser(picked.runtimeUser ?? '');
    setRuntimePassword('');
    setDomain((prev) => prev || node?.domain || '');
    setListenPort(DEFAULT_TLS_PORT);
    setTlsMode('auto');
    setCertId('');
    setTask(null);
    setError(null);
    setPhase('idle');
    setInstallDone(false);
    setPublishedUrl(null);
    setPublishedUpstream(null);
    autoPublicUrl.current = null;
    setStep(2);
  };

  // 发布域名或端口变化时自动更新 public_url，用户手改后不再覆盖。
  useEffect(() => {
    if (!recipe || !publicUrlPreview) return;
    if (!recipe.params.some((param) => param.key === 'public_url')) return;
    setValues((prev) => {
      const current = String(prev.public_url ?? '');
      if (current && current !== autoPublicUrl.current) return prev;
      if (current === publicUrlPreview) return prev;
      autoPublicUrl.current = publicUrlPreview;
      return { ...prev, public_url: publicUrlPreview };
    });
  }, [publicUrlPreview, recipe?.id]);

  const matchingCerts = useMemo(
    () =>
      normalizedDomain
        ? certificates.filter((cert) => certMatchesDomain(cert.domains, normalizedDomain))
        : certificates,
    [certificates, normalizedDomain],
  );

  // 若选中的证书在修改域名后不再匹配，清空以避免误用。
  useEffect(() => {
    if (tlsMode !== 'manual' || !certId) return;
    if (!matchingCerts.some((item) => item.id === certId)) setCertId('');
  }, [matchingCerts, tlsMode, certId]);

  const paramErrors = recipe ? validateValues(recipe, values) : {};
  const hasParamErrors = Object.keys(paramErrors).length > 0;
  const credentialsMissing =
    runtimeMode === 'create' && (!runtimeUser.trim() || !runtimePassword);
  const domainError = !normalizedDomain
    ? zh.hosted.wizardDomainRequired
    : !DOMAIN_RE.test(normalizedDomain)
      ? zh.hosted.wizardDomainInvalid
      : undefined;
  const portInvalid =
    listenPort === null || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535;
  const portConflict =
    !portInvalid && normalizedDomain
      ? existingSites.some(
          (site) =>
            site.name !== normalizedDomain &&
            site.listenPort === listenPort &&
            site.domains.includes(normalizedDomain),
        )
      : false;
  const existingSameSite = normalizedDomain
    ? existingSites.some((site) => site.name === normalizedDomain)
    : false;
  const certError =
    tlsMode === 'manual' && !certId ? zh.hosted.wizardTlsCertRequired : undefined;
  const localPort = recipe ? declaredPort(recipe, values) : null;

  const canStartInstall =
    Boolean(recipe) &&
    !offlineReason &&
    !hasParamErrors &&
    !credentialsMissing &&
    !domainError &&
    !portInvalid &&
    !portConflict &&
    !certError &&
    localPort !== null;

  const publishOnly = async (targetRecipe: CatalogRecipe, port: number, targetDomain: string, targetListenPort: number) => {
    setPhase('publishing');
    setError(null);
    const upstream = `127.0.0.1:${port}`;
    await publishProxySite(hubId, {
      domain: targetDomain,
      listenPort: targetListenPort,
      upstream,
      tls: tlsMode === 'manual' ? { mode: 'manual', cert: { $cert: certId } } : { mode: 'auto', cert: null },
    });
    if (cancelledRef.current) return;
    await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'app-catalog', 'installed'] });
    await onPublished();
    if (cancelledRef.current) return;
    setPublishedUrl(buildDomainEndpoint(targetDomain, String(targetListenPort)));
    setPublishedUpstream(upstream);
    setPhase('done');
  };

  const runInstallAndPublish = async (skipInstall: boolean) => {
    if (!recipe || localPort === null || portInvalid) return;
    setStep(3);
    setError(null);
    try {
      if (!skipInstall) {
        setPhase('installing');
        setInstallDone(false);
        setTask(null);
        const envelope = await runAppAction(hubId, 'app-catalog', 'recipe_install', {
          manifestId: recipe.id,
          values,
          runtimeMode,
          ...(runtimeMode === 'create'
            ? { runtimeUser: runtimeUser.trim(), runtimePassword }
            : {}),
        });
        if (cancelledRef.current) return;
        if (!envelope.ok || !envelope.taskId) {
          throw new Error(friendlyAgentError(envelope.error?.message) ?? zh.hosted.wizardFailedInstall);
        }
        let current = await fetchTask(hubId, envelope.taskId);
        if (cancelledRef.current) return;
        setTask(current);
        while (current.task.state === 'pending' || current.task.state === 'running') {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          if (cancelledRef.current) return;
          current = await fetchTask(hubId, envelope.taskId);
          if (cancelledRef.current) return;
          setTask(current);
        }
        if (current.task.state !== 'done') {
          throw new Error(
            friendlyAgentError(current.task.error?.message) ?? zh.hosted.wizardFailedInstall,
          );
        }
        setInstallDone(true);
      }
      await publishOnly(recipe, localPort, normalizedDomain, listenPort);
    } catch (cause) {
      if (cancelledRef.current) return;
      setPhase('failed');
      const fallback = installDone ? zh.hosted.wizardFailedPublish : zh.hosted.wizardFailedInstall;
      setError(
        friendlyAgentError(cause instanceof Error ? cause.message : null) ?? fallback,
      );
    }
  };

  const refreshTaskNow = async () => {
    if (!task) return;
    try {
      const next = await fetchTask(hubId, task.task.id);
      if (!cancelledRef.current) setTask(next);
    } catch {
      /* 轮询循环会在下一拍重试，这里不打断 */
    }
  };

  const busy = phase === 'installing' || phase === 'publishing';
  const access = taskAccess(task);

  const stepperItems = [
    {
      label: zh.hosted.wizardStep1,
      state: (step > 1 ? 'done' : 'current') as 'done' | 'current' | 'todo',
    },
    {
      label: zh.hosted.wizardStep2,
      state: (step > 2 ? 'done' : step === 2 ? 'current' : 'todo') as 'done' | 'current' | 'todo',
    },
    {
      label: zh.hosted.wizardStep3,
      state: (
        step === 3
          ? phase === 'done'
            ? 'done'
            : phase === 'failed'
              ? 'failed'
              : 'current'
          : 'todo'
      ) as 'done' | 'current' | 'todo' | 'failed',
    },
  ];

  const installStepState: StepState = installDone
    ? 'done'
    : phase === 'failed'
      ? 'failed'
      : phase === 'installing'
        ? 'running'
        : 'todo';
  const publishStepState: StepState =
    phase === 'done'
      ? 'done'
      : phase === 'failed' && installDone
        ? 'failed'
        : phase === 'publishing'
          ? 'running'
          : 'todo';

  return (
    <Drawer
      open
      title={zh.hosted.wizardTitle}
      context={fmt(zh.sites.context, { hub: hubName })}
      dirty={busy}
      onClose={onClose}
      footer={
        step === 1 ? (
          <Button label={zh.common.close} onClick={onClose} />
        ) : step === 2 ? (
          <Row gap={2}>
            <Button label={zh.hosted.wizardBack} onClick={() => setStep(1)} />
            <Button
              label={zh.hosted.wizardStart}
              variant="primary"
              disabled={!canStartInstall}
              disabledReason={
                offlineReason ??
                (localPort === null ? zh.hosted.wizardPortUnknown : undefined)
              }
              onClick={() => void runInstallAndPublish(false)}
            />
          </Row>
        ) : (
          <Row gap={2}>
            {phase === 'failed' ? (
              <Button
                label={zh.hosted.wizardBack}
                disabled={busy}
                onClick={() => {
                  setStep(2);
                  setPhase('idle');
                  setError(null);
                }}
              />
            ) : null}
            {phase === 'failed' ? (
              <Button
                label={installDone ? zh.hosted.wizardRetryPublish : zh.hosted.wizardRetryInstall}
                variant="primary"
                disabled={Boolean(offlineReason)}
                disabledReason={offlineReason}
                onClick={() => void runInstallAndPublish(installDone)}
              />
            ) : null}
            <Button
              label={phase === 'done' ? zh.common.finish : zh.common.close}
              variant={phase === 'done' ? 'primary' : undefined}
              onClick={onClose}
            />
          </Row>
        )
      }
    >
      <Stack gap={4}>
        <Stepper items={stepperItems} />

        {offlineReason ? (
          <Banner tone="warn" title={zh.sites.offlineTitle} description={offlineReason} />
        ) : null}

        {step === 1 ? (
          manifestsQuery.error ? (
            <InlineError
              message={
                friendlyAgentError((manifestsQuery.error as Error).message) ??
                zh.catalog.manifestsLoadFailed
              }
            />
          ) : manifestsQuery.isLoading ? (
            <Skeleton height={88} />
          ) : recipes.length === 0 ? (
            <EmptyState
              icon="box"
              title={zh.hosted.catalogEmpty}
              description={zh.hosted.catalogEmptyDesc}
              action={<Link to={`${paths.settings}?tab=manifests`} label={zh.hosted.goToManifests} />}
            />
          ) : (
            <Stack gap={3}>
              <p className="ui-text-caption">{zh.hosted.wizardPickHelp}</p>
              {recipes.map((item) => {
                const port = declaredPort(item);
                const installedEntry = installed[item.id];
                return (
                  <Card
                    key={item.id}
                    title={item.name}
                    action={
                      <Button
                        label={zh.hosted.wizardPickBtn}
                        size="sm"
                        variant="primary"
                        onClick={() => pickRecipe(item)}
                      />
                    }
                  >
                    <Row gap={2} wrap>
                      <Badge tone="neutral" label={`v${item.version}`} />
                      <Badge tone="neutral" label={item.description} />
                      {port ? <Badge tone="neutral" label={`127.0.0.1:${port}`} /> : null}
                      {installedEntry ? (
                        <Badge
                          tone="ok"
                          label={fmt(zh.hosted.wizardAlreadyInstalled, {
                            version: installedEntry.version ?? item.version,
                          })}
                        />
                      ) : null}
                    </Row>
                  </Card>
                );
              })}
            </Stack>
          )
        ) : null}

        {step === 2 && recipe ? (
          <Stack gap={4}>
            <Card
              title={`${recipe.name} · v${recipe.version}`}
              action={
                <Button label={zh.hosted.wizardChangeApp} size="sm" onClick={() => setStep(1)} />
              }
            >
              <Stack gap={3}>
                <Field
                  id="wizard-app-runtime"
                  label={zh.catalog.runtimeLabel}
                  help={runtimeMode === 'create' ? zh.catalog.runtimeCreateHelp : undefined}
                >
                  <Select
                    id="wizard-app-runtime"
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
                    <Field id="wizard-app-user" label={zh.catalog.runtimeUserLabel} required>
                      <TextInput
                        id="wizard-app-user"
                        value={runtimeUser}
                        mono
                        autoComplete="off"
                        placeholder="khc-app-demo"
                        onChange={setRuntimeUser}
                      />
                    </Field>
                    <Field
                      id="wizard-app-password"
                      label={zh.catalog.runtimePasswordLabel}
                      help={zh.catalog.secretHelp}
                      required
                    >
                      <TextInput
                        id="wizard-app-password"
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
                  const id = `wizard-param-${recipe.id}-${param.key}`;
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
                          value={
                            typeof values[param.key] === 'number'
                              ? (values[param.key] as number)
                              : null
                          }
                          min={param.min}
                          max={param.max}
                          invalid={Boolean(paramErrors[param.key])}
                          onChange={(value) =>
                            setValues((prev) => ({ ...prev, [param.key]: value }))
                          }
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
                        onChange={(value) =>
                          setValues((prev) => ({ ...prev, [param.key]: value }))
                        }
                      />
                    </Field>
                  );
                })}
              </Stack>
            </Card>

            <Card title={zh.hosted.wizardSectionPublish}>
              <Stack gap={3}>
                {domainOptions.length > 0 ? (
                  <Field
                    id="wizard-domain-pick"
                    label={zh.hosted.wizardDomainPick}
                    help={zh.hosted.wizardDomainPickHelp}
                    optional
                  >
                    <Select
                      id="wizard-domain-pick"
                      value={domainOptions.includes(normalizedDomain) ? normalizedDomain : ''}
                      options={[
                        { value: '', label: zh.sites.domainPickCustom },
                        ...domainOptions.map((item) => ({ value: item, label: item })),
                      ]}
                      onChange={(value) => {
                        if (value) setDomain(value);
                      }}
                    />
                  </Field>
                ) : null}

                <Field
                  id="wizard-domain"
                  label={zh.hosted.wizardDomainLabel}
                  help={zh.hosted.wizardDomainHelp}
                  error={domain ? domainError : undefined}
                  required
                >
                  <TextInput
                    id="wizard-domain"
                    value={domain}
                    mono
                    placeholder="app.example.com"
                    onChange={setDomain}
                  />
                </Field>

                <Field
                  id="wizard-listen-port"
                  label={zh.hosted.wizardPortLabel}
                  help={zh.hosted.wizardPortHelp}
                  error={
                    portInvalid
                      ? zh.hosted.wizardPortInvalid
                      : portConflict && normalizedDomain && listenPort !== null
                        ? fmt(zh.hosted.wizardPortConflict, {
                            domain: normalizedDomain,
                            port: String(listenPort),
                          })
                        : undefined
                  }
                  required
                >
                  <NumberInput
                    id="wizard-listen-port"
                    value={listenPort}
                    min={1}
                    max={65535}
                    onChange={setListenPort}
                  />
                </Field>

                {existingSameSite && normalizedDomain ? (
                  <Banner
                    tone="info"
                    title={fmt(zh.hosted.wizardSiteExistsNote, { domain: normalizedDomain })}
                  />
                ) : null}

                <Field
                  id="wizard-tls-mode"
                  label={zh.hosted.wizardTlsLabel}
                  help={zh.hosted.wizardTlsHelp}
                >
                  <Select
                    id="wizard-tls-mode"
                    value={tlsMode}
                    options={[
                      { value: 'auto', label: zh.hosted.wizardTlsAuto },
                      { value: 'manual', label: zh.hosted.wizardTlsManual },
                    ]}
                    onChange={(value) => setTlsMode(value === 'manual' ? 'manual' : 'auto')}
                  />
                </Field>

                {tlsMode === 'manual' ? (
                  matchingCerts.length > 0 ? (
                    <Field
                      id="wizard-tls-cert"
                      label={zh.hosted.wizardTlsCertLabel}
                      error={certError}
                      required
                    >
                      <Select
                        id="wizard-tls-cert"
                        value={certId}
                        placeholder={zh.hosted.wizardTlsCertPlaceholder}
                        options={matchingCerts.map((cert) => ({
                          value: cert.id,
                          label: `${cert.domains[0] ?? cert.name} · ${formatExpiry(cert.notAfter)}`,
                        }))}
                        onChange={setCertId}
                      />
                    </Field>
                  ) : (
                    <Banner
                      tone="warn"
                      title={zh.hosted.wizardTlsNoMatch}
                      action={
                        <Link to={`${paths.settings}?tab=certs`} label={zh.hosted.wizardGoToCerts} />
                      }
                    />
                  )
                ) : null}
              </Stack>
            </Card>
          </Stack>
        ) : null}

        {step === 3 && recipe ? (
          <Stack gap={4}>
            <Steps
              items={[
                {
                  label: fmt(zh.hosted.wizardStepInstall, {
                    name: recipe.name,
                    port: String(localPort ?? '—'),
                  }),
                  state: installStepState,
                },
                {
                  label: fmt(zh.hosted.wizardStepPublish, {
                    url: publicUrlPreview || normalizedDomain,
                  }),
                  state: publishStepState,
                },
              ]}
            />

            {phase === 'publishing' ? (
              <Banner tone="info" title={zh.hosted.wizardPublishingHint} />
            ) : null}

            {phase === 'done' && publishedUrl ? (
              <Banner
                tone="ok"
                title={fmt(zh.hosted.wizardDoneTitle, { name: recipe.name })}
                description={fmt(zh.hosted.wizardDoneDesc, {
                  url: publishedUrl,
                  port: String(localPort ?? '—'),
                })}
                action={
                  <Link to={publishedUrl} label={publishedUrl} external />
                }
              />
            ) : null}

            {error ? <InlineError message={error} /> : null}

            {task ? (
              <Stack gap={3}>
                <Banner
                  tone={
                    task.task.state === 'done'
                      ? 'ok'
                      : task.task.state === 'error'
                        ? 'danger'
                        : 'info'
                  }
                  title={fmt(zh.catalog.taskState, {
                    state: task.task.state,
                    progress: String(task.task.progress),
                  })}
                  action={
                    task.task.state === 'pending' || task.task.state === 'running' ? (
                      <Button
                        label={zh.catalog.refresh}
                        size="sm"
                        onClick={() => void refreshTaskNow()}
                      />
                    ) : undefined
                  }
                />
                <LogViewer
                  lines={(task.task.logs ?? []).map((text) => ({ text }))}
                  title={zh.catalog.taskLogs}
                />
                {access.length > 0 ? (
                  <Card title={zh.catalog.accessTitle}>
                    <Stack gap={2}>
                      {access.map((item) => (
                        <div key={item.label} className="ui-row-between">
                          <span>{item.label}</span>
                          <span className="ui-text-mono">{item.value}</span>
                        </div>
                      ))}
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Drawer>
  );
}
