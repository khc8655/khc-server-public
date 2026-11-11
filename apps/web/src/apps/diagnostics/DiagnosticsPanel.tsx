import { useMemo, useState } from 'react';
import type {
  DiagnosticCheck,
  DiagnosticHint,
  DiagnosticHintFix,
} from '@khc/contracts';
import { runAppAction } from '../../data/apps';
import { runCaddyAction } from '../../data/sites';
import { runWireGuardAction } from '../../data/wireguard';
import {
  action,
  actionLabel,
  actions,
  type ActionId,
  type ActionRef,
} from '../../registry/actions';
import {
  Badge,
  Banner,
  Button,
  CodeBlock,
  InlineError,
  KeyValue,
  Link,
  Row,
  Stack,
  Table,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';
import { severityTone } from '../../data/diagnostics';

/* ------------------------------------------------------- 修复动作（共享） */

interface FixPlan {
  ref: ActionRef;
  label: string;
  key: string;
  run: () => Promise<void>;
}

function isActionId(value: string | undefined): ActionId | null {
  if (!value) return null;
  return Object.prototype.hasOwnProperty.call(actions, value) ? (value as ActionId) : null;
}

function envelopeError(
  error: { code?: string; message?: string } | null | undefined,
  fallback: string,
): Error {
  const code = error?.code ?? 'E_UNKNOWN';
  return new Error(`${code}: ${error?.message ?? fallback}`);
}

/** 应用归属：适配器问题带 `app`；核心码从 evidence.apps 里取第一个应用名。 */
function appForCheck(check: DiagnosticCheck): string | null {
  if (check.app) return check.app;
  const rawApps = check.evidence?.apps;
  if (typeof rawApps === 'string') {
    const first = rawApps.split(/[、,;\s]+/).find((token) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(token));
    if (first) return first;
  }
  return null;
}

function buildPlan(
  hubId: string,
  check: DiagnosticCheck,
  actionId: string,
  label: string,
  params: Record<string, string | number | boolean> = {},
): FixPlan | null {
  const id = isActionId(actionId);
  if (!id) return null;
  const ref = { id };
  const key = `${id}:${JSON.stringify(params)}`;
  if (id === 'wg.apply') {
    return {
      ref,
      label,
      key,
      run: async () => {
        const envelope = await runWireGuardAction(hubId, 'apply');
        if (!envelope.ok) throw envelopeError(envelope.error, zh.diagnostics.fixFailed);
      },
    };
  }
  if (id === 'caddy.reload' || id === 'caddy.service') {
    return {
      ref,
      label,
      key,
      run: async () => {
        const envelope = await runCaddyAction(
          hubId,
          id === 'caddy.reload' ? 'caddy_reload' : 'caddy_service',
        );
        if (!envelope.ok) throw envelopeError(envelope.error, zh.diagnostics.fixFailed);
      },
    };
  }
  if (id === 'app.apply') {
    const app = appForCheck(check);
    if (!app) return null;
    return {
      ref,
      label,
      key,
      run: async () => {
        const envelope = await runAppAction(hubId, app, 'apply');
        if (!envelope.ok) throw envelopeError(envelope.error, zh.diagnostics.fixFailed);
      },
    };
  }
  if (id === 'peer.cancelRotation') {
    const peer = typeof params.peer === 'string' ? params.peer : '';
    if (!peer) return null;
    return {
      ref,
      label,
      key,
      run: async () => {
        const envelope = await runAppAction(hubId, 'wireguard', 'cancel_rotation', { peer });
        if (!envelope.ok) throw envelopeError(envelope.error, zh.diagnostics.fixFailed);
      },
    };
  }
  return null;
}

function buildFixPlan(
  hubId: string,
  check: DiagnosticCheck,
  fix: DiagnosticHintFix,
): FixPlan | null {
  if (fix.mode !== 'action' || !fix.actionId) return null;
  const id = isActionId(fix.actionId);
  if (!id) return null;
  return buildPlan(hubId, check, fix.actionId, fix.label || actionLabel({ id }));
}

function resolveLink(route: string, hubId: string): string {
  return route.replace(/:hubId/g, encodeURIComponent(hubId));
}

/* --------------------------------------------------------------- 文案工具 */

function severityText(check: DiagnosticCheck): string {
  const map: Record<DiagnosticCheck['severity'], string> = {
    info: zh.diagnostics.severityInfo,
    warn: zh.diagnostics.severityWarn,
    error: zh.diagnostics.severityError,
  };
  return map[check.severity];
}

function buildReport(check: DiagnosticCheck, hint: DiagnosticHint | null): string {
  const lines: string[] = [
    zh.diagnostics.reportTitle,
    `${zh.diagnostics.checkItem}: ${check.title}`,
    `${zh.diagnostics.status}: ${severityText(check)}`,
    `${zh.diagnostics.rootCause}: ${hint?.summary ?? check.detail}`,
  ];
  if (hint) {
    lines.push(`${zh.diagnostics.impact}: ${hint.impact}`);
    lines.push(`${zh.diagnostics.causes}: ${hint.causes.join('；')}`);
    lines.push(`${zh.diagnostics.steps}:`);
    for (const item of hint.checks) {
      lines.push(`- ${item.text}${item.command ? `：${item.command}` : ''}`);
    }
  }
  const evidence = Object.entries(check.evidence ?? {});
  if (evidence.length > 0) {
    lines.push(`${zh.diagnostics.evidence}:`);
    for (const [key, value] of evidence) lines.push(`- ${key}: ${String(value)}`);
  }
  lines.push(`code: ${check.code}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------- 诊断问题列表 */

/**
 * 诊断列表（ui-redesign §4）：渲染在页面级唯一抽屉内；
 * 行点击切换到详情内容（不再各自开抽屉）。
 */
export function DiagnosticsIssueList({
  issues,
  counts,
  hints,
  truncated,
  staleMinutes,
  offline,
  generatedAt,
  onOpenCheck,
}: {
  issues: DiagnosticCheck[];
  counts: { error: number; warn: number; info: number };
  hints: Map<string, DiagnosticHint>;
  truncated: boolean;
  staleMinutes: number;
  offline: boolean;
  generatedAt: number | null;
  onOpenCheck: (check: DiagnosticCheck) => void;
}) {
  const columns: ColumnDef<DiagnosticCheck>[] = [
    {
      key: 'title',
      type: 'name',
      header: zh.diagnostics.checkItem,
      value: (check) => check.title,
      dot: (check) => severityTone(check.severity),
    },
    {
      key: 'severity',
      type: 'status',
      header: zh.diagnostics.status,
      status: (check) => ({ tone: severityTone(check.severity), label: severityText(check) }),
    },
    {
      key: 'hint',
      type: 'text',
      header: zh.diagnostics.impact,
      value: (check) => hints.get(check.code)?.impact ?? check.detail,
    },
  ];

  const headline =
    counts.error > 0
      ? { tone: 'danger' as const, label: fmt(zh.diagnostics.summaryIssues, { count: String(counts.error) }) }
      : counts.warn > 0
        ? { tone: 'warn' as const, label: fmt(zh.diagnostics.summaryWarn, { count: String(counts.warn) }) }
        : counts.info > 0
          ? { tone: 'info' as const, label: fmt(zh.diagnostics.summaryInfo, { count: String(counts.info) }) }
          : { tone: 'ok' as const, label: zh.diagnostics.summaryOk };

  return (
    <Stack gap={3}>
      {offline ? (
        <Banner tone="neutral" title={zh.diagnostics.offlineTitle} description={zh.diagnostics.offlineHint} />
      ) : null}
      {staleMinutes >= 5 ? (
        <Banner tone="neutral" title={fmt(zh.diagnostics.stale, { minutes: String(staleMinutes) })} />
      ) : null}
      {truncated ? <Banner tone="neutral" title={zh.diagnostics.truncated} /> : null}
      {generatedAt !== null ? (
        <Banner
          tone="neutral"
          title={fmt(zh.diagnostics.lastChecked, { time: formatAbsoluteTime(generatedAt) })}
        />
      ) : null}
      <Row gap={2} wrap>
        <Badge tone={headline.tone} label={headline.label} />
        {counts.error > 0 ? (
          <Badge tone="danger" label={fmt(zh.diagnostics.countError, { count: String(counts.error) })} />
        ) : null}
        {counts.warn > 0 ? (
          <Badge tone="warn" label={fmt(zh.diagnostics.countWarn, { count: String(counts.warn) })} />
        ) : null}
        {counts.info > 0 ? (
          <Badge tone="info" label={fmt(zh.diagnostics.countInfo, { count: String(counts.info) })} />
        ) : null}
      </Row>
      {issues.length === 0 ? (
        <Banner tone="ok" title={zh.diagnostics.summaryOk} description={zh.diagnostics.noIssuesHint} />
      ) : (
        <Table
          rows={issues}
          columns={columns}
          rowKey={(check) => check.id}
          objectLabel={zh.diagnostics.title}
          onRowOpen={onOpenCheck}
          empty={{ icon: 'check', title: zh.diagnostics.summaryOk }}
        />
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------- 诊断详情内容 */

/**
 * 诊断详情（ui-redesign §4）：渲染在页面级唯一抽屉内；
 * 修复动作直接执行（与应用页“保存并生效”同级，无二级确认弹窗）。
 */
export function DiagnosticsCheckDetail({
  hubId,
  check,
  hint,
  offline,
  onRefetch,
}: {
  hubId: string;
  check: DiagnosticCheck;
  hint: DiagnosticHint | null;
  offline: boolean;
  onRefetch: () => Promise<void>;
}) {
  const toast = useToast();
  const [fixingKey, setFixingKey] = useState<string | null>(null);
  const [fixDone, setFixDone] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  const { supportedFixes, configFixes, manualFixes } = useMemo(() => {
    const supported: FixPlan[] = [];
    const config: DiagnosticHintFix[] = [];
    const manual: string[] = [];
    const seen = new Set<string>();
    const add = (plan: FixPlan | null, fallback: string) => {
      if (!plan) {
        manual.push(fallback);
        return;
      }
      if (seen.has(plan.key)) return;
      seen.add(plan.key);
      supported.push(plan);
    };
    // 核心码的知识库修复；适配器问题则由 check.actions 自带动作。
    for (const fix of hint?.fixes ?? []) {
      if (fix.mode === 'config' && fix.route) {
        config.push(fix);
        continue;
      }
      if (fix.mode === 'manual') {
        manual.push(fix.label);
        continue;
      }
      add(buildFixPlan(hubId, check, fix), fix.label);
    }
    for (const actionRef of check.actions ?? []) {
      add(
        buildPlan(hubId, check, actionRef.id, actionRef.label ?? actionRef.id, actionRef.params ?? {}),
        actionRef.label ?? actionRef.id,
      );
    }
    return { supportedFixes: supported, configFixes: config, manualFixes: manual };
  }, [check, hint, hubId]);

  const copyReport = async () => {
    const text = buildReport(check, hint);
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    try {
      await clipboard.writeText(text);
      toast.show({ message: zh.diagnostics.reportCopied });
    } catch {
      /* 剪贴板不可用时保持静默，避免伪装成功 */
    }
  };

  const runFix = async (plan: FixPlan) => {
    setFixingKey(plan.key);
    setFixError(null);
    try {
      await plan.run();
      setFixDone(true);
      toast.show({ message: zh.diagnostics.fixSuccess });
      await onRefetch().catch(() => undefined);
    } catch (error) {
      setFixError(error instanceof Error ? error.message : zh.diagnostics.fixFailed);
    } finally {
      setFixingKey(null);
    }
  };

  const evidence = Object.entries(check.evidence ?? {});

  return (
    <Stack gap={3}>
      {offline ? (
        <Banner tone="neutral" title={zh.diagnostics.offlineTitle} description={zh.diagnostics.offlineHint} />
      ) : null}
      <Row gap={2} wrap>
        <Badge tone={severityTone(check.severity)} label={severityText(check)} />
      </Row>
      <Banner
        tone="neutral"
        title={zh.diagnostics.rootCause}
        description={hint?.summary ?? check.detail}
      />
      <KeyValue
        items={[
          { key: zh.diagnostics.impact, value: hint?.impact ?? check.detail },
          { key: zh.diagnostics.status, value: severityText(check) },
        ]}
      />
      {hint ? (
        <>
          <Banner tone="neutral" title={zh.diagnostics.causes} />
          {hint.causes.map((cause, index) => (
            <KeyValue
              key={`${cause}-${index}`}
              items={[{ key: `${zh.diagnostics.causes} ${index + 1}`, value: cause }]}
            />
          ))}
          <Banner
            tone="neutral"
            title={zh.diagnostics.steps}
            description={zh.diagnostics.readonlyHint}
          />
          {hint.checks.map((step, index) => (
            <Stack gap={2} key={`${step.text}-${index}`}>
              <KeyValue items={[{ key: `${zh.diagnostics.steps} ${index + 1}`, value: step.text }]} />
              {step.command ? (
                <CodeBlock code={step.command} label={zh.diagnostics.commandLabel} />
              ) : null}
            </Stack>
          ))}
        </>
      ) : (
        <Banner tone="neutral" title={zh.diagnostics.unknownHint} />
      )}

      <Banner tone="neutral" title={zh.diagnostics.evidence} />
      {evidence.length > 0 ? (
        <KeyValue
          items={evidence.map(([key, value]) => ({
            key,
            value: String(value),
            mono: true,
          }))}
        />
      ) : (
        <Banner tone="neutral" title={zh.diagnostics.noEvidence} />
      )}

      <Banner tone="neutral" title={zh.diagnostics.fixes} />
      {supportedFixes.length > 0 ? (
        <Row gap={2} wrap>
          {supportedFixes.map((plan) => (
            <Button
              key={plan.key}
              label={plan.label}
              variant="primary"
              size="sm"
              loading={fixingKey === plan.key}
              disabled={offline || fixingKey !== null}
              disabledReason={offline ? zh.diagnostics.disabledOffline : undefined}
              onClick={() => void runFix(plan)}
            />
          ))}
        </Row>
      ) : null}
      {configFixes.length > 0 ? (
        <Row gap={2} wrap>
          {configFixes.map((fix) => (
            <Link key={fix.label} to={resolveLink(fix.route ?? '', hubId)} label={fix.label} />
          ))}
        </Row>
      ) : null}
      {manualFixes.length > 0 ? (
        <Banner tone="neutral" title={zh.diagnostics.manual} description={manualFixes.join('；')} />
      ) : null}
      {supportedFixes.length === 0 && configFixes.length === 0 && manualFixes.length === 0 ? (
        <Banner tone="neutral" title={zh.diagnostics.noFix} />
      ) : null}

      {fixDone ? <Banner tone="info" title={zh.diagnostics.fixDone} /> : null}
      {fixError ? <InlineError message={`${zh.diagnostics.fixFailed}：${fixError}`} /> : null}

      <Row gap={2}>
        <Button
          label={actionLabel(action('node.diagnostics.copyReport'))}
          icon="copy"
          size="sm"
          onClick={() => void copyReport()}
        />
      </Row>
    </Stack>
  );
}
