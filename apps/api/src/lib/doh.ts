/**
 * 公网 DNS 解析检测（DoH）。
 *
 * 「改完解析记录到底生效没有」不能只看 Cloudflare 的 API 返回——记录写入成功不等于
 * 解析已生效（缓存、代理状态、上游 NS 都可能拖后）。这里用 DoH（RFC 8484 的 JSON 形式）
 * 向 1.1.1.1 直接问，从公网视角回答「现在解析成什么」。
 *
 * 刻意不需要任何 DNS 凭据：没有 Cloudflare 账户的用户（手填域名的场景）也能自查。
 */

/** DoH JSON 接口；固定 Cloudflare，避免不同用户网络下结果口径不一致。 */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const GOOGLE_DOH_ENDPOINT = 'https://dns.google/resolve';

const TYPE_CODES = { A: 1, AAAA: 28, CNAME: 5, TXT: 16 } as const;
export type DohRecordType = keyof typeof TYPE_CODES;

export interface DohResult {
  /** DNS RCODE：0=NOERROR，3=NXDOMAIN */
  status: number;
  answers: string[];
}

interface DohResponseBody {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/** 解析 DNS JSON 应答里的 TXT 字符串（移除外层引号并拼接多段引号片段）。 */
function normalizeTxtAnswer(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/"([^"]*)"/g);
  if (quoted && quoted.length > 0) {
    return quoted.map((part) => part.slice(1, -1)).join('');
  }
  return trimmed;
}

async function queryDohJson(
  endpoint: string,
  name: string,
  type: DohRecordType,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DohResult> {
  const target = name.trim().toLowerCase().replace(/\.$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${endpoint}?name=${encodeURIComponent(target)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: controller.signal },
    );
    if (!response.ok) {
      throw new Error(`DoH 查询失败（HTTP ${response.status}）`);
    }
    const body = (await response.json()) as DohResponseBody;
    const code = TYPE_CODES[type];
    const answers = (body.Answer ?? [])
      .filter((answer) => answer.type === code && typeof answer.data === 'string')
      .map((answer) => {
        const text = answer.data as string;
        return type === 'TXT' ? normalizeTxtAnswer(text) : text;
      });
    return {
      status: typeof body.Status === 'number' ? body.Status : -1,
      answers,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查询一个记录名的解析结果。只保留与请求类型一致的应答（A 查询的 CNAME 链中
 * 中间 CNAME 不混进 answers，否则调用方无法判断「到底生效没有」）。
 *
 * 网络失败直接抛错，由路由层映射成 502——不伪造「无解析」这种业务结论。
 */
export async function resolveDnsName(
  name: string,
  type: DohRecordType,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<DohResult> {
  return queryDohJson(DOH_ENDPOINT, name, type, fetchImpl, timeoutMs);
}

/**
 * 并行通过 Cloudflare 与 Google 公共 DoH 检查 TXT 记录是否已在公网递归解析生效；
 * 单个 DoH 端失败或超时时静默返回空数组，不阻断上层 ACME 质询流程。
 */
export async function resolveTxtViaPublicDoh(
  name: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_000,
): Promise<{ cloudflare: string[]; google: string[] }> {
  const [cf, google] = await Promise.allSettled([
    queryDohJson(DOH_ENDPOINT, name, 'TXT', fetchImpl, timeoutMs),
    queryDohJson(GOOGLE_DOH_ENDPOINT, name, 'TXT', fetchImpl, timeoutMs),
  ]);
  return {
    cloudflare: cf.status === 'fulfilled' ? cf.value.answers : [],
    google: google.status === 'fulfilled' ? google.value.answers : [],
  };
}
