#!/usr/bin/env node
/**
 * 把仓库里的应用清单（apps/manifests/<appId>/manifest.json）推送到面板的应用库（D1）。
 *
 * 用法：
 *   KHC_PASSWORD='<管理员口令>' [KHC_TOTP=<验证码>] \
 *     node scripts/publish-app-manifest.mjs --base https://panel.example.com <appId> [--yes]
 *
 * 默认只打印与 D1 当前版本的差异（dry run，不发任何写请求）；带 --yes 才 POST（新 ID）/ PUT（已存在），
 * 并打印响应里的 warnings。口令只读环境变量，不打印。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAdmin, makeCookieJar } from './lib/admin-session.mjs';
import { diffManifestJson, formatDiff } from './lib/manifest-diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const opts = { base: '', appId: '', yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') opts.base = (argv[(i += 1)] ?? '').replace(/\/+$/, '');
    else if (arg === '--yes') opts.yes = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else if (!opts.appId) opts.appId = arg;
    else throw new Error(`多余的参数：${arg}`);
  }
  if (!opts.base) throw new Error('请传入 --base <面板地址>');
  if (!/^[a-z][a-z0-9-]*$/.test(opts.appId)) throw new Error('请传入合法的 appId（小写 slug）');
  return opts;
}

/**
 * 主流程，依赖可注入以便测试。返回 { mode: 'dry-run' | 'created' | 'updated', lines }。
 */
export async function publish(opts, { password, totp, fetchImpl = fetch, readFile = fs.readFileSync } = {}) {
  if (!password) throw new Error('缺少环境变量 KHC_PASSWORD');
  const file = path.join(ROOT, 'apps/manifests', opts.appId, 'manifest.json');
  const repo = JSON.parse(readFile(file, 'utf8'));
  if (repo.id !== opts.appId) throw new Error(`manifest.json 的 id（${repo.id}）与目录名不一致`);

  const jar = makeCookieJar();
  await loginAdmin(opts.base, password, totp, jar, fetchImpl);
  const call = async (method, urlPath, body) => {
    const res = await fetchImpl(`${opts.base}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: jar.header() ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  const list = await call('GET', '/api/v1/app-manifests');
  if (list.status !== 200) throw new Error(`读取应用库失败（status=${list.status}）`);
  const current = (list.json?.appManifests ?? []).find((item) => item.id === opts.appId);
  const diff = diffManifestJson(current?.manifest, repo.manifest);
  const lines = [`应用 ${opts.appId}：`, ...formatDiff(diff).map((l) => `  ${l}`)];
  if (!opts.yes) {
    lines.push('dry run：未写入。确认无误后加 --yes 推送。');
    return { mode: 'dry-run', lines };
  }

  const enabled = typeof repo.enabled === 'boolean' ? repo.enabled : undefined;
  const res = current
    ? await call('PUT', `/api/v1/app-manifests/${encodeURIComponent(opts.appId)}`, {
        manifest: repo.manifest,
        ...(enabled !== undefined ? { enabled } : {}),
      })
    : await call('POST', '/api/v1/app-manifests', {
        id: opts.appId,
        manifest: repo.manifest,
        enabled: enabled ?? true,
      });
  if (res.status !== 200 && res.status !== 201) {
    const fields = Object.entries(res.json?.error?.fields ?? {}).map(([k, v]) => `    ${k}：${v}`);
    throw new Error(
      [`推送失败（status=${res.status}）：${res.json?.error?.message ?? '未知错误'}`, ...fields].join('\n'),
    );
  }
  for (const w of res.json?.warnings ?? []) lines.push(`  提醒：${w}`);
  lines.push(current ? '已更新。' : '已创建。');
  return { mode: current ? 'updated' : 'created', lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { lines } = await publish(opts, {
      password: process.env.KHC_PASSWORD ?? '',
      totp: process.env.KHC_TOTP ?? '',
    });
    console.log(lines.join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
