import { manifestActionParamsSchema } from '@khc/contracts';
import type { AppManifestDefinition } from '@khc/contracts';
import type { AppDeps } from '../types';
import { badRequest, notFound } from './errors';

/**
 * 写入时校验脚本正文与声明的 sha256 是否一致。
 * Worker 侧先挡一次，让填错哈希的人在保存时就看到错误；节点侧落盘前再校一次。
 */
export async function assertManifestSha256(
  manifest: AppManifestDefinition,
): Promise<void> {
  for (const action of ['install', 'uninstall'] as const) {
    const actual = await sha256Hex(manifest.scripts[action]);
    if (actual !== manifest.sha256[action]) {
      throw badRequest(
        `${action} 脚本与 sha256 不一致（expected=${manifest.sha256[action]} actual=${actual}）`,
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
  if (!record.enabled) throw badRequest('该应用已停用，不能发起安装');

  // 运行身份以安装时的选择为准，未选则用 manifest 的默认值；显式转发给节点。
  // 凭据只在「新建用户」模式下允许，且必须成对。密码绝不写 D1、审计或日志，
  // 这里只在内存里随请求转发给节点，用完即弃。
  // 校验口径：明确选了就用选的，否则用 manifest 默认值。D1 里的旧定义可能仍是
  // shared：只有明确写 root 才算 root，其余一律 create。
  // 只转发明确选择的身份：没选时由节点决定（安装用默认值，卸载用安装时的记录）。
  const explicitMode = parsed.data.runtimeMode;
  const runtimeMode =
    explicitMode ?? (record.manifest.runtime.mode === 'root' ? 'root' : 'create');
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
