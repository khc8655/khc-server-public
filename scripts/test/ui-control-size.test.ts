import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 表单控件尺寸契约（ui-guidelines §8.9 / §8.11）。
 *
 * 背景：L3 确认框输入框曾被压成 18.5px（一行文字），比同页 32px 的输入框矮一截。
 * 根因是 `.ui-input` 自带 `flex: 1 1 0%`，直接放进 column flex 的 `.ui-dialog-field`
 * 后 flex-basis 0 压过 height。这里对 CSS 源做静态断言，防止再次塌陷或掉档。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tokensCss = fs.readFileSync(path.join(ROOT, 'apps/web/src/styles/tokens.css'), 'utf8');
const uiCss = fs.readFileSync(path.join(ROOT, 'apps/web/src/ui/ui.css'), 'utf8');

/** 取某条精确选择器的所有声明块（含 media query 内的覆盖）。 */
function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...uiCss.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]!);
}

describe('表单控件尺寸契约', () => {
  it('控件高度令牌保持 32 / 40 两档', () => {
    expect(tokensCss).toMatch(/--h-control:\s*32px/);
    expect(tokensCss).toMatch(/--h-control-lg:\s*40px/);
  });

  it('输入框容器桌面 32px、≤639 40px', () => {
    const blocks = declarations('.ui-input-wrap');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('height: var(--h-control)');
    expect(blocks[1]).toContain('height: var(--h-control-lg)');
  });

  it('L3 确认框输入框不被 column flex 压塌，桌面 32px、≤639 40px', () => {
    const blocks = declarations('.ui-dialog-field .ui-input');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('flex: none');
    expect(blocks[0]).toContain('height: var(--h-control)');
    expect(blocks[1]).toContain('height: var(--h-control-lg)');
  });

  it('机密字段编辑框与只读字段桌面 32px、≤639 40px', () => {
    for (const selector of ['.ui-secret-wrap .ui-input', '.ui-secret', '.ui-readonly-field']) {
      const blocks = declarations(selector);
      expect(blocks, `${selector} 缺少两档规则`).toHaveLength(2);
      const values = blocks.map((block) => block.match(/(?:min-)?height:\s*(var\(--h-control(?:-lg)?\))/)?.[1]);
      expect(values).toEqual(expect.arrayContaining(['var(--h-control)', 'var(--h-control-lg)']));
    }
  });

  it('表格工具条搜索/筛选不低于默认控件 32px', () => {
    for (const selector of ['.ui-search', '.ui-filter']) {
      const blocks = declarations(selector);
      expect(blocks.length, `${selector} 缺少移动端覆盖`).toBeGreaterThanOrEqual(2);
      expect(blocks[0]).toContain('height: var(--h-control)');
    }
  });
});
