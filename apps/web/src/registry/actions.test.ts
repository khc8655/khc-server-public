import { describe, expect, it } from 'vitest';
import { action, actionMeta } from './actions';
import { zh, fmt } from '../i18n/zh';

describe('agent.rollback 动作注册（ADR-0019）', () => {
  it('是 L3 + confirm 的危险动作，并写独立审计名', () => {
    const meta = actionMeta(action('agent.rollback'));
    expect(meta.level).toBe('L3');
    expect(meta.form).toBe('confirm');
    expect(meta.kind).toBe('update');
    expect(meta.audit).toBe('agent.rollback');
  });

  it('标签与升级动作区分开', () => {
    expect(zh.actions['agent.rollback']).not.toBe(zh.actions['agent.remoteUpgrade']);
  });

  it('确认文案写明从哪个版本降级到哪个版本', () => {
    const text = fmt(zh.agent.rollbackBody, { hub: 'node-a', from: '0.1.41', to: '0.1.40' });
    expect(text).toContain('降级');
    expect(text).toContain('0.1.41');
    expect(text).toContain('0.1.40');
  });
});
