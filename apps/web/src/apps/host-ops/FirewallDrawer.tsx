import { useEffect, useRef, useState } from 'react';
import { SaveBar } from '../../patterns';
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
  Dialog,
  Drawer,
  InlineError,
  KeyValue,
  Row,
  Skeleton,
  Stack,
  Table,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { HostOpsErrorBanner } from './Common';
import { CONFIRM_SECONDS, FirewallRulesEditor, cloneRules, validateRules } from './FirewallRulesEditor';

type Phase = 'idle' | 'waiting' | 'confirmed' | 'rolledback';

export function FirewallDrawer({
  open,
  hubId,
  target,
  context,
  onClose,
}: {
  open: boolean;
  hubId: string;
  target: string;
  context: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [rules, setRules] = useState<HostOpsFirewallRule[]>([]);
  const [serverRules, setServerRules] = useState<HostOpsFirewallRule[]>([]);
  const [draft, setDraft] = useState<HostOpsFirewallRule[]>([]);
  const [baseRev, setBaseRev] = useState<string | null>(null);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [countdown, setCountdown] = useState(CONFIRM_SECONDS);
  const [token, setToken] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [detailRule, setDetailRule] = useState<HostOpsFirewallRule | null>(null);
  const applyAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      applyAbort.current?.abort();
    },
    [],
  );

  const closeDrawer = () => {
    applyAbort.current?.abort();
    onClose();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // call 是 Agent 写锁动作；读动词也串行，避免并发拿不到锁。
      const versionResult = await callHostOps(hubId, target, 'version');
      const showResult = await callHostOps(hubId, target, 'fw.show', {});
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
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const canEdit = !readOnly && !unsupported && phase !== 'waiting' && (rules.length > 0 || !error);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);
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

  const saveDraft = () => {
    const invalid = validateRules(draft);
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    setValidationError(null);
    setRules(cloneRules(draft));
    setEditing(false);
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
        target,
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
    } catch (error) {
      if (!isHostOpsAbortError(error)) {
        setError({
          code: 'E_UNKNOWN',
          message: error instanceof Error ? error.message : zh.hostOps.firewallRules.applyFailed,
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
      const result = await callHostOps(hubId, target, 'fw.confirm', { token });
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

  const columns: ColumnDef<HostOpsFirewallRule>[] = [
    {
      key: 'action',
      type: 'name',
      header: zh.hostOps.firewallRules.action,
      value: (rule) =>
        rule.action === 'allow'
          ? zh.hostOps.firewallRules.allow
          : zh.hostOps.firewallRules.deny,
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
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <>
      <Drawer
        open={open}
        title={zh.hostOps.firewallTitle}
        context={context}
        dirty={editing ? dirty : pendingApply}
        onClose={closeDrawer}
        footer={
          editing ? (
            <SaveBar
              note={
                changedCount > 0
                  ? fmt(zh.hostOps.firewallRules.draftNoteCount, {
                      count: String(changedCount),
                    })
                  : zh.hostOps.firewallRules.draftNote
              }
              dirty={dirty}
              saving={applying}
              onDiscard={() => {
                setDraft(cloneRules(rules));
                setEditing(false);
                setError(null);
                setValidationError(null);
              }}
              onSave={saveDraft}
            />
          ) : (
            <Row gap={2} wrap>
              <Button label={zh.common.close} onClick={closeDrawer} />
              <Button
                label={zh.common.refresh}
                icon="refresh"
                loading={loading}
                onClick={() => void load()}
              />
              <Button
                label={zh.common.discard}
                variant="ghost"
                disabled={!pendingApply || phase === 'waiting'}
                disabledReason={
                  phase === 'waiting'
                    ? zh.hostOps.firewallRules.waitConfirmFirst
                    : zh.common.noChanges
                }
                onClick={() => {
                  setRules(cloneRules(serverRules));
                  setDraft(cloneRules(serverRules));
                  setError(null);
                }}
              />
              <Button
                label={zh.hostOps.firewallRules.edit}
                disabled={!canEdit}
                disabledReason={
                  readOnly
                    ? zh.hostOps.noPriv
                    : unsupported
                      ? zh.hostOps.firewallRules.unsupported
                      : zh.hostOps.firewallRules.waitConfirmFirst
                }
                onClick={() => {
                  setDraft(cloneRules(rules));
                  setEditing(true);
                }}
              />
              <Button
                label={
                  applying ? zh.hostOps.firewallRules.applying : zh.hostOps.firewallRules.applyNow
                }
                variant="primary"
                loading={applying}
                disabled={!pendingApply || !canEdit}
                disabledReason={
                  !pendingApply
                    ? zh.common.noChanges
                    : readOnly
                      ? zh.hostOps.noPriv
                      : zh.hostOps.firewallRules.waitConfirmFirst
                }
                onClick={() => void apply()}
              />
            </Row>
          )
        }
      >
        <Stack gap={4}>
          {phase === 'waiting' ? (
            <Banner
              tone="warn"
              title={fmt(zh.hostOps.firewallRules.waitingTitle, {
                seconds: String(countdown),
              })}
              description={zh.hostOps.firewallRules.waitingDesc}
              action={
                <Button
                  label={actionLabel(action('hostOps.fwConfirm'))}
                  size="sm"
                  variant="primary"
                  loading={confirming}
                  onClick={() => void confirm()}
                />
              }
            />
          ) : null}
          {phase === 'confirmed' ? (
            <Banner tone="info" title={zh.hostOps.firewallRules.confirmed} />
          ) : null}
          {phase === 'rolledback' ? (
            <Banner tone="danger" title={zh.hostOps.firewallRules.rolledBack} />
          ) : null}
          {readOnly ? <Banner tone="warn" title={zh.hostOps.noPriv} /> : null}
          <Banner tone="info" title={zh.hostOps.firewallRules.allowHint} />
          {unsupported ? (
            <Banner tone="warn" title={zh.hostOps.firewallRules.unsupported} />
          ) : null}
          {validationError ? <InlineError message={validationError} /> : null}
          {error ? (
            <HostOpsErrorBanner
              error={error}
              onRetry={() => {
                void load();
              }}
            />
          ) : null}

          {pendingApply && phase === 'idle' ? (
            <Banner
              tone="info"
              title={zh.hostOps.firewallRules.pendingApply}
              description={zh.hostOps.firewallRules.pendingApplyDesc}
            />
          ) : null}
          {loading && rules.length === 0 ? (
            <Stack gap={2}>
              <Skeleton height={10} />
              <Skeleton height={10} />
              <Skeleton height={10} width="70%" />
            </Stack>
          ) : null}

          {editing ? (
            <FirewallRulesEditor
              draft={draft}
              onUpdate={updateRule}
              onRemove={(id) =>
                setDraft((current) => current.filter((item) => item.id !== id))
              }
              onAdd={addRule}
            />
          ) : (
            <Table
              rows={loading && rules.length === 0 ? undefined : rules}
              columns={columns}
              rowKey={(rule) => rule.id}
              onRowOpen={setDetailRule}
              objectLabel={zh.hostOps.firewallTitle}
              empty={{
                icon: 'shield',
                title: zh.hostOps.firewallRules.empty,
                description: zh.hostOps.firewallRules.noRulesHint,
              }}
            />
          )}
        </Stack>
      </Drawer>

      {detailRule ? (
        <Dialog
          open
          title={fmt(zh.hostOps.firewallRules.detailTitle, { id: detailRule.id })}
          onClose={() => setDetailRule(null)}
          footer={<Button label={zh.common.close} onClick={() => setDetailRule(null)} />}
        >
          <Stack gap={3}>
            <KeyValue
              items={[
                {
                  key: zh.hostOps.firewallRules.action,
                  value:
                    detailRule.action === 'allow'
                      ? zh.hostOps.firewallRules.allow
                      : zh.hostOps.firewallRules.deny,
                },
                { key: zh.hostOps.firewallRules.proto, value: detailRule.proto || '—', mono: true },
                { key: zh.hostOps.firewallRules.port, value: detailRule.port, mono: true },
                { key: zh.hostOps.firewallRules.source, value: detailRule.source, mono: true },
                { key: zh.hostOps.firewallRules.note, value: detailRule.note || '—' },
              ]}
            />
            {detailRule.locked ? (
              <Banner tone="neutral" title={zh.hostOps.firewallRules.lockedHint} />
            ) : null}
          </Stack>
        </Dialog>
      ) : null}
    </>
  );
}
