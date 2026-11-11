/**
 * 外部 uptime 探测的纯函数部分（可单测，不碰网络）。
 * 供 scripts/uptime-check.mjs 使用；vitest 覆盖见 scripts/test/uptime-check.test.ts。
 */

/** 健康检查：HTTP 200 + ok:true + 关键字段完整。 */
export function evaluateHealth(status, body) {
  if (status !== 200) return { level: 'fail', detail: `HTTP ${status}` };
  if (!body || body.ok !== true) return { level: 'fail', detail: 'ok 不是 true' };
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return { level: 'fail', detail: '缺少 version' };
  }
  if (typeof body.env !== 'string' || body.env.length === 0) {
    return { level: 'fail', detail: '缺少 env' };
  }
  return { level: 'ok', detail: `env=${body.env} version=${body.version}` };
}

/**
 * 版本检查：HTTP 200 + version + commit。
 * expectCommit 非空时要求 commit 以它为前缀（CI 部署 tag 是 sha 前 12 位）。
 */
export function evaluateVersion(status, body, expectCommit) {
  if (status !== 200) return { level: 'fail', detail: `HTTP ${status}` };
  if (!body || typeof body.version !== 'string' || body.version.length === 0) {
    return { level: 'fail', detail: '缺少 version' };
  }
  const commit = typeof body.commit === 'string' ? body.commit : '';
  if (!commit) return { level: 'fail', detail: '缺少 commit（构建标识未注入）' };
  if (expectCommit && !commit.startsWith(expectCommit)) {
    return {
      level: 'fail',
      detail: `commit=${commit} 与期望 ${expectCommit} 不符（线上不是这次构建）`,
    };
  }
  return { level: 'ok', detail: `version=${body.version} commit=${commit}` };
}

/**
 * 证书到期：已过期 = fail；剩余天数 < warnDays = warn；否则 ok。
 * validTo 为证书 notAfter（Date / ISO 串）。
 */
export function certificateStatus(validTo, now = Date.now(), warnDays = 21) {
  const expiresAt = validTo instanceof Date ? validTo : new Date(validTo);
  const ms = expiresAt.getTime();
  if (!Number.isFinite(ms)) return { level: 'fail', days: null, detail: '到期时间不可解析' };
  const days = Math.floor((ms - now) / 86_400_000);
  if (days < 0) return { level: 'fail', days, detail: `已过期 ${-days} 天` };
  if (days < warnDays) {
    return { level: 'warn', days, detail: `仅剩 ${days} 天（阈值 ${warnDays} 天）` };
  }
  return {
    level: 'ok',
    days,
    detail: `${expiresAt.toISOString().slice(0, 10)} 到期（剩 ${days} 天）`,
  };
}

/** 告警落点状态：未配置时必须显式呈现，不能静默通过。 */
export function webhookState(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) return { configured: false, detail: '未配置（KHC_ALERT_WEBHOOK / --webhook 均为空）' };
  let host = value;
  try {
    host = new URL(value).host;
  } catch {
    return { configured: false, detail: `配置非法（不是合法 URL）：${value.slice(0, 32)}` };
  }
  return { configured: true, detail: `已配置（${host}）` };
}

/** 是否需要外发告警：任一检查 fail 或 warn。 */
export function shouldAlert(checks) {
  return checks.some((c) => c.level === 'fail' || c.level === 'warn');
}

/** 汇总退出码：有 fail 即 1；warn 不改变退出码（避免证书临近到期把 CI 打红）。 */
export function exitCodeFor(checks) {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
