import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyWireGuardMode,
  nextModeTarget,
  saveWireGuardEnabled,
  waitForWireGuardMode,
  ModeSwitchError,
  type NodeModeInfo,
  type NodeModeIssue,
} from '../../data/mode';
import { paths } from '../../registry/routes';
import {
  Banner,
  Button,
  Checkbox,
  Drawer,
  InlineError,
  Link,
  Row,
  Stack,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';
import { ModeBadge, modeLabel } from './ModeBadge';

interface SwitchFailure {
  code: string;
  message: string;
}

function failureFrom(error: unknown): SwitchFailure {
  if (error instanceof ModeSwitchError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { code: 'E_MODE_UNKNOWN', message: error.message };
  }
  return { code: 'E_MODE_UNKNOWN', message: zh.mode.errorUnknown };
}

function resolveFixRoute(route: string, hubId: string): string {
  return route.replace(/:hubId/g, encodeURIComponent(hubId));
}

function issueLink(issue: NodeModeIssue, hubId: string) {
  return issue.fixRoute ? (
    <Link to={resolveFixRoute(issue.fixRoute, hubId)} label={zh.mode.blockerFix} />
  ) : undefined;
}

/**
 * 模式切换抽屉：一屏完成「当前模式 → 阻断 → 影响摘要 → 确认 → 切换」。
 * 切换本身是一次 apply，进度由按钮 loading 表达；不再有独立的进度/结果视图。
 */
export function ModeSwitchDrawer({
  open,
  hubId,
  hubName,
  mode,
  offline,
  onClose,
  onRefreshMode,
}: {
  open: boolean;
  hubId: string;
  hubName: string;
  mode: NodeModeInfo;
  offline: boolean;
  onClose: () => void;
  onRefreshMode: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SwitchFailure | null>(null);
  const [success, setSuccess] = useState<'wg' | 'caddy' | null>(null);

  const target = mode.target ?? nextModeTarget(mode.mode);
  const targetLabel = modeLabel(target);
  const impact = mode.warnings[0] ?? null;
  const blocked = mode.blockers.length > 0;
  const disabledReason = offline
    ? zh.mode.disabledOffline
    : blocked
      ? zh.mode.blockedReason
      : impact && !accepted
        ? zh.mode.impactUnaccepted
        : undefined;

  const switchMode = async () => {
    if (busy || disabledReason) return;
    setBusy(true);
    setFailure(null);
    setSuccess(null);
    try {
      await saveWireGuardEnabled(hubId, target === 'wg');
      await applyWireGuardMode(hubId);
      await waitForWireGuardMode(hubId, target);
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'mode'] });
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] });
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'state'] });
      await onRefreshMode().catch(() => undefined);
      setSuccess(target);
    } catch (error) {
      setFailure(failureFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const footer = success ? (
    <Button label={zh.common.close} onClick={onClose} />
  ) : (
    <Row gap={2} wrap>
      <Button label={zh.common.cancel} onClick={onClose} disabled={busy} />
      <Button
        label={busy ? zh.mode.switchBusy : `${zh.mode.confirmSwitch} · ${targetLabel}`}
        variant="primary"
        loading={busy}
        loadingLabel={zh.mode.switchBusy}
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason}
        onClick={() => void switchMode()}
      />
    </Row>
  );

  return (
    <Drawer
      open={open}
      title={zh.mode.title}
      context={fmt(zh.mode.drawerContext, { hub: hubName })}
      onClose={onClose}
      footer={footer}
    >
      <Stack gap={3}>
        <Row gap={2} wrap>
          <ModeBadge mode={mode.mode} />
          <Banner tone="neutral" title={fmt(zh.mode.modeNow, { label: modeLabel(mode.mode) })} />
        </Row>

        {offline ? (
          <Banner tone="neutral" title={zh.mode.offline} description={zh.mode.offlineHint} />
        ) : null}
        {!offline && mode.mode === 'unknown' ? (
          <Banner tone="info" title={zh.mode.badgeUnknown} description={zh.mode.unknownHint} />
        ) : null}

        {blocked ? (
          <Stack gap={2}>
            <Banner tone="danger" title={zh.mode.blockers} />
            {mode.blockers.map((blocker) => (
              <Banner
                key={blocker.code}
                tone="danger"
                title={blocker.message}
                action={issueLink(blocker, hubId)}
              />
            ))}
          </Stack>
        ) : null}

        {impact ? (
          <Stack gap={2}>
            <Banner
              tone="warn"
              title={zh.mode.impactTitle}
              description={impact.message}
            />
            <Checkbox
              checked={accepted}
              label={zh.mode.impactAck}
              onChange={setAccepted}
              disabled={busy}
            />
          </Stack>
        ) : null}

        {failure ? (
          <Stack gap={2}>
            <Banner tone="danger" title={zh.mode.switchFailed} description={failure.message} />
            <InlineError message={fmt(zh.mode.failedCode, { code: failure.code })} />
            <Banner tone="neutral" title={zh.mode.retryHint} />
            <Link to={paths.hub(hubId)} label={zh.mode.viewDiagnostics} />
          </Stack>
        ) : null}

        {success ? (
          <Banner
            tone="ok"
            title={fmt(zh.mode.switchSuccess, { label: modeLabel(success) })}
          />
        ) : null}

        <Banner
          tone="neutral"
          title={fmt(zh.mode.checkedAt, { time: formatAbsoluteTime(mode.checkedAt) })}
        />
      </Stack>
    </Drawer>
  );
}
