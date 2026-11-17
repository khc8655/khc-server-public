import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOST_OPS_CHANNELS, NODE_CHANNELS, hostOpsChannel, isDirectChannel } from '../src/index';

/**
 * ADR-0020 的一致性校验：contracts 里的 `HOST_OPS_CHANNELS` 必须与
 * `agent/adapters/host_ops/khc_host.py` 的 `CHANNELS` 完全一致。
 *
 * 两边是两份独立的声明（一份 TS 一份 Python），靠测试锁住不漂移。
 * 之所以不引入代码生成：这里只有 18 个动词，一个测试比一套生成流程更轻，
 * 而且失败信息能直接指出是哪个动词不一致。
 */

const here = dirname(fileURLToPath(import.meta.url));
// 本文件在 packages/contracts/test/，仓库根在上三层
const PY_SOURCE = resolve(here, '../../../agent/adapters/host_ops/khc_host.py');

/** 从 Python 源里抠出 CHANNELS 字典（形如 `    "verb": "channel",`）。 */
function readPythonChannels(): Record<string, string> {
  const source = readFileSync(PY_SOURCE, 'utf8');
  const start = source.indexOf('\nCHANNELS = {');
  if (start < 0) throw new Error('khc_host.py 里找不到 CHANNELS');
  const end = source.indexOf('}', start);
  if (end < 0) throw new Error('CHANNELS 字典没有闭合');

  const body = source.slice(start, end);
  const channels: Record<string, string> = {};
  // 只认「整行就是 key: value」的条目，注释与 docstring 里的冒号不会命中
  for (const line of body.split('\n')) {
    const match = /^\s*"([^"]+)":\s*"([^"]+)",?\s*$/.exec(line);
    if (match) channels[match[1]] = match[2];
  }
  return channels;
}

describe('ADR-0020 通道分类', () => {
  it('contracts 与 Agent 的 CHANNELS 完全一致', () => {
    const python = readPythonChannels();
    expect(Object.keys(python).length).toBeGreaterThan(0);
    expect(HOST_OPS_CHANNELS).toEqual(python);
  });

  it('类别只用三个合法值', () => {
    for (const [verb, channel] of Object.entries(HOST_OPS_CHANNELS)) {
      expect(NODE_CHANNELS, `动词 ${verb} 的类别 ${channel} 不合法`).toContain(channel);
    }
  });

  it('写动词一律是 control（写操作绝不能有直连通路）', () => {
    const writeVerbs = [
      'fw.apply',
      'fw.confirm',
      'keys.add',
      'keys.remove',
      'svc.restart',
      'svc.reset-failed',
      'cron.set',
      'cleanup',
    ];
    for (const verb of writeVerbs) {
      expect(HOST_OPS_CHANNELS[verb], `写动词 ${verb} 必须是 control`).toBe('control');
    }
  });

  it('公钥清单与日志不进直连（ADR-0020 §3）', () => {
    for (const verb of ['keys.list', 'svc.logs', 'logs.errors']) {
      expect(isDirectChannel(hostOpsChannel(verb)), `${verb} 不应允许直连`).toBe(false);
    }
  });

  it('未知动词按 control 处理（最保守）', () => {
    expect(hostOpsChannel('some.new.verb')).toBe('control');
  });

  it('isDirectChannel 只放行 observe 与 ops-read', () => {
    expect(isDirectChannel('observe')).toBe(true);
    expect(isDirectChannel('ops-read')).toBe(true);
    expect(isDirectChannel('control')).toBe(false);
  });
});
