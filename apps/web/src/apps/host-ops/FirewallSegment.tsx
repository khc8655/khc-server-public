import { useEffect, useRef, useState } from 'react';
import { action, actionLabel } from '../../registry/actions';
import {
  callHostOps,
  callHostOpsTask,
  isHostOpsAbortError,
  normalizeFirewallShow,
  normalizeFirewallToken,
  normalizeVersion,
  type HostOpsError,
  type HostOpsFirewallRule,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Badge,
  Banner,
  Button,
  Card,
  InlineError,
  Row,
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
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [loading, setLoading] = useState(false);
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
      // call 是 Agent 写锁动作；读动词也串行，避免并发拿不到锁。
      const versionResult = await callHostOps(hubId, 'self', 'version');
      const showResult = await callHostOps(hubId, 'self', 'fw.show', {});
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
  const unsupported = error?.code === 'E_UNSUPPORTED';
  const canEdit = !readOnly && !unsupported && phase !== 'waiting';
  const dirtyDraft = JSON.stringify(draft) !== JSON.stringify(rules);
  const pendingApply = JSON.stringify(rules) !== JSON.stringify(serverRules);
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
    setError(null);
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
    rules, draft, version, loading, error, phase, countdown,
    applying, confirming, validationError,
    readOnly, unsupported, canEdit, dirtyDraft, pendingApply, changedCount,
    load, updateRule, addRule, removeRule, saveDraft, discardDraft, discardServer,
    apply, confirm,
  };
}

export type FirewallState = ReturnType<typeof useFirewallState>;

/** 防火墙分段：只读表格 + 待生效横幅 + 倒计时确认；编辑进入页面级唯一抽屉。 */
export function FirewallSegment({
  fw,
  disabled,
  onOpenEdit,
}: {
  fw: FirewallState;
  disabled: boolean;
  onOpenEdit: () => void;
}) {
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
        <Banner tone="warn" title={zh.hostOps.firewallRules.unsupported} />
      ) : null}
      {fw.validationError ? <InlineError message={fw.validationError} /> : null}
      {fw.error ? <HostOpsErrorBanner error={fw.error} onRetry={() => void fw.load()} /> : null}

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
          onClick={() => void fw.apply()}
        />
      </Row>

      {/* 锁定规则提示放行内徽章集合之外的信息位 */}
      {fw.rules.some((rule) => rule.locked) ? (
        <Row gap={2}>
          <Badge tone="neutral" label={zh.hostOps.firewallRules.lockedHint} />
        </Row>
      ) : null}
    </Stack>
  );
}
