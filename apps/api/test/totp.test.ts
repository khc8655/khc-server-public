import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpAt,
  verifyTotp,
  TOTP_PERIOD,
} from '../src/lib/totp';

/** RFC 6238 Appendix B 的 SHA1 secret（ASCII "12345678901234567890" 的 base32） */
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SECRET_ASCII = '12345678901234567890';

describe('TOTP（RFC 6238 / HMAC-SHA1）', () => {
  it('base32 编解码往返（RFC 4648，大写无 padding）', () => {
    expect(base32Encode(new TextEncoder().encode(RFC_SECRET_ASCII))).toBe(RFC_SECRET_B32);
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET_B32))).toBe(RFC_SECRET_ASCII);
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
    expect(new TextDecoder().decode(base32Decode('MZXW6YTBOI'))).toBe('foobar');
  });

  it('非法 base32 字符返回空；大小写归一化', () => {
    expect(base32Decode('ABC0').length).toBe(0);
    expect(base32Decode('ABC1').length).toBe(0);
    expect(base32Decode('ABC!').length).toBe(0);
    expect(base32Decode('abc').length).toBeGreaterThan(0);
  });

  it('RFC 6238 Appendix B 测试向量（SHA1 / 6 位）', async () => {
    expect(await totpAt(RFC_SECRET_B32, 59)).toBe('287082');
    expect(await totpAt(RFC_SECRET_B32, 1111111109)).toBe('081804');
    expect(await totpAt(RFC_SECRET_B32, 1234567890)).toBe('005924');
  });

  it('30s 时间窗 ±1 步容差，超出窗口拒绝', async () => {
    const code = await totpAt(RFC_SECRET_B32, 59);
    expect(await verifyTotp(RFC_SECRET_B32, code, 59)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, code, 59 + TOTP_PERIOD)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, code, 59 - TOTP_PERIOD)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, code, 59 + 2 * TOTP_PERIOD)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, code, 59 - 2 * TOTP_PERIOD)).toBe(false);
  });

  it('错误码 / 非 6 位 / 非数字 / 非法 secret 一律拒绝', async () => {
    const code = await totpAt(RFC_SECRET_B32, 59);
    const wrong = await totpAt(RFC_SECRET_B32, 59 + 10 * TOTP_PERIOD);
    expect(wrong).not.toBe(code);
    expect(await verifyTotp(RFC_SECRET_B32, wrong, 59)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '00000', 59)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '2870822', 59)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '28708a', 59)).toBe(false);
    expect(await verifyTotp('BAD!', code, 59)).toBe(false);
    expect(await verifyTotp('', code, 59)).toBe(false);
  });

  it('generateTotpSecret 随机 20 字节 → 32 字符 base32，两次不同', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
  });

  it('otpauth URI 含 secret/issuer/algorithm/digits/period', () => {
    const uri = buildOtpauthUri(RFC_SECRET_B32);
    expect(uri.startsWith('otpauth://totp/khc-server:admin?')).toBe(true);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET_B32);
    expect(parsed.searchParams.get('issuer')).toBe('khc-server');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});
