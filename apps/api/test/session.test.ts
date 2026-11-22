import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_EPOCH_KEY,
  bumpSessionEpoch,
  readSessionEpoch,
  signSession,
  verifySession,
} from '../src/lib/session';
import { MemorySettingsRepo } from './helpers/memory';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const now = Math.floor(Date.now() / 1000);
const base = { sub: 'admin', iat: now, exp: now + 3600 };

describe('会话版本（ver）与撤销', () => {
  it('payload 携带 ver，verifySession 回传 ver', async () => {
    const token = await signSession(SECRET, { ...base, ver: 3 });
    expect(await verifySession(SECRET, token, 3)).toMatchObject({ sub: 'admin', ver: 3 });
  });

  it('旧 token（无 ver）在 epoch 0 按 0 处理，保持兼容', async () => {
    const token = await signSession(SECRET, base);
    const parsed = await verifySession(SECRET, token);
    expect(parsed).not.toBeNull();
    expect(parsed?.ver).toBe(0);
  });

  it('epoch 变更后旧 token 失效，新 token 生效', async () => {
    const oldToken = await signSession(SECRET, { ...base, ver: 0 });
    expect(await verifySession(SECRET, oldToken, 0)).not.toBeNull();
    expect(await verifySession(SECRET, oldToken, 1)).toBeNull();
    const newToken = await signSession(SECRET, { ...base, ver: 1 });
    expect(await verifySession(SECRET, newToken, 1)).not.toBeNull();
  });

  it('ver 与当前 epoch 不一致（更高或更低）一律拒绝', async () => {
    const token = await signSession(SECRET, { ...base, ver: 5 });
    expect(await verifySession(SECRET, token, 5)).not.toBeNull();
    expect(await verifySession(SECRET, token, 4)).toBeNull();
    expect(await verifySession(SECRET, token, 6)).toBeNull();
  });

  it('篡改签名 / 过期仍被拒', async () => {
    const token = await signSession(SECRET, { ...base, ver: 1 });
    expect(await verifySession(SECRET, `${token}x`, 1)).toBeNull();
    const expired = await signSession(SECRET, {
      sub: 'admin',
      iat: now - 100,
      exp: now - 10,
      ver: 1,
    });
    expect(await verifySession(SECRET, expired, 1)).toBeNull();
  });

  it('readSessionEpoch 缺省/非法回退 0；bumpSessionEpoch 递增并落 settings', async () => {
    const settings = new MemorySettingsRepo();
    expect(await readSessionEpoch(settings)).toBe(0);
    expect(await bumpSessionEpoch(settings)).toBe(1);
    expect(await settings.getValue(SESSION_EPOCH_KEY)).toBe(1);
    expect(await readSessionEpoch(settings)).toBe(1);
    expect(await bumpSessionEpoch(settings)).toBe(2);
    expect(await readSessionEpoch(settings)).toBe(2);
    await settings.put(SESSION_EPOCH_KEY, 'garbage');
    expect(await readSessionEpoch(settings, { bypassCache: true })).toBe(0);
    const badRepo = new MemorySettingsRepo();
    await badRepo.put(SESSION_EPOCH_KEY, 'garbage');
    expect(await readSessionEpoch(badRepo)).toBe(0);
  });

  it('readSessionEpoch 在 15 秒内按 SettingsRepo 隔离缓存，bumpSessionEpoch 立即更新缓存', async () => {
    const repoA = new MemorySettingsRepo();
    const repoB = new MemorySettingsRepo();
    await repoB.put(SESSION_EPOCH_KEY, 9);
    const spyA = vi.spyOn(repoA, 'getValue');

    expect(await readSessionEpoch(repoA)).toBe(0);
    expect(await readSessionEpoch(repoA)).toBe(0);
    expect(spyA).toHaveBeenCalledTimes(1);

    // 另一仓库实例不共享缓存
    expect(await readSessionEpoch(repoB)).toBe(9);

    // bumpSessionEpoch 绕过旧缓存并立即写入新版本
    expect(await bumpSessionEpoch(repoA)).toBe(1);
    expect(spyA).toHaveBeenCalledTimes(2);
    expect(await readSessionEpoch(repoA)).toBe(1);
    expect(spyA).toHaveBeenCalledTimes(2);
  });
});
