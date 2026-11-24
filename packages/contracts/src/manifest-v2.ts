import { z } from 'zod';
import type { AppManifestDefinition } from './index';

// ---------------------------------------------------------------------------
// 模板语法（Worker 与 Agent 必须一致）
// ---------------------------------------------------------------------------

export const MANIFEST_TEMPLATE_VAR_REGEX =
  /\{\{\s*(node\.(?:id|name)|instance|params\.[a-z][a-z0-9_]*|secret\.[a-z][a-z0-9_]*|facts\.[a-z][a-z0-9_]*)\s*\}\}/g;

const SINGLE_VAR_RE =
  /^(node\.(?:id|name)|instance|params\.[a-z][a-z0-9_]*|secret\.[a-z][a-z0-9_]*|facts\.[a-z][a-z0-9_]*)$/;

export type TemplateRenderErrorCode = 'template_invalid_syntax' | 'template_missing_var';

export class TemplateRenderError extends Error {
  readonly code: TemplateRenderErrorCode;
  readonly variable?: string;

  constructor(code: TemplateRenderErrorCode, message: string, variable?: string) {
    super(message);
    this.name = 'TemplateRenderError';
    this.code = code;
    if (variable !== undefined) {
      this.variable = variable;
    }
  }
}

interface TemplateToken {
  start: number;
  end: number;
  name: string;
}

function scanTemplateTokens(text: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('{{', pos);
    const close = text.indexOf('}}', pos);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      throw new TemplateRenderError('template_invalid_syntax', '模板存在未匹配的结束符 `}}`');
    }
    const end = text.indexOf('}}', open + 2);
    if (end === -1) {
      throw new TemplateRenderError('template_invalid_syntax', '模板存在未闭合的 `{{`');
    }
    const inner = text.slice(open + 2, end).trim();
    if (!SINGLE_VAR_RE.test(inner)) {
      throw new TemplateRenderError(
        'template_invalid_syntax',
        `模板包含非法或未知变量：\`{{${inner}}}\``,
      );
    }
    tokens.push({ start: open, end: end + 2, name: inner });
    pos = end + 2;
  }
  return tokens;
}

/** 校验模板字符串语法合法；合法时返回 null，非法返回错误原因。 */
export function validateTemplateSyntax(text: string): string | null {
  try {
    scanTemplateTokens(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 列出模板字符串中去重后的全部合法变量名（出现顺序）；语法非法时抛 TemplateRenderError。 */
export function listTemplateVars(text: string): string[] {
  const seen = new Set<string>();
  for (const token of scanTemplateTokens(text)) {
    seen.add(token.name);
  }
  return Array.from(seen);
}

function lookupTemplateVar(vars: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(vars, name)) {
    return vars[name];
  }
  const dot = name.indexOf('.');
  if (dot <= 0) return undefined;
  const group = name.slice(0, dot);
  const key = name.slice(dot + 1);
  if (!Object.hasOwn(vars, group)) return undefined;
  const container = vars[group];
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return undefined;
  }
  const record = container as Record<string, unknown>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * 渲染模板字符串：支持平铺键（`"params.port"`）与嵌套对象（`{ params: { port: 80 } }`）。
 * 原样字符串替换不做转义；缺失或 null/undefined 抛出 `template_missing_var`（只带变量名）。
 */
export function renderTemplate(text: string, vars: Record<string, unknown>): string {
  const tokens = scanTemplateTokens(text);
  if (tokens.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    out += text.slice(cursor, token.start);
    const val = lookupTemplateVar(vars, token.name);
    if (val === undefined || val === null) {
      throw new TemplateRenderError(
        'template_missing_var',
        `模板缺少变量：${token.name}`,
        token.name,
      );
    }
    if (typeof val === 'object') {
      throw new TemplateRenderError(
        'template_missing_var',
        `模板变量值必须为标量：${token.name}`,
        token.name,
      );
    }
    out += String(val);
    cursor = token.end;
  }
  out += text.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// 公共常量与基础校验器
// ---------------------------------------------------------------------------

export const AGENT_MANIFEST_FEATURES = [
  'schema2',
  'upgrade',
  'units',
  'health.http',
  'health.tcp',
  'health.unit',
  'preflight',
  'hookEnv',
  'params.enum',
] as const;
export type AgentManifestFeature = (typeof AGENT_MANIFEST_FEATURES)[number];

const PARAM_KEY_RE = /^[a-z][a-z0-9_]*$/;
const SECRET_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ENDPOINT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ENUM_VALUE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const UNIT_NAME_RESOLVED_RE = /^[a-z0-9][a-z0-9@._-]{0,62}$/;
const DERIVE_RE = /^endpoint:([a-z][a-z0-9-]{0,31})\.publicUrl$/;
const HEALTH_PORT_PARAM_RE = /^\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}$/;
const HOSTNAME_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** RFC 6901 JSON Pointer，禁用空串（禁止直接引用根节点） */
const JSON_POINTER_RE = /^(?:\/(?:[^~]|~[01])*)+$/;
const BODY_MAX_BYTES = 8 * 1024;
const BODY_MAX_DEPTH = 4;

const sha256V2Schema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, 'sha256 必须是 64 位 hex')
  .transform((value) => value.toLowerCase());

const runtimeModeV2Schema = z.preprocess(
  (value) => (value === 'shared' ? 'create' : value),
  z.enum(['root', 'create']),
);

export const appManifestRuntimeV2Schema = z
  .object({
    mode: runtimeModeV2Schema.default('create'),
    user: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[a-z][a-z0-9_-]*$/, '运行用户必须是小写字母开头的 POSIX 用户名')
      .optional(),
    linger: z.boolean().default(true),
  })
  .strict();
export type AppManifestRuntimeV2 = z.infer<typeof appManifestRuntimeV2Schema>;

export const appManifestHostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(HOSTNAME_RE, '主机名格式不正确（不含协议、端口与路径）')
  .transform((value) => value.toLowerCase());

// ---------------------------------------------------------------------------
// 应用凭据值（§6）
// ---------------------------------------------------------------------------

export const appSecretValueSchema = z
  .object({
    value: z.string().min(1).max(4096),
    allowHosts: z.array(appManifestHostnameSchema).min(1).max(8),
  })
  .strict();
export type AppSecretValue = z.infer<typeof appSecretValueSchema>;

export function appSecretKey(manifestId: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(manifestId)) {
    throw new Error(`非法 manifestId：${manifestId}`);
  }
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(`非法凭据名：${name}`);
  }
  return `app.${manifestId}.${name}`;
}

// ---------------------------------------------------------------------------
// v2 子结构 schema
// ---------------------------------------------------------------------------

export const appManifestParamOptionV2Schema = z
  .object({
    value: z.string().regex(ENUM_VALUE_RE, '选项值只允许字母/数字与 ._-'),
    label: z.string().trim().min(1).max(64),
    requires: z
      .object({
        memMB: z.number().int().min(1).max(65536).optional(),
        diskMB: z.number().int().min(1).max(1048576).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AppManifestParamOptionV2 = z.infer<typeof appManifestParamOptionV2Schema>;

export const appManifestParamV2Schema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(PARAM_KEY_RE, '参数名必须是小写字母开头'),
    type: z.enum(['string', 'integer', 'boolean', 'enum']),
    label: z.string().trim().min(1).max(64).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().max(256).optional(),
    secret: z.boolean().optional(),
    advanced: z.boolean().optional(),
    options: z.array(appManifestParamOptionV2Schema).min(2).max(16).optional(),
    derive: z
      .string()
      .regex(DERIVE_RE, 'derive 格式须为 endpoint:<id>.publicUrl')
      .optional(),
  })
  .strict();
export type AppManifestParamV2 = z.infer<typeof appManifestParamV2Schema>;

export const appManifestRequirementsV2Schema = z
  .object({
    arch: z.array(z.enum(['amd64', 'arm64'])).min(1).max(2).optional(),
    os: z.array(z.enum(['debian', 'ubuntu', 'rhel'])).min(1).max(3).optional(),
    memMB: z.number().int().min(1).max(65536).optional(),
    diskMB: z.number().int().min(1).max(1048576).optional(),
    commands: z
      .array(z.string().regex(COMMAND_NAME_RE, '命令名格式不合法'))
      .max(16)
      .optional(),
  })
  .strict();
export type AppManifestRequirementsV2 = z.infer<typeof appManifestRequirementsV2Schema>;

export const appManifestSecretDeclV2Schema = z
  .object({
    name: z.string().regex(SECRET_NAME_RE, '凭据名必须是小写字母开头的标识符'),
    label: z.string().trim().min(1).max(64),
    hint: z.string().trim().max(200).optional(),
  })
  .strict();
export type AppManifestSecretDeclV2 = z.infer<typeof appManifestSecretDeclV2Schema>;

export const appManifestHookStepV2Schema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    url: z.string().min(1).max(512),
    headers: z
      .record(
        z.string().regex(HTTP_HEADER_NAME_RE, '请求头名称格式不合法'),
        z.string().max(1024),
      )
      .refine((obj) => Object.keys(obj).length <= 8, 'headers 最多 8 项')
      .optional(),
    body: z.unknown().optional(),
    extract: z
      .record(
        z.string().regex(SECRET_NAME_RE, '提取键必须是小写字母开头的标识符'),
        z
          .string()
          .min(1)
          .max(128)
          .regex(JSON_POINTER_RE, '必须是有效的非根 RFC 6901 JSON Pointer'),
      )
      .refine((obj) => Object.keys(obj).length <= 8, 'extract 最多 8 项')
      .optional(),
    public: z.array(z.string().regex(SECRET_NAME_RE)).max(8).optional(),
    expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(16).optional(),
  })
  .strict();
export type AppManifestHookStepV2 = z.infer<typeof appManifestHookStepV2Schema>;

export const appManifestHooksV2Schema = z
  .object({
    preInstall: appManifestHookStepV2Schema.optional(),
    preUpgrade: appManifestHookStepV2Schema.optional(),
    preUninstall: appManifestHookStepV2Schema.optional(),
  })
  .strict();
export type AppManifestHooksV2 = z.infer<typeof appManifestHooksV2Schema>;

export const appManifestScriptsV2Schema = z
  .object({
    install: z.string().min(1).max(64 * 1024),
    uninstall: z.string().min(1).max(64 * 1024),
    upgrade: z.string().min(1).max(64 * 1024).optional(),
  })
  .strict();
export type AppManifestScriptsV2 = z.infer<typeof appManifestScriptsV2Schema>;

export const appManifestSha256V2Schema = z
  .object({
    install: sha256V2Schema,
    uninstall: sha256V2Schema,
    upgrade: sha256V2Schema.optional(),
  })
  .strict();
export type AppManifestSha256V2 = z.infer<typeof appManifestSha256V2Schema>;

export const appManifestUnitV2Schema = z
  .object({
    name: z.string().min(1).max(128),
    scope: z.enum(['system', 'user']),
  })
  .strict();
export type AppManifestUnitV2 = z.infer<typeof appManifestUnitV2Schema>;

const healthHttpSchema = z
  .object({
    type: z.literal('http'),
    url: z.string().min(1).max(512),
    expectStatus: z.number().int().min(100).max(599).default(200),
    versionPointer: z
      .string()
      .min(1)
      .max(128)
      .regex(JSON_POINTER_RE, '必须是有效的非根 RFC 6901 JSON Pointer')
      .optional(),
    graceSec: z.number().int().min(0).max(600).default(60),
    intervalSec: z.number().int().min(1).max(30).default(3),
    timeoutMs: z.number().int().min(100).max(5000).default(1000),
  })
  .strict();

const healthTcpSchema = z
  .object({
    type: z.literal('tcp'),
    port: z.number().int().min(1).max(65535).optional(),
    portParam: z.string().regex(PARAM_KEY_RE, '参数名必须是小写字母开头').optional(),
    graceSec: z.number().int().min(0).max(600).default(60),
    intervalSec: z.number().int().min(1).max(30).default(3),
    timeoutMs: z.number().int().min(100).max(5000).default(1000),
  })
  .strict();

const healthUnitSchema = z
  .object({
    type: z.literal('unit'),
    graceSec: z.number().int().min(0).max(600).default(60),
    intervalSec: z.number().int().min(1).max(30).default(3),
  })
  .strict();

export const appManifestHealthV2Schema = z.discriminatedUnion('type', [
  healthHttpSchema,
  healthTcpSchema,
  healthUnitSchema,
]);
export type AppManifestHealthV2 = z.infer<typeof appManifestHealthV2Schema>;

export const appManifestEndpointAuthV2Schema = z
  .object({
    type: z.enum(['none', 'key-in-url', 'bearer', 'basic']),
    hint: z.string().trim().max(200).optional(),
  })
  .strict();

export const appManifestEndpointV2Schema = z
  .object({
    id: z.string().regex(ENDPOINT_ID_RE, '端点 id 必须是小写字母开头的 slug'),
    label: z.string().trim().min(1).max(64),
    protocol: z.enum(['http', 'tcp']),
    port: z.number().int().min(1).max(65535).optional(),
    portParam: z.string().regex(PARAM_KEY_RE, '参数名必须是小写字母开头').optional(),
    bind: z.enum(['loopback', 'any']).default('loopback'),
    paths: z
      .array(z.string().min(1).max(128).regex(/^\//, '路径必须以 / 开头'))
      .max(8)
      .optional(),
    publish: z.enum(['caddy', 'direct', 'none']).optional(),
    auth: appManifestEndpointAuthV2Schema.optional(),
  })
  .strict()
  .transform((endpoint) => ({
    ...endpoint,
    publish: endpoint.publish ?? (endpoint.protocol === 'http' ? 'caddy' : 'none'),
  }));
export type AppManifestEndpointV2 = z.infer<typeof appManifestEndpointV2Schema>;

export const appManifestSourceV2Schema = z
  .object({
    host: appManifestHostnameSchema,
    purpose: z.string().trim().min(1).max(120),
    pinned: z.boolean(),
  })
  .strict();
export type AppManifestSourceV2 = z.infer<typeof appManifestSourceV2Schema>;

// ---------------------------------------------------------------------------
// 交叉校验辅助函数
// ---------------------------------------------------------------------------

function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isValidPortString(raw: string): boolean {
  if (!/^\d{1,5}$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1 && n <= 65535;
}

function isValidHookAuthority(authority: string): boolean {
  if (!authority || authority.includes('@') || /[\s\\]/.test(authority)) return false;
  const colonIdx = authority.lastIndexOf(':');
  let host = authority;
  if (colonIdx !== -1 && !authority.endsWith(']')) {
    host = authority.slice(0, colonIdx);
    const portStr = authority.slice(colonIdx + 1);
    if (!isValidPortString(portStr)) return false;
  }
  return HOSTNAME_RE.test(host);
}

function addIssue(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  ctx.addIssue({
    code: 'custom',
    path,
    message,
  });
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function inspectJsonBody(
  value: unknown,
  depth: number,
  leafStrings: Array<{ text: string; path: Array<string | number> }>,
  path: Array<string | number>,
): string | null {
  if (depth > BODY_MAX_DEPTH) {
    return `hook body 嵌套深度超过上限 ${BODY_MAX_DEPTH}`;
  }
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : 'hook body 包含非法数字';
  }
  if (typeof value === 'string') {
    leafStrings.push({ text: value, path });
    return null;
  }
  if (Array.isArray(value)) {
    const nextDepth = depth + 1;
    if (nextDepth > BODY_MAX_DEPTH) {
      return `hook body 嵌套深度超过上限 ${BODY_MAX_DEPTH}`;
    }
    for (let i = 0; i < value.length; i += 1) {
      const err = inspectJsonBody(value[i], nextDepth, leafStrings, [...path, i]);
      if (err) return err;
    }
    return null;
  }
  if (isPlainJsonObject(value)) {
    const nextDepth = depth + 1;
    if (nextDepth > BODY_MAX_DEPTH) {
      return `hook body 嵌套深度超过上限 ${BODY_MAX_DEPTH}`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) return `hook body 字段 ${k} 不能为 undefined`;
      const err = inspectJsonBody(v, nextDepth, leafStrings, [...path, k]);
      if (err) return err;
    }
    return null;
  }
  return 'hook body 必须是合法 JSON 值';
}

type TemplateScope = 'hookPreInstall' | 'hookPost' | 'healthOrUnit';

function checkTemplateText(
  text: string,
  scope: TemplateScope,
  declaredSecrets: Set<string>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  opts: { allowSecret?: boolean } = {},
): void {
  let vars: string[];
  try {
    vars = listTemplateVars(text);
  } catch (err) {
    addIssue(ctx, path, err instanceof Error ? err.message : String(err));
    return;
  }

  for (const name of vars) {
    if (name.startsWith('node.')) {
      if (scope === 'healthOrUnit') {
        addIssue(ctx, path, `此处不允许使用变量 {{${name}}}`);
      }
      continue;
    }
    if (name === 'instance' || name.startsWith('params.')) {
      continue;
    }
    if (name.startsWith('secret.')) {
      if (!opts.allowSecret) {
        addIssue(ctx, path, `此处不允许引用凭据变量 {{${name}}}`);
        continue;
      }
      const secretName = name.slice('secret.'.length);
      if (!declaredSecrets.has(secretName)) {
        addIssue(ctx, path, `引用了未在 secrets[] 声明的凭据：${secretName}`);
      }
      continue;
    }
    if (name.startsWith('facts.')) {
      if (scope !== 'hookPost') {
        addIssue(ctx, path, `此处不允许使用变量 {{${name}}}`);
      }
      continue;
    }
    addIssue(ctx, path, `未知模板变量：${name}`);
  }
}

function validatePortBinding(
  port: number | undefined,
  portParam: string | undefined,
  paramMap: Map<string, AppManifestParamV2>,
  ctx: z.RefinementCtx,
  prefix: Array<string | number>,
): void {
  const hasPort = port !== undefined;
  const hasParam = portParam !== undefined;
  if (hasPort === hasParam) {
    addIssue(
      ctx,
      [...prefix, hasPort ? 'portParam' : 'port'],
      'port 与 portParam 必须且只能填写其中一个',
    );
    return;
  }
  if (hasParam) {
    const param = paramMap.get(portParam);
    if (!param || param.type !== 'integer') {
      addIssue(
        ctx,
        [...prefix, 'portParam'],
        `portParam 引用的参数 ${portParam} 必须存在且 type 为 integer`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 完整 v2 清单定义 schema（appManifestDefinitionV2Schema）
// ---------------------------------------------------------------------------

export const appManifestDefinitionV2Schema = z
  .object({
    schema: z.literal(2),
    name: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(32),
    runtime: appManifestRuntimeV2Schema,
    params: z.array(appManifestParamV2Schema).max(32).default([]),
    requires: appManifestRequirementsV2Schema.optional(),
    secrets: z.array(appManifestSecretDeclV2Schema).max(8).optional(),
    hooks: appManifestHooksV2Schema.optional(),
    scripts: appManifestScriptsV2Schema,
    sha256: appManifestSha256V2Schema,
    writes: z.array(z.string().min(1).max(256)).max(32).default([]),
    units: z.array(appManifestUnitV2Schema).max(4).optional(),
    health: appManifestHealthV2Schema.optional(),
    endpoints: z.array(appManifestEndpointV2Schema).max(8).optional(),
    sources: z.array(appManifestSourceV2Schema).max(8).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. sha256 键集合必须与 scripts 完全一致
    const hasScriptUpgrade = val.scripts.upgrade !== undefined;
    const hasShaUpgrade = val.sha256.upgrade !== undefined;
    if (hasScriptUpgrade !== hasShaUpgrade) {
      addIssue(
        ctx,
        ['sha256', 'upgrade'],
        hasScriptUpgrade
          ? '声明 scripts.upgrade 时必须提供 sha256.upgrade'
          : '未声明 scripts.upgrade 时不得提供 sha256.upgrade',
      );
    }

    const endpoints = val.endpoints ?? [];
    const endpointIds = new Set<string>();
    const paramMap = new Map<string, AppManifestParamV2>();

    // 5a. endpoint id 唯一 + publish: caddy 只允许 http
    for (let i = 0; i < endpoints.length; i += 1) {
      const ep = endpoints[i]!;
      if (endpointIds.has(ep.id)) {
        addIssue(ctx, ['endpoints', i, 'id'], `端点 id 重复：${ep.id}`);
      } else {
        endpointIds.add(ep.id);
      }
      if (ep.publish === 'caddy' && ep.protocol !== 'http') {
        addIssue(
          ctx,
          ['endpoints', i, 'publish'],
          'publish 为 caddy 时 protocol 必须是 http',
        );
      }
    }

    // 2 & 3. params 校验
    for (let i = 0; i < val.params.length; i += 1) {
      const param = val.params[i]!;
      paramMap.set(param.key, param);

      if (param.type === 'enum') {
        if (!param.options || param.options.length < 2) {
          addIssue(ctx, ['params', i, 'options'], 'enum 参数必须提供至少 2 个 options');
        } else if (
          param.default !== undefined &&
          (typeof param.default !== 'string' ||
            !param.options.some((opt) => opt.value === param.default))
        ) {
          addIssue(ctx, ['params', i, 'default'], 'enum 参数默认值必须是 options 中的某一项 value');
        }
      } else if (param.options !== undefined) {
        addIssue(ctx, ['params', i, 'options'], '非 enum 参数不得设置 options');
      }

      if (param.derive !== undefined) {
        if (param.type !== 'string') {
          addIssue(ctx, ['params', i, 'derive'], 'derive 仅允许用于 type 为 string 的参数');
        }
        if (param.secret === true) {
          addIssue(ctx, ['params', i, 'derive'], 'secret 参数不允许设置 derive');
        }
        const match = DERIVE_RE.exec(param.derive);
        if (!match || !endpointIds.has(match[1]!)) {
          addIssue(
            ctx,
            ['params', i, 'derive'],
            `derive 引用的端点不存在：${match?.[1] ?? param.derive}`,
          );
        }
      }
    }

    // 4. endpoint 与 health(tcp) 的 port / portParam 校验
    for (let i = 0; i < endpoints.length; i += 1) {
      const ep = endpoints[i]!;
      validatePortBinding(ep.port, ep.portParam, paramMap, ctx, ['endpoints', i]);
    }
    if (val.health?.type === 'tcp') {
      validatePortBinding(val.health.port, val.health.portParam, paramMap, ctx, ['health']);
    }

    // 6. units scope 与 runtime.mode 校验 + unit.name 模板校验
    const declaredSecrets = new Set((val.secrets ?? []).map((s) => s.name));
    if (val.units) {
      for (let i = 0; i < val.units.length; i += 1) {
        const unit = val.units[i]!;
        checkTemplateText(unit.name, 'healthOrUnit', declaredSecrets, ctx, ['units', i, 'name'], {
          allowSecret: false,
        });
        const resolved = unit.name.replace(MANIFEST_TEMPLATE_VAR_REGEX, 'x');
        if (!UNIT_NAME_RESOLVED_RE.test(resolved)) {
          addIssue(ctx, ['units', i, 'name'], 'unit 名称格式不合法');
        }
        if (unit.scope === 'system' && val.runtime.mode !== 'root') {
          addIssue(ctx, ['units', i, 'scope'], 'system unit 要求 runtime.mode 为 root');
        }
        if (unit.scope === 'user' && val.runtime.mode !== 'create') {
          addIssue(ctx, ['units', i, 'scope'], 'user unit 要求 runtime.mode 为 create');
        }
      }
    }

    // 9. health(http) 回环前缀与模板变量范围校验
    if (val.health?.type === 'http') {
      const url = val.health.url;
      checkTemplateText(url, 'healthOrUnit', declaredSecrets, ctx, ['health', 'url'], {
        allowSecret: false,
      });
      const validLoopbackPrefix =
        url.startsWith('http://127.0.0.1:') || url.startsWith('http://[::1]:');
      if (!validLoopbackPrefix) {
        addIssue(
          ctx,
          ['health', 'url'],
          'health.url 必须以 http://127.0.0.1: 或 http://[::1]: 开头',
        );
      } else {
        const prefixLen = url.startsWith('http://127.0.0.1:')
          ? 'http://127.0.0.1:'.length
          : 'http://[::1]:'.length;
        const afterPortPrefix = url.slice(prefixLen);
        const slashIdx = afterPortPrefix.search(/[/?#]/);
        const portPart = slashIdx === -1 ? afterPortPrefix : afterPortPrefix.slice(0, slashIdx);
        if (/[\s\\]/.test(url.replace(MANIFEST_TEMPLATE_VAR_REGEX, 'x'))) {
          addIssue(ctx, ['health', 'url'], 'health.url 不能包含空白或反斜杠');
        } else if (!isValidPortString(portPart)) {
          const portMatch = HEALTH_PORT_PARAM_RE.exec(portPart);
          if (!portMatch) {
            addIssue(
              ctx,
              ['health', 'url'],
              'health.url 端口位置只允许固定端口或单个 {{params.<key>}} 整型参数',
            );
          } else {
            const portParam = paramMap.get(portMatch[1]!);
            if (!portParam || portParam.type !== 'integer') {
              addIssue(
                ctx,
                ['health', 'url'],
                `health.url 端口参数 ${portMatch[1]} 必须存在且 type 为 integer`,
              );
            }
          }
        }
      }
    }

    // 7, 8, 10. hooks 校验
    if (val.hooks) {
      const stages = ['preInstall', 'preUpgrade', 'preUninstall'] as const;
      for (const stage of stages) {
        const hook = val.hooks[stage];
        if (!hook) continue;
        const scope: TemplateScope = stage === 'preInstall' ? 'hookPreInstall' : 'hookPost';

        // 10 & 7. hook url 必须 https:// 且主机含无模板、不可出现 secret.*
        checkTemplateText(hook.url, scope, declaredSecrets, ctx, ['hooks', stage, 'url'], {
          allowSecret: false,
        });
        if (!hook.url.startsWith('https://')) {
          addIssue(ctx, ['hooks', stage, 'url'], 'hook url 必须以 https:// 开头');
        } else {
          const afterScheme = hook.url.slice('https://'.length);
          const slashIdx = afterScheme.search(/[/?#]/);
          const authority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
          if (
            authority.length === 0 ||
            authority.includes('{{') ||
            authority.includes('}}') ||
            /[\s\\]/.test(hook.url.replace(MANIFEST_TEMPLATE_VAR_REGEX, 'val')) ||
            !isValidHookAuthority(authority)
          ) {
            addIssue(ctx, ['hooks', stage, 'url'], 'hook url 主机部分不合法或包含模板/@');
          }
        }

        // headers 模板校验（允许 secret.*）
        if (hook.headers) {
          for (const [headerName, headerVal] of Object.entries(hook.headers)) {
            checkTemplateText(
              headerVal,
              scope,
              declaredSecrets,
              ctx,
              ['hooks', stage, 'headers', headerName],
              { allowSecret: true },
            );
          }
        }

        // body JSON / 8KB / 深度 ≤ 4 / 叶子模板校验（允许 secret.*）
        if (hook.body !== undefined) {
          const leafStrings: Array<{ text: string; path: Array<string | number> }> = [];
          const bodyErr = inspectJsonBody(hook.body, 0, leafStrings, ['hooks', stage, 'body']);
          if (bodyErr) {
            addIssue(ctx, ['hooks', stage, 'body'], bodyErr);
          } else {
            let encodedLength = 0;
            try {
              const serialized = JSON.stringify(hook.body);
              encodedLength = serialized === undefined ? 0 : utf8ByteLength(serialized);
            } catch {
              addIssue(ctx, ['hooks', stage, 'body'], 'hook body 无法序列化为 JSON');
              encodedLength = BODY_MAX_BYTES + 1;
            }
            if (encodedLength > BODY_MAX_BYTES) {
              addIssue(
                ctx,
                ['hooks', stage, 'body'],
                `hook body 序列化长度超过上限 ${BODY_MAX_BYTES} 字节`,
              );
            }
            for (const leaf of leafStrings) {
              checkTemplateText(leaf.text, scope, declaredSecrets, ctx, leaf.path, {
                allowSecret: true,
              });
            }
          }
        }

        // 8. public 键必须在 extract 里
        if (hook.public) {
          const extractedKeys = new Set(Object.keys(hook.extract ?? {}));
          for (let i = 0; i < hook.public.length; i += 1) {
            const key = hook.public[i]!;
            if (!extractedKeys.has(key)) {
              addIssue(
                ctx,
                ['hooks', stage, 'public', i],
                `public 字段 ${key} 未在 extract 中声明`,
              );
            }
          }
        }
      }
    }
  });

export type AppManifestDefinitionV2Input = z.input<typeof appManifestDefinitionV2Schema>;
export type AppManifestDefinitionV2 = z.output<typeof appManifestDefinitionV2Schema>;

// ---------------------------------------------------------------------------
// v1 → v2 归一化（纯函数、不改输入）
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isV2Definition(
  def: AppManifestDefinition | AppManifestDefinitionV2Input | AppManifestDefinitionV2,
): def is AppManifestDefinitionV2Input | AppManifestDefinitionV2 {
  return (def as { schema?: unknown }).schema === 2;
}

/**
 * 将 v1 或 v2 清单归一化为 v2 结构（纯函数，绝不修改入参；v2 深拷贝后按 schema 归一化）。
 */
export function toManifestV2(
  def: AppManifestDefinition | AppManifestDefinitionV2Input | AppManifestDefinitionV2,
): AppManifestDefinitionV2 {
  if (isV2Definition(def)) {
    return appManifestDefinitionV2Schema.parse(deepClone(def));
  }

  const copy = deepClone(def);
  const endpoints: Array<z.input<typeof appManifestEndpointV2Schema>> = [];

  if (copy.publish) {
    const host = copy.publish.host ?? '127.0.0.1';
    const bind: 'loopback' | 'any' =
      host === '127.0.0.1' || host === '::1' || host === '[::1]' ? 'loopback' : 'any';
    const endpoint: z.input<typeof appManifestEndpointV2Schema> = {
      id: 'web',
      label: copy.publish.label ?? 'Web',
      protocol: 'http',
      bind,
      publish: 'caddy',
      // v1 publish 可同时写 portParam 与 port（优先 portParam）；v2 endpoint 只能二选一
      ...(copy.publish.portParam !== undefined
        ? { portParam: copy.publish.portParam }
        : copy.publish.port !== undefined
          ? { port: copy.publish.port }
          : {}),
    };
    endpoints.push(endpoint);
  }

  const params = (copy.params ?? []).map((param) => {
    const mapped: z.input<typeof appManifestParamV2Schema> = { ...param };
    if (copy.publish && param.key === 'public_url') {
      mapped.derive = 'endpoint:web.publicUrl';
    }
    return mapped;
  });

  const normalizedInput: AppManifestDefinitionV2Input = {
    schema: 2,
    name: copy.name,
    version: copy.version,
    runtime: {
      mode: copy.runtime.mode,
      ...(copy.runtime.user !== undefined ? { user: copy.runtime.user } : {}),
      linger: copy.runtime.linger ?? true,
    },
    params,
    scripts: {
      install: copy.scripts.install,
      uninstall: copy.scripts.uninstall,
    },
    sha256: {
      install: copy.sha256.install,
      uninstall: copy.sha256.uninstall,
    },
    writes: copy.writes ?? [],
    ...(endpoints.length > 0 ? { endpoints } : {}),
  };

  return appManifestDefinitionV2Schema.parse(normalizedInput);
}

// ---------------------------------------------------------------------------
// 所需能力推导（供 V2 版本协商）
// ---------------------------------------------------------------------------

/** 推导单个 v2 清单所需的 Agent 能力列表（去重且字典序排序）。 */
export function requiredAgentFeatures(defV2: AppManifestDefinitionV2): AgentManifestFeature[] {
  const features = new Set<AgentManifestFeature>(['schema2']);

  if (defV2.scripts.upgrade !== undefined || defV2.hooks?.preUpgrade !== undefined) {
    features.add('upgrade');
  }
  if (defV2.units && defV2.units.length > 0) {
    features.add('units');
  }
  if (defV2.health) {
    features.add(`health.${defV2.health.type}`);
  }
  if (defV2.requires) {
    features.add('preflight');
  }
  if (
    defV2.hooks &&
    (defV2.hooks.preInstall !== undefined ||
      defV2.hooks.preUpgrade !== undefined ||
      defV2.hooks.preUninstall !== undefined)
  ) {
    features.add('hookEnv');
  }
  if (defV2.params.some((param) => param.type === 'enum')) {
    features.add('params.enum');
  }

  return Array.from(features).sort();
}
