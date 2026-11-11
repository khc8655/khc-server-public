import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentState } from '@khc/contracts';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import type { WgPeer } from '../../data/wireguard';
import {
  applyHostOpsConfig,
  cachedHostOpsStatus,
  callHostOps,
  compareVersions,
  hostOpsConfigQueryOptions,
  hubPubKeyHostOps,
  normalizeHubKey,
  normalizeOnboard,
  normalizeProbe,
  normalizeStatus,
  normalizeVersion,
  onboardHostOps,
  peerHostAddress,
  probeHostOps,
  saveHostOpsConfig,
  type HostOpsError,
  type HostOpsHubKey,
  type HostOpsOnboard,
  type HostOpsProbe,
  type HostOpsStatus,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  KeyValue,
  Row,
  Skeleton,
  Stack,
  Steps,
  useToast,
  type StepItem,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatRelativeTime } from '../../i18n/format';
import { HostOpsActions } from './HostOpsActions';
import { OpsSummary } from './OpsSummary';
import { HostOpsErrorBanner } from './Common';

/**
 * WireGuard Peer 抽屉「运维」标签：
 * - 未接入：接入命令 / 检查连接 / 核对指纹 / 保存并 apply；
 * - 已接入：状态、手动获取、三个二级抽屉入口。
 */
export function PeerOpsPanel({
  hubId,
  peer,
  offlineReason,
  channelReadOnly = false,
}: {
  hubId: string;
  peer: WgPeer;
  offlineReason?: string;
  channelReadOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const configQuery = useQuery(hostOpsConfigQueryOptions(hubId));
  // 运维缓存状态来自打开页面时的一次性 /state 探测（不随 10s 快照轮询）。
  const { stateQuery } = useHubChannelsContext();
  const liveState = stateQuery.data?.state as unknown as AgentState | undefined;

  const config = configQuery.data?.config ?? { peers: {} };
  const peerConfig = config.peers[peer.name];
  const cached = useMemo(
    () => cachedHostOpsStatus(liveState, peer.name),
    [liveState, peer.name],
  );
  const stateExpectedVersion = useMemo(() => {
    const adapter = liveState?.adapters?.find(
      (item) => item.name === 'host-ops',
    );
    const status = (adapter?.status ?? {}) as Record<string, unknown>;
    const value = status.expectedVersion ?? status.scriptVersion;
    return typeof value === 'string' && value.trim() ? value : null;
  }, [liveState]);

  const [localOnboarded, setLocalOnboarded] = useState(false);
  const onboarded = localOnboarded || Boolean(peerConfig?.hostKey);
  const host = peerConfig?.host || peerHostAddress(peer.allowedIps);
  const port = peerConfig?.port ?? 22;
  const user = peerConfig?.user ?? 'khcops';
  const context = fmt(zh.hostOps.contextPeer, { peer: peer.name });

  const [status, setStatus] = useState<HostOpsStatus | null>(null);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<HostOpsError | null>(null);
  const [versionError, setVersionError] = useState<HostOpsError | null>(null);
  const [expectedScriptVersion, setExpectedScriptVersion] = useState<string | null>(null);
  const [updateRequired, setUpdateRequired] = useState(false);
  const cachedApplied = useRef(false);

  const [onboard, setOnboard] = useState<HostOpsOnboard | null>(null);
  const [hubKey, setHubKey] = useState<HostOpsHubKey | null>(null);
  const [onboardLoading, setOnboardLoading] = useState(false);
  const [onboardError, setOnboardError] = useState<HostOpsError | null>(null);
  const [showUninstall, setShowUninstall] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);

  const [probe, setProbe] = useState<HostOpsProbe | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeError, setProbeError] = useState<HostOpsError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applyError, setApplyError] = useState<HostOpsError | null>(null);

  useEffect(() => {
    if (cachedApplied.current || !cached) return;
    cachedApplied.current = true;
    if (cached.status) setStatus(cached.status);
    if (cached.version) {
      setVersion({ version: cached.version, python: null, root: null, nft: null });
    }
    if (cached.fetchedAt) setFetchedAt(cached.fetchedAt);
  }, [cached]);

  const readOnly = version?.root === false;
  const expectedVersion =
    onboard?.scriptVersion ?? expectedScriptVersion ?? stateExpectedVersion;
  const scriptOld =
    updateRequired ||
    Boolean(
      version?.version &&
        expectedVersion &&
        compareVersions(version.version, expectedVersion) < 0,
    );

  const fetchStatus = async () => {
    setStatusLoading(true);
    setStatusError(null);
    setVersionError(null);
    try {
      // snapshot：一次 SSH 返回 version + status，避免写锁/多次往返（#48）。
      const snapshotResult = await callHostOps(hubId, peer.name, 'snapshot');
      if (snapshotResult.ok) {
        setVersion(normalizeVersion(snapshotResult.data));
        setStatus(normalizeStatus(snapshotResult.data));
        setFetchedAt(Date.now());
      } else {
        setVersionError(snapshotResult.error);
        setStatusError(snapshotResult.error);
      }
      const expected = snapshotResult.expectedVersion;
      if (expected) setExpectedScriptVersion(expected);
      setUpdateRequired(
        snapshotResult.updateRequired === true ||
          snapshotResult.error?.code === 'E_SCRIPT_OLD',
      );
    } finally {
      setStatusLoading(false);
    }
  };

  const generate = async (): Promise<boolean> => {
    if (!host) {
      setOnboardError({
        code: 'E_BAD_REQUEST',
        message: zh.hostOps.commandMissing,
        details: null,
      });
      return false;
    }
    setOnboardLoading(true);
    setOnboardError(null);
    try {
      // onboard 动作从 Worker 下发的已保存配置里取 hubWgIp/peer；首次接入先落一份空 peers 配置。
      if (!configQuery.data?.exists) {
        try {
          await saveHostOpsConfig(hubId, { peers: config.peers });
        } catch (error) {
          setOnboardError({
            code: 'E_BAD_REQUEST',
            message: error instanceof Error ? error.message : zh.hostOps.onboardFailed,
            details: null,
          });
          return false;
        }
      }
      const [onboardResult, hubKeyResult] = await Promise.all([
        onboardHostOps(hubId, { host, port, user }),
        hubPubKeyHostOps(hubId),
      ]);
      if (!onboardResult.ok) {
        setOnboardError(onboardResult.error);
        return false;
      }
      const normalized = normalizeOnboard(onboardResult.data);
      if (!normalized) {
        setOnboardError({
          code: 'E_UNKNOWN',
          message: zh.hostOps.onboardFailed,
          details: null,
        });
        return false;
      }
      setOnboard(normalized);
      if (normalized.scriptVersion) setExpectedScriptVersion(normalized.scriptVersion);
      if (hubKeyResult.ok) setHubKey(normalizeHubKey(hubKeyResult.data));
      return true;
    } finally {
      setOnboardLoading(false);
    }
  };

  const checkConnection = async () => {
    setProbeLoading(true);
    setProbeError(null);
    try {
      const result = await probeHostOps(hubId, { host, port });
      if (!result.ok) {
        setProbeError(result.error);
        return;
      }
      const normalized = normalizeProbe(result.data);
      if (!normalized) {
        setProbeError({
          code: 'E_UNKNOWN',
          message: zh.hostOps.fingerprintMissing,
          details: null,
        });
        return;
      }
      setProbe(normalized);
    } finally {
      setProbeLoading(false);
    }
  };

  const confirmFingerprint = async () => {
    if (!probe) return;
    setConfirming(true);
    setApplyError(null);
    try {
      const nextConfig = {
        peers: {
          ...config.peers,
          [peer.name]: {
            enabled: true,
            host,
            port,
            user,
            hostKey: probe.hostKey || probe.fingerprint,
          },
        },
      };
      const result = await applyHostOpsConfig(hubId, nextConfig);
      if (!result.ok) {
        setApplyError(result.error);
        return;
      }
      setLocalOnboarded(true);
      setProbe(null);
      toast.show({ message: zh.hostOps.onboardSuccess });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
        queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] }),
      ]);
      void configQuery.refetch();
      await fetchStatus();
    } finally {
      setConfirming(false);
    }
  };

  const toggleUninstall = async () => {
    if (showUninstall) {
      setShowUninstall(false);
      return;
    }
    setShowUninstall(true);
    if (!onboard) await generate();
  };

  const toggleUpdate = async () => {
    if (showUpdate) {
      setShowUpdate(false);
      return;
    }
    setShowUpdate(true);
    if (!onboard) await generate();
  };

  if (configQuery.isLoading) {
    return (
      <Stack gap={3}>
        <Skeleton height={80} />
        <Skeleton height={160} />
      </Stack>
    );
  }

  if (configQuery.error) {
    return (
      <Banner
        tone="danger"
        title={zh.hostOps.onboardFailed}
        description={(configQuery.error as Error).message}
        action={
          <Button label={zh.common.retry} size="sm" onClick={() => void configQuery.refetch()} />
        }
      />
    );
  }

  if (!onboarded) {
    const stepItems: StepItem[] = [
      { label: zh.hostOps.generateCommand, state: onboard ? 'done' : 'running' },
      { label: zh.hostOps.stepRun, state: onboard ? (probe ? 'done' : 'running') : 'todo' },
      { label: zh.hostOps.stepCheck, state: probe ? 'running' : 'todo' },
    ];
    return (
      <Stack gap={4}>
        <Card title={zh.hostOps.onboardTitle}>
          <Stack gap={3}>
            <Banner tone="info" title={zh.hostOps.intro} description={zh.hostOps.onboardNote} />
            <Steps items={stepItems} />
            {!onboard ? (
              <Row gap={2}>
                <Button
                  label={
                    onboardLoading ? zh.hostOps.generating : zh.hostOps.generateCommand
                  }
                  icon="terminal"
                  variant="primary"
                  loading={onboardLoading}
                  onClick={() => void generate()}
                />
              </Row>
            ) : (
              <>
                <CodeBlock code={onboard.installCommand} label={zh.hostOps.installCommand} />
                <KeyValue
                  items={[
                    { key: zh.hostOps.hostAddress, value: `${host}:${port}`, mono: true },
                    { key: zh.hostOps.hostUser, value: user, mono: true },
                    ...(hubKey
                      ? [
                          {
                            key: zh.hostOps.hubKeyFingerprint,
                            value: hubKey.fingerprint || '—',
                            mono: true,
                          },
                          {
                            key: zh.hostOps.hubPublicKey,
                            value: hubKey.publicKey,
                            mono: true,
                            mode: 'middle' as const,
                            copyValue: hubKey.publicKey,
                          },
                        ]
                      : []),
                    ...(onboard.scriptVersion
                      ? [
                          {
                            key: zh.hostOps.scriptVersion,
                            value: onboard.scriptVersion,
                            mono: true,
                          },
                        ]
                      : []),
                  ]}
                />
                <Row gap={2} wrap>
                  <Button
                    label={
                      probeLoading ? zh.hostOps.checking : zh.hostOps.checkConnection
                    }
                    icon="refresh"
                    loading={probeLoading}
                    onClick={() => void checkConnection()}
                  />
                  <Button
                    label={zh.hostOps.uninstallCommand}
                    variant="ghost"
                    onClick={() => void toggleUninstall()}
                  />
                </Row>
              </>
            )}
            {onboardError ? <HostOpsErrorBanner error={onboardError} /> : null}
          </Stack>
        </Card>

        {probe ? (
          <Card title={zh.hostOps.fingerprintTitle}>
            <Stack gap={3}>
              <Banner tone="warn" title={zh.hostOps.fingerprintHint} />
              <KeyValue
                items={[
                  {
                    key: zh.hostOps.hubKeyFingerprint,
                    value: probe.fingerprint || '—',
                    mono: true,
                    copyValue: probe.fingerprint || undefined,
                  },
                  { key: zh.hostOps.algorithm, value: probe.algorithm || '—', mono: true },
                  {
                    key: zh.hostOps.hostKey,
                    value: probe.hostKey || '—',
                    mono: true,
                    mode: 'middle',
                    copyValue: probe.hostKey || undefined,
                  },
                ]}
              />
              <Row gap={2}>
                <Button
                  label={zh.hostOps.confirmFingerprint}
                  variant="primary"
                  loading={confirming}
                  disabled={confirming || Boolean(offlineReason) || !host}
                  disabledReason={
                    !host ? zh.hostOps.commandMissing : offlineReason
                  }
                  onClick={() => void confirmFingerprint()}
                />
              </Row>
            </Stack>
          </Card>
        ) : null}

        {probeError ? <HostOpsErrorBanner error={probeError} /> : null}
        {applyError ? (
          <HostOpsErrorBanner error={applyError} onRetry={() => void confirmFingerprint()} />
        ) : null}
        {showUninstall && onboard ? (
          <Card title={zh.hostOps.uninstallCommand}>
            <Stack gap={3}>
              <Banner tone="warn" title={zh.hostOps.uninstallHint} />
              <CodeBlock
                code={onboard.uninstallCommand}
                label={zh.hostOps.uninstallCommand}
              />
            </Stack>
          </Card>
        ) : null}
      </Stack>
    );
  }

  const versionText = version?.version ?? status?.version ?? '—';
  const dataTime = fetchedAt
    ? formatRelativeTime(Math.floor(fetchedAt / 1000))
    : zh.hostOps.neverFetched;

  return (
    <Stack gap={4}>
      <Card>
        <Stack gap={3}>
          <KeyValue
            items={[
              {
                key: zh.hostOps.hostname,
                value: status?.hostname ?? peer.name,
                mono: true,
                mode: 'end',
              },
              { key: zh.hostOps.scriptVersion, value: versionText, mono: true },
              { key: zh.hostOps.hostAddress, value: `${host}:${port}`, mono: true },
              { key: zh.hostOps.hostUser, value: user, mono: true },
              { key: zh.hostOps.dataFrom, value: dataTime },
            ]}
          />
          <Row gap={2} wrap>
            <Button
              label={statusLoading ? zh.hostOps.statusFetching : zh.hostOps.fetchStatus}
              icon="refresh"
              size="sm"
              loading={statusLoading}
              onClick={() => void fetchStatus()}
            />
            <Button
              label={zh.hostOps.uninstallCommand}
              size="sm"
              variant="ghost"
              onClick={() => void toggleUninstall()}
            />
          </Row>
        </Stack>
      </Card>

      {readOnly ? <Banner tone="warn" title={zh.hostOps.noPriv} /> : null}
      {status?.onboard?.shellModified ? (
        <Banner
          tone="info"
          title={fmt(zh.hostOps.shellModifiedTitle, { user: status.onboard.user })}
          description={fmt(zh.hostOps.shellModifiedDesc, {
            shell: status.onboard.originalShell ?? '—',
          })}
        />
      ) : null}
      {onboardError ? <HostOpsErrorBanner error={onboardError} /> : null}
      {scriptOld ? (
        <Banner
          tone="warn"
          title={zh.hostOps.scriptOld}
          description={fmt(zh.hostOps.expectedVersion, { version: expectedVersion ?? '' })}
          action={
            <Button
              label={zh.hostOps.updateCommand}
              size="sm"
              onClick={() => void toggleUpdate()}
            />
          }
        />
      ) : null}
      {showUpdate && onboard ? (
        <Card title={zh.hostOps.updateCommand}>
          <CodeBlock code={onboard.installCommand} label={zh.hostOps.installCommand} />
        </Card>
      ) : null}
      {showUninstall && onboard ? (
        <Card title={zh.hostOps.uninstallCommand}>
          <Stack gap={3}>
            <Banner tone="warn" title={zh.hostOps.uninstallHint} />
            <CodeBlock code={onboard.uninstallCommand} label={zh.hostOps.uninstallCommand} />
          </Stack>
        </Card>
      ) : null}
      {versionError && versionError.code !== 'E_SCRIPT_OLD' ? (
        <HostOpsErrorBanner error={versionError} onRetry={() => void fetchStatus()} />
      ) : null}
      {statusError && statusError.code !== 'E_SCRIPT_OLD' ? (
        <HostOpsErrorBanner error={statusError} onRetry={() => void fetchStatus()} />
      ) : null}

      <Card title={zh.ops.title}>
        <Stack gap={3}>
          {statusLoading && !status ? (
            <Stack gap={2}>
              <Skeleton height={10} />
              <Skeleton height={10} />
              <Skeleton height={10} width="70%" />
            </Stack>
          ) : null}
          {!statusLoading && !status ? (
            <EmptyState
              icon="server"
              title={zh.hostOps.statusEmpty}
              action={
                <Button
                  label={zh.hostOps.fetchStatus}
                  size="sm"
                  variant="primary"
                  onClick={() => void fetchStatus()}
                />
              }
            />
          ) : null}
          {status ? (
            <OpsSummary
              ops={status.ops}
              host={{ hostname: status.hostname, uptime: status.uptime }}
              compact
            />
          ) : null}
        </Stack>
      </Card>

      <Card title={zh.hostOps.tab}>
        <HostOpsActions hubId={hubId} target={peer.name} context={context} disabled={readOnly || channelReadOnly} />
      </Card>
    </Stack>
  );
}
