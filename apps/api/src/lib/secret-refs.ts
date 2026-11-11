import type { AppDeps } from '../types';
import { badRequest } from './errors';

/**
 * 配置/参数中的密钥引用（对适配器透明）：
 *   { "$cert": "cert_xxx" }   -> { domains, certPem, keyPem }
 *   { "$dnsCred": "dns.cf" }  -> 解密后的凭据对象
 * 递归解析；缺失时 400，不调用 Agent。
 */
export async function resolveSecretRefs(deps: AppDeps, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveSecretRefs(deps, item)));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$cert === 'string') {
      const material = await deps.certs.material(record.$cert);
      if (!material) throw badRequest('引用的证书不存在', { cert: record.$cert });
      return {
        domains: material.domains,
        certPem: material.certPem,
        keyPem: material.keyPem,
      };
    }
    if (typeof record.$dnsCred === 'string') {
      // 命名空间隔离：只允许引用 dns.* 前缀的凭据（安全批次 B）
      if (!record.$dnsCred.startsWith('dns.')) {
        throw badRequest('DNS 凭据引用必须以 dns. 前缀开头', { setting: record.$dnsCred });
      }
      const credential = await deps.settings.getValue(record.$dnsCred);
      if (credential === null) {
        throw badRequest('引用的凭据不存在', { setting: record.$dnsCred });
      }
      return credential;
    }
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      resolved[key] = await resolveSecretRefs(deps, item);
    }
    return resolved;
  }
  return value;
}
