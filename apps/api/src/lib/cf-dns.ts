import { AppError } from './errors';

/**
 * Cloudflare DNS API v4 最小客户端（#E1 / 第 5 步）。
 * 只实现 Token 校验、Zone 查询与单条 A/AAAA 记录增删；fetch 可注入（测试 mock，
 * 不触达真实 CF API）。错误统一分类为 AppError：
 * - cf_dns_auth        Token 无效或被禁用
 * - cf_dns_permission  Token 权限不足（含缺失的权限名提示）
 * - cf_dns_zone        Zone 不存在或不可读
 * - cf_dns_conflict    记录冲突（同名记录已存在且非面板托管）
 * - cf_dns_network     网络失败 / 超时（8s）
 * - cf_dns_api         CF 侧其他错误（带原始 code/message）
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 8000;
/**
 * 面板托管记录的唯一标记：comment（不使用 tags——最小权限 Token
 * "Zone→DNS→Edit + Zone→Zone→Read" 不含 record tags 配额，带 tags 会被
 * CF 拒绝 "exceeding the quota of 0"，见 F-L1）。联动删除按 D1 登记的
 * recordId 进行，不依赖该标记。
 */
export const KHC_RECORD_COMMENT = 'khc-server managed';

export interface CfFetchResult {
  status: number;
  body: CfApiBody;
}

export interface CfApiBody {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  result_info?: { page?: number; total_pages?: number; count?: number; total_count?: number };
}

/** 注入式 fetch：生产用全局 fetch，测试用 mock。 */
export type CfFetch = (url: string, init: RequestInit) => Promise<CfFetchResult>;

export const defaultCfFetch: CfFetch = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await response.json().catch(() => ({}))) as CfApiBody;
  return { status: response.status, body };
};

function authHeaders(token: string): RequestInit {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  };
}

function firstError(body: CfApiBody): string {
  return body.errors?.[0]?.message ?? '未知错误';
}

function firstErrorCode(body: CfApiBody): number | undefined {
  return body.errors?.[0]?.code;
}

/** 网络/超时 → cf_dns_network；其余按状态码与 CF 错误码分类。 */
function classify(status: number, body: CfApiBody): AppError {
  const message = firstError(body);
  const code = firstErrorCode(body);
  // 81057/81058：同名同内容记录已存在（用户手建记录冲突时不能覆盖）
  if (status === 422 || status === 409 || code === 81057 || code === 81058) {
    return new AppError(502, 'cf_dns_conflict', `DNS 记录冲突：${message}`);
  }
  if (status === 400 || status === 401 || code === 9109 || code === 1000) {
    return new AppError(502, 'cf_dns_auth', `Cloudflare Token 无效或已失效：${message}`);
  }
  if (status === 403) {
    return new AppError(
      502,
      'cf_dns_permission',
      `Cloudflare Token 权限不足（需要单 Zone 的 Zone→DNS→Read 或 Edit + Zone→Zone→Read）：${message}`,
    );
  }
  if (status === 404) {
    return new AppError(502, 'cf_dns_zone', `Zone 不存在或不可读：${message}`);
  }
  return new AppError(502, 'cf_dns_api', `Cloudflare API 错误（${status}）：${message}`);
}

async function call(
  fetcher: CfFetch,
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ status: number; body: CfApiBody }> {
  let response: CfFetchResult;
  try {
    response = await fetcher(url, { ...authHeaders(token), ...init });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? '超时' : '网络失败';
    throw new AppError(504, 'cf_dns_network', `无法连接 Cloudflare API（${reason}）`);
  }
  if (response.body.success === false) {
    throw classify(response.status, response.body);
  }
  return response;
}

export interface CfZoneInfo {
  id: string;
  name: string;
  status: string;
  /** Zone 所属 Cloudflare 账号名（/zones 返回的 account.name）；旧接口不填 */
  accountName?: string;
}

/** GET /user/tokens/verify：Token 有效性。 */
export async function verifyToken(fetcher: CfFetch, token: string): Promise<string> {
  const { body } = await call(fetcher, `${CF_API_BASE}/user/tokens/verify`, token);
  const result = body.result as { status?: string } | undefined;
  if (result?.status !== 'active') {
    throw new AppError(502, 'cf_dns_auth', `Cloudflare Token 状态异常：${result?.status ?? '未知'}`);
  }
  return result.status;
}

/** GET /zones?name=：Zone 存在性与读权限。 */
export async function findZone(fetcher: CfFetch, token: string, zoneName: string): Promise<CfZoneInfo> {
  const { body } = await call(
    fetcher,
    `${CF_API_BASE}/zones?name=${encodeURIComponent(zoneName)}&status=active`,
    token,
  );
  const zones = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
  const zone = zones.find((item) => item.name === zoneName);
  if (!zone) {
    throw new AppError(502, 'cf_dns_zone', `Zone ${zoneName} 不存在（或 Token 无该 Zone 的读取权限）`);
  }
  return { id: String(zone.id), name: String(zone.name), status: String(zone.status ?? '') };
}

/** GET /zones?per_page=100：Token 可见的全部 Zone（多账号各用自己的 Token 拉取）。 */
export async function listZones(fetcher: CfFetch, token: string): Promise<CfZoneInfo[]> {
  const { body } = await call(
    fetcher,
    `${CF_API_BASE}/zones?per_page=100&status=active`,
    token,
  );
  const zones = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
  return zones
    .filter((zone) => zone.id && zone.name)
    .map((zone) => {
      const account = zone.account as { name?: unknown } | undefined;
      return {
        id: String(zone.id),
        name: String(zone.name),
        status: String(zone.status ?? ''),
        ...(typeof account?.name === 'string' && account.name ? { accountName: account.name } : {}),
      };
    });
}

export interface CfRecordInput {
  zoneId: string;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  /** 面板代建时写标记注释；手工新增记录留空 */
  comment?: string;
  proxied?: boolean;
  ttl?: number;
}

export interface CfRecord {
  id: string;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
}

/** 只读列出的记录（含 CNAME，用于同名冲突判断）。 */
export interface CfListedRecord {
  id: string;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  proxied: boolean;
  comment: string | null;
}

const LIST_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const LIST_MAX_PAGES = 5;

/**
 * GET /zones/:id/dns_records（只读）。
 * 仅保留 A/AAAA/CNAME；分页最多 5 页（500 条），足够面板选择场景。
 */
export async function listDnsRecords(
  fetcher: CfFetch,
  token: string,
  zoneId: string,
): Promise<CfListedRecord[]> {
  const records: CfListedRecord[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const { body } = await call(
      fetcher,
      `${CF_API_BASE}/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
      token,
    );
    const rows = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const type = String(row.type ?? '').toUpperCase();
      if (!row.id || !row.name || !LIST_TYPES.has(type)) continue;
      records.push({
        id: String(row.id),
        type: type as CfListedRecord['type'],
        name: String(row.name),
        content: String(row.content ?? ''),
        proxied: Boolean(row.proxied),
        comment: typeof row.comment === 'string' ? row.comment : null,
      });
    }
    const totalPages = Number(body.result_info?.total_pages ?? 1);
    if (page >= totalPages) break;
  }
  return records;
}

/** POST /zones/:id/dns_records。 */
export async function createRecord(
  fetcher: CfFetch,
  token: string,
  input: CfRecordInput,
): Promise<CfRecord> {
  const { body } = await call(fetcher, `${CF_API_BASE}/zones/${input.zoneId}/dns_records`, token, {
    method: 'POST',
    body: JSON.stringify({
      type: input.type,
      name: input.name,
      content: input.content,
      ...(input.comment ? { comment: input.comment } : {}),
      proxied: input.proxied ?? false,
      ttl: input.ttl ?? 1,
    }),
  });
  const result = body.result as Record<string, unknown> | undefined;
  if (!result?.id) {
    throw new AppError(502, 'cf_dns_api', 'Cloudflare 创建记录响应缺少 id');
  }
  return {
    id: String(result.id),
    type: input.type,
    name: input.name,
    content: input.content,
  };
}

export interface CfRecordUpdateInput {
  zoneId: string;
  recordId: string;
  type?: 'A' | 'AAAA' | 'CNAME';
  name?: string;
  content?: string;
  proxied?: boolean;
  ttl?: number;
}

/** PATCH /zones/:id/dns_records/:recordId；只提交显式给出的字段。 */
export async function updateRecord(
  fetcher: CfFetch,
  token: string,
  input: CfRecordUpdateInput,
): Promise<CfListedRecord> {
  const payload: Record<string, unknown> = {};
  if (input.type !== undefined) payload.type = input.type;
  if (input.name !== undefined) payload.name = input.name;
  if (input.content !== undefined) payload.content = input.content;
  if (input.proxied !== undefined) payload.proxied = input.proxied;
  if (input.ttl !== undefined) payload.ttl = input.ttl;
  const { body } = await call(
    fetcher,
    `${CF_API_BASE}/zones/${input.zoneId}/dns_records/${encodeURIComponent(input.recordId)}`,
    token,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
  const result = body.result as Record<string, unknown> | undefined;
  if (!result?.id) {
    throw new AppError(502, 'cf_dns_api', 'Cloudflare 更新记录响应缺少 id');
  }
  const type = String(result.type ?? input.type ?? '').toUpperCase();
  return {
    id: String(result.id),
    type: (['A', 'AAAA', 'CNAME'].includes(type) ? type : 'A') as CfListedRecord['type'],
    name: String(result.name ?? input.name ?? ''),
    content: String(result.content ?? input.content ?? ''),
    proxied: Boolean(result.proxied ?? input.proxied),
    comment: typeof result.comment === 'string' ? result.comment : null,
  };
}

/** DELETE /zones/:id/dns_records/:recordId（幂等：记录已不存在 404 视为成功）。 */
export async function deleteRecord(
  fetcher: CfFetch,
  token: string,
  zoneId: string,
  recordId: string,
): Promise<void> {
  try {
    const { body } = await call(
      fetcher,
      `${CF_API_BASE}/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`,
      token,
      { method: 'DELETE' },
    );
    if (body.success) return;
  } catch (error) {
    if (error instanceof AppError && error.code === 'cf_dns_zone') return; // 404 = 已删除
    throw error;
  }
}
