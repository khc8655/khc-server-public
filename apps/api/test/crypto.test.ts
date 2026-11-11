import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENC_KEY_ID,
  decryptSecret,
  encryptSecret,
  newNodeToken,
} from '../src/lib/crypto';

const SECRET = 'test-master-key-0123456789';
const PREVIOUS = 'old-master-key-9876543210xyz';

describe('crypto: AES-GCM 敏感字段加密', () => {
  it('加密后可解密，且每次 IV 不同', async () => {
    const secret = 'test-master-key-0123456789';
    const a = await encryptSecret(secret, 'node-token-value');
    const b = await encryptSecret(secret, 'node-token-value');
    expect(a).not.toBe(b);
    expect(await decryptSecret(secret, a)).toBe('node-token-value');
    expect(await decryptSecret(secret, b)).toBe('node-token-value');
  });

  it('错误密钥无法解密', async () => {
    const payload = await encryptSecret('test-master-key-0123456789', 'x');
    await expect(decryptSecret('another-master-key-9876543210', payload)).rejects.toBeTruthy();
  });

  it('token 随机且足够长', () => {
    const a = newNodeToken();
    const b = newNodeToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });
});

describe('crypto: A-11 v2 keyId 前缀与旧格式兼容', () => {
  it('v2 密文带 enc:v2:<keyId>: 前缀（缺省 keyId = k1），可解密', async () => {
    const payload = await encryptSecret(SECRET, 'node-token-value');
    expect(payload.startsWith(`enc:v2:${DEFAULT_ENC_KEY_ID}:`)).toBe(true);
    expect(await decryptSecret(SECRET, payload)).toBe('node-token-value');
  });

  it('显式 keyId 写进前缀（轮换后新行标 k2）', async () => {
    const payload = await encryptSecret(SECRET, 'value-2', { keyId: 'k2' });
    expect(payload.startsWith('enc:v2:k2:')).toBe(true);
    expect(await decryptSecret(SECRET, payload)).toBe('value-2');
  });

  it('兼容旧的无前缀行（iv.cipher 裸格式）', async () => {
    const legacy = await encryptSecret(SECRET, 'legacy-value');
    // 手工剥掉 v2 前缀，模拟历史行
    const stripped = legacy.replace(/^enc:v2:[^:]+:/, '');
    expect(stripped.startsWith('enc:')).toBe(false);
    expect(await decryptSecret(SECRET, stripped)).toBe('legacy-value');
  });

  it('轮换场景：旧钥加密的行用「当前钥+previousKey」可解', async () => {
    const oldRow = await encryptSecret(PREVIOUS, 'rotated-row', { keyId: 'k1' });
    // 当前钥解不开 → 回退旧钥
    expect(await decryptSecret(SECRET, oldRow, { previousKey: PREVIOUS })).toBe('rotated-row');
  });

  it('轮换后未配置旧钥：报 503 且提示配置 MASTER_ENC_KEY_PREVIOUS', async () => {
    const oldRow = await encryptSecret(PREVIOUS, 'row', { keyId: 'k1' });
    const failure = await decryptSecret(SECRET, oldRow).catch((error: unknown) => error);
    expect(failure).toHaveProperty('status', 503);
    expect(String((failure as Error).message)).toContain('MASTER_ENC_KEY_PREVIOUS');
  });

  it('当前钥与旧钥都不匹配时明确报错', async () => {
    const row = await encryptSecret('totally-different-key-abcdef', 'row', { keyId: 'k1' });
    await expect(decryptSecret(SECRET, row, { previousKey: PREVIOUS })).rejects.toThrow(
      /旧钥也不匹配/,
    );
  });
});
