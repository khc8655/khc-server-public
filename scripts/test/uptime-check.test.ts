import { describe, expect, it } from 'vitest';
import {
  evaluateHealth,
  evaluateVersion,
  certificateStatus,
  webhookState,
  shouldAlert,
  exitCodeFor,
} from '../lib/uptime-check.mjs';

describe('uptime-check 纯函数', () => {
  it('health：200 + ok:true + 字段完整才通过', () => {
    expect(evaluateHealth(200, { ok: true, version: '0.7.11', env: 'production' }).level).toBe('ok');
    expect(evaluateHealth(503, { ok: true }).level).toBe('fail');
    expect(evaluateHealth(200, { ok: false }).level).toBe('fail');
    expect(evaluateHealth(200, { ok: true, env: 'production' }).level).toBe('fail');
    expect(evaluateHealth(200, { ok: true, version: '0.7.11' }).level).toBe('fail');
  });

  it('version：必须带 commit，可按前缀校验期望提交', () => {
    const body = { version: '0.7.11', commit: '2b852199fce1' };
    expect(evaluateVersion(200, body).level).toBe('ok');
    expect(evaluateVersion(200, body, '2b8521').level).toBe('ok');
    expect(evaluateVersion(200, body, 'deadbeef').level).toBe('fail');
    expect(evaluateVersion(200, { version: '0.7.11' }).level).toBe('fail');
    expect(evaluateVersion(500, body).level).toBe('fail');
  });

  it('certificateStatus：过期 fail、临近 warn、正常 ok', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    expect(certificateStatus('2026-11-09T00:00:00Z', now).level).toBe('fail');
    expect(certificateStatus('2026-11-20T00:00:00Z', now, 21).level).toBe('warn');
    expect(certificateStatus('2027-02-01T00:00:00Z', now, 21).level).toBe('ok');
    expect(certificateStatus('not-a-date', now).level).toBe('fail');
  });

  it('webhookState：未配置必须显式标记，配置非法也不算已配置', () => {
    expect(webhookState('').configured).toBe(false);
    expect(webhookState('   ').configured).toBe(false);
    expect(webhookState('not-a-url').configured).toBe(false);
    const ok = webhookState('https://example.com/hook?token=secret');
    expect(ok.configured).toBe(true);
    expect(ok.detail).not.toContain('secret');
  });

  it('shouldAlert / exitCodeFor：warn 触发告警但不改退出码，fail 才 1', () => {
    expect(shouldAlert([{ level: 'ok' }])).toBe(false);
    expect(shouldAlert([{ level: 'ok' }, { level: 'warn' }])).toBe(true);
    expect(exitCodeFor([{ level: 'warn' }])).toBe(0);
    expect(exitCodeFor([{ level: 'warn' }, { level: 'fail' }])).toBe(1);
  });
});
