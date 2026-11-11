/**
 * 构建标识（L3）：把「线上正在跑的到底是哪次提交」暴露出来。
 *
 * 数据来源是 Cloudflare 官方的 version metadata binding
 * （wrangler.toml 的 `[version_metadata] binding = "CF_VERSION_METADATA"`）：
 *   - `tag`       ← `wrangler deploy --tag <commit sha 前 12 位>`（CI 注入）
 *   - `timestamp` ← 该版本创建时间
 *   - `id`        ← Cloudflare Worker Version ID（线上回滚时可见的同一个 ID）
 *
 * 全部字段可缺失：本地 `wrangler dev`、单测、以及 binding 未配置时
 * 一律返回空对象，调用方按 optional 处理，绝不因为溯源信息缺失而报错。
 * 口径见 docs/release-versioning.md、ADR-0013。
 */

export interface BuildInfo {
  /** 构建来源提交（CI 用 commit sha 前 12 位），缺失表示非 CI 部署 */
  commit?: string;
  /** 版本创建时间（ISO 8601，Cloudflare 提供） */
  builtAt?: string;
  /** Cloudflare Worker Version ID */
  versionId?: string;
}

interface VersionMetadataBinding {
  id?: unknown;
  tag?: unknown;
  timestamp?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 从 Worker env 读取构建标识；任何异常都降级为空对象，不影响请求 */
export function readBuildInfo(env: unknown): BuildInfo {
  try {
    const meta = (env as { CF_VERSION_METADATA?: VersionMetadataBinding } | undefined)
      ?.CF_VERSION_METADATA;
    if (!meta) return {};
    const info: BuildInfo = {
      commit: asString(meta.tag),
      builtAt: asString(meta.timestamp),
      versionId: asString(meta.id),
    };
    // 只保留实际存在的键，避免响应里出现一堆 undefined
    return Object.fromEntries(
      Object.entries(info).filter(([, v]) => v !== undefined),
    ) as BuildInfo;
  } catch {
    return {};
  }
}
