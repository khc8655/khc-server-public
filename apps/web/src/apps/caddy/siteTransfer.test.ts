import { describe, expect, it } from 'vitest';
import { normalizeCaddySite, type CaddySite } from '../../data/sites';
import {
  MAX_SITE_IMPORT_BYTES,
  SiteImportError,
  parseSitesImport,
  serializeSites,
  siteExportFilename,
} from './siteTransfer';

function site(overrides: Record<string, unknown> = {}): CaddySite {
  const normalized = normalizeCaddySite({
    name: 'blog',
    domains: ['blog.example.com'],
    listenPort: 443,
    kind: 'proxy',
    upstreams: ['10.0.0.2:8080'],
    ...overrides,
  });
  if (!normalized) throw new Error('fixture invalid');
  return normalized;
}

function text(sites: unknown[]): string {
  return JSON.stringify({ format: 'khc-caddy-sites/v1', version: 1, sites });
}

describe('Caddy 站点导出', () => {
  it('导出 sites 数组并生成安全文件名', () => {
    const body = JSON.parse(serializeSites([site()])) as {
      format: string;
      sites: { name: string }[];
    };
    expect(body.format).toBe('khc-caddy-sites/v1');
    expect(body.sites[0]?.name).toBe('blog');
    expect(siteExportFilename('vm1/HK', 'node-1', new Date(2026, 9, 27))).toBe(
      'khc-sites-vm1-HK-2026-10-27.json',
    );
  });
});

describe('Caddy 站点导入', () => {
  it('新增站点合并到现有配置', () => {
    const result = parseSitesImport(text([{ name: 'api', domains: ['api.example.com'], upstreams: ['127.0.0.1:3000'] }]), []);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.status).toBe('new');
    expect(result.nextConfig.sites.map((item) => item.name)).toEqual(['api']);
  });

  it('同名站点标记覆盖并替换', () => {
    const existing = site();
    const result = parseSitesImport(
      text([{ name: 'blog', domains: ['new.example.com'], upstreams: ['127.0.0.1:3000'] }]),
      [existing],
    );
    expect(result.rows[0]?.status).toBe('overwrite');
    expect(result.nextConfig.sites[0]?.domains).toEqual(['new.example.com']);
  });

  it('域名+端口冲突标记 conflict 且不合并', () => {
    const result = parseSitesImport(
      text([
        { name: 'other', domains: ['blog.example.com'], listenPort: 443, upstreams: ['127.0.0.1:3000'] },
      ]),
      [site()],
    );
    expect(result.rows[0]?.status).toBe('conflict');
    expect(result.rows[0]?.reason).toContain('blog');
    expect(result.nextConfig.sites).toHaveLength(1);
  });

  it('校验域名、端口、上游与 JSON 格式', () => {
    expect(() => parseSitesImport('{bad', [])).toThrow(SiteImportError);
    expect(() => parseSitesImport(JSON.stringify({ format: 'other', sites: [] }), [])).toThrow(
      '不是本面板',
    );
    const bad = parseSitesImport(
      text([
        { name: 'bad name', domains: ['not a domain'], listenPort: '443', upstreams: ['%%%'] },
      ]),
      [],
    );
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(MAX_SITE_IMPORT_BYTES).toBe(2 * 1024 * 1024);
  });

  it('拒绝空站点列表', () => {
    expect(() => parseSitesImport(text([]), [])).toThrow('没有可导入');
  });
});
