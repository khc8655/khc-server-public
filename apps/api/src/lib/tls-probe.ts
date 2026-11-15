/**
 * 控制面实测的 TLS 结论（纯函数，便于单测）。
 *
 * 为什么不去读证书字段：Workers 的 `fetch` 与 `cloudflare:sockets` 都不暴露对端证书
 * （拿不到 subject/issuer/notAfter）。但平台对 https 请求做**完整且不可关闭**的校验，
 * 于是「探测成功」与「证书有效」是等价的强证据，且适用于 TLS 由外部反代 / Caddy /
 * Cloudflare Tunnel 终结、Agent 本机根本没有证书文件的节点——那正是面板误报
 * 「未签发」的场景。
 *
 * 反过来，探测失败要区分「证书类失败」与「网络类失败」：前者能断言证书有问题，
 * 后者只能说未知，不能顺势报成证书故障。
 */
import type { TlsProbe } from '@khc/contracts';

/** 与 `describeChannelError` 的中文口径一致（它会把证书类错误改写成「证书校验失败…」）。 */
const TLS_FAILURE_RE =
  /证书校验失败|certificate|\bcert\b|self[- ]?signed|\btls\b|tls[_-]?error|\bssl\b|ssl[_-]?error/i;

export interface TlsProbeInput {
  /** 本次实际使用的接入地址（直连 endpoint 或隧道地址） */
  endpoint: string | null;
  /** Agent 调用是否拿到响应（拿到即代表 TLS 握手通过） */
  reachable: boolean;
  /** 不可达时的错误原文 */
  error?: string | null;
  now?: number;
}

export function classifyTlsProbe(input: TlsProbeInput): TlsProbe {
  const checkedAt = input.now ?? Math.floor(Date.now() / 1000);
  const endpoint = input.endpoint ?? '';
  let protocol = '';
  try {
    protocol = new URL(endpoint).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:') {
    // http 明文接入：这里是「未启用 TLS」，与「证书没签」是两件事，不能混报。
    return { state: 'none', endpoint, detail: null, checkedAt };
  }
  if (input.reachable) {
    return { state: 'verified', endpoint, detail: null, checkedAt };
  }
  const detail = input.error ?? null;
  if (detail && TLS_FAILURE_RE.test(detail)) {
    return { state: 'failed', endpoint, detail, checkedAt };
  }
  return { state: 'unknown', endpoint, detail, checkedAt };
}
