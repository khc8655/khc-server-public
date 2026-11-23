import { describe, expect, it, vi } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  assertImportUrl,
  diffManifests,
  fetchImportUrl,
  importText,
  parseImportText,
} from './appImport';

const sha = (c: string) => c.repeat(64);

function v2(overrides: Record<string, unknown> = {}) {
  return {
    schema: 2,
    name: '示例',
    version: '1.0.0',
    runtime: { mode: 'create', user: 'khc-app-demo', linger: true },
    params: [{ key: 'port', type: 'integer', default: 8080 }],
    scripts: { install: 'echo i', uninstall: 'echo u' },
    sha256: { install: sha('a'), uninstall: sha('b') },
    writes: [],
    ...overrides,
  };
}

describe('parseImportText', () => {
  it('仓库格式带 id / enabled', () => {
    const r = parseImportText(JSON.stringify({ id: 'demo', enabled: false, manifest: v2() }), '');
    expect(r).toMatchObject({ ok: true, id: 'demo', enabled: false });
  });

  it('裸清单必须填 ID，填了就通过', () => {
    const bare = JSON.stringify(v2());
    expect(parseImportText(bare, '')).toMatchObject({ ok: false, error: importText.needId });
    expect(parseImportText(bare, 'My_App')).toMatchObject({ ok: false, error: importText.badId });
    expect(parseImportText(bare, 'my-app')).toMatchObject({ ok: true, id: 'my-app' });
  });

  it('非法 JSON、非对象、超 512KB', () => {
    expect(parseImportText('{oops', 'a')).toMatchObject({ ok: false, error: importText.badJson });
    expect(parseImportText('[]', 'a')).toMatchObject({ ok: false, error: importText.notObject });
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_IMPORT_BYTES) });
    expect(parseImportText(big, 'a')).toMatchObject({ ok: false, error: importText.tooLarge });
  });

  it('契约校验失败时按 zod issue 的 path 标出字段（v2 分支）', () => {
    const r = parseImportText(
      JSON.stringify({ id: 'demo', manifest: v2({ params: [{ key: 'Bad', type: 'integer' }] }) }),
      '',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'manifest.params.0.key')).toBe(true);
    }
  });
});

describe('fetchImportUrl（浏览器端）', () => {
  it('只允许 https，且不带用户名口令', () => {
    expect(() => assertImportUrl('http://example.com/a.json')).toThrow(importText.notHttps);
    expect(() => assertImportUrl('https://u:p@example.com/a.json')).toThrow(importText.hasCredentials);
    expect(() => assertImportUrl('not a url')).toThrow(importText.badUrl);
  });

  it('请求带 credentials omit 与 redirect error', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    await expect(fetchImportUrl('https://example.com/m.json', fetchImpl)).resolves.toBe('{"a":1}');
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/m.json', {
      credentials: 'omit',
      redirect: 'error',
    });
  });

  it('非 https 不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchImportUrl('http://example.com/m.json', fetchImpl)).rejects.toThrow(importText.notHttps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('跨域失败（TypeError）提示改用文件导入', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchImportUrl('https://example.com/m.json', fetchImpl)).rejects.toThrow(
      '该地址不允许跨域读取，请下载后用文件导入',
    );
  });

  it('超过 512KB 拒绝（声明长度与实际流都检查）', async () => {
    const declared = vi.fn(
      async () =>
        new Response('x', { status: 200, headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) } }),
    );
    await expect(fetchImportUrl('https://example.com/m.json', declared)).rejects.toThrow(importText.tooLarge);
    const streamed = vi.fn(async () => new Response('x'.repeat(MAX_IMPORT_BYTES + 1), { status: 200 }));
    await expect(fetchImportUrl('https://example.com/m.json', streamed)).rejects.toThrow(importText.tooLarge);
  });

  it('HTTP 非 2xx 报状态码', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchImportUrl('https://example.com/m.json', fetchImpl)).rejects.toThrow('HTTP 404');
  });
});

describe('diffManifests', () => {
  const parse = (def: unknown) => {
    const r = parseImportText(JSON.stringify({ id: 'demo', manifest: def }), '');
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.manifest;
  };
  const keys = (d: ReturnType<typeof diffManifests>) => d.changes.map((c) => c.key);

  it('新 ID：isNew，没有逐项变化，概览有内容', () => {
    const d = diffManifests(undefined, parse(v2()));
    expect(d.isNew).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.summary.find((s) => s.key === 'version')?.after).toBe('1.0.0');
  });

  it('无变化', () => {
    const d = diffManifests(parse(v2()), parse(v2()));
    expect(d.changes).toEqual([]);
  });

  it('版本、脚本 sha256、参数增删改', () => {
    const next = v2({
      version: '1.1.0',
      sha256: { install: sha('c'), uninstall: sha('b') },
      params: [
        { key: 'port', type: 'integer', default: 9090 },
        { key: 'extra', type: 'string', default: '' },
      ],
    });
    const d = diffManifests(parse(v2()), parse(next));
    expect(keys(d)).toEqual(
      expect.arrayContaining(['version', 'sha256.install', 'params.port', 'params.extra']),
    );
    expect(keys(d)).not.toContain('sha256.uninstall');
    const removed = diffManifests(parse(v2()), parse(v2({ params: [] })));
    expect(removed.changes.find((c) => c.key === 'params.port')?.after).toBe('删除');
  });

  it('create → root 是 danger', () => {
    const d = diffManifests(parse(v2()), parse(v2({ runtime: { mode: 'root', linger: true } })));
    expect(d.changes.find((c) => c.key === 'runtime.mode')?.tone).toBe('danger');
    const back = diffManifests(parse(v2({ runtime: { mode: 'root', linger: true } })), parse(v2()));
    expect(back.changes.find((c) => c.key === 'runtime.mode')?.tone).toBe('warn');
  });

  it('控制面步骤（阶段与主机）、sources、secrets 声明', () => {
    const next = v2({
      hooks: { preInstall: { method: 'POST', url: 'https://hub.example.com/x' } },
      sources: [{ host: 'dl.example.com', purpose: '下载', pinned: false }],
      secrets: [{ name: 'api_key', label: '密钥' }],
    });
    const d = diffManifests(parse(v2()), parse(next));
    expect(d.changes.find((c) => c.key === 'hooks.preInstall')?.after).toBe('POST hub.example.com');
    expect(keys(d)).toEqual(
      expect.arrayContaining(['sources.dl.example.com（动态）', 'secrets.api_key']),
    );
  });
});
