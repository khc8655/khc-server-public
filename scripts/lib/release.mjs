/**
 * 发版一致性的共享判定逻辑（纯函数，无 I/O），供：
 *   - scripts/check-release-consistency.mjs（门禁）
 *   - scripts/prune-agent-packages.mjs（旧包退役）
 *   - scripts/test/*.test.ts（单测）
 *
 * 口径见 docs/release-versioning.md 与 ADR-0013。
 */

/** semver 正则：主.次.补丁 + 可选预发布/构建元数据 */
export const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** YYYY-MM-DD，且必须是真实存在的日期 */
export function isValidReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 解析 semver；非法返回 null */
export function parseSemver(value) {
  const m = SEMVER_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
    raw: String(value).trim(),
  };
}

/**
 * 比较两个 semver 字符串（升序返回负数）。
 * 预发布版本小于同号正式版（1.0.0-rc.1 < 1.0.0），满足退役排序需要。
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

/**
 * 版本号变化属于哪一档（用于提示，不用于门禁）：
 *   breaking = 主版本变化；feature = 次版本变化；fix = 补丁位变化；none
 */
export function classifyBump(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return 'none';
  if (a.major !== b.major) return 'breaking';
  if (a.minor !== b.minor) return 'feature';
  if (a.patch !== b.patch) return 'fix';
  return 'none';
}

/** 从 CHANGELOG 文本提取所有 `## [x.y.z]` 段（忽略 [Unreleased]） */
export function parseChangelogVersions(text) {
  const versions = [];
  const re = /^##[ \t]+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/gm;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) versions.push(m[1]);
  return versions;
}

/** CHANGELOG 是否包含某版本段 */
export function changelogHasVersion(text, version) {
  return parseChangelogVersions(text).includes(String(version));
}

/**
 * 面板「功能代码」判定：命中即为"改了就必须 bump 面板版本"。
 * 豁免（不触发 bump）：
 *   - 测试：*.test.ts(x) / *.smoke.test.tsx
 *   - 纯文案：apps/web/src/i18n/
 *   - 静态资产：apps/web/public/（Agent 包走 agent 自己的规则）
 *   - 文档/配置：*.md、CI、wrangler.toml、脚本
 */
export function isPanelFunctionalChange(file) {
  const path = String(file ?? '');
  if (!path.startsWith('apps/')) return false;
  if (!/^apps\/(api|web)\/src\//.test(path)) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (/\.smoke\.test\.tsx?$/.test(path)) return false;
  if (/^apps\/web\/src\/i18n\//.test(path)) return false;
  if (!/\.(ts|tsx|css)$/.test(path)) return false;
  return true;
}

/**
 * 提交信息是否声明跳过发版（用于纯内部整理的一次性豁免）。
 *
 * 严格口径：只看**提交标题**（`git log --format=%s`），且范围内**每个**提交都带标记才算豁免。
 * 早期实现把所有提交正文拼接后再匹配，结果提交正文里"讨论到 [skip-release]"也会误判成豁免
 * —— 门禁自己失效，比没有门禁更糟。
 */
export function hasSkipReleaseMarker(subjects) {
  const list = (Array.isArray(subjects) ? subjects : [subjects])
    .map((s) => String(s ?? '').trim().split('\n')[0])
    .filter((s) => s.length > 0);
  if (list.length === 0) return false;
  return list.every((subject) => /\[skip-release\]/i.test(subject));
}
