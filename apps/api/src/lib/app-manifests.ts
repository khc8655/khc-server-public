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

  const { manifestId: _manifestId, ...rest } = params;
  return {
    ...rest,
    manifest: record.manifest,
    manifestId: parsed.data.manifestId,
    ...(parsed.data.instance ? { instance: parsed.data.instance } : {}),
  };
}
