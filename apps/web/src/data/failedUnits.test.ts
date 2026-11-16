/**
 * 失败单元取值顺序（2026-11-16 U2）。
 *
 * 回归目标：失败单元只从 `/state` 读时，计数会冻在打开页面那一刻。
 * 现在快照优先，但旧 Agent 不返回该字段，必须能退回 /state；
 * 两处都没有时要能表达「不知道」，不能冒充「没有失败」。
 */
import { describe, expect, it } from 'vitest';
import { pickFailedUnits } from './failedUnits';

describe('pickFailedUnits', () => {
  it('快照有该字段时优先用快照（这是每 10 秒刷新的来源）', () => {
    const result = pickFailedUnits(
      { failedUnits: ['a.service'] },
      { failedUnits: ['stale.service'] },
    );
    expect(result).toEqual(['a.service']);
  });

  it('快照是空数组时用它（确实没有失败单元），不回退到 /state 的旧值', () => {
    const result = pickFailedUnits({ failedUnits: [] }, { failedUnits: ['stale.service'] });
    expect(result).toEqual([]);
  });

  it('旧 Agent 不返回该字段时退回 /state', () => {
    const result = pickFailedUnits({}, { failedUnits: ['b.service'] });
    expect(result).toEqual(['b.service']);
  });

  it('快照把失败单元放在 ops.services 里时也能读到', () => {
    const result = pickFailedUnits({ services: { failedUnits: ['c.service'] } });
    expect(result).toEqual(['c.service']);
  });

  it('两处都没有时返回 null（不知道），不是空数组', () => {
    expect(pickFailedUnits({})).toBeNull();
    expect(pickFailedUnits(null)).toBeNull();
    expect(pickFailedUnits(undefined)).toBeNull();
    expect(pickFailedUnits({}, {})).toBeNull();
    expect(pickFailedUnits({}, null)).toBeNull();
  });

  it('空数组与 null 不能混为一谈（页面文案不同）', () => {
    expect(pickFailedUnits({ failedUnits: [] })).toEqual([]);
    expect(pickFailedUnits({})).toBeNull();
  });

  it('null 值的字段视为「没读到」，继续往下找', () => {
    const result = pickFailedUnits({ failedUnits: null }, { failedUnits: ['d.service'] });
    expect(result).toEqual(['d.service']);
  });

  it('不被非数组的脏值干扰', () => {
    const result = pickFailedUnits(
      { failedUnits: 'not-an-array' as unknown as string[] },
      { failedUnits: ['e.service'] },
    );
    expect(result).toEqual(['e.service']);
  });
});
