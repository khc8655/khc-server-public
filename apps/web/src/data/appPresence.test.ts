import { describe, expect, it } from 'vitest';
import { appPresence, hasExternalBlocks } from './appPresence';

/**
 * 三种情形（2026-11-11 修正标注语义）：
 * 1) 节点已安装 + D1 有配置行 + 0 条 → 「已安装 · 暂无站点」，不是"未纳管"；
 * 2) 节点已安装 + D1 有配置行 + 有站点 → 正常纳管；
 * 3) 只有 `caddy_import_scan` 真扫到外部站点块，才允许标「外部安装 · 未纳管」。
 */
describe('appPresence：实装 × D1 配置的差集', () => {
  it('面板装 + D1 有行 + 0 站点 → installed-empty（已安装 · 暂无站点）', () => {
    expect(appPresence(true, 0, { installed: true })).toBe('installed-empty');
  });

  it('面板装 + D1 有行 + 有站点 → managed，不追加任何缺失注记', () => {
    expect(appPresence(true, 3, { installed: true })).toBe('managed');
  });

  it('D1 有行但节点未安装 → missing（未安装 / 未生效），不降级为"暂无站点"', () => {
    expect(appPresence(true, 0, { installed: false })).toBe('missing');
    expect(appPresence(true, 3, { installed: false })).toBe('missing');
  });

  it('节点已安装但 D1 无行 → unconfigured（已安装 · 面板无配置）', () => {
    expect(appPresence(false, null, { installed: true })).toBe('unconfigured');
  });

  it('没有在线结论时不猜 → unknown', () => {
    expect(appPresence(true, 0, undefined)).toBe('unknown');
    expect(appPresence(false, null, undefined)).toBe('unknown');
    expect(appPresence(false, null, { installed: false })).toBe('unknown');
  });

  it('扫描到外部站点块才满足"未纳管"的显示条件', () => {
    expect(hasExternalBlocks([{ hash: 'a' }])).toBe(true);
    expect(hasExternalBlocks([])).toBe(false);
    expect(hasExternalBlocks(undefined)).toBe(false);
  });
});
