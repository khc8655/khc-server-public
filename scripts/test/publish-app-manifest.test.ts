import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 脚本模块
import { parseArgs, publish } from '../publish-app-manifest.mjs';
// @ts-expect-error 纯 JS 脚本模块
import { diffManifestJson } from '../lib/manifest-diff.mjs';

const repoManifest = {
  id: 'demo',
  enabled: true,
  manifest: {
    schema: 2,
    name: 'demo',
    version: '2.0.0',
    runtime: { mode: 'create', user: 'khc-app-demo' },
    params: [{ key: 'port', type: 'integer', default: 1 }],
    sha256: { install: 'a'.repeat(64), uninstall: 'b'.repeat(64) },
  },
};

function fakeServer(existing: unknown) {
  const calls: Array<{ method: string; url: string; body?: unknown; cookie?: string }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      cookie: headers.Cookie,
    });
    if (url.endsWith('/auth/login')) {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'set-cookie': 'khc_sess=tok; Path=/; HttpOnly' },
      });
    }
    if (method === 'GET') {
      return new Response(JSON.stringify({ appManifests: existing ? [existing] : [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ appManifest: {}, warnings: ['提醒一条'] }), {
      status: method === 'POST' ? 201 : 200,
    });
  };
  return { calls, fetchImpl };
}

const readFile = () => JSON.stringify(repoManifest);

describe('publish-app-manifest', () => {
  it('参数校验', () => {
    expect(parseArgs(['--base', 'https://p.example/', 'demo', '--yes'])).toEqual({
      base: 'https://p.example',
      appId: 'demo',
      yes: true,
    });
    expect(() => parseArgs(['demo'])).toThrow('--base');
    expect(() => parseArgs(['--base', 'https://p', 'Bad_ID'])).toThrow('appId');
  });

  it('默认 dry run：只登录与读取，不发写请求', async () => {
    const { calls, fetchImpl } = fakeServer(null);
    const res = await publish(
      { base: 'https://p', appId: 'demo', yes: false },
      { password: 'pw', fetchImpl, readFile },
    );
    expect(res.mode).toBe('dry-run');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(calls.every((c) => !c.url.endsWith('/app-manifests') || c.method === 'GET')).toBe(true);
  });

  it('--yes：新 ID 走 POST，已存在走 PUT，并打印 warnings；口令不出现在输出', async () => {
    const created = fakeServer(null);
    const r1 = await publish(
      { base: 'https://p', appId: 'demo', yes: true },
      { password: 'secret-pw', fetchImpl: created.fetchImpl, readFile },
    );
    expect(r1.mode).toBe('created');
    expect(created.calls.at(-1)).toMatchObject({ method: 'POST', body: { id: 'demo', enabled: true } });
    expect(r1.lines.join('\n')).toContain('提醒一条');
    expect(r1.lines.join('\n')).not.toContain('secret-pw');
    expect(created.calls.at(-1)?.cookie).toBe('khc_sess=tok');

    const existing = fakeServer({ id: 'demo', manifest: { ...repoManifest.manifest, version: '1.0.0' } });
    const r2 = await publish(
      { base: 'https://p', appId: 'demo', yes: true },
      { password: 'pw', fetchImpl: existing.fetchImpl, readFile },
    );
    expect(r2.mode).toBe('updated');
    expect(existing.calls.at(-1)).toMatchObject({ method: 'PUT', url: 'https://p/api/v1/app-manifests/demo' });
    expect(r2.lines.join('\n')).toContain('版本：1.0.0 → 2.0.0');
  });

  it('缺口令直接报错', async () => {
    await expect(
      publish({ base: 'https://p', appId: 'demo', yes: false }, { password: '', readFile }),
    ).rejects.toThrow('KHC_PASSWORD');
  });

  it('差异：create → root 标高风险', () => {
    const d = diffManifestJson(
      { version: '1', runtime: { mode: 'create', user: 'u' }, sha256: {} },
      { version: '1', runtime: { mode: 'root' }, sha256: {} },
    );
    expect(d.changes[0]).toMatchObject({ key: 'runtime.mode', tone: 'danger' });
  });
});
