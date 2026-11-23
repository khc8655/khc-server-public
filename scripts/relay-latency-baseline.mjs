#!/usr/bin/env node
/**
 * 面板中转链路分段基线采样脚本（读取响应 `Server-Timing` 头并汇总首呼与稳态中位数）。
 *
 * 用法：
 *   KHC_PASSWORD='<管理员口令>' node scripts/relay-latency-baseline.mjs \
 *     --base https://panel.example.com --base https://khc-worker.example.workers.dev \
 *     [--runs 10] [--node nd_xxx] [--skip-host-ops] [--json]
 *
 * 估算请求量：
 *   每个入口 1 次登录 + runs × (3 + 4 × 目标节点数) 次请求（`--skip-host-ops` 时为 3 × 节点数）；
 *   默认 `--runs 10`、3 台节点、2 个入口约产生 300 次请求（登录每入口仅 1 次，不触发 10 次/5 分钟限流）。
 *   口令仅从环境变量 KHC_PASSWORD（可选 KHC_TOTP）读取，不落盘、不回显。
 */
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cookieValue, renderMarkdown, sessionCookie, summarize } from './lib/relay-latency.mjs';

const SNAPSHOT_DEDUPE_WAIT_MS = 2100;

function parseArgs(argv) {
  const opts = {
    bases: [],
    runs: 10,
    nodeIds: [],
    skipHostOps: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1] ?? '';
    if (arg === '--base') opts.bases.push(next().replace(/\/+$/, '')), (i += 1);
    else if (arg === '--runs') opts.runs = Math.max(1, Number.parseInt(next(), 10) || 10), (i += 1);
    else if (arg === '--node') opts.nodeIds.push(next()), (i += 1);
    else if (arg === '--skip-host-ops') opts.skipHostOps = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法见脚本文件头注释。需设置环境变量 KHC_PASSWORD（可选 KHC_TOTP）。');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (opts.bases.length === 0) {
    console.error('请至少传入一个 --base <url>');
    process.exit(2);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCookieJar() {
  let sess = null;
  let d1bm = null;
  return {
    header() {
      return [sess, d1bm].filter(Boolean).join('; ') || null;
    },
    update(headers) {
      const nextSess = sessionCookie(headers);
      if (nextSess) sess = nextSess;
      const nextBm = cookieValue(headers, 'khc_d1bm');
      if (nextBm) d1bm = nextBm;
    },
    hasSession() {
      return Boolean(sess);
    },
  };
}

async function timedFetch(
  base,
  path,
  { method = 'GET', cookie = null, jar = null, body = undefined } = {},
) {
  const headers = {};
  const cookieHeader = cookie ?? jar?.header() ?? null;
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const start = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar?.update(res.headers);
  const text = await res.text();
  const wallMs = performance.now() - start;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: res.status,
    wallMs,
    header: res.headers.get('server-timing'),
    setCookie: sessionCookie(res.headers),
    json,
  };
}

async function login(base, password, totp, jar) {
  const payload = totp ? { password, totp } : { password };
  const res = await timedFetch(base, '/api/v1/auth/login', { method: 'POST', jar, body: payload });
  if (res.status !== 200 || !jar.hasSession()) {
    throw new Error(`登录 ${base} 失败（status=${res.status}）`);
  }
}

async function sampleSeries(runs, fn, gapMs = 0) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    samples.push(await fn());
  }
  return samples;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const password = process.env.KHC_PASSWORD ?? '';
  const totp = process.env.KHC_TOTP ?? '';
  if (!password) {
    console.error('缺少环境变量 KHC_PASSWORD');
    process.exit(2);
  }

  const allSummaries = [];

  for (const base of opts.bases) {
    const entryHost = new URL(base).host;
    const jar = makeCookieJar();
    await login(base, password, totp, jar);

    const nodesSamples = await sampleSeries(opts.runs, () =>
      timedFetch(base, '/api/v1/nodes', { jar }),
    );
    allSummaries.push(summarize(entryHost, 'GET /api/v1/nodes', nodesSamples));

    const nodeList = nodesSamples[0]?.json?.items ?? nodesSamples[0]?.json?.nodes ?? [];
    const targetNodes =
      opts.nodeIds.length > 0
        ? nodeList.filter((n) => opts.nodeIds.includes(n.id))
        : nodeList;

    const certsSamples = await sampleSeries(opts.runs, () =>
      timedFetch(base, '/api/v1/certs', { jar }),
    );
    allSummaries.push(summarize(entryHost, 'GET /api/v1/certs', certsSamples));

    const probeSamples = await sampleSeries(opts.runs, () =>
      timedFetch(base, '/api/v1/nodes/probe', { method: 'POST', jar }),
    );
    allSummaries.push(summarize(entryHost, 'POST /api/v1/nodes/probe', probeSamples));

    for (const node of targetNodes) {
      const label = node.name || node.id;
      const stateSamples = await sampleSeries(opts.runs, () =>
        timedFetch(base, `/api/v1/nodes/${node.id}/state`, { jar }),
      );
      allSummaries.push(summarize(entryHost, `GET /nodes/${label}/state`, stateSamples));

      const overviewSamples = await sampleSeries(opts.runs, () =>
        timedFetch(base, `/api/v1/nodes/${node.id}/overview`, { jar }),
      );
      allSummaries.push(summarize(entryHost, `GET /nodes/${label}/overview`, overviewSamples));

      const snapSamples = await sampleSeries(
        opts.runs,
        () => timedFetch(base, `/api/v1/nodes/${node.id}/snapshot`, { jar }),
        SNAPSHOT_DEDUPE_WAIT_MS,
      );
      allSummaries.push(summarize(entryHost, `GET /nodes/${label}/snapshot`, snapSamples));

      if (!opts.skipHostOps) {
        const svcSamples = await sampleSeries(opts.runs, () =>
          timedFetch(base, `/api/v1/nodes/${node.id}/apps/host-ops/call`, {
            method: 'POST',
            jar,
            body: {
              params: { target: 'self', verb: 'svc.list', params: {} },
              idempotencyKey: crypto.randomUUID(),
            },
          }),
        );
        allSummaries.push(summarize(entryHost, `POST /nodes/${label}/svc.list`, svcSamples));
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summaries: allSummaries }, null, 2));
  } else {
    console.log(renderMarkdown(allSummaries));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
