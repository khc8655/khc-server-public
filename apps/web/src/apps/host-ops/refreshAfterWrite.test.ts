/**
 * 写操作成功后的刷新（2026-11-16 §5 / N-3）。
 *
 * 回归目标：状态带「服务 N 个失败」来自打开页面时的 `/state`，重启成功后只重拉了
 * `svc.list`，计数停在旧值 —— 列表已经没失败单元，状态带却还显示 1。
 */
import { describe, expect, it, vi } from 'vitest';
import { hubStateQueryKey, refreshAfterWrite } from './refreshAfterWrite';

describe('hubStateQueryKey', () => {
  it('与 hubStateQueryOptions 同口径（hubs / <id> / state）', () => {
    expect(hubStateQueryKey('hub-1')).toEqual(['hubs', 'hub-1', 'state']);
  });

  it('不同节点不串键', () => {
    expect(hubStateQueryKey('a')).not.toEqual(hubStateQueryKey('b'));
  });
});

describe('refreshAfterWrite', () => {
  it('失效该节点的 /state，让失败计数重新拉取', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await refreshAfterWrite({ invalidateQueries }, 'hub-1');

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hubs', 'hub-1', 'state'] });
  });

  it('只失效目标节点，不动别的节点', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await refreshAfterWrite({ invalidateQueries }, 'hub-2');
    const call = invalidateQueries.mock.calls[0]![0] as { queryKey: string[] };
    expect(call.queryKey[1]).toBe('hub-2');
  });
});
