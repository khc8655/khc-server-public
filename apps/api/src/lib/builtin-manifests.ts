import { appManifestDefinitionSchema } from '@khc/contracts';
import type { AppDeps } from '../types';
import magpie from '../../../../apps/manifests/magpie/manifest.json';

/**
 * 内置应用清单：面板开箱即可安装，不需要主人手工粘 JSON。
 *
 * 单一事实来源仍然是 `apps/manifests/<id>/manifest.json`（脚本正文 + sha256 由
 * `scripts/verify-app-manifests.mjs` 校验，`--sync` 回填）。这里只是把它打包进 Worker，
 * 在应用目录读取时把 D1 记录对齐到仓内版本。
 *
 * 语义边界：
 * - **缺就补、旧就升**：仓内版本与 D1 不一致时更新，否则修了脚本（比如给下载加超时）
 *   上线后完全不起作用 —— 生产 D1 会一直执行上线前那份正文；
 * - **被主人改过就不动**：D1 记录若既不等于当前仓内版本、也不等于上一个内置版本
 *   （`priorManifests`），说明主人手工改过，保留其编辑，不悄悄冲掉；
 * - **不做删除**：把内置项从仓里删掉不会删 D1 里已有的记录。
 */
export interface BuiltinAppManifest {
  id: string;
  enabled: boolean;
  manifest: ReturnType<typeof appManifestDefinitionSchema.parse>;
  /** 上一个内置版本：用于识别「D1 里的是内置旧版」还是「主人手改过」。 */
  priorManifests?: unknown[];
}

function builtin(raw: unknown): BuiltinAppManifest {
  const parsed = raw as {
    id?: unknown;
    enabled?: unknown;
    manifest?: unknown;
    priorManifests?: unknown;
  };
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new Error('内置应用清单缺少 id');
  }
  // 解析一次：仓库里的 JSON 若与契约漂移，部署后第一次读应用目录就会当场报错，
  // 而不是把非法定义塞进 D1 让节点侧执行失败。
  return {
    id: parsed.id,
    enabled: parsed.enabled !== false,
    manifest: appManifestDefinitionSchema.parse(parsed.manifest),
    priorManifests: Array.isArray(parsed.priorManifests) ? parsed.priorManifests : [],
  };
}

export const BUILTIN_APP_MANIFESTS: BuiltinAppManifest[] = [builtin(magpie)];

/** 与内置版本等价？只比语义，不比密钥顺序。 */
function sameManifest(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 把 D1 里的内置清单对齐到仓内版本。
 *
 * - 没有 → 新建；
 * - 与仓内一致 → 不动；
 * - 等于任一 `priorManifests`（内置历史的某个版本）→ 视为「没人改过、只是没升级」，
 *   升级到仓内版本；
 * - 其它情况 → 认为被主人改过，保持原样（不覆盖别人的编辑）。
 */
export async function ensureBuiltinAppManifests(
  deps: Pick<AppDeps, 'appManifests'>,
): Promise<void> {
  for (const item of BUILTIN_APP_MANIFESTS) {
    const existing = await deps.appManifests.get(item.id);
    if (!existing) {
      try {
        await deps.appManifests.create({
          id: item.id,
          manifest: item.manifest,
          enabled: item.enabled,
        });
      } catch {
        // 并发下的唯一键冲突：另一请求已经补上了，按已存在处理，不影响列表读取。
      }
      continue;
    }
    if (!existing.manifest) continue;
    if (sameManifest(existing.manifest, item.manifest)) continue;
    const isBuiltinHistory = (item.priorManifests ?? []).some((prior) =>
      sameManifest(existing.manifest, prior),
    );
    if (!isBuiltinHistory) continue;
    try {
      await deps.appManifests.update(item.id, {
        manifest: item.manifest,
        enabled: item.enabled,
      });
    } catch {
      // 升级失败不阻断读取：下次请求还会再试一次。
    }
  }
}
