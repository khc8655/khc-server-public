/**
 * 节点设置 · Agent 卡片（C5 + E3）：上报信息展示 + 安装/卸载命令（复制粘贴）
 * + 远程升级（发布清单 → POST /agent/upgrade，Agent 拉取式自重启，替换升级命令）。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hubStateQueryOptions } from '../../data/queries';
import {
  fetchAgentReleases,
  rollbackTarget,
  upgradeAgentRemote,
  type AgentRelease,
} from '../../data/agent';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Badge,
  Banner,
  Button,
  Card,
  Drawer,
  KeyValue,
  Row,
  Skeleton,
  Stack,
  useToast,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';
import { ApiError } from '../../data/client';
import { AgentCommandDrawer } from './AgentCommandDrawer';

function agentModeLabel(mode: 'wg' | 'caddy' | undefined): string {
  if (mode === 'wg') return zh.agent.agentModeWg;
  if (mode === 'caddy') return zh.agent.agentModeCaddy;
  return zh.agent.agentModeUnknown;
}

export function AgentCard({
  hubId,
  hubName,
  lastSeenAt,
  offline,
}: {
  hubId: string;
  hubName: string;
  lastSeenAt: number | null;
  offline: boolean;
}) {
  const stateQuery = useQuery(hubStateQueryOptions(hubId));
  const toast = useToast();
  const [drawerKind, setDrawerKind] = useState<'install' | 'uninstall' | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeConfirm, setUpgradeConfirm] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [releases, setReleases] = useState<AgentRelease[] | null>(null);
  const [dispatched, setDispatched] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const agent = stateQuery.data?.state?.agent;
  const version = agent?.version ?? null;
  const stateOffline = offline || stateQuery.data?.reachable === false;
  const authFailed = Boolean(
    stateQuery.data?.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(stateQuery.data.error),
  );
  const latest = releases?.[0] ?? null;
  // ADR-0019：清单第 2 条是上一版；仅当节点正跑最新版时才提供回滚入口。
  const previous = rollbackTarget(releases, version);

  // 发布清单（#32）：远程升级从中取包地址与 sha256。
  useEffect(() => {
    let cancelled = false;
    void fetchAgentReleases()
      .then((items) => {
        if (!cancelled) setReleases(items);
      })
      .catch(() => {
        if (!cancelled) setReleases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmRemoteUpgrade = async () => {
    if (!latest) return;
    try {
      await upgradeAgentRemote(hubId, { packageUrl: latest.url, sha256: latest.sha256 });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : zh.agent.remoteUpgradeFailed;
      setUpgradeError(message);
      throw error;
    }
    setUpgradeOpen(false);
    setUpgradeError(null);
    setDispatched(true);
    toast.show({ message: zh.agent.remoteUpgradeDispatched });
  };

  const confirmRollback = async () => {
    if (!previous) return;
    try {
      await upgradeAgentRemote(hubId, { packageUrl: previous.url, sha256: previous.sha256 });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : zh.agent.remoteUpgradeFailed;
      setUpgradeError(message);
      throw error;
    }
    setUpgradeError(null);
    setDispatched(true);
    toast.show({ message: zh.agent.rollbackDispatched });
  };

  const commandButtons: { kind: 'install' | 'uninstall'; ref: ActionRef }[] = [
    { kind: 'install', ref: action('agent.installCommand') },
    { kind: 'uninstall', ref: action('agent.uninstallCommand') },
  ];

  return (
    <>
      <Card title={zh.agent.title}>
        <Stack gap={3}>
          {stateQuery.isLoading && !stateQuery.data ? (
            <Stack gap={2}>
              <Skeleton height={10} width="35%" />
              <Skeleton height={10} width="55%" />
            </Stack>
          ) : null}

          {stateQuery.error ? (
            <Banner
              tone="danger"
              title={zh.agent.loadError}
              description={stateQuery.error instanceof Error ? stateQuery.error.message : undefined}
              action={
                <Button
                  label={zh.common.retry}
                  size="sm"
                  onClick={() => void stateQuery.refetch()}
                />
              }
            />
          ) : null}
          {stateOffline ? (
            <Banner tone="neutral" title={zh.agent.offline} description={zh.agent.offlineHint} />
          ) : null}

          {agent ? (
            <>
              <Row gap={2} wrap>
                <Badge tone="ok" label={version ? `v${version}` : zh.agent.notReported} />
              </Row>
              <KeyValue
                items={[
                  { key: zh.agent.version, value: version ?? zh.agent.notReported, mono: true },
                  { key: zh.agent.runMode, value: agentModeLabel(agent.mode) },
                  {
                    key: zh.agent.lastSeen,
                    value: lastSeenAt === null ? '—' : formatAbsoluteTime(lastSeenAt),
                  },
                ]}
              />
            </>
          ) : stateQuery.data ? (
            <Banner tone="neutral" title={zh.agent.noAgentHint} />
          ) : null}

          {dispatched && version !== latest?.version ? (
            <Banner tone="info" title={zh.agent.remoteUpgradeDispatched} />
          ) : null}
          {upgradeError ? <Banner tone="danger" title={upgradeError} /> : null}

          <Row gap={2} wrap>
            {commandButtons.map((item) => (
              <Button
                key={item.kind}
                label={actionLabel(item.ref)}
                icon={item.kind === 'install' ? 'download' : 'x'}
                size="sm"
                onClick={() => setDrawerKind(item.kind)}
              />
            ))}
            <Button
              label={actionLabel(action('agent.remoteUpgrade'))}
              icon="refresh"
              size="sm"
              variant="primary"
              disabled={stateOffline || !latest || authFailed}
              disabledReason={
                authFailed
                  ? zh.agent.remoteUpgradeAuthFailed
                  : stateOffline
                    ? zh.agent.disabledOffline
                    : !latest
                      ? zh.agent.remoteUpgradeNoRelease
                      : undefined
              }
              onClick={() => {
                setUpgradeError(null);
                setUpgradeOpen(true);
              }}
            />
            {previous ? (
              <Button
                label={actionLabel(action('agent.rollback'))}
                icon="refresh"
                size="sm"
                disabled={stateOffline}
                disabledReason={stateOffline ? zh.agent.disabledOffline : undefined}
                onClick={() => {
                  setUpgradeError(null);
                  setRollbackConfirm(true);
                }}
              />
            ) : null}
          </Row>
          <Banner tone="neutral" title={zh.agent.remoteUpgradeCadence} />
        </Stack>
      </Card>

      {drawerKind ? (
        <AgentCommandDrawer
          open
          kind={drawerKind}
          hubId={hubId}
          hubName={hubName}
          offline={stateOffline}
          onClose={() => setDrawerKind(null)}
        />
      ) : null}

      {upgradeOpen && latest ? (
        <Drawer
          open
          title={zh.agent.remoteUpgradeTitle}
          context={fmt(zh.agent.drawerContext, { hub: hubName })}
          onClose={() => setUpgradeOpen(false)}
          footer={
            <Row gap={2}>
              <Button label={zh.common.close} onClick={() => setUpgradeOpen(false)} />
              <Button
                label={zh.agent.remoteUpgradeConfirm}
                variant="primary"
                disabled={stateOffline}
                disabledReason={stateOffline ? zh.agent.disabledOffline : undefined}
                onClick={() => {
                  // ui-guidelines §8.3：关闭抽屉 → 页面级 ConfirmAction。
                  setUpgradeOpen(false);
                  setUpgradeConfirm(true);
                }}
              />
            </Row>
          }
        >
          <Stack gap={3}>
            <KeyValue
              items={[
                { key: zh.agent.version, value: version ?? zh.agent.notReported, mono: true },
                { key: zh.agent.remoteUpgradeLatest, value: latest.version, mono: true },
                { key: zh.agent.remoteUpgradePackage, value: latest.url, mono: true },
                { key: zh.agent.remoteUpgradeSha, value: latest.sha256, mono: true, copyValue: latest.sha256 },
              ]}
            />
          </Stack>
        </Drawer>
      ) : null}

      {upgradeConfirm && latest ? (
        <ConfirmAction
          open
          action={action('agent.remoteUpgrade')}
          title={zh.agent.remoteUpgradeTitle}
          body={zh.agent.remoteUpgradeBody}
          confirmLabel={zh.agent.remoteUpgradeConfirm}
          targetName={latest.version}
          nameLabel={fmt(zh.agent.remoteUpgradeNameLabel, { version: latest.version })}
          onCancel={() => setUpgradeConfirm(false)}
          onConfirm={async () => {
            try {
              await confirmRemoteUpgrade();
            } catch {
              // 失败信息由页面级 Banner（upgradeError）展示，确认框直接关闭。
            } finally {
              setUpgradeConfirm(false);
            }
          }}
        />
      ) : null}
      {rollbackConfirm && previous ? (
        <ConfirmAction
          open
          action={action('agent.rollback')}
          title={zh.agent.rollbackTitle}
          body={fmt(zh.agent.rollbackBody, {
            hub: hubName,
            from: version ?? zh.agent.notReported,
            to: previous.version,
          })}
          confirmLabel={zh.agent.rollbackConfirm}
          targetName={previous.version}
          nameLabel={fmt(zh.agent.rollbackNameLabel, { version: previous.version })}
          onCancel={() => setRollbackConfirm(false)}
          onConfirm={async () => {
            try {
              await confirmRollback();
            } catch {
              // 失败信息由页面级 Banner（upgradeError）展示，确认框直接关闭。
            } finally {
              setRollbackConfirm(false);
            }
          }}
        />
      ) : null}
    </>
  );
}
