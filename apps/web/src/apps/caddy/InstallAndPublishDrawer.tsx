/**
 * 三步「安装并发布应用」向导抽屉（V4 通用化）：
 * 1. 从设置 → 应用管理中已启用的清单选择应用（能力协商 + 动态脚本标记 + 已装按字段定位）；
 * 2. 通用渲染声明式参数（enum / secret / 隐藏 derive）与多端点发布计划（caddy / direct / none）；
 * 3. 安装到本地（v1 用 recipe_install，v2 用 manifest_install，不传 instance）→ 顺序发布勾选端点 → 渲染结果卡片。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANIFEST_V2_MIN_AGENT,
  type AgentState,
  type AppManifestEndpointV2,
  type AppRuntimeMode,
  type Certificate,
  type Node,
  type TaskResponse,
} from '@khc/contracts';
import { fetchTask, runAppAction } from '../../data/apps';
import { appManifestsQueryOptions } from '../../data/appManifests';
import { buildDomainEndpoint, normalizeDomain } from '../../data/endpoint';
import { callHostOps, isHostOpsAbortError, normalizeFirewallShow } from '../../data/hostOps';
import { pickPreferredCertId } from '../../data/certs';
import {
  certMatchesDomain,
  defaultManifestValues,
  installActionForSchema,
  installedEntries,
  missingNodeFeatures,
  normalizeResultCards,
  toAppView,
  validateManifestValues,
  type AppView,
} from '../../data/manifestApps';
import { refreshHubRuntime } from '../../data/queries';
import { publishProxySite, type CaddySite } from '../../data/sites';
import { paths } from '../../registry/routes';
import { formatExpiry } from '../../i18n/format';
import { fmt, zh } from '../../i18n/zh';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
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
import { ManifestErrorAlert } from '../hosted-apps/ManifestErrorAlert';
import { ResultCardsView } from '../hosted-apps/ResultCardsView';
import { HostFirewallPortAlert, isTcpPortAllowedByFirewall } from './HostFirewallPortAlert';
import { DOMAIN_RE, parseEndpointPort, pickRecommendedListenPort } from './siteForm';

/** Agent 脚本超时 900s + 20s 余量 */
const INSTALL_POLL_MAX_MS = 920_000;

export interface InstallAndPublishDrawerProps {
  hubId: string;
  hubName: string;
  node: Node | undefined;
  /** 来自 /overview 的节点状态，调用方必传（无状态时传 null） */
  state: AgentState | null;
  hasHostOps?: boolean;
  certificates: Certificate[];
  existingSites: CaddySite[];
  offlineReason?: string;
  /** 测试可注入更短轮询间隔，生产默认 800ms */
  pollIntervalMs?: number;
  /** 安装任务轮询上限（毫秒）；Agent 脚本超时 900s + 余量，测试可注入更短值 */
  installTimeoutMs?: number;
  onClose: () => void;
  onPublished: () => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;
type WizardTlsMode = 'auto' | 'manual' | 'off';

interface PublishedEndpointSummary {
  id: string;
  label: string;
  localPort: number;
  listenPort: number;
  urls: string[];
}

function buildPublishUrl(domain: string, port: number, tlsMode: WizardTlsMode): string {
  if (tlsMode === 'off') {
    return port === 80 ? `http://${domain}` : `http://${domain}:${port}`;
  }
  return buildDomainEndpoint(domain, String(port));
}

function endpointLocalPort(
  ep: AppManifestEndpointV2,
  values: Record<string, unknown>,
): number | null {
  const raw = ep.portParam ? values[ep.portParam] : ep.port;
  const port = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function InstallAndPublishDrawer({
  hubId,
  hubName,
  node,
  state: effectiveState,
  hasHostOps = false,
  certificates,
  existingSites,
  offlineReason,
  pollIntervalMs = 800,
  installTimeoutMs = INSTALL_POLL_MAX_MS,
  onClose,
  onPublished,
}: InstallAndPublishDrawerProps) {
  const queryClient = useQueryClient();
  const manifestsQuery = useQuery(appManifestsQueryOptions());

  const appViews = useMemo(
    () => (manifestsQuery.data ?? []).filter((item) => item.enabled).map(toAppView),
    [manifestsQuery.data],
  );
  const installed = useMemo(() => installedEntries(effectiveState), [effectiveState]);

  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    if (node?.domain) set.add(node.domain);
    for (const site of existingSites) {
      if (site.tls.mode === 'off') continue;
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

  const nodeAgentPort = useMemo(() => parseEndpointPort(node?.endpoint), [node?.endpoint]);

  const [step, setStep] = useState<WizardStep>(1);
  const [selectedId, setSelectedId] = useState('');
  const selectedApp = appViews.find((item) => item.id === selectedId) ?? null;

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [secretShown, setSecretShown] = useState<Record<string, boolean>>({});
  const [runtimeMode, setRuntimeMode] = useState<AppRuntimeMode>('create');
  const [runtimeUser, setRuntimeUser] = useState('');
  const [domain, setDomain] = useState(() => node?.domain?.trim() ?? '');
  const [caddyEnabled, setCaddyEnabled] = useState<Record<string, boolean>>({});
  const [caddyPorts, setCaddyPorts] = useState<Record<string, number | null>>({});
  const [tlsMode, setTlsMode] = useState<WizardTlsMode>('auto');
  const [certId, setCertId] = useState('');
  const tlsTouchedRef = useRef(false);

  const [phase, setPhase] = useState<'idle' | 'installing' | 'publishing' | 'done' | 'failed'>(
    'idle',
  );
  const [installDone, setInstallDone] = useState(false);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [publishedEndpoints, setPublishedEndpoints] = useState<PublishedEndpointSummary[]>([]);
  const publishedIdsRef = useRef<Set<string>>(new Set());

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const endpoints = selectedApp ? (selectedApp.def.endpoints ?? []) : [];
  const caddyEndpoints = useMemo(
    () => endpoints.filter((ep) => ep.publish === 'caddy'),
    [endpoints],
  );
  const checkedCaddyEndpoints = useMemo(
    () => caddyEndpoints.filter((ep) => Boolean(caddyEnabled[ep.id])),
    [caddyEndpoints, caddyEnabled],
  );
  const hasCaddyPublish = checkedCaddyEndpoints.length > 0;
  const hasBindAnyNonDirect = endpoints.some(
    (ep) => ep.bind === 'any' && ep.publish !== 'direct',
  );

  // bind:any 端点需要在第 2 步核对宿主防火墙是否已放行（信息 vs 警告）。
  const fwShowQuery = useQuery({
    // 与 HostFirewallPortAlert 的 fw-show 缓存形状不同，必须用独立 key（前缀相同，放行后仍会一并失效）
    queryKey: ['hubs', hubId, 'host-ops', 'fw-show', 'wizard-bind-any'] as const,
    enabled: Boolean(
      step === 2 &&
        hasHostOps &&
        !offlineReason &&
        node?.accessMode !== 'tunnel' &&
        hasBindAnyNonDirect,
    ),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      try {
        const res = await callHostOps(hubId, 'self', 'fw.show', {});
        return res.ok ? normalizeFirewallShow(res.data) : null;
      } catch (err) {
        if (isHostOpsAbortError(err)) return null;
        return null;
      }
    },
  });

  const normalizedDomain = normalizeDomain(domain);

  const pickApp = (picked: AppView) => {
    if (picked.invalid) return;
    const defaults = defaultManifestValues(picked.def);
    const defaultDomain = node?.domain?.trim() ?? '';
    const eps = picked.def.endpoints ?? [];
    const nextEnabled: Record<string, boolean> = {};
    const nextPorts: Record<string, number | null> = {};
    const taken = new Set<number>();
    let pickedFirstCaddy = false;

    for (const ep of eps) {
      if (ep.publish !== 'caddy') continue;
      const shouldEnable = !pickedFirstCaddy;
      nextEnabled[ep.id] = shouldEnable;
      pickedFirstCaddy = true;
      const local = endpointLocalPort(ep, defaults);
      let candidate = pickRecommendedListenPort({
        agentPort: nodeAgentPort,
        localPort: local,
        domain: defaultDomain,
        existingSites,
      });
      while (taken.has(candidate) || candidate === nodeAgentPort || (local !== null && candidate === local)) {
        candidate = candidate >= 65535 ? 10080 : candidate + 1;
      }
      taken.add(candidate);
      nextPorts[ep.id] = candidate;
    }

    setSelectedId(picked.id);
    setValues(defaults);
    setSecretShown({});
    setRuntimeMode(picked.def.runtime.mode === 'root' ? 'root' : 'create');
    setRuntimeUser(picked.def.runtime.user ?? '');
    setDomain(defaultDomain);
    setCaddyEnabled(nextEnabled);
    setCaddyPorts(nextPorts);
    tlsTouchedRef.current = false;
    const preferredCertId = pickPreferredCertId(
      certificates,
      normalizeDomain(defaultDomain),
      node?.tlsCertId,
    );
    setTlsMode(preferredCertId ? 'manual' : 'auto');
    setCertId(preferredCertId);
    setTask(null);
    setActionError(null);
    setPhase('idle');
    setInstallDone(false);
    setPublishedEndpoints([]);
    publishedIdsRef.current = new Set();
    setStep(2);
  };

  const matchingCerts = useMemo(
    () =>
      normalizedDomain
        ? certificates.filter((cert) => certMatchesDomain(cert.domains, normalizedDomain))
        : certificates,
    [certificates, normalizedDomain],
  );

  useEffect(() => {
    if (step !== 2 || tlsTouchedRef.current) return;
    const preferredCertId = normalizedDomain
      ? pickPreferredCertId(certificates, normalizedDomain, node?.tlsCertId)
      : '';
    if (preferredCertId) {
      if (tlsMode !== 'manual') setTlsMode('manual');
      if (certId !== preferredCertId) setCertId(preferredCertId);
    } else if (tlsMode === 'manual' && !matchingCerts.some((item) => item.id === certId)) {
      setTlsMode('auto');
      setCertId('');
    }
  }, [step, normalizedDomain, certificates, node?.tlsCertId, matchingCerts, tlsMode, certId]);

  useEffect(() => {
    if (tlsMode !== 'manual' || !certId) return;
    if (!matchingCerts.some((item) => item.id === certId)) setCertId('');
  }, [matchingCerts, tlsMode, certId]);

  const paramErrors = selectedApp ? validateManifestValues(selectedApp.def, values) : {};
  const hasParamErrors = Object.keys(paramErrors).length > 0;
  const credentialsMissing = runtimeMode === 'create' && !runtimeUser.trim();

  const domainError = !hasCaddyPublish
    ? undefined
    : !normalizedDomain
      ? zh.hosted.wizardDomainRequired
      : !DOMAIN_RE.test(normalizedDomain)
        ? zh.hosted.wizardDomainInvalid
        : undefined;

  const certError =
    hasCaddyPublish && tlsMode === 'manual' && !certId
      ? zh.hosted.wizardTlsCertRequired
      : undefined;

  const endpointPortStates = useMemo(() => {
    const out: Record<
      string,
      {
        localPort: number | null;
        listenPort: number | null;
        listenError?: string;
        localConflictPort?: number;
      }
    > = {};
    const checkedPortCounts = new Map<number, number>();
    for (const ep of checkedCaddyEndpoints) {
      const p = caddyPorts[ep.id] ?? null;
      if (p !== null && Number.isInteger(p) && p >= 1 && p <= 65535) {
        checkedPortCounts.set(p, (checkedPortCounts.get(p) ?? 0) + 1);
      }
    }

    for (const ep of endpoints) {
      const localPort = endpointLocalPort(ep, values);
      let listenPort: number | null = null;
      let listenError: string | undefined;
      let localConflictPort: number | undefined;

      if (ep.publish === 'caddy' && caddyEnabled[ep.id]) {
        listenPort = caddyPorts[ep.id] ?? null;
        const portInvalid =
          listenPort === null ||
          !Number.isInteger(listenPort) ||
          listenPort < 1 ||
          listenPort > 65535;
        if (portInvalid) {
          listenError = zh.hosted.wizardPortInvalid;
        } else if (nodeAgentPort !== null && listenPort === nodeAgentPort) {
          listenError = fmt(zh.hosted.wizardPortAgentConflict, {
            port: String(nodeAgentPort),
          });
        } else if (
          normalizedDomain &&
          existingSites.some(
            (site) => site.listenPort === listenPort && site.domains.includes(normalizedDomain),
          )
        ) {
          listenError = fmt(zh.hosted.wizardPortConflict, {
            domain: normalizedDomain,
            port: String(listenPort),
          });
        } else if ((checkedPortCounts.get(listenPort!) ?? 0) > 1) {
          listenError = `对外端口 ${listenPort} 与其他已勾选端点重复`;
        }

        if (localPort !== null && !portInvalid && localPort === listenPort) {
          localConflictPort = listenPort!;
        }
      }
      if (localPort !== null && nodeAgentPort !== null && localPort === nodeAgentPort) {
        localConflictPort = nodeAgentPort;
      }
      out[ep.id] = { localPort, listenPort, listenError, localConflictPort };
    }
    return out;
  }, [
    endpoints,
    checkedCaddyEndpoints,
    caddyEnabled,
    caddyPorts,
    values,
    nodeAgentPort,
    normalizedDomain,
    existingSites,
  ]);

  const hasEndpointErrors = Object.values(endpointPortStates).some(
    (s) => Boolean(s.listenError) || s.localConflictPort !== undefined,
  );
  const missingCheckedLocalPort = checkedCaddyEndpoints.some(
    (ep) => endpointPortStates[ep.id]?.localPort === null,
  );

  const canStartInstall =
    Boolean(selectedApp) &&
    !offlineReason &&
    !hasParamErrors &&
    !credentialsMissing &&
    !domainError &&
    !certError &&
    !hasEndpointErrors &&
    !missingCheckedLocalPort;

  const resolveSubmitValues = (app: AppView): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...values };
    for (const param of app.def.params) {
      if (!param.derive) continue;
      const match = /^endpoint:([a-z][a-z0-9-]{0,31})\.publicUrl$/.exec(param.derive);
      if (!match) {
        out[param.key] = '';
        continue;
      }
      const targetEpId = match[1]!;
      const ep = (app.def.endpoints ?? []).find((item) => item.id === targetEpId);
      const listenPort = caddyPorts[targetEpId] ?? null;
      if (
        ep &&
        ep.publish === 'caddy' &&
        caddyEnabled[targetEpId] &&
        normalizedDomain &&
        listenPort !== null
      ) {
        out[param.key] = buildPublishUrl(normalizedDomain, listenPort, tlsMode);
      } else {
        out[param.key] = '';
      }
    }
    return out;
  };

  const publishCheckedEndpoints = async (app: AppView) => {
    setPhase('publishing');
    setActionError(null);
    const totalChecked = checkedCaddyEndpoints.length;

    for (const ep of checkedCaddyEndpoints) {
      if (publishedIdsRef.current.has(ep.id)) continue;
      const st = endpointPortStates[ep.id];
      if (!st || st.localPort === null || st.listenPort === null) {
        throw new Error(`端点 ${ep.label} 缺少有效端口`);
      }
      const upstream = `127.0.0.1:${st.localPort}`;
      const siteName = totalChecked === 1 ? app.id : `${app.id}-${ep.id}`;

      await publishProxySite(hubId, {
        name: siteName,
        domain: normalizedDomain,
        listenPort: st.listenPort,
        upstream,
        tls:
          tlsMode === 'off'
            ? { mode: 'off', cert: null }
            : tlsMode === 'manual'
              ? { mode: 'manual', cert: { $cert: certId } }
              : { mode: 'auto', cert: null },
      });
      if (cancelledRef.current) return;

      const baseUrl = buildPublishUrl(normalizedDomain, st.listenPort, tlsMode);
      const urls =
        ep.paths && ep.paths.length > 0 ? ep.paths.map((p) => `${baseUrl}${p}`) : [baseUrl];
      publishedIdsRef.current.add(ep.id);
      setPublishedEndpoints((prev) => [
        ...prev,
        { id: ep.id, label: ep.label, localPort: st.localPort!, listenPort: st.listenPort!, urls },
      ]);
    }

    await refreshHubRuntime(queryClient, hubId, { force: true });
    await onPublished();
    if (cancelledRef.current) return;
    setPhase('done');
  };

  const runInstallAndPublish = async (skipInstall: boolean) => {
    if (!selectedApp || !canStartInstall) return;
    setStep(3);
    setActionError(null);
    try {
      if (!skipInstall) {
        setPhase('installing');
        setInstallDone(false);
        setTask(null);
        const submitValues = resolveSubmitValues(selectedApp);
        const actionName = installActionForSchema(selectedApp.schema);
        const envelope = await runAppAction(hubId, 'app-catalog', actionName, {
          manifestId: selectedApp.id,
          values: submitValues,
          runtimeMode,
          ...(runtimeMode === 'create' ? { runtimeUser: runtimeUser.trim() } : {}),
        });
        if (cancelledRef.current) return;
        if (!envelope.ok || !envelope.taskId) {
          throw envelope.error ?? new Error(zh.hosted.wizardFailedInstall);
        }
        let current = await fetchTask(hubId, envelope.taskId);
        if (cancelledRef.current) return;
        setTask(current);
        const pollDeadline = Date.now() + installTimeoutMs;
        while (current.task.state === 'pending' || current.task.state === 'running') {
          if (Date.now() >= pollDeadline) {
            throw new Error(
              fmt(zh.hosted.wizardInstallTimeout, { seconds: String(Math.round(installTimeoutMs / 1000)) }),
            );
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          if (cancelledRef.current) return;
          current = await fetchTask(hubId, envelope.taskId);
          if (cancelledRef.current) return;
          setTask(current);
        }
        if (current.task.state !== 'done') {
          throw current.task.error ?? new Error(zh.hosted.wizardFailedInstall);
        }
        setInstallDone(true);
        await refreshHubRuntime(queryClient, hubId, { force: true });
      }
      if (hasCaddyPublish) {
        await publishCheckedEndpoints(selectedApp);
      } else {
        await onPublished();
        if (!cancelledRef.current) setPhase('done');
      }
    } catch (cause) {
      if (cancelledRef.current) return;
      setPhase('failed');
      setActionError(cause);
    }
  };

  const refreshTaskNow = async () => {
    if (!task) return;
    try {
      const next = await fetchTask(hubId, task.task.id);
      if (!cancelledRef.current) setTask(next);
    } catch {
      /* 轮询循环会在下一拍重试 */
    }
  };

  const busy = phase === 'installing' || phase === 'publishing';
  const resultCards = selectedApp
    ? normalizeResultCards(
        selectedApp.schema,
        (task?.task.result as { cards?: unknown } | null | undefined)?.cards,
      )
    : [];
  const primaryUrlCard =
    resultCards.find((card) => card.primary && card.kind === 'url') ??
    resultCards.find((card) => card.kind === 'url');

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

  const firstCheckedPort =
    checkedCaddyEndpoints.length > 0
      ? (caddyPorts[checkedCaddyEndpoints[0]!.id] ?? null)
      : null;
  const fwAlertEnabled = Boolean(
    hasHostOps &&
      !offlineReason &&
      node?.accessMode !== 'tunnel' &&
      hasCaddyPublish &&
      firstCheckedPort !== null &&
      !hasEndpointErrors,
  );

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
                (missingCheckedLocalPort ? zh.hosted.wizardPortUnknown : undefined)
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
                  setActionError(null);
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
            <InlineError message={manifestErrorFallback(manifestsQuery.error)} />
          ) : manifestsQuery.isLoading ? (
            <Skeleton height={88} />
          ) : appViews.length === 0 ? (
            <EmptyState
              icon="box"
              title={zh.hosted.catalogEmpty}
              description={zh.hosted.catalogEmptyDesc}
              action={<Link to={`${paths.settings}?tab=manifests`} label={zh.hosted.goToManifests} />}
            />
          ) : (
            <Stack gap={3}>
              <p className="ui-text-caption">{zh.hosted.wizardPickHelp}</p>
              {appViews.map((item) => {
                const missing = item.invalid ? [] : missingNodeFeatures(item, effectiveState);
                const incompatible = !item.invalid && missing.length > 0;
                const installedEntry = installed.find((entry) => entry.manifestId === item.id);
                const firstEp = item.def.endpoints?.[0];
                const defaultPort = firstEp ? endpointLocalPort(firstEp, defaultManifestValues(item.def)) : null;

                return (
                  <Card
                    key={item.id}
                    title={item.def.name || item.id}
                    action={
                      <Button
                        label={zh.hosted.wizardPickBtn}
                        size="sm"
                        variant="primary"
                        disabled={item.invalid || incompatible}
                        disabledReason={
                          item.invalid
                            ? (item.error ?? '清单格式异常')
                            : incompatible
                              ? `需将节点 Agent 升级到 ≥ ${MANIFEST_V2_MIN_AGENT}`
                              : undefined
                        }
                        onClick={() => pickApp(item)}
                      />
                    }
                  >
                    <Stack gap={2}>
                      <Row gap={2} wrap>
                        {item.invalid ? (
                          <Badge tone="danger" label="格式异常" />
                        ) : (
                          <>
                            <Badge tone="neutral" label={`v${item.def.version}`} />
                            {item.schema === 2 ? <Badge tone="info" label="v2" /> : null}
                            {item.dynamicScript ? <Badge tone="warn" label="动态脚本" /> : null}
                            {defaultPort ? (
                              <Badge tone="neutral" label={`127.0.0.1:${defaultPort}`} />
                            ) : null}
                            {installedEntry ? (
                              <Badge
                                tone="ok"
                                label={fmt(zh.hosted.wizardAlreadyInstalled, {
                                  version: installedEntry.version || item.def.version,
                                })}
                              />
                            ) : null}
                          </>
                        )}
                      </Row>
                      {item.dynamicScript && item.def.sources ? (
                        <span className="ui-text-caption">
                          外部来源：{item.def.sources.map((s) => s.host).join('、')}
                        </span>
                      ) : null}
                      {item.invalid && item.error ? (
                        <span className="ui-field-error">{item.error}</span>
                      ) : null}
                      {incompatible ? (
                        <Row gap={2} align="center" wrap>
                          <span className="ui-text-caption">
                            需将节点 Agent 升级到 ≥ {MANIFEST_V2_MIN_AGENT}（缺少：
                            {missing.join('、')}）
                          </span>
                          <Link to={paths.hubSection(hubId, 'settings')} label="去升级" />
                        </Row>
                      ) : null}
                    </Stack>
                  </Card>
                );
              })}
            </Stack>
          )
        ) : null}

        {step === 2 && selectedApp ? (
          <Stack gap={4}>
            <Card
              title={`${selectedApp.def.name} · v${selectedApp.def.version}`}
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
                  <Field
                    id="wizard-app-user"
                    label={zh.catalog.runtimeUserLabel}
                    error={!runtimeUser.trim() ? '请填写运行用户名' : undefined}
                    required
                  >
                    <TextInput
                      id="wizard-app-user"
                      value={runtimeUser}
                      mono
                      autoComplete="off"
                      placeholder="khc-app-demo"
                      onChange={setRuntimeUser}
                    />
                  </Field>
                ) : (
                  <Banner
                    tone="warn"
                    title={zh.catalog.runtimeRootWarnTitle}
                    description={zh.catalog.runtimeRootWarnDesc}
                  />
                )}

                {selectedApp.def.params
                  .filter((param) => !param.derive)
                  .map((param) => {
                    const id = `wizard-param-${selectedApp.id}-${param.key}`;
                    const label = param.label ?? param.key;
                    const boundConflict = endpoints.find(
                      (ep) =>
                        ep.portParam === param.key &&
                        endpointPortStates[ep.id]?.localConflictPort !== undefined,
                    );
                    const conflictPort = boundConflict
                      ? endpointPortStates[boundConflict.id]?.localConflictPort
                      : undefined;
                    const fieldError =
                      paramErrors[param.key] ??
                      (conflictPort !== undefined
                        ? fmt(zh.hosted.wizardLocalPortConflict, { port: String(conflictPort) })
                        : undefined);

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
                        <Field key={param.key} id={id} label={label} error={fieldError}>
                          <NumberInput
                            id={id}
                            value={
                              typeof values[param.key] === 'number'
                                ? (values[param.key] as number)
                                : null
                            }
                            min={param.min}
                            max={param.max}
                            invalid={Boolean(fieldError)}
                            onChange={(value) =>
                              setValues((prev) => ({ ...prev, [param.key]: value }))
                            }
                          />
                        </Field>
                      );
                    }
                    if (param.type === 'enum' && param.options) {
                      const currentVal = String(values[param.key] ?? '');
                      const selectedOpt = param.options.find((opt) => opt.value === currentVal);
                      const reqParts: string[] = [];
                      if (selectedOpt?.requires?.memMB) {
                        reqParts.push(`需 ≥ ${selectedOpt.requires.memMB} MB 内存`);
                      }
                      if (selectedOpt?.requires?.diskMB) {
                        reqParts.push(`需 ≥ ${selectedOpt.requires.diskMB} MB 磁盘`);
                      }
                      return (
                        <Field
                          key={param.key}
                          id={id}
                          label={label}
                          help={reqParts.length > 0 ? reqParts.join(' · ') : undefined}
                          error={fieldError}
                        >
                          <Select
                            id={id}
                            value={currentVal}
                            options={param.options.map((opt) => ({
                              value: opt.value,
                              label: opt.label,
                            }))}
                            onChange={(value) =>
                              setValues((prev) => ({ ...prev, [param.key]: value }))
                            }
                            ariaLabel={label}
                          />
                        </Field>
                      );
                    }

                    if (param.secret) {
                      const shown = Boolean(secretShown[param.key]);
                      return (
                        <Field
                          key={param.key}
                          id={id}
                          label={label}
                          help={zh.catalog.secretHelp}
                          error={fieldError}
                        >
                          <Row gap={2} align="center">
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <TextInput
                                id={id}
                                type={shown ? 'text' : 'password'}
                                mono
                                autoComplete="new-password"
                                value={String(values[param.key] ?? '')}
                                invalid={Boolean(fieldError)}
                                onChange={(value) =>
                                  setValues((prev) => ({ ...prev, [param.key]: value }))
                                }
                              />
                            </div>
                            <Button
                              label={shown ? '隐藏' : '显示'}
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setSecretShown((prev) => ({
                                  ...prev,
                                  [param.key]: !prev[param.key],
                                }))
                              }
                            />
                          </Row>
                        </Field>
                      );
                    }

                    return (
                      <Field key={param.key} id={id} label={label} error={fieldError}>
                        <TextInput
                          id={id}
                          type="text"
                          mono
                          autoComplete="off"
                          value={String(values[param.key] ?? '')}
                          invalid={Boolean(fieldError)}
                          onChange={(value) =>
                            setValues((prev) => ({ ...prev, [param.key]: value }))
                          }
                        />
                      </Field>
                    );
                  })}

                {endpoints
                  .filter(
                    (ep) => !ep.portParam && endpointPortStates[ep.id]?.localConflictPort !== undefined,
                  )
                  .map((ep) => (
                    <InlineError
                      key={`conflict-${ep.id}`}
                      message={fmt(zh.hosted.wizardLocalPortConflict, {
                        port: String(endpointPortStates[ep.id]!.localConflictPort),
                      })}
                    />
                  ))}
              </Stack>
            </Card>

            {endpoints.length > 0 ? (
              <Card title={zh.hosted.wizardSectionPublish}>
                <Stack gap={3}>
                  {endpoints.map((ep) => {
                    const epState = endpointPortStates[ep.id];
                    const localPort = epState?.localPort ?? null;
                    const bindHost = ep.bind === 'any' ? '0.0.0.0' : '127.0.0.1';
                    const isCaddy = ep.publish === 'caddy';
                    const isDirect = ep.publish === 'direct';
                    const checked = Boolean(caddyEnabled[ep.id]);
                    const fwAllowed =
                      ep.bind === 'any' &&
                      !isDirect &&
                      localPort !== null &&
                      fwShowQuery.data != null &&
                      isTcpPortAllowedByFirewall(fwShowQuery.data, localPort);

                    return (
                      <Card
                        key={ep.id}
                        title={ep.label}
                        action={
                          <Badge
                            tone="neutral"
                            label={`${ep.protocol.toUpperCase()} · ${bindHost}${localPort !== null ? `:${localPort}` : ''}`}
                          />
                        }
                      >
                        <Stack gap={2}>
                          {ep.paths && ep.paths.length > 0 ? (
                            <span className="ui-text-caption">
                              路径：{ep.paths.join('、')}
                            </span>
                          ) : null}

                          {isCaddy ? (
                            <>
                              <Checkbox
                                checked={checked}
                                label="通过 Caddy 发布此端点"
                                onChange={(next) =>
                                  setCaddyEnabled((prev) => ({ ...prev, [ep.id]: next }))
                                }
                              />
                              {checked ? (
                                <Field
                                  id={`wizard-listen-port-${ep.id}`}
                                  label={
                                    caddyEndpoints.length > 1
                                      ? `${zh.hosted.wizardPortLabel}（${ep.label}）`
                                      : zh.hosted.wizardPortLabel
                                  }
                                  help={zh.hosted.wizardPortHelp}
                                  error={epState?.listenError}
                                  required
                                >
                                  <NumberInput
                                    id={`wizard-listen-port-${ep.id}`}
                                    value={caddyPorts[ep.id] ?? null}
                                    min={1}
                                    max={65535}
                                    invalid={Boolean(epState?.listenError)}
                                    onChange={(val) =>
                                      setCaddyPorts((prev) => ({ ...prev, [ep.id]: val }))
                                    }
                                  />
                                </Field>
                              ) : null}
                            </>
                          ) : isDirect ? (
                            <>
                              <span className="ui-text-caption">
                                直连端点（不建 Caddy 站点）
                              </span>
                              <HostFirewallPortAlert
                                hubId={hubId}
                                port={localPort}
                                enabled={Boolean(
                                  hasHostOps &&
                                    !offlineReason &&
                                    node?.accessMode !== 'tunnel' &&
                                    localPort !== null,
                                )}
                                appLabel={`${selectedApp.def.name} · ${ep.label}`}
                              />
                            </>
                          ) : (
                            <span className="ui-text-caption">仅本机使用，不对外发布。</span>
                          )}

                          {ep.bind === 'any' && !isDirect && localPort !== null ? (
                            <Banner
                              tone={fwAllowed ? 'warn' : 'info'}
                              title={`应用监听所有地址；端口 ${localPort} 若不打算直接对外，请确认主机防火墙未放行`}
                              description={
                                fwAllowed
                                  ? `主机防火墙当前已放行 TCP ${localPort}。`
                                  : undefined
                              }
                            />
                          ) : null}

                          {ep.auth?.hint ? (
                            <span className="ui-text-caption">鉴权提示：{ep.auth.hint}</span>
                          ) : null}
                        </Stack>
                      </Card>
                    );
                  })}

                  {hasCaddyPublish ? (
                    <>
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
                          list={domainOptions.length > 0 ? 'wizard-domain-options' : undefined}
                          placeholder="app.example.com"
                          onChange={setDomain}
                        />
                        {domainOptions.length > 0 ? (
                          <datalist id="wizard-domain-options">
                            {domainOptions.map((item) => (
                              <option key={item} value={item} />
                            ))}
                          </datalist>
                        ) : null}
                      </Field>

                      <HostFirewallPortAlert
                        hubId={hubId}
                        port={firstCheckedPort}
                        enabled={fwAlertEnabled}
                        appLabel={selectedApp.def.name}
                      />

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
                            { value: 'off', label: zh.sites.tlsOff },
                          ]}
                          onChange={(value) => {
                            tlsTouchedRef.current = true;
                            setTlsMode(value === 'manual' ? 'manual' : value === 'off' ? 'off' : 'auto');
                          }}
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
                              onChange={(value) => {
                                tlsTouchedRef.current = true;
                                setCertId(value);
                              }}
                            />
                          </Field>
                        ) : (
                          <Banner
                            tone="warn"
                            title={zh.hosted.wizardTlsNoMatch}
                            action={
                              <Link
                                to={`${paths.settings}?tab=certs`}
                                label={zh.hosted.wizardGoToCerts}
                              />
                            }
                          />
                        )
                      ) : null}
                    </>
                  ) : null}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        ) : null}

        {step === 3 && selectedApp ? (
          <Stack gap={4}>
            <Steps
              items={[
                {
                  label: `安装 ${selectedApp.def.name} 到本机`,
                  state: installStepState,
                },
                ...(hasCaddyPublish
                  ? [
                      {
                        label: `发布 ${checkedCaddyEndpoints.length} 个端点（${normalizedDomain}）`,
                        state: publishStepState,
                      },
                    ]
                  : []),
              ]}
            />

            {phase === 'publishing' ? (
              <Banner tone="info" title={zh.hosted.wizardPublishingHint} />
            ) : null}

            {phase === 'done' ? (
              <Banner
                tone="ok"
                title={
                  publishedEndpoints.length > 0
                    ? fmt(zh.hosted.wizardDoneTitle, { name: selectedApp.def.name })
                    : `${selectedApp.def.name} 已安装`
                }
                description={
                  publishedEndpoints.length > 0
                    ? publishedEndpoints
                        .map((item) => `${item.label}：${item.urls[0]} → 127.0.0.1:${item.localPort}`)
                        .join('；')
                    : undefined
                }
                action={
                  primaryUrlCard ? (
                    <Link to={primaryUrlCard.value} label={primaryUrlCard.title} external />
                  ) : publishedEndpoints[0]?.urls[0] ? (
                    <Link
                      to={publishedEndpoints[0].urls[0]}
                      label={publishedEndpoints[0].urls[0]}
                      external
                    />
                  ) : undefined
                }
              />
            ) : null}

            {phase === 'done' && publishedEndpoints.length > 0 ? (
              <Card title="已发布访问地址">
                <Stack gap={2}>
                  {publishedEndpoints.map((ep) => (
                    <Stack key={ep.id} gap={1}>
                      <span className="ui-text-caption">
                        {ep.label}（反代 127.0.0.1:{ep.localPort}）
                      </span>
                      {ep.urls.map((url) => (
                        <Link key={url} to={url} label={url} external />
                      ))}
                    </Stack>
                  ))}
                </Stack>
              </Card>
            ) : null}

            {phase === 'done' && hasCaddyPublish ? (
              <HostFirewallPortAlert
                hubId={hubId}
                port={firstCheckedPort}
                enabled={fwAlertEnabled}
                appLabel={selectedApp.def.name}
              />
            ) : null}

            {actionError ? (
              <ManifestErrorAlert
                error={actionError}
                hubId={hubId}
                manifestId={selectedApp.id}
                onNavigate={onClose}
              />
            ) : null}

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
                <ResultCardsView cards={resultCards} title={zh.catalog.accessTitle} />
              </Stack>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Drawer>
  );
}

function manifestErrorFallback(err: unknown): string {
  return err instanceof Error && err.message ? err.message : zh.catalog.manifestsLoadFailed;
}
