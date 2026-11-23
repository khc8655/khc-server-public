/**
 * 共享节点安装 / 重装与探活面板（ui-redesign）：
 * 用于「添加节点」成功页、AccessCard 改接/离线改证后重装，以及 AgentCard「安装 Agent」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeAccessMode, NodeProbeItem } from '@khc/contracts';
import {
  AgentCommandError,
  fetchAgentReleases,
  generateAgentCommand,
  validatePackageUrl,
  validateSha256,
  type AgentCommandResult,
  type AgentRunMode,
} from '../../data/agent';
import { certificatesQueryOptions } from '../../data/certs';
import { fetchHubState, probeHubs } from '../../data/hubs';
import { AdvancedSection } from '../../patterns';
import { accessModeLabel } from './AccessForm';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  Field,
  InlineError,
  KeyValue,
  Row,
  SecretField,
  Segmented,
  Skeleton,
  Stack,
  TextInput,
} from '../../ui';
import { zh } from '../../i18n/zh';

interface FormErrors {
  packageUrl?: string;
  sha256?: string;
}

export interface NodeInstallPanelProps {
  hubId: string;
  hubName: string;
  accessMode: NodeAccessMode;
  endpoint?: string | null;
  domain?: string | null;
  tlsCertId?: string | null;
  /** 仅创建节点成功抽屉传入一次性 token */
  token?: string | null;
  /** 抽屉顶部的上下文说明横幅 */
  notice?: { tone: 'info' | 'warn'; title: string; description?: string } | null;
  /** 节点离线提示（例如从 AgentCard 打开且节点离线） */
  offline?: boolean;
  /** 是否显示创建成功引导标题与节点摘要 */
  showCreatedSummary?: boolean;
  /** 是否显示「查看节点概况 / 去发布应用」跳转按钮 */
  showNavActions?: boolean;
  onGoToNode?: () => void;
  onGoToSites?: () => void;
  onOnline?: () => void;
}

export function NodeInstallPanel({
  hubId,
  hubName,
  accessMode,
  endpoint,
  domain,
  tlsCertId,
  token,
  notice,
  offline = false,
  showCreatedSummary = false,
  showNavActions = false,
  onGoToNode,
  onGoToSites,
  onOnline,
}: NodeInstallPanelProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AgentRunMode>('system');
  const [withCaddy, setWithCaddy] = useState(accessMode === 'domain');
  const [packageUrl, setPackageUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [releaseLoaded, setReleaseLoaded] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [command, setCommand] = useState<AgentCommandResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const [probeState, setProbeState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle');
  const [probeItem, setProbeItem] = useState<NodeProbeItem | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeAuthIssue, setProbeAuthIssue] = useState<string | null>(null);
  const [probeCaddy, setProbeCaddy] = useState<{ installed: boolean; running: boolean } | null>(
    null,
  );

  const certsQuery = useQuery({
    ...certificatesQueryOptions(),
    enabled: accessMode === 'domain' && Boolean(tlsCertId),
  });
  const boundCert = tlsCertId
    ? (certsQuery.data ?? []).find((cert) => cert.id === tlsCertId) ?? null
    : null;

  // hubId 或接入模式变化时重置默认安装选项与上次探测状态。
  const prevKeyRef = useRef(`${hubId}|${accessMode}`);
  useEffect(() => {
    const key = `${hubId}|${accessMode}`;
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setWithCaddy(accessMode === 'domain');
      setCommand(null);
      setInstallError(null);
      setProbeState('idle');
      setProbeItem(null);
      setProbeError(null);
      setProbeAuthIssue(null);
      setProbeCaddy(null);
    }
  }, [hubId, accessMode]);

  const runGenerate = useCallback(
    async (nextMode: AgentRunMode, nextUrl: string, nextSha: string, nextWithCaddy: boolean) => {
      const urlErr = validatePackageUrl(nextUrl);
      const shaErr = validateSha256(nextSha);
      if (urlErr || shaErr) {
        setErrors({
          ...(urlErr ? { packageUrl: urlErr } : {}),
          ...(shaErr ? { sha256: shaErr } : {}),
        });
        setCommand(null);
        return;
      }
      setErrors({});
      setGenerating(true);
      setInstallError(null);
      try {
        const result = await generateAgentCommand(hubId, 'install', {
          mode: nextMode,
          packageUrl: nextUrl.trim(),
          sha256: nextSha.trim(),
          installOptions: { withCaddy: nextWithCaddy },
        });
        setCommand(result);
      } catch (err) {
        if (err instanceof AgentCommandError && (err.field === 'packageUrl' || err.field === 'sha256')) {
          setErrors((prev) => ({ ...prev, [err.field]: err.message }));
        }
        setInstallError(err instanceof Error && err.message ? err.message : zh.hubs.installFailed);
        setCommand(null);
      } finally {
        setGenerating(false);
      }
    },
    [hubId],
  );

  // 自动拉取最新已签名安装包清单。
  useEffect(() => {
    let cancelled = false;
    setGenerating(true);
    setInstallError(null);
    void fetchAgentReleases()
      .then((releases) => {
        if (cancelled) return;
        const release = releases[0];
        if (!release) {
          setGenerating(false);
          setInstallError(zh.hubs.installUnavailable);
          return;
        }
        setPackageUrl(release.url);
        setSha256(release.sha256);
        setReleaseLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setGenerating(false);
        setInstallError(err instanceof Error && err.message ? err.message : zh.hubs.installFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [hubId]);

  // 发布清单就绪，或切换 mode / withCaddy / 证书绑定变化时自动生成安装命令。
  const packageRef = useRef({ packageUrl: '', sha256: '' });
  packageRef.current = { packageUrl, sha256 };

  useEffect(() => {
    if (!releaseLoaded) return;
    const { packageUrl: url, sha256: sha } = packageRef.current;
    if (!url || !sha) return;
    void runGenerate(mode, url, sha, withCaddy);
  }, [releaseLoaded, mode, withCaddy, hubId, accessMode, domain, endpoint, tlsCertId, runGenerate]);

  const checkInstalled = async () => {
    setProbeState('checking');
    setProbeError(null);
    setProbeAuthIssue(null);
    setProbeCaddy(null);
    try {
      const result = await probeHubs();
      const item = result.nodes.find((node) => node.id === hubId) ?? null;
      setProbeItem(item);
      if (item?.reachable) {
        const state = await fetchHubState(hubId, { force: true });
        if (state.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(state.error)) {
          setProbeAuthIssue(state.error);
          setProbeState('error');
          setProbeError(state.error);
          await queryClient.invalidateQueries({ queryKey: ['hubs'] });
          return;
        }
        const caddyAdapter = state.state?.adapters.find((adapter) => adapter.name === 'caddy-site');
        const caddyStatus = caddyAdapter?.status as
          | { installed?: boolean; running?: boolean }
          | undefined;
        const caddyInstalled =
          typeof caddyStatus?.installed === 'boolean' ? caddyStatus.installed : null;
        setProbeCaddy(
          caddyInstalled === null
            ? null
            : { installed: caddyInstalled, running: caddyStatus?.running === true },
        );
        onOnline?.();
      }
      setProbeState('done');
      await queryClient.invalidateQueries({ queryKey: ['hubs'] });
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'overview'] });
    } catch (error) {
      setProbeState('error');
      setProbeError(error instanceof Error ? error.message : zh.hubs.probeError);
    }
  };

  const displayToken = token || command?.token || null;

  return (
    <Stack gap={4}>
      {notice ? (
        <Banner tone={notice.tone} title={notice.title} description={notice.description} />
      ) : null}

      {offline && !notice ? (
        <Banner tone="neutral" title={zh.agent.offline} description={zh.agent.offlineHint} />
      ) : null}

      {showCreatedSummary ? (
        <Banner tone="info" title={zh.hubs.createdTitle} description={zh.hubs.createdHint} />
      ) : !notice ? (
        <Banner tone="info" title={zh.agent.installationHint} />
      ) : null}

      {displayToken ? (
        <>
          <Banner tone="warn" title={zh.hubs.tokenWarning} />
          <SecretField kind="once" text={displayToken} />
        </>
      ) : (
        <Banner tone="warn" title={zh.agent.tokenWarning} />
      )}

      {showCreatedSummary ? (
        <KeyValue
          items={[
            { key: zh.fields.name, value: hubName },
            { key: zh.access.modeLabel, value: accessModeLabel(accessMode) },
            {
              key: zh.fields.endpoint,
              value: endpoint || '—',
              mono: true,
              mode: 'middle',
            },
            ...(domain
              ? [{ key: zh.hubs.cfDnsDomainField, value: domain, mono: true }]
              : []),
          ]}
        />
      ) : null}

      <Stack gap={2}>
        <p className="ui-field-label">{zh.hubs.installStepTitle}</p>
        <p className="ui-field-help">{zh.hubs.installStepHint}</p>

        <Field id="install-mode" label={zh.hubs.installModeLabel} help={zh.hubs.installModeHelp}>
          <Segmented
            value={mode}
            ariaLabel={zh.hubs.installModeLabel}
            options={[
              { value: 'system', label: zh.hubs.installModeSystem },
              { value: 'user', label: zh.hubs.installModeUser },
            ]}
            onChange={(value) => setMode(value === 'user' ? 'user' : 'system')}
          />
        </Field>

        <Checkbox
          checked={withCaddy}
          onChange={setWithCaddy}
          label={zh.hubs.installWithCaddy}
        />
        <p className="ui-field-help">{zh.hubs.installOptionsHint}</p>

        {accessMode === 'domain' ? (
          tlsCertId ? (
            <Banner
              tone="info"
              title={zh.hubs.installBootstrapTitle}
              description={
                boundCert
                  ? `${zh.hubs.installBootstrapHint}（${boundCert.domains.join(', ')}）`
                  : zh.hubs.installBootstrapHint
              }
            />
          ) : (
            <Stack gap={1}>
              <p className="ui-field-label">{zh.hubs.installPortsTitle}</p>
              <p className="ui-field-help">{zh.hubs.installPortsRequired}</p>
              <p className="ui-field-help">{zh.hubs.installPortsOutbound}</p>
              <p className="ui-field-help">{zh.hubs.installPortsOptional}</p>
              <p className="ui-field-help">{zh.hubs.installPortsProxy}</p>
            </Stack>
          )
        ) : null}

        <Banner
          tone="warn"
          title={zh.hubs.installOverwriteTitle}
          description={zh.hubs.installOverwriteHint}
        />

        {generating ? <Skeleton height={80} /> : null}
        {!generating && command ? <CodeBlock code={command.command} label={zh.agent.command} /> : null}
        {!generating && !command && installError ? <InlineError message={installError} /> : null}

        <AdvancedSection title="高级">
          <Stack gap={3}>
            <Field
              id="agent-package-url"
              label={zh.agent.packageUrl}
              help={zh.agent.packageUrlHelp}
              error={errors.packageUrl}
            >
              <TextInput
                id="agent-package-url"
                value={packageUrl}
                mono
                autoComplete="off"
                placeholder="https://example.com/khc-agent.tar.gz"
                onChange={(value) => {
                  setPackageUrl(value);
                  setErrors((prev) => ({ ...prev, packageUrl: undefined }));
                }}
              />
            </Field>
            <Field
              id="agent-sha256"
              label={zh.agent.sha256}
              help={zh.agent.sha256Help}
              error={errors.sha256}
            >
              <TextInput
                id="agent-sha256"
                value={sha256}
                mono
                autoComplete="off"
                placeholder="64 位十六进制"
                onChange={(value) => {
                  setSha256(value);
                  setErrors((prev) => ({ ...prev, sha256: undefined }));
                }}
              />
            </Field>
            <Row gap={2}>
              <Button
                label={command ? zh.agent.regenerate : zh.agent.generate}
                size="sm"
                loading={generating}
                onClick={() => void runGenerate(mode, packageUrl, sha256, withCaddy)}
              />
            </Row>
          </Stack>
        </AdvancedSection>

        <p className="ui-field-help">{zh.hubs.installStepAfter}</p>
      </Stack>

      <Stack gap={2}>
        <Button
          label={
            probeState === 'idle' || probeState === 'error'
              ? zh.hubs.probeDone
              : zh.hubs.probeRecheck
          }
          size="sm"
          loading={probeState === 'checking'}
          onClick={() => void checkInstalled()}
        />
        {probeState === 'done' ? (
          <Banner
            tone={probeItem?.reachable ? 'ok' : 'warn'}
            title={probeItem?.reachable ? zh.hubs.probeOnline : zh.hubs.probeOffline}
            description={probeItem?.error ?? undefined}
          />
        ) : null}
        {probeState === 'done' && probeItem?.reachable ? (
          <Row gap={2} wrap>
            <Badge tone="ok" label={zh.hubs.checkAgent} dot />
            {probeCaddy === null ? (
              <Badge tone="neutral" label={zh.hubs.checkCaddyUnknown} dot />
            ) : probeCaddy.installed ? (
              <Badge
                tone={probeCaddy.running ? 'ok' : 'neutral'}
                label={probeCaddy.running ? zh.hubs.checkCaddyReady : zh.hubs.checkCaddyStopped}
                dot
              />
            ) : (
              <Badge tone="neutral" label={zh.hubs.checkCaddyMissing} dot />
            )}
          </Row>
        ) : null}
        {probeState === 'done' && !probeItem?.reachable ? (
          <Stack gap={1}>
            <p className="ui-field-label">{zh.hubs.probeHintsTitle}</p>
            <p className="ui-field-help">{zh.hubs.probeHintDns}</p>
            <p className="ui-field-help">{zh.hubs.probeHintTunnel}</p>
            <p className="ui-field-help">{zh.hubs.probeHintFirewall}</p>
          </Stack>
        ) : null}
        {probeAuthIssue ? (
          <Banner
            tone="danger"
            title={zh.hubs.probeAuthFailedTitle}
            description={zh.hubs.probeAuthFailedHint}
          />
        ) : null}
        {probeState === 'error' && !probeAuthIssue ? (
          <InlineError message={probeError ?? zh.hubs.probeError} />
        ) : null}
      </Stack>

      {showNavActions && (onGoToNode || onGoToSites) ? (
        <Row gap={2} wrap>
          {onGoToNode ? <Button label={zh.hubs.goToNode} size="sm" onClick={onGoToNode} /> : null}
          {onGoToSites ? (
            <Button
              label={zh.hubs.goToSites}
              size="sm"
              variant={probeState === 'done' && probeItem?.reachable ? 'primary' : 'default'}
              onClick={onGoToSites}
            />
          ) : null}
        </Row>
      ) : null}
    </Stack>
  );
}
