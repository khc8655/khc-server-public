import type { Node } from '@khc/contracts';

/**
 * 节点接入地址（域名模式）的唯一构造/解析入口。
 *
 * 生产环境控制面强制 https（apps/api/src/routes/nodes.ts assertProductionTls），
 * 域名模式必须给出 `https://<域名>[:端口]`；端口默认 443（URL 里省略），
 * 只提供 Cloudflare 可代理的 HTTPS 端口 + 常用的 8443（需 DNS only 直连）。
 */
export const HTTPS_PORT_OPTIONS = ['443', '8443', '2053', '2083', '2087', '2096'] as const;

/** 能走 Cloudflare 代理（橙云）的 HTTPS 端口；其余端口需要 DNS only。 */
export const CF_PROXIED_HTTPS_PORTS = ['443', '2053', '2083', '2087', '2096'] as const;

/** 域名 → https 接入地址；443 省略端口，避免 `https://x:443` 这类冗余。 */
export function buildDomainEndpoint(domain: string, port: string): string {
  const host = normalizeDomain(domain);
  const clean = port.trim();
  return clean && clean !== '443' ? `https://${host}:${clean}` : `https://${host}`;
}

/** 用户输入的域名可能带协议/路径，统一取 host（小写、去尾点）。 */
export function normalizeDomain(input: string): string {
  const text = input.trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return text
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split('/')[0]!
      .split(':')[0]!
      .toLowerCase()
      .replace(/\.$/, '');
  }
}

/** 从已有 endpoint 拆出域名模式表单的初值。 */
export function parseDomainEndpoint(endpoint: string): { domain: string; port: string } | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return null;
    if (/^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return { domain: url.hostname.toLowerCase(), port: url.port || '443' };
  } catch {
    return null;
  }
}

/** 域名是否指向某个节点的绑定域名（用于解析记录占用提示）。 */
export function nodeByDomain(nodes: Node[], domain: string): Node | null {
  const target = normalizeDomain(domain);
  if (!target) return null;
  return nodes.find((node) => node.domain && normalizeDomain(node.domain) === target) ?? null;
}

/** endpoint 的 host；非法输入返回空串。 */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 自定义入口是否应写入 nodes.domain：只有 https 的域名入口才绑定。 */
export function domainFromEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (/^[0-9.]+$/.test(host) || host.includes(':') || host === 'localhost') return null;
    return host;
  } catch {
    return null;
  }
}
