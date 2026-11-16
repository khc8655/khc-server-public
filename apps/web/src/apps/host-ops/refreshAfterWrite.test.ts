/**
 * 写操作成功后的刷新（2026-11-16 §5 / N-3）。
 *
 * 回归目标：状态带「服务 N 个失败」来自打开页面时的 `/state`，重启成功后只重拉了
 * `svc.list`，计数停在旧值。真机还发现 Agent 侧 ops 有 5 秒缓存，单纯 invalidate
 * 仍会读到旧值 —— 所以必须带 force=1 重新拉取。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hubStateQueryKey, refreshAfterWrite } from './refreshAfterWrite';

const fetchHubState = vi.fn();
vi.mock('../../data/hubs', () => ({
  fetchHubState: (...args: unknown[]) => fetchHubState(...args),
}));

beforeEach(() => {
  fetchHubState.mockReset();
});

describe('hubStateQueryKey', () => {
  it('与 hubStateQueryOptions 同口径（hubs / <id> / state）', () => {
    expect(hubStateQueryKey('hub-1')).toEqual(['hubs', 'hub-1', 'state']);
  });

  it('不同节点不串键', () => {
    expect(hubStateQueryKey('a')).not.toEqual(hubStateQueryKey('b'));
  });
});

describe('refreshAfterWrite', () => {
  it('带 force=1 重新拉 /state 并写入缓存（绕过 Agent 5 秒缓存）', async () => {
    const state = { ok: true, state: { ops: { services: { failedUnits: [] } } } };
    fetchHubState.mockResolvedValue(state);
    const setQueryData = vi.fn();
    const invalidateQueries = vi.fn();

    await refreshAfterWrite({ setQueryData, invalidateQueries }, 'hub-1');

    // 关键：必须带 force，否则会落进 Agent 的缓存窗口
    expect(fetchHubState).toHaveBeenCalledWith('hub-1', { force: true });
    expect(setQueryData).toHaveBeenCalledWith(['hubs', 'hub-1', 'state'], state);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('拉取失败时退回 invalidate，不把异常抛给写操作收尾', async () => {
    fetchHubState.mockRejectedValue(new Error('boom'));
    const setQueryData = vi.fn();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await expect(
      refreshAfterWrite({ setQueryData, invalidateQueries }, 'hub-1'),
    ).resolves.toBeUndefined();

    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hubs', 'hub-1', 'state'] });
  });
});
