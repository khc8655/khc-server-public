/**
 * 应用清单 v2 通用前端模型与纯函数（替代旧 `recipes.ts` 的 v1 回转）。
 *
 * 所有清单定义经 `@khc/contracts` 归一化与能力推导，界面层不按应用名或参数名分支。
 */
import {
  MANIFEST_V2_MIN_AGENT,
  requiredAgentFeatures,
  toManifestV2,
  type AgentManifestFeature,
  type AgentState,
  type AppManifest,
  type AppManifestDefinitionV2,
} from '@khc/contracts';
import { formatAbsoluteTime } from '../i18n/format';
import { fmt, zh } from '../i18n/zh';
import type { Tone } from '../ui';
import { ApiError } from './client';
import { friendlyAgentError } from './apps';

export interface AppView {
  id: string;
  schema: 1 | 2;
  def: AppManifestDefinitionV2;
  enabled: boolean;
  invalid: boolean;
  error: string | null;
  dynamicScript: boolean;
  requiredFeatures: AgentManifestFeature[];
}

export interface InstalledUnit {
  name: string;
  scope: 'system' | 'user';
  active?: string;
}

export interface InstalledHealth {
  ok: boolean;
  checkedAt?: string;
  version?: string;
  error?: string;
}

export interface InstalledEndpoint {
  id: string;
  label?: string;
  protocol: 'http' | 'tcp';
  port?: number;
  bind: 'loopback' | 'any';
  paths?: string[];
  publish?: 'caddy' | 'direct' | 'none';
}

export interface InstalledApp {
  manifestId: string;
  instance: string;
  version: string;
  schema: 1 | 2;
  units: InstalledUnit[];
  lastHealth?: InstalledHealth;
  facts?: Record<string, string | number | boolean>;
  endpoints: InstalledEndpoint[];
  installedAt?: string;
  upgradedAt?: string;
  source: string;
  mode?: string;
  user?: string;
}

export interface AppCatalogStatusState {
  entries: InstalledApp[];
  stale: boolean;
  staleSince?: number;
  pending: boolean;
  error?: string;
}

export interface AppManifestCapabilities {
  schemas: number[];
  features: string[];
}

export interface ResultCardView {
  title: string;
  value: string;
  kind: 'url' | 'secret' | 'text' | 'command';
  copy: boolean;
  primary: boolean;
  qr?: boolean;
}

export interface PreflightCheckItem {
  name: string;
  ok: boolean;
  message: string;
}

export interface ManifestErrorView {
  code?: string;
  title: string;
  detail?: string;
  actionKind?: 'upgrade-agent' | 'config-secrets' | 'switch-channel';
  missingFeatures?: string[];
  secretNames?: string[];
  checks?: PreflightCheckItem[];
  logs?: string;
}

const FALLBACK_DEF: AppManifestDefinitionV2 = {
  schema: 2,
  name: '',
  version: '0.0.0',
  runtime: { mode: 'create', linger: true },
  params: [],
  scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
  sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
  writes: [],
};

/** 列表与卡片里的运行身份文案；旧值 shared 按「新建用户」显示。 */
export function runtimeLabel(runtime: { mode: string; user?: string }): string {
  if (runtime.mode === 'root') return zh.catalog.runtimeRootShort;
  return runtime.user
    ? fmt(zh.catalog.runtimeCreateShort, { user: runtime.user })
    : zh.catalog.runtimeCreate;
}

/** 将 `/app-manifests` 单条记录转换为统一的 v2 前端视图（坏清单不调 `toManifestV2`）。 */
export function toAppView(item: AppManifest): AppView {
  if (item.invalid === true || !item.manifest) {
    return {
      id: item.id,
      schema: 1,
      def: { ...FALLBACK_DEF, name: item.id },
      enabled: item.enabled,
      invalid: true,
      error: item.error ?? '清单格式异常',
      dynamicScript: false,
      requiredFeatures: [],
    };
  }
  const rawSchema = (item.manifest as { schema?: unknown }).schema === 2 ? 2 : 1;
  try {
    const def = toManifestV2(item.manifest);
    const dynamicScript = Boolean(def.sources?.some((source) => !source.pinned));
    return {
      id: item.id,
      schema: rawSchema,
      def,
      enabled: item.enabled,
      invalid: false,
      error: null,
      dynamicScript,
      requiredFeatures: requiredAgentFeatures(def),
    };
  } catch (err) {
    return {
      id: item.id,
      schema: rawSchema,
      def: { ...FALLBACK_DEF, name: item.manifest.name || item.id },
      enabled: item.enabled,
      invalid: true,
      error: err instanceof Error ? err.message : '清单解析失败',
      dynamicScript: false,
      requiredFeatures: [],
    };
  }
}

export function nodeAppCapabilities(
  state: AgentState | null | undefined,
): AppManifestCapabilities | undefined {
  return state?.agent?.capabilities?.appManifest;
}

export function missingNodeFeatures(
  view: Pick<AppView, 'schema' | 'requiredFeatures'>,
  state: AgentState | null | undefined,
): string[] {
  if (view.schema !== 2) return [];
  const caps = nodeAppCapabilities(state);
  if (!caps || !caps.schemas.includes(2)) {
    return view.requiredFeatures.length > 0 ? [...view.requiredFeatures] : ['schema2'];
  }
  return view.requiredFeatures.filter((feature) => !caps.features.includes(feature));
}

export function installActionForSchema(schema: 1 | 2): 'recipe_install' | 'manifest_install' {
  return schema === 2 ? 'manifest_install' : 'recipe_install';
}

export function uninstallActionForSchema(schema: 1 | 2): 'recipe_uninstall' | 'manifest_uninstall' {
  return schema === 2 ? 'manifest_uninstall' : 'recipe_uninstall';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseUnits(raw: unknown): InstalledUnit[] {
  if (!Array.isArray(raw)) return [];
  const units: InstalledUnit[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec || typeof rec.name !== 'string' || !rec.name) continue;
    const scope = rec.scope === 'system' ? 'system' : 'user';
    units.push({
      name: rec.name,
      scope,
      ...(typeof rec.active === 'string' ? { active: rec.active } : {}),
    });
  }
  return units;
}

function parseLastHealth(raw: unknown): InstalledHealth | undefined {
  const rec = asRecord(raw);
  if (!rec || typeof rec.ok !== 'boolean') return undefined;
  return {
    ok: rec.ok,
    ...(typeof rec.checkedAt === 'string' ? { checkedAt: rec.checkedAt } : {}),
    ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
    ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
  };
}

function parseFacts(raw: unknown): Record<string, string | number | boolean> | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseEndpoints(raw: unknown): InstalledEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const endpoints: InstalledEndpoint[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec || typeof rec.id !== 'string' || !rec.id) continue;
    endpoints.push({
      id: rec.id,
      ...(typeof rec.label === 'string' ? { label: rec.label } : {}),
      protocol: rec.protocol === 'tcp' ? 'tcp' : 'http',
      ...(typeof rec.port === 'number' ? { port: rec.port } : {}),
      bind: rec.bind === 'any' ? 'any' : 'loopback',
      ...(Array.isArray(rec.paths)
        ? { paths: rec.paths.filter((p): p is string => typeof p === 'string') }
        : {}),
      ...(rec.publish === 'caddy' || rec.publish === 'direct' || rec.publish === 'none'
        ? { publish: rec.publish }
        : {}),
    });
  }
  return endpoints;
}

/** 从 `/overview` 回填的 `state` 提取 `app-catalog` 状态及已装清单（按字段定位，不解析键字符串）。 */
export function installedCatalogState(state: AgentState | null | undefined): AppCatalogStatusState {
  const adapter = state?.adapters?.find((item) => item.name === 'app-catalog');
  const status = asRecord(adapter?.status);
  if (!status) {
    return { entries: [], stale: false, pending: false };
  }
  const rawStale = status.stale;
  const stale = Boolean(rawStale);
  const staleSince = asRecord(rawStale)?.since;
  const pending = Boolean(status.pending);
  const error = typeof status.error === 'string' ? status.error : undefined;

  const detail = asRecord(status.installedDetail);
  const entries: InstalledApp[] = [];
  if (detail) {
    for (const [fallbackKey, rawEntry] of Object.entries(detail)) {
      const rec = asRecord(rawEntry);
      if (!rec) continue;
      const source = typeof rec.source === 'string' && rec.source ? rec.source : 'recipe';
      const manifestId =
        typeof rec.manifestId === 'string' && rec.manifestId ? rec.manifestId : fallbackKey;
      const instance =
        typeof rec.instance === 'string' && rec.instance ? rec.instance : manifestId;
      entries.push({
        manifestId,
        instance,
        version: typeof rec.version === 'string' && rec.version ? rec.version : '—',
        schema: rec.schema === 2 ? 2 : 1,
        units: parseUnits(rec.units),
        lastHealth: parseLastHealth(rec.lastHealth),
        facts: parseFacts(rec.facts),
        endpoints: parseEndpoints(rec.endpoints),
        ...(typeof rec.installedAt === 'string' ? { installedAt: rec.installedAt } : {}),
        ...(typeof rec.upgradedAt === 'string' ? { upgradedAt: rec.upgradedAt } : {}),
        source,
        ...(typeof rec.mode === 'string' ? { mode: rec.mode } : {}),
        ...(typeof rec.user === 'string' ? { user: rec.user } : {}),
      });
    }
  }
  return {
    entries,
    stale,
    ...(typeof staleSince === 'number' ? { staleSince } : {}),
    pending,
    ...(error ? { error } : {}),
  };
}

export function installedEntries(state: AgentState | null | undefined): InstalledApp[] {
  return installedCatalogState(state).entries;
}

export function appStatus(
  entry: InstalledApp,
  catalogState?: Pick<AppCatalogStatusState, 'stale' | 'pending'>,
): { tone: Tone; label: string } {
  if (catalogState?.stale || catalogState?.pending) {
    return { tone: 'neutral', label: '未读取' };
  }
  const hasUnitFailure = entry.units.some(
    (unit) => unit.active !== undefined && unit.active !== 'active',
  );
  if (entry.lastHealth?.ok === false || hasUnitFailure) {
    return { tone: 'danger', label: '异常' };
  }
  const unitsAllActive =
    entry.units.length > 0 && entry.units.every((unit) => unit.active === 'active');
  if (entry.lastHealth?.ok === true || (entry.lastHealth === undefined && unitsAllActive)) {
    return { tone: 'ok', label: '运行中' };
  }
  return { tone: 'neutral', label: '已安装' };
}

export function canUpgrade(
  view: AppView | undefined,
  entry: InstalledApp,
  state?: AgentState | null,
): boolean {
  if (!view || view.invalid) return false;
  if (entry.source !== 'manifest' || view.schema !== 2) return false;
  if (entry.version === view.def.version) return false;
  return Boolean(nodeAppCapabilities(state)?.features.includes('upgrade'));
}

export function normalizeResultCards(schema: 1 | 2, rawCards: unknown): ResultCardView[] {
  if (!Array.isArray(rawCards)) return [];
  const cards: ResultCardView[] = [];
  for (const raw of rawCards) {
    const rec = asRecord(raw);
    if (!rec || typeof rec.title !== 'string' || typeof rec.value !== 'string') continue;
    let kind: ResultCardView['kind'] = 'text';
    if (
      rec.kind === 'url' ||
      rec.kind === 'secret' ||
      rec.kind === 'text' ||
      rec.kind === 'command'
    ) {
      kind = rec.kind;
    } else if (schema === 1 && /^https?:\/\//i.test(rec.value.trim())) {
      // v1 兼容，v1 下线时删除（ADR-0023 §决策 5）
      kind = 'url';
    }
    cards.push({
      title: rec.title,
      value: rec.value,
      kind,
      copy: Boolean(rec.copy),
      primary: Boolean(rec.primary),
      ...(rec.qr !== undefined ? { qr: Boolean(rec.qr) } : {}),
    });
  }
  return cards;
}

function formatErrorLogs(rawLogs: unknown): string | undefined {
  if (typeof rawLogs === 'string' && rawLogs.trim()) return rawLogs;
  const rec = asRecord(rawLogs);
  if (!rec) return undefined;
  const parts = Object.entries(rec)
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([unit, text]) => `[${unit}]\n${String(text).trim()}`);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function manifestErrorView(error: unknown): ManifestErrorView {
  let code: string | undefined;
  let message = '操作失败';
  let details: Record<string, unknown> | undefined;

  if (error instanceof ApiError) {
    code = error.code;
    message = friendlyAgentError(error.message) ?? error.message;
    details = error.details;
  } else if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof rec.code === 'string') code = rec.code;
    if (typeof rec.message === 'string' && rec.message) {
      message = friendlyAgentError(rec.message) ?? rec.message;
    }
    details = asRecord(rec.details) ?? undefined;
  } else if (typeof error === 'string' && error.trim()) {
    message = friendlyAgentError(error) ?? error;
  }

  switch (code) {
    case 'agent_upgrade_required': {
      const missingFeatures = Array.isArray(details?.missing)
        ? details.missing.filter((item): item is string => typeof item === 'string')
        : [];
      const minVer =
        typeof details?.minAgentVersion === 'string'
          ? details.minAgentVersion
          : MANIFEST_V2_MIN_AGENT;
      return {
        code,
        title: `需将节点 Agent 升级到 ≥ ${minVer}`,
        ...(missingFeatures.length > 0
          ? { detail: `缺少能力：${missingFeatures.join('、')}`, missingFeatures }
          : {}),
        actionKind: 'upgrade-agent',
      };
    }
    case 'preflight_failed': {
      const checks: PreflightCheckItem[] = [];
      if (Array.isArray(details?.checks)) {
        for (const item of details.checks) {
          const rec = asRecord(item);
          if (!rec || typeof rec.message !== 'string') continue;
          checks.push({
            name: typeof rec.name === 'string' ? rec.name : 'check',
            ok: Boolean(rec.ok),
            message: rec.message,
          });
        }
      }
      return {
        code,
        title: message || '节点安装预检未通过',
        checks,
      };
    }
    case 'secret_not_configured':
    case 'secret_host_not_allowed': {
      const secretNames =
        typeof details?.secret === 'string'
          ? [details.secret]
          : Array.isArray(details?.secrets)
            ? details.secrets.filter((s): s is string => typeof s === 'string')
            : [];
      return {
        code,
        title: message,
        ...(secretNames.length > 0
          ? { detail: `涉及凭据：${secretNames.join('、')}`, secretNames }
          : {}),
        actionKind: 'config-secrets',
      };
    }
    case 'hook_failed':
    case 'hook_extract_failed': {
      const stage = typeof details?.stage === 'string' ? details.stage : '控制面步骤';
      const status = typeof details?.status === 'number' ? details.status : undefined;
      const rawDetail =
        typeof details?.error === 'string' && details.error
          ? details.error
          : message;
      return {
        code,
        title:
          status !== undefined
            ? `${stage} 失败（HTTP ${status}）`
            : `${stage} 执行失败`,
        detail: rawDetail,
      };
    }
    case 'insecure_channel_secret':
      return {
        code,
        title: '该节点为明文接入，不能安装带控制面步骤的应用；改为域名或 Tunnel 接入',
        actionKind: 'switch-channel',
      };
    case 'manifest_invalid':
    case 'not_installed':
    case 'health_failed': {
      const logs = formatErrorLogs(details?.logs);
      return {
        code,
        title: message,
        ...(logs ? { logs } : {}),
      };
    }
    default:
      return {
        ...(code ? { code } : {}),
        title: message,
      };
  }
}

export function defaultManifestValues(def: AppManifestDefinitionV2): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of def.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }
  return values;
}

/** 参数校验（对齐 Agent 端校验：必填、整数、范围、长度、pattern、enum）。 */
export function validateManifestValues(
  def: AppManifestDefinitionV2,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const param of def.params) {
    if (param.derive) continue;
    const label = param.label ?? param.key;
    const required = param.default === undefined;
    const raw = values[param.key];

    if (param.type === 'integer') {
      if (raw === null || raw === undefined || raw === '') {
        if (required) errors[param.key] = fmt(zh.catalog.paramRequired, { label });
        continue;
      }
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(value)) {
        errors[param.key] = fmt(zh.catalog.paramInteger, { label });
        continue;
      }
      if (
        (param.min !== undefined && value < param.min) ||
        (param.max !== undefined && value > param.max)
      ) {
        errors[param.key] = fmt(zh.catalog.paramRange, {
          label,
          min: String(param.min ?? '—'),
          max: String(param.max ?? '—'),
        });
      }
      continue;
    }

    if (param.type === 'boolean') continue;

    if (param.type === 'enum') {
      const text = raw === null || raw === undefined ? '' : String(raw);
      if (!text) {
        if (required) errors[param.key] = fmt(zh.catalog.paramRequired, { label });
        continue;
      }
      if (param.options && !param.options.some((opt) => opt.value === text)) {
        errors[param.key] = fmt(zh.catalog.paramPattern, { label });
      }
      continue;
    }

    const text = raw === null || raw === undefined ? '' : String(raw);
    if (!text && required) {
      errors[param.key] = fmt(zh.catalog.paramRequired, { label });
      continue;
    }
    if (param.maxLength !== undefined && text.length > param.maxLength) {
      errors[param.key] = fmt(zh.catalog.paramMaxLength, {
        label,
        max: String(param.maxLength),
      });
      continue;
    }
    if (param.pattern) {
      let pattern: RegExp | null = null;
      try {
        pattern = new RegExp(`^(?:${param.pattern})$`);
      } catch {
        pattern = null;
      }
      if (pattern && text && !pattern.test(text)) {
        errors[param.key] = fmt(zh.catalog.paramPattern, { label });
      }
    }
  }
  return errors;
}

/** 证书 SAN 是否匹配目标域名（支持单级通配符 *.example.com）。 */
export function certMatchesDomain(domains: readonly string[], target: string): boolean {
  const host = target.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return domains.some((raw) => {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!pattern) return false;
    if (pattern === host) return true;
    if (!pattern.startsWith('*.')) return false;
    const base = pattern.slice(2);
    if (!base || !host.endsWith(`.${base}`)) return false;
    const prefix = host.slice(0, host.length - base.length - 1);
    return prefix.length > 0 && !prefix.includes('.');
  });
}

/** installedAt / upgradedAt / checkedAt 是 ISO 字符串。 */
export function installedTime(value?: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatAbsoluteTime(Math.floor(ms / 1000));
}

function collectHookStringValues(val: unknown, out: string[]): void {
  if (typeof val === 'string') {
    out.push(val);
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) collectHookStringValues(item, out);
    return;
  }
  if (val && typeof val === 'object') {
    for (const v of Object.values(val)) collectHookStringValues(v, out);
  }
}

/** 从 hooks 中推导引用指定凭据的主机列表（用于凭据配置表单默认 allowHosts）。 */
export function suggestedAllowHostsForSecret(
  def: AppManifestDefinitionV2,
  secretName: string,
): string[] {
  const hosts = new Set<string>();
  const needle = new RegExp(`\\{\\{\\s*secret\\.${secretName}\\s*\\}\\}`);
  const stages = [def.hooks?.preInstall, def.hooks?.preUpgrade, def.hooks?.preUninstall];
  for (const step of stages) {
    if (!step) continue;
    const texts: string[] = [];
    collectHookStringValues(step.headers, texts);
    collectHookStringValues(step.body, texts);
    if (texts.some((t) => needle.test(t))) {
      try {
        hosts.add(new URL(step.url).hostname.toLowerCase());
      } catch {
        // ignore invalid url
      }
    }
  }
  return Array.from(hosts);
}
