import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  changelogHasVersion,
  classifyBump,
  compareSemver,
  hasSkipReleaseMarker,
  isPanelFunctionalChange,
  isValidReleaseDate,
  parseChangelogVersions,
  parseSemver,
} from '../lib/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(script: string, args: string[] = []) {
  return spawnSync('node', [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('semver 解析与比较', () => {
  it('解析合法版本', () => {
    expect(parseSemver('0.1.20')).toMatchObject({ major: 0, minor: 1, patch: 20 });
    expect(parseSemver('1.2.3-rc.1')).toMatchObject({ prerelease: 'rc.1' });
  });

  it('拒绝非法版本', () => {
    expect(parseSemver('0.1')).toBeNull();
    expect(parseSemver('v0.1.0')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('按数值而非字典序比较（0.1.9 < 0.1.10 < 0.1.20）', () => {
    expect(compareSemver('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareSemver('0.1.10', '0.1.20')).toBeLessThan(0);
    expect(compareSemver('0.1.20', '0.1.20')).toBe(0);
  });

  it('预发布版本小于同号正式版', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });
});

describe('发版日期校验', () => {
  it('接受真实日期', () => {
    expect(isValidReleaseDate('2026-11-07')).toBe(true);
    expect(isValidReleaseDate('2028-02-29')).toBe(true);
  });

  it('拒绝不存在的日期与错误格式', () => {
    expect(isValidReleaseDate('2026-02-30')).toBe(false);
    expect(isValidReleaseDate('2026-13-01')).toBe(false);
    expect(isValidReleaseDate('2026/11/07')).toBe(false);
    expect(isValidReleaseDate('')).toBe(false);
  });
});

describe('bump 档位判定', () => {
  it('区分 breaking / feature / fix / none', () => {
    expect(classifyBump('0.2.0', '1.0.0')).toBe('breaking');
    expect(classifyBump('0.2.0', '0.3.0')).toBe('feature');
    expect(classifyBump('0.2.0', '0.2.1')).toBe('fix');
    expect(classifyBump('0.2.0', '0.2.0')).toBe('none');
  });
});

describe('CHANGELOG 版本段解析', () => {
  const text = [
    '# Changelog',
    '## [Unreleased]',
    '### Fixed',
    '## [0.3.0] - 2026-11-07',
    '## [0.1.0] - 2026-10-25',
  ].join('\n');

  it('只认带版本号的段，忽略 Unreleased', () => {
    expect(parseChangelogVersions(text)).toEqual(['0.3.0', '0.1.0']);
  });

  it('能判断某版本段是否存在', () => {
    expect(changelogHasVersion(text, '0.3.0')).toBe(true);
    expect(changelogHasVersion(text, '0.2.0')).toBe(false);
  });
});

describe('面板功能代码判定（决定是否必须 bump）', () => {
  it('apps/(api|web)/src 的 ts/tsx/css 算功能代码', () => {
    expect(isPanelFunctionalChange('apps/api/src/routes/auth.ts')).toBe(true);
    expect(isPanelFunctionalChange('apps/web/src/pages/OverviewPage.tsx')).toBe(true);
    expect(isPanelFunctionalChange('apps/web/src/styles/global.css')).toBe(true);
  });

  it('测试/i18n 文案/静态资产/文档一律豁免', () => {
    expect(isPanelFunctionalChange('apps/api/test/auth.test.ts')).toBe(false);
    expect(isPanelFunctionalChange('apps/web/src/pages/c3.smoke.test.tsx')).toBe(false);
    expect(isPanelFunctionalChange('apps/web/src/apps/x/y.test.tsx')).toBe(false);
    expect(isPanelFunctionalChange('apps/web/src/i18n/zh.ts')).toBe(false);
    expect(isPanelFunctionalChange('apps/web/public/agent/release-manifest.json')).toBe(false);
    expect(isPanelFunctionalChange('docs/README.md')).toBe(false);
    expect(isPanelFunctionalChange('scripts/verify.sh')).toBe(false);
    expect(isPanelFunctionalChange('wrangler.toml')).toBe(false);
  });
});

describe('skip-release 豁免标记', () => {
  it('只看标题，且要求范围内每个提交都带标记', () => {
    expect(hasSkipReleaseMarker(['chore: 整理注释 [skip-release]'])).toBe(true);
    expect(hasSkipReleaseMarker(['chore: a [SKIP-RELEASE]'])).toBe(true);
    expect(hasSkipReleaseMarker('chore: b [skip-release]')).toBe(true);
  });

  it('只要有一个提交没带标记就不豁免（防止顺手豁免掉真功能）', () => {
    expect(hasSkipReleaseMarker(['chore: a [skip-release]', 'feat: 新能力'])).toBe(false);
  });

  it('大小写不敏感、不接受空集合', () => {
    expect(hasSkipReleaseMarker('chore: b [SKIP-RELEASE]')).toBe(true);
    expect(hasSkipReleaseMarker([])).toBe(false);
  });
});

describe('门禁脚本对当前仓库自洽', () => {
  it('check-release-consistency --repo 通过（版本单一来源 + CHANGELOG 有当前段）', () => {
    const res = run('scripts/check-release-consistency.mjs', ['--repo']);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  });

  it('prune-agent-packages --check 通过（包留存未超限）', () => {
    const res = run('scripts/prune-agent-packages.mjs', ['--check']);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  });
});
