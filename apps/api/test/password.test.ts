import { describe, expect, it } from 'vitest';
import { hashPassword, timingSafeEqualString, verifyPassword } from '../src/lib/password';

describe('password (PBKDF2)', () => {
  it('哈希后可正确校验，错误口令不通过', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash.startsWith('pbkdf2$100000$')).toBe(true);
    await expect(verifyPassword('correct-horse-battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('同一口令两次哈希不同（随机 salt）', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('格式非法或过短迭代次数返回 false', async () => {
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
    await expect(verifyPassword('x', 'pbkdf2$1000$AAAA$AAAA')).resolves.toBe(false);
    await expect(verifyPassword('x', 'pbkdf2$100000$@@@$@@@')).resolves.toBe(false);
  });

  it('timingSafeEqualString 行为正确', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'ab')).toBe(false);
  });
});
