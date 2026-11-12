/**
 * Agent 发布清单的纯函数（无进程副作用），供：
 *   - scripts/sign-agent-release.mjs（签发）
 *   - scripts/carry-over-agent-release.mjs（发版前取回 N-1）
 *   - scripts/test/agent-manifest.test.ts（单测）
 *
 * 口径见 ADR-0019：回滚包与升级包由**同一份签名**覆盖，清单 `releases`
 * 第 0 条永远是本次要发布的新版本，第 1 条是上一版（N-1）。
 * 顺序是硬约束（面板 `/agent/releases` 直接按数组顺序取最新），
 * 因此这里用断言而不是注释来保证。
 */
import crypto from 'node:crypto';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** 与 sign-agent-release.mjs / Worker / Agent 三端一致：key 递归排序、无空白 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function assertRelease(release, where) {
  if (!release || typeof release !== 'object') {
    throw new Error(`${where} 条目必须是对象`);
  }
  const { version, url, sha256 } = release;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${where} 版本号不合法：${JSON.stringify(version)}`);
  }
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    throw new Error(`${where} url 必须是 https 地址：${JSON.stringify(url)}`);
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256.toLowerCase())) {
    throw new Error(`${where} sha256 必须是 64 位 hex`);
  }
}

/**
 * 组装签名 payload 并强制断言顺序：「新版本必须在 releases[0]」。
 *
 * 面板 `AgentCard` 用 releases[0] 当"最新版本"、releases[1] 当"上一版"，
 * Worker 的卸载命令也取 releases[0]。顺序错了不会报错，只会让回滚/升级
 * 指向错误版本——所以这里直接抛错，不靠约定。
 */
export function buildReleasePayload(newRelease, previousReleases = [], { now = Date.now() } = {}) {
  assertRelease(newRelease, '新版本');
  const releases = [{ ...newRelease, sha256: newRelease.sha256.toLowerCase() }];
  for (const [index, release] of previousReleases.entries()) {
    assertRelease(release, `上一版[${index}]`);
    const entry = { ...release, sha256: release.sha256.toLowerCase() };
    if (entry.version === newRelease.version) {
      // 同版本重复（例如纯面板发版时取回的线上版就是本次构建版本）：调用方应先跳过 carry-over。
      throw new Error(`清单版本重复：${entry.version}（新版本与上一版相同，应跳过 carry-over）`);
    }
    releases.push(entry);
  }
  const seen = new Set();
  for (const release of releases) {
    if (seen.has(release.version)) throw new Error(`清单版本重复：${release.version}`);
    seen.add(release.version);
  }
  if (releases[0].version !== newRelease.version) {
    throw new Error('清单顺序错误：新版本不在 releases[0]');
  }
  return { version: 1, generatedAt: Math.floor(now / 1000), releases };
}

/** 用内置公钥（raw 32B base64）验证清单签名；任何异常一律 false */
export function verifyManifestSignature(manifest, pubkeyB64) {
  try {
    if (!manifest || typeof manifest !== 'object') return false;
    const payload = manifest.payload;
    const signature = manifest.signature;
    if (!payload || typeof signature !== 'string') return false;
    if (!Array.isArray(payload.releases) || payload.releases.length === 0) return false;
    const raw = Buffer.from(String(pubkeyB64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (raw.length !== 32) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(
      null,
      Buffer.from(canonical(payload)),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * 从已验签的 payload 里挑出「上一版」。
 *
 * - 线上清单的 releases[0] 就是当前生产版本；
 * - 与本次构建版本相同（纯面板发版）时返回 null：没有 N-1 可取，也不需要；
 * - 条目缺 url/sha256 时返回 null（宁可不带回滚，也不带一个坏条目）。
 */
export function selectPreviousRelease(payload, newVersion) {
  const releases = payload && Array.isArray(payload.releases) ? payload.releases : [];
  const current = releases[0];
  if (!current || typeof current !== 'object') return null;
  if (typeof current.version !== 'string' || current.version === newVersion) return null;
  if (typeof current.url !== 'string' || typeof current.sha256 !== 'string') return null;
  if (!SHA256_RE.test(current.sha256.toLowerCase())) return null;
  return { version: current.version, url: current.url, sha256: current.sha256.toLowerCase() };
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 仅用于测试/工具：从 PEM 私钥导出 raw 公钥（base64） */
export function rawPublicKeyFrom(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}
