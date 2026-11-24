import { useEffect, useRef, useState } from 'react';
import { ConfirmAction } from '../../patterns';
import { action, actionLabel } from '../../registry/actions';
import {
  callHostOps,
  callHostOpsTask,
  installHostOpsNftables,
  isHostOpsAbortError,
  normalizeFirewallShow,
  normalizeFirewallToken,
  normalizeVersion,
  type HostOpsError,
  type HostOpsFirewallAppPort,
  type HostOpsFirewallMode,
  type HostOpsFirewallRule,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  InlineError,
  Row,
  Segmented,
  Skeleton,
  Stack,
  Table,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { HostOpsErrorBanner } from './Common';
import { CONFIRM_SECONDS, cloneRules, validateRules } from './FirewallRulesEditor';

type Phase = 'idle' | 'waiting' | 'confirmed' | 'rolledback';

/**
 * 防火墙状态机（ui-redesign §4）：状态提升到页面级 hook，
 * 只读表格/待生效横幅/倒计时确认留在分段内，草稿编辑进入页面级唯一抽屉（fw-edit）。
 * active 由分段激活控制：进入防火墙分段才按需连接主机。
 */
export function useFirewallState(hubId: string, disabled: boolean, active: boolean) {
  const toast = useToast();
  const [rules, setRules] = useState<HostOpsFirewallRule[]>([]);
  const [serverRules, setServerRules] = useState<HostOpsFirewallRule[]>([]);
  const [draft, setDraft] = useState<HostOpsFirewallRule[]>([]);
  const [baseRev, setBaseRev] = useState<string | null>(null);
  const [mode, setMode] = useState<HostOpsFirewallMode>('open');
  const [serverMode, setServerMode] = useState<HostOpsFirewallMode>('open');
  const [closePublicSsh, setClosePublicSshState] = useState(false);
  const [serverClosePublicSsh, setServerClosePublicSsh] = useState(false);
  const [appPorts, setAppPorts] = useState<HostOpsFirewallAppPort[]>([]);
  const [wgInterfaces, setWgInterfaces] = useState<string[]>([]);
  const [wgSubnets, setWgSubnets] = useState<string[]>([]);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [installingNft, setInstallingNft] = useState(false);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [countdown, setCountdown] = useState(CONFIRM_SECONDS);
  const [token, setToken] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const applyAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      applyAbort.current?.abort();
    },
    [],
  );

  const load = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      // 两个调用互不依赖，并行发出去（串行时总耗时是两者之和）。
      const [versionResult, showResult] = await Promise.all([
        callHostOps(hubId, 'self', 'version'),
        callHostOps(hubId, 'self', 'fw.show', {}),
      ]);
      if (versionResult.ok) setVersion(normalizeVersion(versionResult.data));
      if (!showResult.ok) {
        setError(showResult.error);
        return;
      }
      const data = normalizeFirewallShow(showResult.data);
      setRules(data.rules);
      setServerRules(cloneRules(data.rules));
      setDraft(cloneRules(data.rules));
      setBaseRev(data.baseRev);
      setMode(data.mode);
      setServerMode(data.mode);
      setClosePublicSshState(data.closePublicSsh);
      setServerClosePublicSsh(data.closePublicSsh);
      setAppPorts(data.appPorts);
      setWgInterfaces(data.wgInterfaces);
      setWgSubnets(data.wgSubnets);
      if (data.pending?.token) {
        setToken(data.pending.token);
        setCountdown(Math.max(1, data.pending.secondsLeft ?? CONFIRM_SECONDS));
        setPhase('waiting');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, disabled]);

  useEffect(() => {
    if (phase !== 'waiting') return;
    if (countdown <= 0) {
      setPhase('rolledback');
      setToken(null);
      void load();
      return;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  const readOnly = version?.root === false;
  const unsupported = error?.code === 'E_UNSUPPORTED' || version?.nft === false;
  const canEdit = !readOnly && !unsupported && phase !== 'waiting';
  const dirtyDraft = JSON.stringify(draft) !== JSON.stringify(rules);
  const pendingApply =
    JSON.stringify(rules) !== JSON.stringify(serverRules) ||
    mode !== serverMode ||
    closePublicSsh !== serverClosePublicSsh;
  const changedCount = (() => {
    const current = new Map(rules.map((rule) => [rule.id, JSON.stringify(rule)]));
    let count = 0;
    for (const rule of draft) {
      if (current.get(rule.id) !== JSON.stringify(rule)) count += 1;
    }
    for (const rule of rules) {
      if (!draft.some((item) => item.id === rule.id)) count += 1;
    }
    return count;
  })();

  const changeMode = (nextMode: HostOpsFirewallMode) => {
    setMode(nextMode);
    if (nextMode !== 'allowlist') setClosePublicSshState(false);
    setError(null);
  };

  const setClosePublicSsh = (checked: boolean) => {
    if (checked && mode !== 'allowlist') setMode('allowlist');
    setClosePublicSshState(checked);
    setError(null);
  };

  const updateRule = (id: string, patch: Partial<HostOpsFirewallRule>) => {
    setValidationError(null);
    setDraft((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  };

  const addRule = () => {
    setDraft((current) => [
      ...current,
      {
        id: `new-${Date.now()}-${current.length}`,
        action: 'allow',
        proto: 'tcp',
        port: '',
        source: '0.0.0.0/0',
        note: '',
        locked: false,
        lockReason: null,
      },
    ]);
  };

  const removeRule = (id: string) => {
    setValidationError(null);
    setDraft((current) => current.filter((item) => item.id !== id));
  };

  const saveDraft = () => {
    const invalid = validateRules(draft);
    if (invalid) {
      setValidationError(invalid);
      return false;
    }
    setValidationError(null);
    setRules(cloneRules(draft));
    setError(null);
    return true;
  };

  const discardDraft = () => {
    setDraft(cloneRules(rules));
    setValidationError(null);
  };

  const discardServer = () => {
    setRules(cloneRules(serverRules));
    setDraft(cloneRules(serverRules));
    setMode(serverMode);
    setClosePublicSshState(serverClosePublicSsh);
    setError(null);
  };

  const installNftables = async () => {
    if (disabled) return false;
    setInstallingNft(true);
    setError(null);
    const controller = new AbortController();
    applyAbort.current = controller;
    try {
      const result = await installHostOpsNftables(hubId, { signal: controller.signal });
      if (controller.signal.aborted) return false;
      if (!result.ok) {
        setError(
          result.error ?? {
            code: 'pkg_install_failed',
            message: zh.hostOps.errors.pkg_install_failed,
            details: null,
          },
        );
        return false;
      }
      toast.show({ message: zh.hostOps.firewallRules.installedNft });
      await load();
      return true;
    } catch (err) {
      if (!isHostOpsAbortError(err)) {
        setError({
          code: 'pkg_install_failed',
          message: err instanceof Error ? err.message : zh.hostOps.errors.pkg_install_failed,
          details: null,
        });
      }
      return false;
    } finally {
      if (applyAbort.current === controller) applyAbort.current = null;
      setInstallingNft(false);
    }
  };

  const apply = async () => {
    const invalid = validateRules(rules);
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    setValidationError(null);
    setApplying(true);
    setError(null);
    const controller = new AbortController();
    applyAbort.current = controller;
    try {
      const result = await callHostOpsTask(
        hubId,
        'self',
        'fw.apply',
        {
          rules: rules.map((rule) => ({
            id: rule.id,
            action: rule.action,
            proto: rule.proto,
            port: rule.port.trim(),
            source: rule.source.trim(),
            note: rule.note.trim(),
          })),
          mode,
          closePublicSsh: mode === 'allowlist' ? closePublicSsh : false,
          baseRev,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!result.ok) {
        if (result.error) setError(result.error);
        return;
      }
      const nextToken = normalizeFirewallToken(result.data);
      if (!nextToken) {
        setError({
          code: 'E_UNKNOWN',
          message: zh.hostOps.firewallRules.applyFailed,
          details: null,
        });
        return;
      }
      setToken(nextToken);
      setCountdown(CONFIRM_SECONDS);
      setPhase('waiting');
    } catch (err) {
      if (!isHostOpsAbortError(err)) {
        setError({
          code: 'E_UNKNOWN',
          message: err instanceof Error ? err.message : zh.hostOps.firewallRules.applyFailed,
          details: null,
        });
      }
    } finally {
      if (applyAbort.current === controller) applyAbort.current = null;
      setApplying(false);
    }
  };

  const confirm = async () => {
    if (!token) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await callHostOps(hubId, 'self', 'fw.confirm', { token });
      if (!result.ok) {
        if (result.error) setError(result.error);
        return;
      }
      setPhase('confirmed');
      setToken(null);
      toast.show({ message: zh.hostOps.firewallRules.confirmed });
      await load();
    } finally {
      setConfirming(false);
    }
  };

  return {
    rules, draft, version, loading, installingNft, error, phase, countdown,
    mode, serverMode, closePublicSsh, serverClosePublicSsh, appPorts, wgInterfaces, wgSubnets,
    applying, confirming, validationError,
    readOnly, unsupported, canEdit, dirtyDraft, pendingApply, changedCount,
    load, changeMode, setClosePublicSsh, installNftables,
    updateRule, addRule, removeRule, saveDraft, discardDraft, discardServer,
    apply, confirm,
  };
}

export type FirewallState = ReturnType<typeof useFirewallState>;

/** 防火墙分段：只读表格 + 模式与待生效横幅 + 倒计时确认；编辑进入页面级唯一抽屉。 */
export function FirewallSegment({
  fw,
  hubName,
  disabled,
  onOpenEdit,
}: {
  fw: FirewallState;
  hubName: string;
  disabled: boolean;
  onOpenEdit: () => void;
}) {
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);
  const [closeSshConfirmOpen, setCloseSshConfirmOpen] = useState(false);
  const [vncConfirmed, setVncConfirmed] = useState(false);

  const reason = fw.version?.nftUnavailableReason;
  const canInstallNft = fw.version?.nftInstallable === true || reason === 'missing_pkg';
  const wgTargetLabel = [...fw.wgInterfaces, ...fw.wgSubnets].join(' / ');

  const columns: ColumnDef<HostOpsFirewallRule>[] = [
    {
      key: 'action',
      type: 'name',
      header: zh.hostOps.firewallRules.action,
      value: (rule) =>
        rule.action === 'allow' ? zh.hostOps.firewallRules.allow : zh.hostOps.firewallRules.deny,
      dot: (rule) => (rule.action === 'allow' ? 'ok' : 'danger'),
    },
    {
      key: 'proto',
      type: 'text',
      header: zh.hostOps.firewallRules.proto,
      value: (rule) => rule.proto || '—',
    },
    {
      key: 'port',
      type: 'text',
      header: zh.hostOps.firewallRules.port,
      value: (rule) => rule.port,
    },
    {
      key: 'source',
      type: 'mono',
      header: zh.hostOps.firewallRules.source,
      value: (rule) => rule.source,
    },
    {
      key: 'note',
      type: 'text',
      header: zh.hostOps.firewallRules.note,
      value: (rule) => rule.note || '—',
    },
    {
      key: 'locked',
      type: 'status',
      header: zh.hostOps.firewallRules.locked,
      status: (rule) =>
        rule.locked
          ? { tone: 'neutral', label: zh.hostOps.firewallRules.locked }
          : { tone: 'neutral', label: '—' },
    },
  ];

  return (
    <Stack gap={3}>
      {fw.phase === 'waiting' ? (
        <Banner
          tone="warn"
          title={fmt(zh.hostOps.firewallRules.waitingTitle, {
            seconds: String(fw.countdown),
          })}
          description={zh.hostOps.firewallRules.waitingDesc}
          action={
            <Button
              label={actionLabel(action('hostOps.fwConfirm'))}
              size="sm"
              variant="primary"
              loading={fw.confirming}
              onClick={() => void fw.confirm()}
            />
          }
        />
      ) : null}
      {fw.phase === 'confirmed' ? (
        <Banner tone="info" title={zh.hostOps.firewallRules.confirmed} />
      ) : null}
      {fw.phase === 'rolledback' ? (
        <Banner tone="danger" title={zh.hostOps.firewallRules.rolledBack} />
      ) : null}
      {fw.readOnly ? <Banner tone="warn" title={zh.hostOps.noPriv} /> : null}
      <Banner tone="info" title={zh.hostOps.firewallRules.allowHint} />
      {fw.unsupported ? (
        <Banner
          tone="warn"
          title={
            canInstallNft
              ? zh.hostOps.firewallRules.unsupportedMissingPkgTitle
              : reason === 'no_kernel'
                ? zh.hostOps.firewallRules.unsupportedNoKernelTitle
                : zh.hostOps.firewallRules.unsupported
          }
          description={
            canInstallNft
              ? zh.hostOps.firewallRules.unsupportedMissingPkgDesc
              : reason === 'no_kernel'
                ? zh.hostOps.firewallRules.unsupportedNoKernelDesc
                : undefined
          }
          action={
            <Row gap={2} wrap>
              {canInstallNft ? (
                <Button
                  label={
                    fw.installingNft
                      ? zh.hostOps.firewallRules.installingNft
                      : actionLabel(action('hostOps.fwInstallNft'))
                  }
                  variant="primary"
                  size="sm"
                  loading={fw.installingNft}
                  disabled={disabled || fw.installingNft}
                  onClick={() => setInstallConfirmOpen(true)}
                />
              ) : null}
              <Button
                label={zh.common.retry}
                size="sm"
                loading={fw.loading}
                disabled={disabled || fw.installingNft}
                onClick={() => void fw.load()}
              />
            </Row>
          }
        />
      ) : null}
      {fw.validationError ? <InlineError message={fw.validationError} /> : null}
      {fw.error && fw.error.code !== 'E_UNSUPPORTED' ? (
        <HostOpsErrorBanner error={fw.error} onRetry={() => void fw.load()} />
      ) : null}

      {!fw.unsupported ? (
        <Card>
          <Stack gap={3}>
            <Row gap={3} wrap>
              <Segmented
                value={fw.mode}
                ariaLabel={zh.hostOps.firewallRules.modeTitle}
                options={[
                  { value: 'open', label: zh.hostOps.firewallRules.modeOpen },
                  { value: 'allowlist', label: zh.hostOps.firewallRules.modeAllowlist },
                ]}
                onChange={(value) => {
                  if (disabled || !fw.canEdit) return;
                  fw.changeMode(value === 'allowlist' ? 'allowlist' : 'open');
                }}
              />
            </Row>
            <span className="ui-field-help">
              {fw.mode === 'allowlist'
                ? zh.hostOps.firewallRules.modeAllowlistHint
                : zh.hostOps.firewallRules.modeOpenHint}
            </span>
            {fw.mode === 'allowlist' ? (
              <Stack gap={2}>
                <Row gap={2} wrap>
                  <span className="ui-field-label">{zh.hostOps.firewallRules.appPortsTitle}</span>
                  {fw.appPorts.length > 0 ? (
                    fw.appPorts.map((item) => (
                      <Badge
                        key={`${item.proto}-${item.port}`}
                        tone="neutral"
                        label={`${item.proto.toUpperCase()}/${item.port} · ${item.app}`}
                      />
                    ))
                  ) : (
                    <span className="ui-field-help">{zh.hostOps.firewallRules.appPortsEmpty}</span>
                  )}
                </Row>
                <Checkbox
                  checked={fw.closePublicSsh}
                  disabled={disabled || !fw.canEdit}
                  label={zh.hostOps.firewallRules.closePublicSshLabel}
                  description={
                    wgTargetLabel
                      ? `${zh.hostOps.firewallRules.closePublicSshDescWithWg}${wgTargetLabel}`
                      : zh.hostOps.firewallRules.closePublicSshDescNoWg
                  }
                  onChange={(checked) => fw.setClosePublicSsh(checked)}
                />
              </Stack>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {fw.pendingApply && fw.phase === 'idle' ? (
        <Banner
          tone="info"
          title={zh.hostOps.firewallRules.pendingApply}
          description={zh.hostOps.firewallRules.pendingApplyDesc}
        />
      ) : null}
      {fw.loading && fw.rules.length === 0 ? (
        <Stack gap={2}>
          <Skeleton height={10} />
          <Skeleton height={10} />
          <Skeleton height={10} width="70%" />
        </Stack>
      ) : null}

      <Table
        rows={fw.loading && fw.rules.length === 0 ? undefined : fw.rules}
        columns={columns}
        rowKey={(rule) => rule.id}
        objectLabel={zh.hostOps.firewallTitle}
        empty={{
          icon: 'shield',
          title: zh.hostOps.firewallRules.empty,
          description: zh.hostOps.firewallRules.noRulesHint,
        }}
      />

      <Row gap={2} wrap>
        <Button
          label={zh.common.refresh}
          icon="refresh"
          loading={fw.loading}
          disabled={disabled}
          disabledReason={disabled ? zh.channels.controlFailed : undefined}
          onClick={() => void fw.load()}
        />
        <Button
          label={zh.hostOps.firewallRules.edit}
          disabled={disabled || !fw.canEdit}
          disabledReason={
            disabled
              ? zh.channels.controlFailed
              : fw.readOnly
                ? zh.hostOps.noPriv
                : fw.unsupported
                  ? zh.hostOps.firewallRules.unsupported
                  : zh.hostOps.firewallRules.waitConfirmFirst
          }
          onClick={onOpenEdit}
        />
        <Button
          label={zh.common.discard}
          variant="ghost"
          disabled={disabled || !fw.pendingApply || fw.phase === 'waiting'}
          disabledReason={
            fw.phase === 'waiting'
              ? zh.hostOps.firewallRules.waitConfirmFirst
              : zh.common.noChanges
          }
          onClick={fw.discardServer}
        />
        <Button
          label={fw.applying ? zh.hostOps.firewallRules.applying : zh.hostOps.firewallRules.applyNow}
          variant="primary"
          loading={fw.applying}
          disabled={disabled || !fw.pendingApply || !fw.canEdit}
          disabledReason={
            !fw.pendingApply
              ? zh.common.noChanges
              : fw.readOnly
                ? zh.hostOps.noPriv
                : zh.hostOps.firewallRules.waitConfirmFirst
          }
          onClick={() => {
            if (fw.closePublicSsh && !fw.serverClosePublicSsh) {
              setVncConfirmed(false);
              setCloseSshConfirmOpen(true);
              return;
            }
            void fw.apply();
          }}
        />
      </Row>

      {/* 锁定规则提示放行内徽章集合之外的信息位 */}
      {fw.rules.some((rule) => rule.locked) ? (
        <Row gap={2}>
          <Badge tone="neutral" label={zh.hostOps.firewallRules.lockedHint} />
        </Row>
      ) : null}

      <ConfirmAction
        open={installConfirmOpen}
        action={action('hostOps.fwInstallNft')}
        title={zh.hostOps.firewallRules.installNftTitle}
        body={zh.hostOps.firewallRules.installNftBody}
        confirmLabel={zh.hostOps.firewallRules.installNftConfirm}
        onCancel={() => setInstallConfirmOpen(false)}
        onConfirm={async () => {
          setInstallConfirmOpen(false);
          await fw.installNftables();
        }}
      />

      <ConfirmAction
        open={closeSshConfirmOpen}
        action={action('hostOps.fwClosePublicSsh')}
        title={fmt(zh.hostOps.firewallRules.closePublicSshTitle, { name: hubName })}
        body={
          fw.wgInterfaces.length > 0 || fw.wgSubnets.length > 0
            ? zh.hostOps.firewallRules.closePublicSshBody
            : zh.hostOps.firewallRules.closePublicSshBodyNoWg
        }
        confirmLabel={zh.hostOps.firewallRules.closePublicSshConfirm}
        targetName={hubName}
        nameLabel={fmt(zh.hostOps.firewallRules.closePublicSshNameLabel, { name: hubName })}
        confirmDisabled={!vncConfirmed}
        onCancel={() => {
          setCloseSshConfirmOpen(false);
          setVncConfirmed(false);
        }}
        onConfirm={async () => {
          setCloseSshConfirmOpen(false);
          setVncConfirmed(false);
          await fw.apply();
        }}
      >
        <Checkbox
          checked={vncConfirmed}
          label={zh.hostOps.firewallRules.closePublicSshVncCheck}
          onChange={setVncConfirmed}
        />
      </ConfirmAction>
    </Stack>
  );
}
