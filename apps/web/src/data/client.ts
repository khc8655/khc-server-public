import { apiErrorSchema } from '@khc/contracts';
import { assertHubWriteAllowed } from './writeGuard';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 写方法一律按 JSON 发送：浏览器对无 body 的 POST/DELETE 仍会带空 body 流。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 统一请求封装：同源 Cookie、JSON、契约化错误 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertHubWriteAllowed(path, init);
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  const isWrite = WRITE_METHODS.has(method);
  if (!headers.has('content-type') && (isWrite || init.body != null)) {
    headers.set('content-type', 'application/json');
  }
  // 无 body 的写请求也发空 JSON：Worker 以「有 body」判定需要 content-type，
  // 浏览器/Curl 对无 body 的 POST/DELETE 仍会给出非空空流，只补头仍可能被判 415。
  const body = isWrite && init.body == null ? '{}' : init.body;

  const res = await fetch(path, {
    ...init,
    body,
    headers,
    credentials: 'same-origin',
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    if (parsed.success) {
      throw new ApiError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.fields,
      );
    }
    throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
  }

  return data as T;
}
