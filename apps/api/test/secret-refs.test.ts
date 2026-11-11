import { describe, it, expect } from 'vitest';
import { resolveSecretRefs } from '../src/lib/secret-refs';
import type { AppDeps } from '../src/types';

describe('secret-refs: 密钥引用解析', () => {
  const mockDeps: AppDeps = {
    certs: {
      material: async (id: string) => {
        if (id === 'cert_123') {
          return {
            domains: ['example.com'],
            certPem: '--- CERT ---',
            keyPem: '--- KEY ---',
          };
        }
        return null;
      },
    } as any,
    settings: {
      getValue: async (key: string) => {
        if (key === 'dns.cloudflare') {
          return { apiToken: 'test-token' };
        }
        if (key === 'internal.secret') {
          return { password: 'should-not-leak' };
        }
        return null;
      },
    } as any,
  } as any;

  describe('$cert 引用', () => {
    it('存在的证书 → 解析为 PEM 材料', async () => {
      const result = await resolveSecretRefs(mockDeps, { $cert: 'cert_123' });
      expect(result).toEqual({
        domains: ['example.com'],
        certPem: '--- CERT ---',
        keyPem: '--- KEY ---',
      });
    });

    it('不存在的证书 → 400', async () => {
      await expect(resolveSecretRefs(mockDeps, { $cert: 'cert_missing' })).rejects.toThrow('引用的证书不存在');
    });
  });

  describe('$dnsCred 引用', () => {
    it('dns.* 前缀的凭据 → 解析成功', async () => {
      const result = await resolveSecretRefs(mockDeps, { $dnsCred: 'dns.cloudflare' });
      expect(result).toEqual({ apiToken: 'test-token' });
    });

    it('非 dns.* 前缀的 settings → 拒绝（命名空间隔离，安全批次 B）', async () => {
      await expect(resolveSecretRefs(mockDeps, { $dnsCred: 'internal.secret' })).rejects.toThrow(
        'DNS 凭据引用必须以 dns. 前缀开头'
      );
    });

    it('不存在的 dns.* 凭据 → 400', async () => {
      await expect(resolveSecretRefs(mockDeps, { $dnsCred: 'dns.missing' })).rejects.toThrow('引用的凭据不存在');
    });
  });

  describe('递归解析', () => {
    it('嵌套对象中的引用', async () => {
      const input = {
        provider: 'cloudflare',
        credentials: { $dnsCred: 'dns.cloudflare' },
      };
      const result = await resolveSecretRefs(mockDeps, input);
      expect(result).toEqual({
        provider: 'cloudflare',
        credentials: { apiToken: 'test-token' },
      });
    });

    it('数组中的引用', async () => {
      const input = [{ $dnsCred: 'dns.cloudflare' }, { plain: 'value' }];
      const result = await resolveSecretRefs(mockDeps, input);
      expect(result).toEqual([{ apiToken: 'test-token' }, { plain: 'value' }]);
    });
  });
});
