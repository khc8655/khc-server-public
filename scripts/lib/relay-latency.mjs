/**
 * 中转链路基线统计与 Server-Timing 解析纯函数（不依赖运行环境，供 CLI 与单测复用）。
 */

/** 按逗号拆分 Server-Timing 头，忽略双引号 desc="" 内部逗号。 */
function splitTimingHeader(raw) {
  const parts = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== '\\') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts;
}

/**
 * 解析 HTTP `Server-Timing` 响应头，返回 `{ [metric]: { dur, count, tokens } }`。
 * 忽略格式损坏的项，绝不抛出异常。
 */
export function parseServerTiming(raw) {
  const result = {};
  if (typeof raw !== 'string' || !raw.trim()) return result;

  for (const part of splitTimingHeader(raw)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const segments = trimmed.split(';').map((s) => s.trim()).filter(Boolean);
    const name = segments[0]?.toLowerCase();
    if (!name || !/^[a-z0-9_-]{1,32}$/.test(name)) continue;

    let dur = null;
    let count = null;
    const tokens = [];

    for (const seg of segments.slice(1)) {
      const durMatch = /^dur\s*=\s*([0-9]+(?:\.[0-9]+)?)$/i.exec(seg);
      if (durMatch) {
        const value = Number(durMatch[1]);
        if (Number.isFinite(value)) dur = value;
        continue;
      }
      const descMatch = /^desc\s*=\s*"([^"]*)"$/i.exec(seg);
      if (descMatch) {
        for (const tok of descMatch[1].split(/\s+/).filter(Boolean)) {
          const nMatch = /^n=(\d+)$/.exec(tok);
          if (nMatch) {
            count = Number(nMatch[1]);
          } else {
            tokens.push(tok);
          }
        }
      }
    }

    if (dur !== null) {
      result[name] = { dur, count, tokens };
    }
  }

  return result;
}

/** 计算有限数字数组的中位数；空数组返回 null。 */
export function median(values) {
  if (!Array.isArray(values)) return null;
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

/** 从 Headers（或原生 getSetCookie 数组）提取非空的 `khc_sess=...` Cookie 字符串。 */
export function sessionCookie(headers) {
  if (!headers) return null;
  let cookies = [];
  if (typeof headers.getSetCookie === 'function') {
    cookies = headers.getSetCookie();
  } else if (typeof headers.get === 'function') {
    const raw = headers.get('set-cookie');
    if (raw) cookies = [raw];
  } else if (Array.isArray(headers)) {
    cookies = headers;
  }

  let matched = null;
  for (const item of cookies) {
    if (typeof item !== 'string') continue;
    const m = /(?:^|[,\s])khc_sess=([^;,\s]*)/.exec(item);
    if (m && m[1]) {
      matched = `khc_sess=${m[1]}`;
    }
  }
  return matched;
}

/**
 * 汇总单个入口单接口的多次采样结果：
 * - 第 1 次单列为 `firstMs`（排除在稳态中位数外）
 * - 第 2..N 次取 `wall` / `total` / `auth` / `d1` / `agent` / `edge(= wall - total)` 中位数
 */
export function summarize(entry, endpoint, samples) {
  const list = Array.isArray(samples) ? samples : [];
  const firstMs = typeof list[0]?.wallMs === 'number' ? list[0].wallMs : null;
  const steady = list.length > 1 ? list.slice(1) : [];

  const walls = [];
  const totals = [];
  const auths = [];
  const d1s = [];
  const agents = [];
  const edges = [];

  for (const sample of steady) {
    if (typeof sample?.wallMs === 'number' && Number.isFinite(sample.wallMs)) {
      walls.push(sample.wallMs);
    }
    const parsed = parseServerTiming(sample?.header);
    const total = parsed.total?.dur ?? null;
    if (total !== null) {
      totals.push(total);
      if (typeof sample?.wallMs === 'number' && Number.isFinite(sample.wallMs)) {
        edges.push(sample.wallMs - total);
      }
    }
    if (parsed.auth?.dur !== undefined) auths.push(parsed.auth.dur);
    if (parsed.d1?.dur !== undefined) d1s.push(parsed.d1.dur);
    if (parsed.agent?.dur !== undefined) agents.push(parsed.agent.dur);
  }

  const statuses = new Set();
  const vias = new Set();
  let missingHeaders = 0;

  for (const sample of list) {
    if (typeof sample?.status === 'number') statuses.add(sample.status);
    const parsed = parseServerTiming(sample?.header);
    if (parsed.total?.dur === undefined) {
      missingHeaders += 1;
    }
    for (const tok of parsed.agent?.tokens ?? []) {
      vias.add(tok);
    }
  }

  return {
    entry,
    endpoint,
    count: list.length,
    firstMs,
    wallMedianMs: median(walls),
    totalMedianMs: median(totals),
    authMedianMs: median(auths),
    d1MedianMs: median(d1s),
    agentMedianMs: median(agents),
    edgeMedianMs: median(edges),
    statuses: Array.from(statuses).sort((a, b) => a - b),
    vias: Array.from(vias).sort(),
    missingHeaders,
  };
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}` : '—';
}

/** 渲染 Markdown 基线对比表；缺头响应会在状态码列标记并在表末附 Workers Logs 提示。 */
export function renderMarkdown(summaries) {
  const rows = [
    '| 入口 | 接口 | 次数 | 首次 (ms) | 中位墙钟 | Worker total | auth | d1 | agent | 网络+边缘 | 状态码 | 通道 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
  ];

  let totalMissing = 0;
  for (const item of summaries) {
    totalMissing += item.missingHeaders ?? 0;
    const statusBase = item.statuses?.length ? item.statuses.join(',') : '—';
    const statusText =
      item.missingHeaders > 0 ? `${statusBase}（缺头×${item.missingHeaders}）` : statusBase;
    const viaText = item.vias?.length ? item.vias.join(',') : '—';
    rows.push(
      `| ${item.entry} | ${item.endpoint} | ${item.count} | ${fmtMs(item.firstMs)} | ${fmtMs(item.wallMedianMs)} | ${fmtMs(item.totalMedianMs)} | ${fmtMs(item.authMedianMs)} | ${fmtMs(item.d1MedianMs)} | ${fmtMs(item.agentMedianMs)} | ${fmtMs(item.edgeMedianMs)} | ${statusText} | ${viaText} |`,
    );
  }

  if (totalMissing > 0) {
    rows.push('');
    rows.push(
      `> 注：检测到 ${totalMissing} 次响应缺少 \`Server-Timing\` 头（可能被边缘剥离），请改看 Workers Logs 中 \`[timing] slow request\` 日志。`,
    );
  }
  return rows.join('\n');
}
