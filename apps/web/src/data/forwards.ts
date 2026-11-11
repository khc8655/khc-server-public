/** 节点端口转发（port-forward）：配置、/state 状态合并、动作与错误。 */
import { queryOptions } from '@tanstack/react-query';
import {
  agentEnvelopeSchema,
  type AgentEnvelope,
  type AppConfig,
} from '@khc/contracts';
import { ApiError } from './client';
import { fetchAppConfig, runAppAction, saveAppConfig } from './apps';
import { fetchHubState } from './hubs';

export const PORT_FORWARD_APP = 'port-forward';
export const FORWARD_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const FORWARD_HOST_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
export const FORWARD_PROTOCOLS = ['tcp', 'udp'] as const;
export const DEFAULT_LISTEN_HOST = '0.0.0.0';

export type ForwardProtocol = (typeof FORWARD_PROTOCOLS)[number];

export interface ForwardRule {
  name: string;
  protocol: ForwardProtocol;
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  note: string;
}

export interface ForwardConfig {
  forwards: ForwardRule[];
}

export interface ForwardConfigState {
  config: ForwardConfig;
  rev: number | null;
  appliedRev: number | null;
  exists: boolean;
}

export interface ForwardStatusRule {
  name: string;
  unit: string;
  protocol: ForwardProtocol | null;
  listenHost: string;
  listenPort: number | null;
  targetHost: string;
  targetPort: number | null;
  enabled: boolean | null;
  active: boolean | null;
  error: string | null;
}

export interface ForwardStatus {
  installed: boolean | null;
  running: boolean | null;
  socatVersion: string | null;
  rules: ForwardStatusRule[];
  total: number | null;
  error: string | null;
}

export interface ForwardRuntime {
  reachable: boolean;
  error: string | null;
  status: ForwardStatus | null;
}

export interface ForwardError {
  message: string;
  details: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback: boolean | null = null): boolean | null {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeProtocol(value: unknown): ForwardProtocol {
  return value === 'udp' ? 'udp' : 'tcp';
}

export function normalizeForwardRule(raw: unknown, index = 0): ForwardRule {
  const rule = asRecord(raw);
  return {
    name: asString(rule.name) || asString(rule.id) || `forward-${index + 1}`,
    protocol: normalizeProtocol(rule.protocol),
    listenHost: asString(rule.listenHost) || DEFAULT_LISTEN_HOST,
    listenPort: asNumber(rule.listenPort ?? rule.port),
    targetHost: asString(rule.targetHost) || asString(rule.target) || asString(rule.host),
    targetPort: asNumber(rule.targetPort),
    enabled: asBoolean(rule.enabled, true) ?? true,
    note: asString(rule.note),
  };
}

export function normalizeForwardConfig(raw: unknown): ForwardConfig {
  const record = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record.forwards)
      ? record.forwards
      : [];
  return { forwards: list.map((item, index) => normalizeForwardRule(item, index)) };
}

export const emptyForwardConfig = (): ForwardConfig => ({ forwards: [] });

export const forwardConfigQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', PORT_FORWARD_APP],
    queryFn: () => fetchAppConfig(hubId, PORT_FORWARD_APP),
    select: (data: AppConfig | null): ForwardConfigState => ({
      config: normalizeForwardConfig(data?.config ?? null),
      rev: data?.rev ?? null,
      appliedRev: data?.appliedRev ?? null,
      exists: Boolean(data),
    }),
    staleTime: 5_000,
    enabled: Boolean(hubId),
  });

function normalizeStatusRule(raw: unknown, index: number): ForwardStatusRule | null {
  if (typeof raw === 'string') {
    const name = raw.replace(/^khc-forward-/, '').replace(/\.service$/, '');
    return {
      name: name || raw,
      unit: raw,
      protocol: null,
      listenHost: DEFAULT_LISTEN_HOST,
      listenPort: null,
      targetHost: '',
      targetPort: null,
      enabled: null,
      active: null,
      error: null,
    };
  }
  const rule = asRecord(raw);
  const unit = asString(rule.unit) || asString(rule.unitName) || asString(rule.service);
  const unitName = unit
    .replace(/^khc-forward-/, '')
    .replace(/\.service$/, '');
  const name = asString(rule.name) || asString(rule.id) || unitName;
  const protocolRaw = asString(rule.protocol);
  if (!name && !unit) return null;
  return {
    name: name || `forward-${index + 1}`,
    unit,
    protocol: protocolRaw === 'udp' ? 'udp' : protocolRaw === 'tcp' ? 'tcp' : null,
    listenHost: asString(rule.listenHost) || DEFAULT_LISTEN_HOST,
    listenPort: asNullableNumber(rule.listenPort ?? rule.port),
    targetHost: asString(rule.targetHost) || asString(rule.target),
    targetPort: asNullableNumber(rule.targetPort),
    enabled: asBoolean(rule.enabled),
    active: asBoolean(rule.active ?? rule.running ?? rule.unitActive),
    error: asString(rule.error) || asString(rule.lastError) || null,
  };
}

function statusRuleList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length === 0) return [];
  return entries.flatMap(([name, item]) => {
    if (typeof item === 'string') return [{ name, unit: item }];
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return [{ ...asRecord(item), name }];
    }
    return [];
  });
}

export function normalizeForwardStatus(
  adapters: readonly { name: string; status?: Record<string, unknown> }[] | undefined,
): ForwardStatus | null {
  const adapter = adapters?.find((item) => item.name === PORT_FORWARD_APP);
  if (!adapter) return null;
  const status = asRecord(adapter.status);
  const rawRules =
    statusRuleList(status.forwards).length > 0
      ? statusRuleList(status.forwards)
      : statusRuleList(status.rules).length > 0
        ? statusRuleList(status.rules)
        : statusRuleList(status.units).length > 0
          ? statusRuleList(status.units)
          : statusRuleList(status.services);
  const rules = rawRules
    .map((item, index) => normalizeStatusRule(item, index))
    .filter((item): item is ForwardStatusRule => item !== null);
  return {
    installed: asBoolean(status.installed),
    running: asBoolean(status.running ?? status.active),
    socatVersion:
      asString(status.socatVersion) ||
      asString(status.socat) ||
      asString(status.version) ||
      null,
    rules,
    total:
      asNullableNumber(status.total) ??
      asNullableNumber(status.count) ??
      (rules.length > 0 ? rules.length : null),
    error: asString(status.error) || asString(status.lastError) || null,
  };
}

export function findForwardStatus(
  status: ForwardStatus | null,
  rule: Pick<ForwardRule, 'name' | 'listenPort' | 'protocol'>,
): ForwardStatusRule | null {
  if (!status) return null;
  return (
    status.rules.find(
      (item) =>
        item.name === rule.name ||
        (item.listenPort === rule.listenPort && item.protocol === rule.protocol),
    ) ?? null
  );
}

export async function saveForwardConfig(
  hubId: string,
  config: ForwardConfig,
): Promise<AppConfig> {
  // 默认 0.0.0.0 不写入配置，兼容只认识旧 schema 的 Agent。
  const forwards = config.forwards.map((rule) =>
    rule.listenHost === DEFAULT_LISTEN_HOST
      ? {
          name: rule.name,
          protocol: rule.protocol,
          listenPort: rule.listenPort,
          targetHost: rule.targetHost,
          targetPort: rule.targetPort,
          enabled: rule.enabled,
          note: rule.note,
        }
      : rule,
  );
  return saveAppConfig(hubId, PORT_FORWARD_APP, { forwards } as unknown as Record<string, unknown>);
}

export type ForwardActionName = 'plan' | 'apply';

export async function runForwardAction(
  hubId: string,
  action: ForwardActionName,
): Promise<AgentEnvelope> {
  const body = await runAppAction(hubId, PORT_FORWARD_APP, action);
  return agentEnvelopeSchema.parse(body) as AgentEnvelope;
}

export function forwardEnvelopeError(
  envelope: AgentEnvelope,
  fallback: string,
): ForwardError | null {
  if (envelope.ok) return null;
  const details = envelope.error?.details;
  let detailText: string | null = null;
  if (details && Object.keys(details).length > 0) {
    try {
      detailText = JSON.stringify(details, null, 2);
    } catch {
      detailText = null;
    }
  }
  return {
    message: envelope.error?.message || fallback,
    details: detailText,
  };
}

export function forwardApiError(error: unknown, fallback: string): ForwardError {
  if (error instanceof ApiError) {
    let details: string | null = null;
    if (error.fields && Object.keys(error.fields).length > 0) {
      try {
        details = JSON.stringify(error.fields, null, 2);
      } catch {
        details = null;
      }
    }
    return { message: error.message || fallback, details };
  }
  return {
    message: error instanceof Error && error.message ? error.message : fallback,
    details: null,
  };
}

export function upsertForward(
  config: ForwardConfig,
  forward: ForwardRule,
  originalName?: string,
): ForwardConfig {
  const target = originalName ?? forward.name;
  const index = config.forwards.findIndex((item) => item.name === target);
  const forwards = [...config.forwards];
  if (index >= 0) forwards[index] = forward;
  else forwards.push(forward);
  return { forwards };
}

export function removeForward(config: ForwardConfig, name: string): ForwardConfig {
  return { forwards: config.forwards.filter((item) => item.name !== name) };
}

export function setForwardEnabled(
  config: ForwardConfig,
  name: string,
  enabled: boolean,
): ForwardConfig {
  return {
    forwards: config.forwards.map((item) =>
      item.name === name ? { ...item, enabled } : item,
    ),
  };
}

export function forwardTarget(forward: Pick<ForwardRule, 'targetHost' | 'targetPort'>): string {
  return `${forward.targetHost}:${forward.targetPort}`;
}
