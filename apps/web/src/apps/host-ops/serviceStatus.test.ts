import { describe, expect, it } from 'vitest';
import { serviceRowTone, servicesTile } from './serviceStatus';

/**
 * 2026-11-20 真机走查：aws-hui-us 上 fwupd / fwupd-refresh / apt-daily-upgrade 三个
 * 发行版自带单元 failed，状态带摆出红色「3 个失败」、服务段三行全红 —— 面板修不了它们。
 * 这组用例把「红色只给受管单元」的口径钉住，防止以后又退回到全量计数。
 */
describe('serviceRowTone', () => {
  it('受管单元失败用 danger（面板能重启、能清失败标记）', () => {
    expect(serviceRowTone('khc-agent.service', 'failed')).toBe('danger');
    expect(serviceRowTone('caddy.service', 'failed')).toBe('danger');
    expect(serviceRowTone('wg-quick@wg0.service', 'failed')).toBe('danger');
    expect(serviceRowTone('khc-forward-app-2083.service', 'failed')).toBe('danger');
  });

  it('系统自带单元失败只给 warn（可见但不冒充待处理）', () => {
    expect(serviceRowTone('fwupd.service', 'failed')).toBe('warn');
    expect(serviceRowTone('apt-daily-upgrade.service', 'failed')).toBe('warn');
    expect(serviceRowTone('cloud-final.service', 'failed')).toBe('warn');
  });

  it('运行中与非失败状态照旧', () => {
    expect(serviceRowTone('fwupd.service', 'active')).toBe('ok');
    expect(serviceRowTone('fwupd.service', 'inactive')).toBe('neutral');
  });
});

describe('servicesTile', () => {
  it('读不到失败单元时显示未知，不显示正常', () => {
    expect(servicesTile(null)).toEqual({ value: '未知', tone: 'neutral' });
  });

  it('没有失败单元：正常', () => {
    expect(servicesTile([])).toEqual({ value: '正常', tone: 'neutral' });
  });

  it('只有系统单元失败：中性文字带条数，不是红色告警', () => {
    expect(servicesTile(['fwupd.service', 'apt-daily-upgrade.service'])).toEqual({
      value: '2 个系统单元失败',
      tone: 'neutral',
    });
  });

  it('受管单元失败：只数受管那条，并保持 danger', () => {
    expect(servicesTile(['fwupd.service', 'khc-agent.service'])).toEqual({
      value: '1 个失败',
      tone: 'danger',
    });
  });
});
