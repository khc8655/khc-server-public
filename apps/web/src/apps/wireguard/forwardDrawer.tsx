/**
 * 端口转发抽屉（B4 抽取）：内网穿透页与「对外服务」页共用同一表单与状态口径。
 */
import { useState } from 'react';
import {
  DEFAULT_LISTEN_HOST,
  FORWARD_HOST_RE,
  FORWARD_NAME_RE,
  type ForwardConfig,
  type ForwardError,
  type ForwardProtocol,
  type ForwardRule,
  type ForwardStatus,
  type ForwardStatusRule,
} from '../../data/forwards';
import {
  Button,
  CodeBlock,
  Drawer,
  Field,
  InlineError,
  NumberInput,
  Row,
  Select,
  Stack,
  TextInput,
  Textarea,
  Toggle,
  type Tone,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';

export type ForwardField = 'name' | 'listenHost' | 'listenPort' | 'targetHost' | 'targetPort';
export type ForwardErrors = Partial<Record<ForwardField, string>>;

export interface ForwardFormState {
  mode: 'create' | 'edit';
  originalName?: string;
  name: string;
  protocol: ForwardProtocol;
  listenHost: string;
  listenPort: number | null;
  targetHost: string;
  targetPort: number | null;
  enabled: boolean;
  note: string;
  initial: string;
}

export interface ForwardRow {
  forward: ForwardRule;
  status: ForwardStatusRule | null;
}

export function forwardSignature(form: ForwardFormState): string {
  return JSON.stringify([
    form.name,
    form.protocol,
    form.listenHost,
    form.listenPort,
    form.targetHost,
    form.targetPort,
    form.enabled,
    form.note,
  ]);
}

export function createForwardForm(): ForwardFormState {
  const form: ForwardFormState = {
    mode: 'create',
    name: '',
    protocol: 'tcp',
    listenHost: DEFAULT_LISTEN_HOST,
    listenPort: null,
    targetHost: '',
    targetPort: null,
    enabled: true,
    note: '',
    initial: '',
  };
  return { ...form, initial: forwardSignature(form) };
}

export function editForwardForm(forward: ForwardRule): ForwardFormState {
  const form: ForwardFormState = {
    mode: 'edit',
    originalName: forward.name,
    name: forward.name,
    protocol: forward.protocol,
    listenHost: forward.listenHost,
    listenPort: forward.listenPort,
    targetHost: forward.targetHost,
    targetPort: forward.targetPort,
    enabled: forward.enabled,
    note: forward.note,
    initial: '',
  };
  return { ...form, initial: forwardSignature(form) };
}

export function forwardStatusBadge(
  row: ForwardRow,
  unapplied: boolean,
  runtimeStatus: ForwardStatus | null,
): { tone: Tone; label: string } {
  if (!row.forward.enabled) return { tone: 'neutral', label: zh.forwards.statusDisabled };
  if (row.status?.error) return { tone: 'danger', label: zh.forwards.statusFailed };
  if (runtimeStatus?.error) return { tone: 'danger', label: zh.forwards.statusFailed };
  if (unapplied) return { tone: 'neutral', label: zh.forwards.statusPending };
  if (!runtimeStatus) return { tone: 'neutral', label: zh.forwards.statusPending };
  if (runtimeStatus.installed === false) {
    return { tone: 'danger', label: zh.forwards.statusFailed };
  }
  if (!row.status) return { tone: 'neutral', label: zh.forwards.statusPending };
  if (row.status.active === true) return { tone: 'ok', label: zh.forwards.statusActive };
  if (row.status.active === false) return { tone: 'danger', label: zh.forwards.statusFailed };
  return { tone: 'neutral', label: zh.forwards.statusPending };
}

/** 与 Agent 适配器保持一致：SSH/Caddy/Agent 自身端口不允许被转发监听占用。 */
const RESERVED_LISTEN_PORTS = new Set([22, 80, 443, 8880, 8899]);

/** 目标是否指向本机（与后端 _host_is_local 同口径）。 */
function isLocalForwardTarget(targetHost: string, listenHost: string): boolean {
  const host = targetHost.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  if (host === '0.0.0.0' || host === '::') return true;
  if (/^127\./.test(host) || host === '::1') return true;
  return host === listenHost.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

export function validateForward(form: ForwardFormState, config: ForwardConfig): ForwardErrors {
  const next: ForwardErrors = {};
  const name = form.name.trim();
  if (!FORWARD_NAME_RE.test(name)) next.name = zh.forwards.invalidName;
  else if (config.forwards.some((item) => item.name === name && item.name !== form.originalName)) {
    next.name = zh.forwards.duplicateName;
  }
  if (
    form.listenPort === null ||
    !Number.isInteger(form.listenPort) ||
    form.listenPort < 1 ||
    form.listenPort > 65535
  ) {
    next.listenPort = zh.forwards.invalidListenPort;
  } else if (RESERVED_LISTEN_PORTS.has(form.listenPort)) {
    next.listenPort = zh.forwards.reservedListen;
  }
  const listenHost = form.listenHost.trim();
  if (!/^[0-9a-fA-F:.]+$/.test(listenHost)) next.listenHost = zh.forwards.invalidListenHost;
  const targetHost = form.targetHost.trim();
  if (!FORWARD_HOST_RE.test(targetHost)) next.targetHost = zh.forwards.invalidTargetHost;
  if (
    form.targetPort === null ||
    !Number.isInteger(form.targetPort) ||
    form.targetPort < 1 ||
    form.targetPort > 65535
  ) {
    next.targetPort = zh.forwards.invalidTargetPort;
  }
  if (
    !next.targetPort &&
    form.listenPort !== null &&
    form.targetPort === form.listenPort &&
    isLocalForwardTarget(targetHost, listenHost)
  ) {
    next.targetPort = zh.forwards.selfLoop;
  }
  const duplicate = config.forwards.some(
    (item) =>
      item.name !== form.originalName &&
      item.protocol === form.protocol &&
      item.listenPort === form.listenPort,
  );
  if (duplicate) next.listenPort = zh.forwards.duplicateListen;
  return next;
}

export function buildForward(form: ForwardFormState): ForwardRule {
  return {
    name: form.name.trim(),
    protocol: form.protocol,
    listenHost: form.listenHost.trim() || DEFAULT_LISTEN_HOST,
    listenPort: form.listenPort ?? 0,
    targetHost: form.targetHost.trim(),
    targetPort: form.targetPort ?? 0,
    enabled: form.enabled,
    note: form.note.trim(),
  };
}

export function ForwardDrawer({
  form,
  errors,
  saveError,
  saving,
  hubName,
  offlineReason,
  peers,
  onChange,
  onClose,
  onSave,
}: {
  form: ForwardFormState;
  errors: ForwardErrors;
  saveError: ForwardError | null;
  saving: boolean;
  hubName: string;
  offlineReason?: string;
  peers: { name: string; host: string }[];
  onChange: (patch: Partial<ForwardFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
}) {
  const dirty = forwardSignature(form) !== form.initial;
  const [customTarget, setCustomTarget] = useState(
    () => !peers.some((peer) => peer.host === form.targetHost) && form.targetHost !== '127.0.0.1',
  );
  const selectedTarget = customTarget
    ? 'custom'
    : peers.some((peer) => peer.host === form.targetHost)
      ? form.targetHost
      : 'local';
  return (
    <Drawer
      open
      title={form.mode === 'create' ? zh.forwards.addTitle : zh.forwards.editTitle}
      context={fmt(zh.forwards.context, { hub: hubName })}
      dirty={dirty}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.cancel} onClick={onClose} />
          <Button
            label={zh.common.save}
            loading={saving}
            disabled={!dirty || saving}
            disabledReason={zh.common.noChanges}
            onClick={() => onSave(false)}
          />
          <Button
            label={zh.common.saveAndApply}
            variant="primary"
            loading={saving}
            disabled={!dirty || saving || Boolean(offlineReason)}
            disabledReason={offlineReason ?? zh.common.noChanges}
            onClick={() => onSave(true)}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        <Field id="forward-name" label={zh.forwards.name} help={zh.forwards.nameHelp} error={errors.name} required>
          <TextInput
            id="forward-name"
            value={form.name}
            autoComplete="off"
            onChange={(value) => onChange({ name: value })}
          />
        </Field>
        <Field id="forward-protocol" label={zh.forwards.protocol} help={zh.forwards.protocolHelp}>
          <Select
            id="forward-protocol"
            value={form.protocol}
            options={[
              { value: 'tcp', label: zh.forwards.protocolTcp },
              { value: 'udp', label: zh.forwards.protocolUdp },
            ]}
            onChange={(value) => onChange({ protocol: value === 'udp' ? 'udp' : 'tcp' })}
          />
        </Field>
        <Field id="forward-listen-host" label={zh.forwards.listenHost} help={zh.forwards.listenHostHelp} error={errors.listenHost}>
          <TextInput
            id="forward-listen-host"
            value={form.listenHost}
            mono
            onChange={(value) => onChange({ listenHost: value })}
          />
        </Field>
        <Field
          id="forward-listen"
          label={zh.forwards.listenPort}
          help={zh.forwards.listenPortHelp}
          error={errors.listenPort}
          required
        >
          <NumberInput
            id="forward-listen"
            value={form.listenPort}
            min={1}
            max={65535}
            onChange={(value) => onChange({ listenPort: value })}
          />
        </Field>
        <Field id="forward-target-source" label={zh.forwards.targetSource} help={zh.forwards.targetSourceHelp} optional>
          <Select
            id="forward-target-source"
            value={selectedTarget}
            options={[
              ...peers.map((peer) => ({ value: peer.host, label: `${peer.name} · ${peer.host}` })),
              { value: 'local', label: zh.sites.targetLocal },
              { value: 'custom', label: zh.sites.targetCustom },
            ]}
            onChange={(value) => {
              if (value === 'custom') {
                setCustomTarget(true);
                return;
              }
              setCustomTarget(false);
              onChange({ targetHost: value === 'local' ? '127.0.0.1' : value });
            }}
          />
        </Field>
        <Field
          id="forward-target-host"
          label={zh.forwards.targetHost}
          help={zh.forwards.targetHostHelp}
          error={errors.targetHost}
          required
        >
          {selectedTarget === 'custom' ? (
            <TextInput
              id="forward-target-host"
              value={form.targetHost}
              mono
              onChange={(value) => onChange({ targetHost: value })}
            />
          ) : (
            <div className="ui-readonly-field mono">{form.targetHost || '—'}</div>
          )}
        </Field>
        <Field
          id="forward-target-port"
          label={zh.forwards.targetPort}
          help={zh.forwards.targetPortHelp}
          error={errors.targetPort}
          required
        >
          <NumberInput
            id="forward-target-port"
            value={form.targetPort}
            min={1}
            max={65535}
            onChange={(value) => onChange({ targetPort: value })}
          />
        </Field>
        <Field id="forward-enabled" label={zh.forwards.enabled} help={zh.forwards.enabledHelp} variant="row">
          <Toggle
            checked={form.enabled}
            label={zh.forwards.enabled}
            onChange={(checked) => onChange({ enabled: checked })}
          />
        </Field>
        <Field id="forward-note" label={zh.forwards.note} help={zh.forwards.noteHelp} optional>
          <Textarea
            id="forward-note"
            value={form.note}
            rows={3}
            onChange={(value) => onChange({ note: value })}
          />
        </Field>
        {saveError ? (
          <Stack gap={2}>
            <InlineError message={saveError.message} />
            {saveError.details ? (
              <CodeBlock code={saveError.details} label={zh.forwards.detailsTitle} />
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Drawer>
  );
}
