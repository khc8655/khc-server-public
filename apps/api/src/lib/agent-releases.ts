/**
 * Agent 发布清单（#32、ADR-0011）：固定发布源 + Ed25519 签名校验。
 *
 * 清单来源（按优先级，见 ADR-0011）：
 * 1. 随 Worker assets 部署的签名清单 `apps/web/public/agent/release-manifest.json`
 *    （线上路径 `/agent/release-manifest.json`，与 tar.gz 同一发布路径）；
 * 2. 兼容兜底：`AGENT_RELEASE_MANIFEST` secret（仅当 assets 中清单缺失/不可读时使用）。
 * 清单本身是公开内容，安全性由私钥签名 + 内置公钥校验保证，因此不再需要每次
 * 发版手动 `wrangler secret put`。
 *
 * 环境变量：
 * - AGENT_RELEASE_BASE：固定包前缀（无清单时兜底）
 * - AGENT_RELEASE_PUBKEY：Ed25519 公钥（base64 raw，32 字节）
 * - AGENT_RELEASE_MANIFEST：签名清单（可选覆盖/兜底）
 *
 * 清单格式：
 * { "payload": { "version": 1, "generatedAt": 179..., "releases": [
 *     { "version": "0.1.0", "url": "https://...tar.gz", "sha256": "64hex" }
 *   ] }, "signature": "base64" }
 * 签名对象是 payload 的 canonical JSON（对象 key 递归排序）。
 */
import { AppError } from './errors';

/** 签名清单随 assets 部署的相对路径（apps/web/public/agent/ 下同名文件）。 */
export const BUNDLED_MANIFEST_PATH = '/agent/release-manifest.json';

export interface AgentRelease {
  version: string;
  url: string;
  sha256: string;
}

export interface AgentReleaseManifest {
  payload: {
    version: number;
    generatedAt: number;
    releases: AgentRelease[];
  };
  signature: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalManifestPayload(payload: unknown): string {
  return canonical(payload);
}

function base64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function verifyAgentReleaseManifest(
  manifestRaw: string,
  publicKeyRaw: string,
): Promise<AgentReleaseManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    throw new AppError(503, 'release_manifest_invalid', 'Agent 发布清单不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AppError(503, 'release_manifest_invalid', 'Agent 发布清单格式错误');
  }
  const manifest = parsed as Partial<AgentReleaseManifest>;
  if (!manifest.payload || typeof manifest.signature !== 'string') {
    throw new AppError(503, 'release_manifest_invalid', 'Agent 发布清单缺少 payload/signature');
  }
  const payload = manifest.payload as AgentReleaseManifest['payload'];
  if (!Array.isArray(payload.releases)) {
    throw new AppError(503, 'release_manifest_invalid', 'Agent 发布清单缺少 releases');
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      base64Bytes(publicKeyRaw),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    throw new AppError(503, 'release_pubkey_invalid', 'AGENT_RELEASE_PUBKEY 不是合法 Ed25519 公钥');
  }
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      base64Bytes(manifest.signature),
      new TextEncoder().encode(canonicalManifestPayload(payload)),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new AppError(403, 'release_signature_invalid', 'Agent 发布清单签名校验失败');
  return { payload, signature: manifest.signature };
}

export interface AgentReleaseEnv {
  ENVIRONMENT?: string;
  AGENT_RELEASE_BASE?: string;
  AGENT_RELEASE_PUBKEY?: string;
  /** 兼容兜底：仅当 assets 中签名清单缺失/不可读时使用。 */
  AGENT_RELEASE_MANIFEST?: string;
  /** 显式要求清单（本地/预发可打开）；生产默认强制。 */
  AGENT_RELEASE_REQUIRE_MANIFEST?: string;
  /** 静态资源绑定（apps/web/dist）；用于读取随部署发布的签名清单。 */
  ASSETS?: { fetch(input: Request): Promise<Response> };
}

export interface AgentReleaseManifestSource {
  releases: AgentRelease[];
  /** 清单原文：A-5 转发给 Agent 用内置公钥独立验签。 */
  raw: string;
  source: 'bundled' | 'secret';
}

function manifestRequired(env: AgentReleaseEnv): boolean {
  if (env.AGENT_RELEASE_REQUIRE_MANIFEST === '1' || env.AGENT_RELEASE_REQUIRE_MANIFEST === 'true') {
    return true;
  }
  return env.ENVIRONMENT === 'production';
}

/**
 * 读取随部署发布的签名清单原文。缺失（404）返回 null，交给 secret 兜底；
 * 存在但读取失败/非 2xx 直接报错，避免静默放行。
 */
async function readBundledManifest(env: AgentReleaseEnv, origin?: string): Promise<string | null> {
  if (!env.ASSETS) return null;
  let response: Response;
  try {
    response = await env.ASSETS.fetch(
      new Request(`${origin ?? 'https://khc-assets.invalid'}${BUNDLED_MANIFEST_PATH}`, {
        // SPA 兜底只对导航请求返回 index.html；显式要 JSON，缺失时得到 404。
        headers: { accept: 'application/json' },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(503, 'release_manifest_unavailable', `读取内置发布清单失败：${message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new AppError(503, 'release_manifest_unavailable', `内置发布清单返回 HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * 解析并验签发布清单：静态资源优先，secret 兜底。两者都没有返回 null。
 * 任何解析/验签失败都抛 AppError（fail-closed，不静默放行）。
 */
export async function loadAgentReleaseManifest(
  env: AgentReleaseEnv,
  /** 当前请求的 origin：assets 绑定按路径解析资源，用真实 origin 最稳妥。 */
  origin?: string,
): Promise<AgentReleaseManifestSource | null> {
  const bundled = await readBundledManifest(env, origin);
  const raw = bundled ?? env.AGENT_RELEASE_MANIFEST ?? null;
  if (!raw) return null;
  if (!env.AGENT_RELEASE_PUBKEY) {
    throw new AppError(503, 'release_pubkey_missing', '缺少 AGENT_RELEASE_PUBKEY，无法校验 Agent 发布清单');
  }
  const manifest = await verifyAgentReleaseManifest(raw, env.AGENT_RELEASE_PUBKEY);
  return {
    releases: manifest.payload.releases,
    raw,
    source: bundled ? 'bundled' : 'secret',
  };
}

/** 若配置了清单，返回已验证的 release 列表；未配置返回 null（允许手工 URL + 可选 base 前缀）。 */
export async function loadAgentReleases(
  env: AgentReleaseEnv,
  origin?: string,
): Promise<AgentRelease[] | null> {
  return (await loadAgentReleaseManifest(env, origin))?.releases ?? null;
}

/** 校验 URL/sha 是否来自固定发布源/签名清单。 */
export async function assertAgentReleaseAllowed(
  env: AgentReleaseEnv,
  packageUrl: string,
  sha256: string,
  options: {
    /** 已加载的清单（避免同一次请求重复读 assets）；不传则内部加载。 */
    releases?: AgentRelease[] | null;
    origin?: string;
  } = {},
): Promise<AgentRelease | null> {
  const releases =
    options.releases === undefined ? await loadAgentReleases(env, options.origin) : options.releases;
  if (!releases && manifestRequired(env)) {
    throw new AppError(
      503,
      'release_manifest_required',
      '生产环境必须提供签名发布清单（随部署发布的 release-manifest.json 或 AGENT_RELEASE_MANIFEST）',
    );
  }
  if (releases) {
    const match = releases.find(
      (release) => release.url === packageUrl && release.sha256.toLowerCase() === sha256.toLowerCase(),
    );
    if (!match) {
      throw new AppError(400, 'release_not_in_manifest', '安装包不在已签名的发布清单中');
    }
    return match;
  }
  const base = (env.AGENT_RELEASE_BASE ?? '').trim();
  if (base) {
    const normalized = base.endsWith('/') ? base : `${base}/`;
    if (!packageUrl.startsWith(normalized)) {
      throw new AppError(400, 'release_source_not_allowed', '升级包必须来自配置的固定发布源');
    }
  }
  return null;
}
