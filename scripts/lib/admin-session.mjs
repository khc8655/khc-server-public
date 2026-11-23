/**
 * 管理员会话（脚本共用）：按 POST /api/v1/auth/login 契约登录并保存 Cookie。
 * 口令与 TOTP 只由调用方从环境变量读取传入，本模块不打印、不落盘。
 */
import { cookieValue, sessionCookie } from './relay-latency.mjs';

export function makeCookieJar() {
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

/** 登录并把会话写入 jar；失败抛错（只带状态码，不回显口令）。 */
export async function loginAdmin(base, password, totp, jar, fetchImpl = fetch) {
  const payload = totp ? { password, totp } : { password };
  const res = await fetchImpl(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  jar.update(res.headers);
  await res.text();
  if (res.status !== 200 || !jar.hasSession()) {
    throw new Error(`登录 ${base} 失败（status=${res.status}）`);
  }
}
