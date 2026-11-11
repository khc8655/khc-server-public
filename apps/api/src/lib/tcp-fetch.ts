import { connect } from 'cloudflare:sockets';

/**
 * Cloudflare Workers 的 fetch() 对裸 IP 一律返回 403 error 1003（与端口无关），
 * 因此 IP 直连 / 非标端口必须走 TCP socket（cloudflare:sockets）手写 HTTP/1.1。
 * 该实现对齐旧系统 backend/src/app.js 的 directTcpFetch()。
 *
 * TLS 证书口径（平台事实，勿凭旧文档推翻）：TCP 通道的 TLS 由平台强制校验证书
 * （secureTransport: 'on'，无 rejectUnauthorized:false 等价物），自签证书不可用；
 * 必须使用公网可信证书（含 IP 证书），否则退回 http://（仅限可信网络）或改用 Tunnel。
 */

/** TCP 通道超时（含建连+读）；类型化供上层区分"请求可能已送达"（R-3） */
export class TcpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TcpTimeoutError';
  }
}

export interface TcpFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1 << 20; // 1 MiB，配置 JSON 远小于此

export function isIpLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.startsWith('[') ||
    hostname.includes(':')
  );
}

/** 选路：裸 IP 一律 TCP；域名优先 fetch（支持自定义端口） */
export function chooseTransport(rawUrl: string): 'fetch' | 'tcp' {
  try {
    return isIpLiteral(new URL(rawUrl).hostname) ? 'tcp' : 'fetch';
  } catch {
    return 'fetch';
  }
}

function findCrlf(input: Uint8Array, from: number): number {
  for (let i = from; i < input.length - 1; i++) {
    if (input[i] === 13 && input[i + 1] === 10) return i;
  }
  return -1;
}

function findHeaderSplit(input: Uint8Array): number {
  for (let i = 0; i < input.length - 3; i++) {
    if (input[i] === 13 && input[i + 1] === 10 && input[i + 2] === 13 && input[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * chunked 解码按字节进行（B-1）：chunk size 是**字节数**，多字节 UTF-8 内容（中文等）
 * 若按字符串下标切会错位——"节"是 1 个 code unit 但 3 个字节，字符串切片必然取串。
 */
function decodeChunkedBytes(input: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const ascii = new TextDecoder();
  let index = 0;
  while (index < input.length) {
    const lineEnd = findCrlf(input, index);
    if (lineEnd < 0) break;
    const size = Number.parseInt(ascii.decode(input.slice(index, lineEnd)).trim(), 16);
    if (!Number.isFinite(size)) break;
    index = lineEnd + 2;
    if (size === 0) break;
    if (index + size > input.length) break;
    chunks.push(input.slice(index, index + size));
    index += size + 2;
  }
  return concatBytes(chunks);
}

/** 解析原始 HTTP/1.1 响应（Content-Length / chunked / close 三种）——按字节解析（B-1） */
export function parseHttpResponseBytes(raw: Uint8Array): Response {
  const split = findHeaderSplit(raw);
  if (split < 0) throw new Error('TCP 响应格式错误（缺少头部分隔符）');
  const head = new TextDecoder().decode(raw.slice(0, split));
  const rawBody = raw.slice(split + 4);
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = Number.parseInt(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine ?? '')?.[1] ?? '', 10);
  if (!Number.isFinite(status)) throw new Error(`TCP 响应状态行非法: ${statusLine ?? ''}`);

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  let body: Uint8Array = rawBody;
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunkedBytes(rawBody);
  } else if (headers['content-length']) {
    const length = Number.parseInt(headers['content-length'], 10);
    if (Number.isFinite(length)) body = rawBody.slice(0, length);
  }

  const contentType = headers['content-type'] ?? 'application/json';
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

/** 字符串入口（测试/兼容）：等价 UTF-8 编码后按字节解析 */
export function parseHttpResponse(raw: string): Response {
  return parseHttpResponseBytes(new TextEncoder().encode(raw));
}

function buildRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string,
): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostHeader = port === '80' || port === '443' ? url.hostname : `${url.hostname}:${port}`;
  const path = `${url.pathname || '/'}${url.search}`;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Connection: close',
    'Accept: application/json',
  ];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    lines.push(`${key}: ${value}`);
  }
  if (body) {
    lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  }
  lines.push('', body);
  return lines.join('\r\n');
}

/** 通过 cloudflare:sockets 发起原始 HTTP/TLS 请求 */
export async function tcpFetch(rawUrl: string, init: TcpFetchInit = {}): Promise<Response> {
  const url = new URL(rawUrl);
  const isTls = url.protocol === 'https:';
  const port = url.port ? Number.parseInt(url.port, 10) : isTls ? 443 : 80;
  const method = (init.method ?? 'GET').toUpperCase();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  const body = init.body ?? '';

  const socketOptions = {
    allowHalfOpen: false,
    ...(isTls ? { secureTransport: 'on' as const } : {}),
  };
  const socket = connect({ hostname: url.hostname, port }, socketOptions);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exchange = async (): Promise<Response> => {
    try {
      await socket.opened;
      const writer = socket.writable.getWriter();
      try {
        await writer.write(
          new TextEncoder().encode(buildRequest(url, method, init.headers ?? {}, body)),
        );
      } finally {
        writer.releaseLock();
      }

      const reader = socket.readable.getReader();
      const segments: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytes += value.length;
          if (bytes > maxBytes) throw new Error(`TCP 响应超过 ${maxBytes} 字节上限`);
          segments.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      // 按字节累积后再解析（B-1）：流式 TextDecoder 会把多字节字符提前转字符串，
      // chunked/Content-Length 的字节偏移就丢了；正文在字节层解析完再统一解码。
      return parseHttpResponseBytes(concatBytes(segments));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TCP 直连失败: ${message}`);
    }
  };

  try {
    return await Promise.race([
      exchange(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            void socket.close();
          } catch {
            // ignore
          }
          reject(new TcpTimeoutError(`TCP 连接超时（>${timeoutMs}ms）`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // 不要 await close()：对"SYN 被丢、连接一直挂着"的黑洞主机，socket.close() 会等到
    // 系统层 connect 超时才 resolve（实测 ~20s），于是超时定时器 3s 就触发了、
    // 请求却仍要陪跑满 20s —— 表现为 /nodes/probe 耗时 19.8s。
    // close() 本身是幂等的，这里只发起、不等待；连接资源由运行时回收。
    try {
      void socket.close();
    } catch {
      // ignore
    }
  }
}
