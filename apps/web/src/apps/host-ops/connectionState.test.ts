/**
 * 统一连接指示（2026-11-16 §4 / P-4 A）。
 *
 * 回归目标：原来「实时状态」卡片挂「直连」标签，让人以为主机运维也直连；
 * 实际只有指标走直连，主机运维一律经控制面。没有域名的节点照样能用主机运维。
 */
import { describe, expect, it } from 'vitest';
import { channelRows, connectionState } from './connectionState';
import type { HubPresence } from '../../data/channels';
import type { SnapshotMode, SnapshotStatus } from '../../data/snapshot';

function state(presence: HubPresence, mode: SnapshotMode, status: SnapshotStatus = 'live') {
  return connectionState({ presence }, { mode, status });
}

describe('connectionState 三态', () => {
  it('控制面不可达 → 离线（红色）', () => {
    const result = state('offline', 'none');
    expect(result.kind).toBe('offline');
    expect(result.label).toBe('离线');
    expect(result.tone).toBe('danger');
  });

  it('指标直连且正常 → 实时 · 直连（绿色）', () => {
    const result = state('managed-online', 'direct');
    expect(result.kind).toBe('direct');
    expect(result.label).toBe('实时 · 直连');
    expect(result.tone).toBe('ok');
  });

  it('直连降级（fallback）时不再声称直连', () => {
    const result = state('managed-online', 'direct', 'fallback');
    expect(result.label).toBe('实时 · 经控制面');
  });

  it('仅观测可达 → 直连但琥珀（能看不能操作）', () => {
    const result = state('live-only', 'direct');
    expect(result.kind).toBe('direct');
    expect(result.tone).toBe('warn');
  });

  it('指标走转发 → 实时 · 经控制面', () => {
    const result = state('managed-online', 'forward');
    expect(result.kind).toBe('forward');
    expect(result.label).toBe('实时 · 经控制面');
    expect(result.tone).toBe('ok');
  });

  it('没有可信域名（mode=none）→ 经控制面，不是离线', () => {
    const result = state('managed-online', 'none');
    expect(result.kind).toBe('forward');
    expect(result.label).toBe('实时 · 经控制面');
  });
});

describe('channelRows 通道说明', () => {
  it('主机运维与服务清单一律经控制面（与有无域名无关）', () => {
    const rows = channelRows({ mode: 'direct', status: 'live' });
    const ops = rows.find((row) => row.name.includes('主机运维'));
    const services = rows.find((row) => row.name.includes('服务清单'));
    expect(ops?.channel).toBe('经控制面');
    expect(services?.channel).toContain('经控制面');
  });

  it('指标在直连模式下标注浏览器直连', () => {
    const rows = channelRows({ mode: 'direct', status: 'live' });
    expect(rows[0]!.channel).toBe('浏览器直连');
  });

  it('指标走控制面时如实标注', () => {
    const rows = channelRows({ mode: 'forward', status: 'live' });
    expect(rows[0]!.channel).toBe('经控制面');
  });

  it('没有域名（mode=none）时主机运维仍是经控制面，不会变成不可用', () => {
    const rows = channelRows({ mode: 'none', status: 'disabled' });
    expect(rows[0]!.channel).toBe('经控制面');
    expect(rows.find((row) => row.name.includes('主机运维'))?.channel).toBe('经控制面');
    // 三行都在，说明通道清单不因离线而空
    expect(rows).toHaveLength(3);
  });
});
