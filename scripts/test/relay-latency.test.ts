import { describe, expect, it } from 'vitest';
import {
  cookieValue,
  median,
  parseServerTiming,
  renderMarkdown,
  sessionCookie,
  summarize,
} from '../lib/relay-latency.mjs';

describe('relay-latency 纯函数', () => {
  it('parseServerTiming 解析完整头并容错缺失/格式错误项', () => {
    expect(parseServerTiming(null)).toEqual({});
    expect(parseServerTiming('')).toEqual({});

    const parsed = parseServerTiming(
      'auth;dur=12.0;desc="n=1", d1;dur=280.4;desc="n=3", broken;dur=nope, agent;dur=1402.7;desc="n=1 tcp", total;dur=1731.2',
    );
    expect(parsed).toEqual({
      auth: { dur: 12.0, count: 1, tokens: [] },
      d1: { dur: 280.4, count: 3, tokens: [] },
      agent: { dur: 1402.7, count: 1, tokens: ['tcp'] },
      total: { dur: 1731.2, count: null, tokens: [] },
    });
  });

  it('median 处理空数组、奇数、偶数与非法数字', () => {
    expect(median([])).toBeNull();
    expect(median([NaN])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
  });

  it('sessionCookie 只提取非空 khc_sess=...', () => {
    expect(sessionCookie(null)).toBeNull();
    const fakeHeadersEmpty = { getSetCookie: () => ['khc_sess=; Path=/; Max-Age=0', 'other=1'] };
    expect(sessionCookie(fakeHeadersEmpty)).toBeNull();

    const fakeHeadersReal = {
      getSetCookie: () => [
        'other=abc; HttpOnly',
        'khc_sess=token.sig; Path=/; HttpOnly; Secure',
      ],
    };
    expect(sessionCookie(fakeHeadersReal)).toBe('khc_sess=token.sig');
  });

  it('summarize 单列首次、计算稳态中位数与 edge、汇总状态/通道/缺头数', () => {
    const s = summarize('a.18888.bond', 'GET /nodes/hub/state', [
      { wallMs: 2000, status: 200, header: 'auth;dur=20.0;desc="n=1", total;dur=1500.0' },
      { wallMs: 900, status: 200, header: 'auth;dur=2.0;desc="n=1", d1;dur=100.0;desc="n=1", agent;dur=600.0;desc="n=1 fetch", total;dur=710.0' },
      { wallMs: 1100, status: 200, header: 'auth;dur=4.0;desc="n=1", d1;dur=120.0;desc="n=1", agent;dur=700.0;desc="n=1 tcp", total;dur=830.0' },
      { wallMs: 1000, status: 502, header: null },
    ]);

    expect(s.count).toBe(4);
    expect(s.firstMs).toBe(2000);
    expect(s.wallMedianMs).toBe(1000);
    expect(s.totalMedianMs).toBe(770); // median([710, 830])
    expect(s.authMedianMs).toBe(3); // median([2, 4])
    expect(s.d1MedianMs).toBe(110);
    expect(s.agentMedianMs).toBe(650);
    expect(s.edgeMedianMs).toBe(230); // median([190, 270])
    expect(s.statuses).toEqual([200, 502]);
    expect(s.vias).toEqual(['fetch', 'tcp']);
    expect(s.missingHeaders).toBe(1);
  });

  it('renderMarkdown 缺值显示 — 且缺头写入状态列并附表末提示', () => {
    const md = renderMarkdown([
      {
        entry: 'panel.example.com',
        endpoint: 'GET /api/v1/nodes',
        count: 2,
        firstMs: 1200,
        wallMedianMs: 450,
        totalMedianMs: null,
        authMedianMs: null,
        d1MedianMs: null,
        agentMedianMs: null,
        edgeMedianMs: null,
        statuses: [200],
        vias: [],
        missingHeaders: 2,
      },
    ]);

    expect(md).toContain('| panel.example.com | GET /api/v1/nodes | 2 | 1200.0 | 450.0 | — | — | — | — | — | 200（缺头×2） | — |');
    expect(md).toContain('Workers Logs');
  });

  it('cookieValue 提取最新非空 Cookie，空值或 Max-Age=0 返回 null', () => {
    const fakeHeaders = {
      getSetCookie: () => [
        'khc_d1bm=bm-old; Path=/api; HttpOnly',
        'khc_d1bm=bm-new; Path=/api; Max-Age=28800; HttpOnly',
        'khc_sess=; Path=/; Max-Age=0',
      ],
    };
    expect(cookieValue(fakeHeaders, 'khc_d1bm')).toBe('khc_d1bm=bm-new');
    expect(cookieValue(fakeHeaders, 'khc_sess')).toBeNull();

    const clearedHeaders = {
      getSetCookie: () => ['khc_d1bm=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'],
    };
    expect(cookieValue(clearedHeaders, 'khc_d1bm')).toBeNull();
  });

  it('summarize 对有效头中因缓存命中省略的 d1/agent 按 0 计入中位数，缺头不计，未出现的段仍为 null', () => {
    const s = summarize('a.18888.bond', 'GET /nodes/hub/snapshot', [
      { wallMs: 900, status: 200, header: 'auth;dur=0.0;desc="n=1", d1;dur=220.0;desc="n=2", agent;dur=100.0;desc="n=1 fetch", total;dur=320.0' },
      { wallMs: 400, status: 200, header: 'auth;dur=40.0;desc="n=1", d1;dur=80.0;desc="n=2", agent;dur=57.0;desc="n=1 fetch", total;dur=137.0' },
      { wallMs: 310, status: 200, header: 'auth;dur=0.0;desc="n=1", agent;dur=25.0;desc="n=1 fetch", total;dur=25.0' },
      { wallMs: 312, status: 200, header: 'auth;dur=0.0;desc="n=1", agent;dur=25.0;desc="n=1 fetch", total;dur=25.0' },
      { wallMs: 314, status: 200, header: 'auth;dur=0.0;desc="n=1", agent;dur=24.0;desc="n=1 fetch", total;dur=24.0' },
      { wallMs: 320, status: 200, header: 'auth;dur=0.0;desc="n=1", agent;dur=27.0;desc="n=1 fetch", total;dur=27.0' },
      { wallMs: 500, status: 502, header: null },
    ]);

    // 5 个有效头稳态样本的 d1 为 [80, 0, 0, 0, 0] -> 中位数 0；缺头样本不参与
    expect(s.totalMedianMs).toBe(25);
    expect(s.d1MedianMs).toBe(0);
    expect(s.d1MedianMs).toBeLessThanOrEqual(s.totalMedianMs!);
    expect(s.agentMedianMs).toBe(25);

    // 稳态样本从未出现 agent（如纯 D1 接口），仍应为 null 而非 0
    const pureD1 = summarize('a.18888.bond', 'GET /api/v1/nodes', [
      { wallMs: 500, status: 200, header: 'auth;dur=0.0;desc="n=1", d1;dur=50.0;desc="n=2", total;dur=50.0' },
      { wallMs: 360, status: 200, header: 'auth;dur=0.0;desc="n=1", d1;dur=46.0;desc="n=2", total;dur=46.0' },
    ]);
    expect(pureD1.agentMedianMs).toBeNull();
  });
});
