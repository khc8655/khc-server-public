import { describe, expect, it } from 'vitest';
import type { TaskResponse } from '@khc/contracts';
import { installTaskText } from './installTaskText';

const TEMPLATE = '任务 {id}：{state} · {progress}%';

function task(overrides: {
  state?: string;
  progress?: number;
  message?: string | null;
}): TaskResponse {
  return {
    task: {
      id: 'bf156709229840c3b5c0c1985d295ac7',
      state: overrides.state ?? 'error',
      progress: overrides.progress ?? 1,
      error: overrides.message ? { code: 'command_failed', message: overrides.message } : null,
    },
  } as unknown as TaskResponse;
}

describe('installTaskText', () => {
  it('失败时带上失败原因', () => {
    const text = installTaskText(
      task({ message: '未检测到 WireGuard 工具链（缺：wg-quick）。' }),
      TEMPLATE,
    );
    expect(text).toContain('error · 1%');
    expect(text).toContain('失败原因');
    expect(text).toContain('缺：wg-quick');
  });

  it('进行中不带原因', () => {
    const text = installTaskText(task({ state: 'running', progress: 40 }), TEMPLATE);
    expect(text).toBe('任务 bf156709229840c3b5c0c1985d295ac7：running · 40%');
    expect(text).not.toContain('失败原因');
  });

  it('失败但没有 message 时只显示状态，不出现空标签', () => {
    const text = installTaskText(task({ message: null }), TEMPLATE);
    expect(text).not.toContain('失败原因');
    expect(text).toContain('error · 1%');
  });

  it('过长的原因截断，避免撑爆卡片', () => {
    const text = installTaskText(task({ message: 'x'.repeat(400) }), TEMPLATE);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(220);
  });
});
