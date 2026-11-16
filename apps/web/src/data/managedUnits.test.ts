/**
 * 受管单元名单（2026-11-16 P-3 A / N-4）。
 *
 * 回归目标：`unattended-upgrades.service` 这类系统单元曾被塞进「需要处理」，
 * 面板管不了它，提示永远挂着，用户就学会无视整条提示。
 */
import { describe, expect, it } from 'vitest';
import { MANAGED_UNITS, isManagedUnit, splitFailedUnits } from './managedUnits';

describe('isManagedUnit', () => {
  it('精确名单内的单元算受管', () => {
    for (const unit of MANAGED_UNITS) {
      expect(isManagedUnit(unit)).toBe(true);
    }
    expect(isManagedUnit('caddy.service')).toBe(true);
    expect(isManagedUnit('khc-agent.service')).toBe(true);
  });

  it('khc- 前缀（Agent 自写 unit）算受管', () => {
    expect(isManagedUnit('khc-agent-upgrade.service')).toBe(true);
    expect(isManagedUnit('khc-r3-driver.service')).toBe(true);
  });

  it('khc-app- 前缀（脚本式应用）算受管', () => {
    expect(isManagedUnit('khc-app-magpie.service')).toBe(true);
  });

  it('wg-quick@ 模板实例算受管', () => {
    expect(isManagedUnit('wg-quick@wg0.service')).toBe(true);
    expect(isManagedUnit('wg-quick@khc0.service')).toBe(true);
  });

  it('系统自带单元不算受管（面板无法处理）', () => {
    for (const unit of [
      'unattended-upgrades.service',
      'fwupd.service',
      'udisks2.service',
      'systemd-resolved.service',
      'ssh.service',
      'cron.service',
    ]) {
      expect(isManagedUnit(unit)).toBe(false);
    }
  });

  it('空值不算受管', () => {
    expect(isManagedUnit('')).toBe(false);
    expect(isManagedUnit(null)).toBe(false);
    expect(isManagedUnit(undefined)).toBe(false);
    expect(isManagedUnit('  ')).toBe(false);
  });

  it('只是包含 khc 字样但前缀不对的，不算受管', () => {
    // 防止「名字里有 khc 就当受管」这种松判定把系统单元误收进来
    expect(isManagedUnit('not-khc-thing.service')).toBe(false);
    expect(isManagedUnit('my-khc-app.service')).toBe(false);
  });
});

describe('splitFailedUnits', () => {
  it('按受管/系统两拨拆分，保持原顺序', () => {
    const { managed, system } = splitFailedUnits([
      'unattended-upgrades.service',
      'khc-agent.service',
      'fwupd.service',
      'caddy.service',
      'wg-quick@wg0.service',
    ]);
    expect(managed).toEqual(['khc-agent.service', 'caddy.service', 'wg-quick@wg0.service']);
    expect(system).toEqual(['unattended-upgrades.service', 'fwupd.service']);
  });

  it('全系统单元时受管为空（「需要处理」不该出现任何服务条目）', () => {
    const { managed, system } = splitFailedUnits(['fwupd.service', 'udisks2.service']);
    expect(managed).toEqual([]);
    expect(system).toHaveLength(2);
  });

  it('空数组安全', () => {
    expect(splitFailedUnits([])).toEqual({ managed: [], system: [] });
  });
});
