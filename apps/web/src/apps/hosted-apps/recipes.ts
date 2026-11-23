/**
 * 应用清单 → 面板可用的「recipe」视图（设置 → 应用管理与节点 → 应用共用）。
 *
 * 这里只做纯函数：把 D1 里的清单定义摊平成表单要的字段、把参数校验对齐 Agent 侧
 * （`agent/khc/recipes.py`：必填、整数、范围、长度、pattern），以及解析任务结果里的
 * access 卡片。安装/发布这些带副作用的动作不在这里。
 */
import {
  toManifestV2,
  type AgentEnvelope,
  type AppManifest,
  type AppManifestDefinition,
  type TaskResponse,
} from '@khc/contracts';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';

/** 节点已安装应用缓存键：向导与「已安装的托管应用」卡共用，确保安装/卸载后即时刷新。 */
export function hostedAppsInstalledQueryKey(hubId: string) {
  return ['hubs', hubId, 'app-catalog', 'installed'] as const;
}

/**
 * 解析 `app-catalog/recipe_installed` 响应：
 * 真实 Agent 将 `installed` 放在信封顶层（与 `recipes`/`cards` 同级），兼容旧 mock 放 `result.installed`。
 */
export function parseInstalledRecipes(envelope: AgentEnvelope): Record<string, InstalledEntry> {
  const topLevel = (envelope as unknown as { installed?: unknown }).installed;
  if (topLevel && typeof topLevel === 'object' && !Array.isArray(topLevel)) {
    return topLevel as Record<string, InstalledEntry>;
  }
  const nested = (envelope.result as { installed?: unknown } | undefined)?.installed;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, InstalledEntry>;
  }
  return {};
}

export interface RecipeParam {
  key: string;
  label?: string;
  type: 'string' | 'integer' | 'boolean';
  default?: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  secret?: boolean;
}

export interface CatalogRecipe {
  id: string;
  name: string;
  version: string;
  description: string;
  requiresRoot: boolean;
  params: RecipeParam[];
  access: unknown;
  runtimeMode: 'root' | 'create';
  runtimeUser?: string;
  /** 归一化后的清单视图：endpoints[0] 映射到 publish，兼容既有发布向导 */
  manifest: AppManifestDefinition;
}

export interface AccessItem {
  label: string;
  value: string;
  kind?: string;
  secret?: boolean;
  copy?: boolean;
}

export interface InstalledEntry {
  version?: string;
  installedAt?: string;
  accessCount?: number;
}

/** 列表与卡片里的运行身份文案；旧值 shared 按「新建用户」显示。 */
export function runtimeLabel(runtime: { mode: string; user?: string }): string {
  if (runtime.mode === 'root') return zh.catalog.runtimeRootShort;
  return runtime.user
    ? fmt(zh.catalog.runtimeCreateShort, { user: runtime.user })
    : zh.catalog.runtimeCreate;
}

export function toCatalogRecipe(item: AppManifest): CatalogRecipe {
  if (!item.manifest) {
    return {
      id: item.id,
      name: item.id,
      version: '—',
      description: item.error ?? '清单格式异常',
      requiresRoot: false,
      runtimeMode: 'create',
      manifest: {
        name: item.id,
        version: '0.0.0',
        runtime: { mode: 'create', linger: true },
        params: [],
        scripts: { install: '', uninstall: '' },
        sha256: { install: '', uninstall: '' },
        writes: [],
      },
      params: [],
      access: [],
    };
  }
  const v2 = toManifestV2(item.manifest);
  const firstEndpoint = v2.endpoints?.find((ep) => ep.publish === 'caddy') ?? v2.endpoints?.[0];
  const publish = firstEndpoint
    ? {
        ...(firstEndpoint.portParam !== undefined ? { portParam: firstEndpoint.portParam } : {}),
        ...(firstEndpoint.port !== undefined ? { port: firstEndpoint.port } : {}),
        host: firstEndpoint.bind === 'any' ? '0.0.0.0' : '127.0.0.1',
        label: firstEndpoint.label,
      }
    : undefined;
  const legacyLikeManifest: AppManifestDefinition = {
    name: v2.name,
    version: v2.version,
    runtime: v2.runtime,
    params: v2.params.map((p) => ({
      key: p.key,
      type: p.type === 'enum' ? 'string' : p.type,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
      ...(p.pattern !== undefined ? { pattern: p.pattern } : {}),
      ...(p.secret !== undefined ? { secret: p.secret } : {}),
    })),
    scripts: { install: v2.scripts.install, uninstall: v2.scripts.uninstall },
    sha256: { install: v2.sha256.install, uninstall: v2.sha256.uninstall },
    writes: v2.writes,
    ...(publish ? { publish } : {}),
  };
  return {
    id: item.id,
    name: v2.name,
    version: v2.version,
    description: runtimeLabel(v2.runtime),
    requiresRoot: false,
    runtimeMode: v2.runtime.mode,
    runtimeUser: v2.runtime.user,
    manifest: legacyLikeManifest,
    params: v2.params.map((param) => ({
      key: param.key,
      label: param.label,
      type: param.type === 'enum' ? 'string' : param.type,
      default: param.default,
      required: param.default === undefined,
      min: param.min,
      max: param.max,
      maxLength: param.maxLength,
      pattern: param.pattern,
      secret: param.secret,
    })),
    access: [],
  };
}

export function defaultValues(recipe: CatalogRecipe): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of recipe.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }
  return values;
}

/** 清单声明的本机端口（取参数默认值、当前填值或固定 port）。 */
export function declaredPort(
  recipe: CatalogRecipe,
  values?: Record<string, unknown>,
): number | null {
  const decl = recipe.manifest.publish;
  if (!decl) return null;
  const paramDefault = decl.portParam
    ? recipe.params.find((param) => param.key === decl.portParam)?.default
    : decl.port;
  const raw = decl.portParam && values && values[decl.portParam] !== undefined
    ? values[decl.portParam]
    : paramDefault;
  const port = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
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

/** recipe 的 installedAt 是 ISO 字符串（Agent 侧 datetime.isoformat）。 */
export function installedTime(value?: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatAbsoluteTime(Math.floor(ms / 1000));
}

/** 任务结果里的 access 卡片（登录链接、Key、端口），只展示不落库。 */
export function taskAccess(task: TaskResponse | null): AccessItem[] {
  const result = task?.task.result as { access?: unknown } | null | undefined;
  if (!Array.isArray(result?.access)) return [];
  return result.access.filter(
    (item): item is AccessItem =>
      Boolean(item) && typeof item === 'object' && typeof (item as AccessItem).label === 'string',
  );
}

/** 与 Agent 侧 recipe 参数校验对齐：必填、整数、范围、长度、pattern（fullmatch 语义）。 */
export function validateValues(
  recipe: CatalogRecipe,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const param of recipe.params) {
    const label = param.label ?? param.key;
    const raw = values[param.key];
    if (param.type === 'integer') {
      if (raw === null || raw === undefined || raw === '') {
        if (param.required) errors[param.key] = fmt(zh.catalog.paramRequired, { label });
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
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (!text && param.required) {
      errors[param.key] = fmt(zh.catalog.paramRequired, { label });
      continue;
    }
    if (param.maxLength !== undefined && text.length > param.maxLength) {
      errors[param.key] = fmt(zh.catalog.paramMaxLength, { label, max: String(param.maxLength) });
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
