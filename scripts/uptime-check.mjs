#!/usr/bin/env node
/**
 * 外部 uptime 探测（不属于 Worker）：健康、版本 commit、TLS 证书到期。
 *
 * 用法：
 *   node scripts/uptime-check.mjs [--base https://panel.example.com] \
 *     [--expect-commit <sha>] [--cert-hosts panel.example.com,example.com] \
 *     [--warn-days 21] [--timeout-ms 10000] [--webhook <url>] [--json]
 *
 * 告警落点：--webhook 或环境变量 KHC_ALERT_WEBHOOK。**未配置时会显式打印"未配置"**，
 * 不会静默通过；配置后在有 fail/warn 时 POST JSON（{text, source, at, checks}）。
 *
 * 退出码：0 = 全部正常（warn 也算 0）；1 = 有检查 fail。
 */
import { request as httpsRequest } from 'node:https';
import { evaluateHealth, evaluateVersion, certificateStatus, webhookState, shouldAlert, exitCodeFor } from './lib/uptime-check.mjs';

function parseArgs(argv) {
  const opts = {
    base: 'https://panel.example.com',
    expectCommit: '',
    certHosts: [],
    warnDays: 21,
    timeoutMs: 10_000,
    webhook: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1] ?? '';
    if (arg === '--base') opts.base = next(), (i += 1);
    else if (arg === '--expect-commit') opts.expectCommit = next(), (i += 1);
    else if (arg === '--cert-hosts') opts.certHosts = next().split(',').map((s) => s.trim()).filter(Boolean), (i += 1);
    else if (arg === '--warn-days') opts.warnDays = Number(next()), (i += 1);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next()), (i += 1);
    else if (arg === '--webhook') opts.webhook = next(), (i += 1);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法见脚本头部注释');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (opts.certHosts.length === 0) {
    try {
      opts.certHosts = [new URL(opts.base).hostname];
    } catch {
      /* 非法 base 交给后面报错 */
    }
  }
  return opts;
}

async function getJson(url, timeoutMs) {
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, latencyMs: Date.now() - started };
}

/** 读 TLS 证书 notAfter；SNI 用 host 本身。 */
function readCertificate(host, timeoutMs) {
  return new Promise((resolve) => {
    const req = httpsRequest(
      { host, port: 443, servername: host, method: 'HEAD', path: '/', timeout: timeoutMs },
      (res) => {
        const cert = res.socket.getPeerCertificate();
        res.resume();
        if (!cert || !cert.valid_to) return resolve({ ok: false, error: '未读到证书' });
        resolve({ ok: true, validTo: new Date(cert.valid_to), subject: cert.subject?.CN ?? '' });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`TLS 连接超时（${timeoutMs}ms）`)));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const checks = [];

  try {
    const base = opts.base.replace(/\/+$/, '');
    const health = await getJson(`${base}/api/v1/health`, opts.timeoutMs);
    checks.push({
      name: 'health',
      ...evaluateHealth(health.status, health.body),
      latencyMs: health.latencyMs,
    });

    const version = await getJson(`${base}/api/v1/version`, opts.timeoutMs);
    checks.push({
      name: 'version',
      ...evaluateVersion(version.status, version.body, opts.expectCommit),
      latencyMs: version.latencyMs,
    });
  } catch (err) {
    checks.push({ name: 'http', level: 'fail', detail: `探测失败：${err.message}` });
  }

  for (const host of opts.certHosts) {
    const cert = await readCertificate(host, opts.timeoutMs);
    if (!cert.ok) {
      checks.push({ name: `cert:${host}`, level: 'fail', detail: `读取失败：${cert.error}` });
      continue;
    }
    const status = certificateStatus(cert.validTo, Date.now(), opts.warnDays);
    checks.push({
      name: `cert:${host}`,
      ...status,
      detail: `${cert.subject ? `${cert.subject} ` : ''}${status.detail}`,
    });
  }

  const alert = webhookState(opts.webhook || process.env.KHC_ALERT_WEBHOOK || '');
  const shouldSend = shouldAlert(checks);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { base: opts.base, checks, alertConfigured: alert.configured, alertDetail: alert.detail, at: new Date().toISOString() },
        null,
        2,
      ),
    );
  } else {
    const symbol = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
    for (const c of checks) {
      const latency = c.latencyMs === undefined ? '' : ` ${c.latencyMs}ms`;
      console.log(`[${symbol[c.level]}] ${c.name}${latency} — ${c.detail}`);
    }
    console.log(`[告警] ${alert.configured ? alert.detail : `${alert.detail} — 本次结果不会外发，需人工查看`}`);
  }

  if (shouldSend) {
    if (!alert.configured) {
      // 已经在上面显式打印"未配置"，这里再提示一次，确保不是静默通过。
      if (opts.json) console.error(`告警未配置：${alert.detail}`);
    } else {
      const text = checks
        .filter((c) => c.level !== 'ok')
        .map((c) => `[${c.level}] ${c.name}: ${c.detail}`)
        .join('\n');
      try {
        const res = await fetch(opts.webhook || process.env.KHC_ALERT_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `khc uptime: ${text}`, source: 'khc-uptime-check', at: new Date().toISOString(), checks }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (!res.ok) console.error(`告警发送失败：HTTP ${res.status}`);
      } catch (err) {
        console.error(`告警发送失败：${err.message}`);
      }
    }
  }

  process.exit(exitCodeFor(checks));
}

main();
