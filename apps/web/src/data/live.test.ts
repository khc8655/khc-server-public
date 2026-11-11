import { describe, expect, it } from 'vitest';
import { LIVE_STALE_MS, buildLiveSseUrl, isLiveStreamStale } from './live';

describe('buildLiveSseUrl', () => {
  it('https 保持 https，拼接 livePath 与 ticket 查询串', () => {
    expect(buildLiveSseUrl('https://hub.example.com', '/_live/', 'abc.def123')).toBe(
      'https://hub.example.com/_live/?ticket=abc.def123',
    );
  });

  it('http 保持 http，忽略原 endpoint 的 query/hash，ticket 会被编码', () => {
    expect(buildLiveSseUrl('http://198.51.100.10:8443/?x=1#y', '/_live/', 'a.b+c/d')).toBe(
      'http://198.51.100.10:8443/_live/?ticket=a.b%2Bc%2Fd',
    );
  });
});

describe('isLiveStreamStale', () => {
  it('超过阈值没有新帧视为静默断链', () => {
    expect(isLiveStreamStale(1_000, 1_000 + LIVE_STALE_MS + 1)).toBe(true);
  });

  it('阈值内仍有新帧时不算断链', () => {
    expect(isLiveStreamStale(1_000, 1_000 + LIVE_STALE_MS)).toBe(false);
  });

  it('从未收到过帧（null）不触发自动重连', () => {
    expect(isLiveStreamStale(null, Date.now())).toBe(false);
  });
});
