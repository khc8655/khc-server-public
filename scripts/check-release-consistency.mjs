#!/usr/bin/env node
/**
 * 面板发版一致性门禁（ADR-0013 的 L2 层）。
 *
 * 背景：面板版本原先在 web 与 api 两处硬编码、且没有任何校验，
 * 结果 2026-10-31 之后 8 天的功能改动全压在 `v0.2.0 · 2026-10-31` 下 ——
 * 线上无法回答"这个功能是哪个版本"。Agent 侧早就有 verify-agent-release.mjs
 * 强卡，面板侧一直是空白，本脚本补上这段对称性。
 *
 * 两种模式：
 *   node scripts/check-release-consistency.mjs --repo
 *       仓库自检（不需要 git 基线，任何分支/本地都能跑）：
 *         1. package.json 的 version 合法 semver、khcRelease 是合法日期
 *         2. CHANGELOG 必须存在当前版本的 `## [x.y.z]` 段（不能只堆在 Unreleased）
 *         3. apps/web/src/version.ts 与 apps/api/src/version.ts 必须从 package.json 取值，
 *            不允许再出现硬编码版本字面量（防双写回潮）
 *   node scripts/check-release-consistency.mjs --diff <base-ref>
 *       变更规则（CI 用）：
 *         规则 P1：apps/(api|web)/src 下非豁免文件有改动 ⇒ package.json version 必须变；
 *                  （测试 / i18n 文案 / public 静态资产不算，见 scripts/lib/release.mjs）
 *         规则 P2：version 变了 ⇒ CHANGELOG 必须有对应版本段；
 *         规则 P3：提交信息含 [skip-release] 时跳过 P1（仅用于纯内部整理）。
 *
 * 退出码：0 通过；1 有违反项（打印逐条原因与修法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifyBump,
  changelogHasVersion,
  hasSkipReleaseMarker,
  isPanelFunctionalChange,
  isValidReleaseDate,
  parseSemver,
} from './lib/release.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');
const VERSION_SOURCES = ['apps/web/src/version.ts', 'apps/api/src/version.ts'];

const BUMP_HINT =
  '按 semver（ADR-0013）：新增用户可见能力 = minor；行为修复/内部改进 = patch；' +
  '破坏 API 或 Agent 协议 = major。纯测试/文案/文档整理可在提交信息里写 [skip-release] 豁免。';

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** 基线不可用时退化为 HEAD~1（首次 push 的 event.before 全是 0） */
function resolveBase(base) {
  if (!base || /^0+$/.test(base)) return 'HEAD~1';
  const exists = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: ROOT });
  return exists.status === 0 ? base : 'HEAD~1';
}

function changedFiles(base) {
  const out = git(['diff', '--name-only', `${base}...HEAD`]);
  return (out ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function commitMessages(base) {
  // 只取标题：豁免标记必须写在标题里，避免正文提及就误判（见 lib/release.mjs 说明）
  const out = git(['log', '--format=%s', `${base}..HEAD`]);
  return (out ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function versionOf(text) {
  const m = /^##[ \t]+\[?(\d+\.\d+\.\d+[^\]]*)\]?/m.exec(text);
  return m ? m[1] : null;
}

/** --repo：静态自检 */
function checkRepo() {
  const problems = [];
  const pkg = readJson(PKG_FILE);
  const version = pkg.version;
  const release = pkg.khcRelease;

  if (!parseSemver(version)) {
    problems.push(`package.json version 不是合法 semver：${JSON.stringify(version)}`);
  }
  if (!isValidReleaseDate(release)) {
    problems.push(
      `package.json khcRelease 必须是真实日期 YYYY-MM-DD，当前 ${JSON.stringify(release)}`,
    );
  }

  const changelog = readText(CHANGELOG_FILE);
  if (!changelog) {
    problems.push('缺少 CHANGELOG.md');
  } else if (version && !changelogHasVersion(changelog, version)) {
    const latest = versionOf(changelog);
    problems.push(
      `CHANGELOG 缺少当前版本段 \`## [${version}]\`（最近一段是 ${latest ?? '无'}）。` +
        '禁止把已发布改动只堆在 [Unreleased] 里。',
    );
  }

  // 防双写回潮：两个版本入口都必须从 package.json 读，不能出现硬编码字面量
  for (const rel of VERSION_SOURCES) {
    const file = path.join(ROOT, rel);
    const text = readText(file);
    if (!text) {
      problems.push(`缺少版本来源文件 ${rel}`);
      continue;
    }
    if (!/from\s+['"][^'"]*package\.json['"]/.test(text)) {
      problems.push(`${rel} 必须 import 仓库根 package.json（不要再写死版本号/日期）`);
    }
    if (/PANEL_VERSION\s*=\s*['"]\d+\.\d+\.\d+/.test(text) || /APP_VERSION\s*=\s*['"]\d+\.\d+\.\d+/.test(text)) {
      problems.push(`${rel} 出现了硬编码版本字面量，违反单一来源（ADR-0013）`);
    }
  }

  return problems;
}

/** --diff：变更规则 */
function checkDiff(rawBase) {
  const base = resolveBase(rawBase);
  const problems = [];
  const notes = [];
  const pkg = readJson(PKG_FILE);
  const version = pkg.version;

  const files = changedFiles(base);
  if (files.length === 0) {
    notes.push(`基线 ${base} 与 HEAD 之间没有文件差异，跳过 P1/P2`);
    return { problems, notes };
  }

  const prevPkgRaw = git(['show', `${base}:package.json`]);
  const prevVersion = prevPkgRaw ? JSON.parse(prevPkgRaw).version : null;

  const functional = files.filter(isPanelFunctionalChange);
  const versionChanged = prevVersion !== version;

  // 规则 P1
  if (functional.length > 0 && !versionChanged) {
    if (hasSkipReleaseMarker(commitMessages(base))) {
      notes.push(`P1 已按 [skip-release] 豁免（改动 ${functional.length} 个面板文件）`);
    } else {
      problems.push(
        `改动面板功能代码但未 bump 版本：package.json version 仍是 ${version}。\n` +
          `  改动文件（前 8 个）：\n${functional.slice(0, 8).map((f) => `    - ${f}`).join('\n')}\n` +
          `  ${BUMP_HINT}`,
      );
    }
  } else if (functional.length > 0) {
    notes.push(
      `版本 ${prevVersion} → ${version}（${classifyBump(prevVersion, version)}），面板改动 ${functional.length} 个文件`,
    );
  } else {
    notes.push('无面板功能代码改动，不要求 bump 版本');
  }

  // 规则 P2
  if (versionChanged) {
    const changelog = readText(CHANGELOG_FILE);
    if (!changelogHasVersion(changelog, version)) {
      problems.push(
        `版本已 bump 到 ${version}，但 CHANGELOG 缺少 \`## [${version}]\` 段。` +
          '发布必须自带发布说明（ADR-0013 L1）。',
      );
    } else {
      notes.push(`CHANGELOG 已含 [${version}] 段`);
    }
    if (!isValidReleaseDate(pkg.khcRelease)) {
      problems.push(`khcRelease 不是合法日期：${JSON.stringify(pkg.khcRelease)}`);
    }
  }

  return { problems, notes };
}

function main() {
  const args = process.argv.slice(2);
  const diffIndex = args.indexOf('--diff');
  const repoOnly = args.includes('--repo');

  let problems = [];
  let notes = [];

  if (diffIndex >= 0) {
    const result = checkDiff(args[diffIndex + 1]);
    problems = result.problems;
    notes = result.notes;
  }
  if (repoOnly || diffIndex < 0) {
    problems = problems.concat(checkRepo());
  }

  for (const note of notes) console.log(`  · ${note}`);
  if (problems.length === 0) {
    console.log('OK: 发版一致（面板版本单一来源 + CHANGELOG + bump 规则）');
    return 0;
  }
  console.error('ERROR: 发版一致性检查未通过：');
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

process.exit(main());
