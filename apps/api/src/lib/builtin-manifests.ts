import { appManifestDefinitionSchema } from '@khc/contracts';
import type { AppDeps } from '../types';
import magpie from '../../../../apps/manifests/magpie/manifest.json';

/**
 * 内置应用清单：面板开箱即可安装，不需要主人手工粘 JSON。
 *
 * 单一事实来源仍然是 `apps/manifests/<id>/manifest.json`（脚本正文 + sha256 由
 * `scripts/verify-app-manifests.mjs` 校验，`--sync` 回填）。这里只是把它打包进 Worker，
 * 在应用目录首次读取时补一行 D1 记录 —— 不迁移、不覆盖。
 *
 * 语义边界：
 * - **只补缺，不覆盖**：D1 里已有同 id 的记录（主人手工导入过、或改过）一律不动，
 *   否则会把别人的编辑悄悄冲掉；
 * - **不做删除**：把内置项从仓里删掉不会删 D1 里已有的记录（那可能是主人自己导的）。
 */
export interface BuiltinAppManifest {
  id: string;
  enabled: boolean;
  manifest: ReturnType<typeof appManifestDefinitionSchema.parse>;
}

function builtin(raw: unknown): BuiltinAppManifest {
  const parsed = raw as { id?: unknown; enabled?: unknown; manifest?: unknown };
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new Error('内置应用清单缺少 id');
  }
  // 解析一次：仓库里的 JSON 若与契约漂移，部署后第一次读应用目录就会当场报错，
  // 而不是把非法定义塞进 D1 让节点侧执行失败。
  return {
    id: parsed.id,
    enabled: parsed.enabled !== false,
    manifest: appManifestDefinitionSchema.parse(parsed.manifest),
  };
}

export const BUILTIN_APP_MANIFESTS: BuiltinAppManifest[] = [builtin(magpie)];

/** 把缺失的内置应用补进 D1；已存在（含被主人改过的）一律保持原样。 */
export async function ensureBuiltinAppManifests(
  deps: Pick<AppDeps, 'appManifests'>,
): Promise<void> {
  for (const item of BUILTIN_APP_MANIFESTS) {
    if (await deps.appManifests.get(item.id)) continue;
    try {
      await deps.appManifests.create({
        id: item.id,
        manifest: item.manifest,
        enabled: item.enabled,
      });
    } catch {
      // 并发下的唯一键冲突：另一请求已经补上了，按已存在处理，不影响列表读取。
    }
  }
}
