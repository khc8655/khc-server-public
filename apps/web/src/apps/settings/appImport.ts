/**
 * 应用库导入（设置 → 应用管理 → 导入应用）的纯逻辑：解析、浏览器端拉取、与 D1 现有版本的差异。
 *
 * - 全程在浏览器完成，不新增 Worker 接口：URL 由浏览器 fetch，避免 Worker 获得任意出站能力（SSRF）。
 * - 清单字段只经 `@khc/contracts` 校验，这里不维护第二份字段表，也不认识任何具体应用。
 */
import {
  appManifestAnyDefinitionSchema,
  appManifestDefinitionSchema,
  appManifestDefinitionV2Schema,
  toManifestV2,
  type AppManifest,
  type AppManifestAnyDefinition,
  type AppManifestDefinitionV2,
} from '@khc/contracts';

export const MAX_IMPORT_BYTES = 512 * 1024;
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

export const importText = {
  tooLarge: '内容超过 512KB，已拒绝',
  notHttps: '只允许 https:// 地址',
  hasCredentials: '地址里不能带用户名或口令',
  badUrl: '地址格式不正确',
  crossOrigin: '该地址不允许跨域读取，请下载后用文件导入（地址发生重定向时也会被拒绝）',
  badJson: 'JSON 解析失败，请检查格式',
  badId: '应用 ID 必须是小写字母开头的 slug（小写字母、数字、连字符，≤48）',
  needId: '这是一份裸清单，请填写应用 ID',
  notObject: '内容必须是 JSON 对象',
} as const;

export interface ImportIssue {
  /** 点分路径，如 `manifest.params.0.key`；整体错误用 `_` */
  path: string;
  message: string;
}

export type ParseImportResult =
  | { ok: true; id: string; enabled: boolean | undefined; manifest: AppManifestAnyDefinition }
  | { ok: false; error: string; issues: ImportIssue[] };

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function fail(error: string, issues: ImportIssue[] = []): ParseImportResult {
  return { ok: false, error, issues };
}

/** 解析导入文本：仓库格式 `{id, enabled?, manifest}` 或裸清单（需要 idInput）。 */
export function parseImportText(text: string, idInput: string): ParseImportResult {
  if (utf8Bytes(text) > MAX_IMPORT_BYTES) return fail(importText.tooLarge);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(importText.badJson);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(importText.notObject);
  const obj = raw as Record<string, unknown>;

  // 仓库格式的特征：有 manifest 对象且没有清单自己的 scripts 字段
  const isRepoFormat =
    typeof obj.manifest === 'object' && obj.manifest !== null && !('scripts' in obj);
  const manifestRaw = isRepoFormat ? obj.manifest : obj;
  const embeddedId = isRepoFormat && typeof obj.id === 'string' ? obj.id.trim() : '';
  const id = embeddedId || idInput.trim();
  if (!id) return fail(importText.needId);
  if (!APP_ID_RE.test(id) || id.length > 48) return fail(importText.badId);
  const enabled = isRepoFormat && typeof obj.enabled === 'boolean' ? obj.enabled : undefined;

  const parsed = appManifestAnyDefinitionSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    // 联合类型的 issue 是「两个分支都不匹配」，看不出哪个字段错：按 schema 字段选分支重新解析
    const branch =
      (manifestRaw as { schema?: unknown }).schema === 2
        ? appManifestDefinitionV2Schema
        : appManifestDefinitionSchema;
    const detail = branch.safeParse(manifestRaw);
    const issues = (detail.success ? parsed.error.issues : detail.error.issues).map((issue) => ({
      path: ['manifest', ...issue.path.map(String)].join('.'),
      message: issue.message,
    }));
    return fail('清单不符合格式', issues);
  }
  return { ok: true, id, enabled, manifest: parsed.data };
}

/** 浏览器端读取 URL 的失败，`message` 可直接展示。 */
export class ImportFetchError extends Error {}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 只允许无凭据的 https 地址；返回规范化后的 URL 字符串。 */
export function assertImportUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportFetchError(importText.badUrl);
  }
  if (url.protocol !== 'https:') throw new ImportFetchError(importText.notHttps);
  if (url.username || url.password) throw new ImportFetchError(importText.hasCredentials);
  return url.toString();
}

/** 读取响应正文，超过上限立即中止（不依赖 content-length 的真实性）。 */
async function readLimited(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    throw new ImportFetchError(importText.tooLarge);
  }
  if (!res.body) {
    const text = await res.text();
    if (utf8Bytes(text) > MAX_IMPORT_BYTES) throw new ImportFetchError(importText.tooLarge);
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel();
      throw new ImportFetchError(importText.tooLarge);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * 浏览器端拉取清单文本：`credentials: 'omit'`（不带 Cookie）、`redirect: 'error'`（不跟随重定向）。
 * 跨域被拒与重定向在浏览器里都表现为 TypeError，统一提示改用文件导入。
 */
export async function fetchImportUrl(
  rawUrl: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<string> {
  const url = assertImportUrl(rawUrl);
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'omit', redirect: 'error' });
  } catch {
    throw new ImportFetchError(importText.crossOrigin);
  }
  if (!res.ok) throw new ImportFetchError(`拉取失败：HTTP ${res.status}`);
  try {
    return await readLimited(res);
  } catch (error) {
    if (error instanceof ImportFetchError) throw error;
    throw new ImportFetchError(importText.crossOrigin);
  }
}

// ---------------------------------------------------------------------------
// 差异
// ---------------------------------------------------------------------------

export type DiffTone = 'neutral' | 'info' | 'warn' | 'danger';

export interface DiffItem {
  /** 稳定键，供测试与渲染使用 */
  key: string;
  label: string;
  before: string;
  after: string;
  tone: DiffTone;
}

export interface ManifestDiff {
  /** D1 里没有这个 ID：全部是新增 */
  isNew: boolean;
  /** 逐项变化；没有变化时为空 */
  changes: DiffItem[];
  /** 不随变化而变的概览（版本、脚本 sha256 等）：始终展示，供确认时对照 */
  summary: DiffItem[];
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : '—');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function modeLabel(def: AppManifestDefinitionV2): string {
  return def.runtime.mode === 'root' ? 'root' : `create（${def.runtime.user ?? '安装时填写'}）`;
}

function hookLines(def: AppManifestDefinitionV2): Map<string, string> {
  const map = new Map<string, string>();
  for (const stage of ['preInstall', 'preUpgrade', 'preUninstall'] as const) {
    const step = def.hooks?.[stage];
    if (!step) continue;
    let host = '—';
    try {
      host = new URL(step.url).host;
    } catch {
      /* 保存时 Worker 会拒绝非法 URL；这里只做展示 */
    }
    map.set(stage, `${step.method} ${host}`);
  }
  return map;
}

function sourceLine(src: { host: string; pinned: boolean }): string {
  return `${src.host}（${src.pinned ? '固定' : '动态'}）`;
}

/** 比较 D1 当前版本与待导入版本。`previous` 为空表示 ID 不存在或旧记录已损坏。 */
export function diffManifests(
  previous: AppManifestAnyDefinition | undefined,
  next: AppManifestAnyDefinition,
): ManifestDiff {
  const n = toManifestV2(next);
  const p = previous ? toManifestV2(previous) : undefined;
  const pSchema = previous ? ('schema' in previous && previous.schema === 2 ? 2 : 1) : undefined;
  const nSchema = 'schema' in next && next.schema === 2 ? 2 : 1;

  const summary: DiffItem[] = [
    {
      key: 'version',
      label: '版本',
      before: p?.version ?? '—',
      after: n.version,
      tone: p && p.version !== n.version ? 'info' : 'neutral',
    },
  ];
  const changes: DiffItem[] = [];
  const push = (item: DiffItem) => changes.push(item);

  if (p && p.version !== n.version) {
    push({ key: 'version', label: '版本', before: p.version, after: n.version, tone: 'info' });
  }
  if (p && pSchema !== nSchema) {
    push({
      key: 'schema',
      label: '清单格式',
      before: `v${pSchema}`,
      after: `v${nSchema}`,
      tone: 'info',
    });
  }

  for (const action of ['install', 'uninstall', 'upgrade'] as const) {
    const before = p?.sha256[action];
    const after = n.sha256[action];
    summary.push({
      key: `sha256.${action}`,
      label: `${action} 脚本 sha256`,
      before: short(before),
      after: short(after),
      tone: before !== after ? 'warn' : 'neutral',
    });
    if (p && before !== after) {
      push({
        key: `sha256.${action}`,
        label: `${action} 脚本 sha256`,
        before: before ? short(before) : '无',
        after: after ? short(after) : '无',
        tone: 'warn',
      });
    }
  }

  if (p) {
    // 运行方式：create → root 是权限提升，danger
    if (p.runtime.mode !== n.runtime.mode || p.runtime.user !== n.runtime.user) {
      push({
        key: 'runtime.mode',
        label: '运行方式',
        before: modeLabel(p),
        after: modeLabel(n),
        tone: p.runtime.mode === 'create' && n.runtime.mode === 'root' ? 'danger' : 'warn',
      });
    }

    const pParams = new Map(p.params.map((x) => [x.key, x]));
    const nParams = new Map(n.params.map((x) => [x.key, x]));
    for (const [key, spec] of nParams) {
      const old = pParams.get(key);
      if (!old) {
        push({ key: `params.${key}`, label: `参数 ${key}`, before: '无', after: '新增', tone: 'info' });
      } else if (stable(old) !== stable(spec)) {
        push({ key: `params.${key}`, label: `参数 ${key}`, before: '旧定义', after: '已修改', tone: 'info' });
      }
    }
    for (const key of pParams.keys()) {
      if (!nParams.has(key)) {
        push({ key: `params.${key}`, label: `参数 ${key}`, before: '有', after: '删除', tone: 'warn' });
      }
    }

    const pHooks = hookLines(p);
    const nHooks = hookLines(n);
    for (const stage of new Set([...pHooks.keys(), ...nHooks.keys()])) {
      const before = pHooks.get(stage);
      const after = nHooks.get(stage);
      const sameStep = stable(p.hooks?.[stage as 'preInstall']) === stable(n.hooks?.[stage as 'preInstall']);
      if (before === after && sameStep) continue;
      push({
        key: `hooks.${stage}`,
        label: `控制面步骤 ${stage}`,
        before: before ?? '无',
        after: after ?? '无',
        tone: 'warn',
      });
    }

    const pSources = new Set((p.sources ?? []).map(sourceLine));
    const nSources = new Set((n.sources ?? []).map(sourceLine));
    for (const line of nSources) {
      if (!pSources.has(line)) {
        push({ key: `sources.${line}`, label: '外部来源', before: '无', after: line, tone: 'warn' });
      }
    }
    for (const line of pSources) {
      if (!nSources.has(line)) {
        push({ key: `sources.${line}`, label: '外部来源', before: line, after: '移除', tone: 'info' });
      }
    }

    const pSecrets = new Set((p.secrets ?? []).map((s) => s.name));
    const nSecrets = new Set((n.secrets ?? []).map((s) => s.name));
    for (const name of nSecrets) {
      if (!pSecrets.has(name)) {
        push({ key: `secrets.${name}`, label: '凭据声明', before: '无', after: name, tone: 'warn' });
      }
    }
    for (const name of pSecrets) {
      if (!nSecrets.has(name)) {
        push({ key: `secrets.${name}`, label: '凭据声明', before: name, after: '移除', tone: 'info' });
      }
    }
  }

  // 概览：新增时用来看清「即将写入什么」，更新时用来对照
  const join = (items: string[]) => (items.length > 0 ? items.join('、') : '无');
  const overview = (def: AppManifestDefinitionV2 | undefined) => ({
    runtime: def ? modeLabel(def) : '—',
    params: def ? join(def.params.map((x) => x.key)) : '—',
    hooks: def ? join(Array.from(hookLines(def), ([stage, line]) => `${stage} ${line}`)) : '—',
    sources: def ? join((def.sources ?? []).map(sourceLine)) : '—',
    secrets: def ? join((def.secrets ?? []).map((x) => x.name)) : '—',
  });
  const before = overview(p);
  const after = overview(n);
  const rows: Array<[keyof typeof after, string]> = [
    ['runtime', '运行方式'],
    ['params', '参数'],
    ['hooks', '控制面步骤'],
    ['sources', '外部来源'],
    ['secrets', '凭据声明'],
  ];
  for (const [key, label] of rows) {
    summary.push({
      key: `overview.${key}`,
      label,
      before: before[key],
      after: after[key],
      tone: p && before[key] !== after[key] ? 'info' : 'neutral',
    });
  }

  return { isNew: !p, changes, summary };
}

/** 用于定位「ID 已存在」的记录；损坏的旧记录（无 manifest）也算存在。 */
export function findExisting(rows: AppManifest[], id: string): AppManifest | null {
  return rows.find((item) => item.id === id) ?? null;
}
