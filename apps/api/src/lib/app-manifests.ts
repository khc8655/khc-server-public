import { manifestActionParamsSchema, toManifestV2 } from '@khc/contracts';
import type { AppManifestAnyDefinition } from '@khc/contracts';
import type { AppDeps } from '../types';
import { AppError, badRequest, notFound } from './errors';

/**
 * 写入时校验全部脚本正文与声明的 sha256 是否一致（支持 v1 与 v2 optional upgrade）。
 * Worker 侧先挡一次，让填错哈希的人在保存时就看到错误；节点侧落盘前再校一次。
 */
export async function assertManifestSha256(
  manifest: AppManifestAnyDefinition,
): Promise<void> {
  const scripts = manifest.scripts as Record<string, string | undefined>;
  const hashes = manifest.sha256 as Record<string, string | undefined>;
  for (const [action, script] of Object.entries(scripts)) {
    if (typeof script !== 'string') continue;
    const expected = hashes[action]?.toLowerCase();
    const actual = await sha256Hex(script);
    if (!expected || actual !== expected) {
      throw badRequest(
        `${action} 脚本与 sha256 不一致（expected=${hashes[action] ?? ''} actual=${actual}）`,
      );
    }
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 浏览器不得直接传 manifest 正文，只能给 manifestId 由 Worker 从 D1 注入。 */
export function assertNoInlineManifest(params: Record<string, unknown>): void {
  if ('manifest' in params) {
    throw badRequest('不接受直接传入 manifest，请改用 manifestId');
  }
}

/**
 * 通用注入点：只要动作参数里带 manifestId，就从应用清单取出正文附上。
 *
 * 这里按 **字段** 识别，不判断 app 或 action 名字，因此路由层无需知道任何
 * 具体应用，符合核心冻结「路由里不得出现 app === '<应用名>' 判断」。
 */
export async function resolveManifestParams(
  deps: Pick<AppDeps, 'appManifests'>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertNoInlineManifest(params);
  if (!('manifestId' in params)) return params;

  const parsed = manifestActionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw badRequest(`manifestId 动作参数非法：${parsed.error.issues[0]?.message ?? '格式错误'}`);
  }
  const record = await deps.appManifests.get(parsed.data.manifestId);
  if (!record) throw notFound('应用不存在');
  if (record.invalid || !record.manifest) {
    throw new AppError(400, 'manifest_invalid', record.error ?? '应用清单格式不合法');
  }
  if (!record.enabled) throw badRequest('该应用已停用，不能发起安装');

  const v2 = toManifestV2(record.manifest);
  const explicitMode = parsed.data.runtimeMode;
  const runtimeMode =
    explicitMode ?? (v2.runtime.mode === 'root' ? 'root' : 'create');
  const hasUser = Boolean(parsed.data.runtimeUser);
  const hasPassword = Boolean(parsed.data.runtimePassword);
  if (runtimeMode === 'root' && (hasUser || hasPassword)) {
    throw badRequest('以 root 运行时不接受用户名和密码');
  }
  if (runtimeMode === 'create') {
    if (hasPassword && !hasUser) throw badRequest('填写密码时必须同时填写用户名');
    if (parsed.data.runtimeUser === 'root') {
      throw badRequest('不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」');
    }
  }

  const { manifestId: _manifestId, ...rest } = params;
  return {
    ...rest,
    manifest: record.manifest,
    manifestId: parsed.data.manifestId,
    ...(explicitMode ? { runtimeMode: explicitMode } : {}),
    ...(parsed.data.instance ? { instance: parsed.data.instance } : {}),
  };
}

/**
 * 应用脚本动作的审计摘要：记下运行身份（尤其是 root），不含密码与参数值。
 * 只认 resolveManifestParams 产出的字段，不认识任何具体应用。
 */
export function manifestAuditDetail(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof params.manifestId !== 'string') return null;
  const manifest = params.manifest as
    | { version?: unknown; runtime?: { mode?: unknown } }
    | undefined;
  const explicit = params.runtimeMode === 'root' || params.runtimeMode === 'create';
  return {
    manifestId: params.manifestId,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    instance: typeof params.instance === 'string' ? params.instance : params.manifestId,
    // null 表示请求没选，由节点决定（安装用 manifest 默认值，卸载沿用安装时的身份）。
    runtimeMode: explicit ? params.runtimeMode : null,
    manifestDefaultMode: manifest?.runtime?.mode === 'root' ? 'root' : 'create',
    runtimeUser:
      params.runtimeMode === 'root'
        ? 'root'
        : typeof params.runtimeUser === 'string'
          ? params.runtimeUser
          : null,
  };
}
