import type { Env } from '../types';
import { AppError } from './errors';

/**
 * 控制通道安全约束：证书私钥（`$cert`）与 DNS 凭据（`$dnsCred`）会在 apply 时被展开成明文
 * 放进请求体（见 secret-refs.ts）。HMAC 只保证请求未被篡改，不提供保密性，所以只要节点的
 * 任一候选通道是明文 http，就拒绝下发这类材料，而不是静默发出去。
 */

/** 配置/参数里是否含有会被展开成密钥材料的引用。 */
export function containsSecretRefs(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretRefs);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$cert === 'string' || typeof record.$dnsCred === 'string') return true;
    return Object.values(record).some(containsSecretRefs);
  }
  return false;
}

function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url);
}

/**
 * 含密钥引用且节点存在明文候选通道（直连或隧道入口为 http://）时抛 400 `insecure_channel_secret`。
 * `ENVIRONMENT=development` 放行，方便本机用 http://127.0.0.1 调试。
 */
export function assertSecureChannelForSecrets(
  env: Pick<Env, 'ENVIRONMENT'>,
  node: { endpoint: string; tunnelEndpoint: string | null },
  ...values: unknown[]
): void {
  assertSecureChannel(env, node, values.some(containsSecretRefs));
}

/**
 * 请求体本身就是密钥材料（如把证书 PEM/私钥直接安装到节点）时使用：
 * 没有 `$cert` 这类占位符可检测，调用方明确知道这里有敏感内容。
 */
export function assertSecureChannelForRawSecrets(
  env: Pick<Env, 'ENVIRONMENT'>,
  node: { endpoint: string; tunnelEndpoint: string | null },
): void {
  assertSecureChannel(env, node, true);
}

function assertSecureChannel(
  env: Pick<Env, 'ENVIRONMENT'>,
  node: { endpoint: string; tunnelEndpoint: string | null },
  hasSecrets: boolean,
): void {
  if (env.ENVIRONMENT === 'development') return;
  if (!hasSecrets) return;
  const plain = [node.endpoint, node.tunnelEndpoint].filter(
    (url): url is string => typeof url === 'string' && url.length > 0 && !isHttps(url),
  );
  if (plain.length === 0) return;
  throw new AppError(
    400,
    'insecure_channel_secret',
    '该节点的控制通道含明文 http 入口，不会下发证书私钥或 DNS 凭据；请把入口改为 https（可信证书直连）或使用隧道后重试',
    undefined,
    { plainEndpoints: plain.length },
  );
}
