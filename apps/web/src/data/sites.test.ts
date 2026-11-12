import { describe, expect, it } from 'vitest';
import {
  extractCaddyConfig,
  extractCaddyImportPreview,
  extractCaddyImportScan,
  extractCaddyService,
  extractCaddyValidate,
  envelopeErrorText,
  externalBlockToSite,
  findSitesImpactedByPeer,
  formatList,
  healthForSite,
  hasExternalBlocks,
  importConflict,
  normalizeCaddyConfig,
  normalizeCaddySite,
  parseCaddyStatus,
  parseList,
  splitUpstreamHostPort,
  syncSitesToPeer,
  uniqueSiteName,
  type CaddyEnvelope,
  type ExternalSiteBlock,
} from './sites';

function envelope(result: Record<string, unknown>, ok = true): CaddyEnvelope {
  return { ok, result } as unknown as CaddyEnvelope;
}

describe('normalizeCaddySite', () => {
  it('旧配置（domain/upstream）自动升级为 domains/upstreams', () => {
    const site = normalizeCaddySite({
      name: 'blog',
      domain: 'blog.example.dev',
      listenPort: 443,
      upstream: '10.99.0.2:8080',
      tls: { mode: 'manual', cert: { $cert: 'cert_1' } },
      forceTls13: true,
      enabled: true,
    });
    expect(site).not.toBeNull();
    expect(site?.kind).toBe('proxy');
    expect(site?.domains).toEqual(['blog.example.dev']);
    expect(site?.upstreams).toEqual(['10.99.0.2:8080']);
    expect(site?.tls).toEqual({ mode: 'manual', cert: { $cert: 'cert_1' } });
    expect(site?.forceTls13).toBe(true);
    expect(site?.hsts).toBe(false);
    expect(site?.log).toEqual({ enabled: false, path: '' });
  });

  it('新配置保留 kind/多域名/静态/日志/观测入口', () => {
    const site = normalizeCaddySite({
      name: 'files',
      kind: 'static',
      domains: ['files.example.dev', 'www.files.example.dev'],
      listenPort: 80,
      root: '/var/www/files',
      browse: true,
      index: 'home.html',
      tryFiles: ['{path}', '/index.html'],
      tls: { mode: 'internal', cert: null },
      hsts: true,
      securityHeaders: true,
      compression: true,
      allowedIps: ['10.0.0.0/8'],
      maxBodyBytes: 10485760,
      log: { enabled: true, path: '/var/log/caddy/files.log' },
      liveGateway: true,
    });
    expect(site?.kind).toBe('static');
    expect(site?.domains).toHaveLength(2);
    expect(site?.domain).toBe('files.example.dev');
    expect(site?.root).toBe('/var/www/files');
    expect(site?.tls.mode).toBe('internal');
    expect(site?.tryFiles).toEqual(['{path}', '/index.html']);
    expect(site?.maxBodyBytes).toBe(10485760);
    expect(site?.log.enabled).toBe(true);
    expect(site?.liveGateway).toBe(true);
  });

  it('缺少域名时丢弃站点，配置整体仍可解析', () => {
    const config = normalizeCaddyConfig({
      sites: [{ name: 'bad' }, { name: 'ok', domains: ['ok.example.dev'] }],
    });
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0]?.name).toBe('ok');
  });
});

describe('parseCaddyStatus', () => {
  it('解析 siteHealth 四态并可按 name/domain 匹配', () => {
    const status = parseCaddyStatus([
      {
        name: 'caddy-site',
        status: {
          active: true,
          version: '2.8.4',
          sites: 4,
          validate: { ok: true },
          lastReloadAt: '2026-10-26T01:00:00Z',
          siteHealth: [
            { name: 'a', domain: 'a.example.dev', state: 'ok', status: 200, latencyMs: 12 },
            { name: 'b', domain: 'b.example.dev', state: 'warn', error: '证书不受信任' },
            { name: 'c', domain: 'c.example.dev', state: 'down', error: '连接超时' },
            { name: 'd', domain: 'd.example.dev', state: 'unknown' },
          ],
        },
      },
    ]);
    expect(status?.version).toBe('2.8.4');
    expect(status?.siteHealth.map((item) => item.state)).toEqual(['ok', 'warn', 'down', 'unknown']);
    expect(healthForSite(status, { name: 'b', domain: 'b.example.dev' })?.state).toBe('warn');
    expect(healthForSite(status, { name: 'x', domain: 'c.example.dev' })?.state).toBe('down');
    expect(healthForSite(status, { name: 'x', domain: 'x.example.dev' })).toBeNull();
  });

  it('兼容旧 sites 数组状态', () => {
    const status = parseCaddyStatus([
      {
        name: 'caddy-site',
        status: {
          active: true,
          sites: [{ name: 'blog', domain: 'blog.example.dev', active: true }],
        },
      },
    ]);
    expect(status?.siteHealth[0]?.state).toBe('ok');
    expect(status?.siteCount).toBe(1);
  });

  it('validate 失败时 error 使用校验信息', () => {
    const status = parseCaddyStatus([
      {
        name: 'caddy-site',
        status: {
          active: true,
          validate: { ok: false, message: 'unexpected token' },
        },
      },
    ]);
    expect(status?.validateOk).toBe(false);
    expect(status?.error).toBe('unexpected token');
  });
});

describe('Caddy 服务动作结果', () => {
  it('提取服务状态与 validate 结果', () => {
    const service = extractCaddyService(
      envelope({
        version: '2.8.4',
        active: true,
        unit: 'caddy.service',
        caddyfile: '/etc/caddy/Caddyfile',
        lastReloadAt: '2026-10-26T01:00:00Z',
      }),
    );
    expect(service.version).toBe('2.8.4');
    expect(service.active).toBe(true);
    expect(service.unit).toBe('caddy.service');

    const validate = extractCaddyValidate(
      envelope({ validate: { ok: false, message: 'bad config', details: { line: 3 } } }),
    );
    expect(validate.ok).toBe(false);
    expect(validate.message).toBe('bad config');
    expect(validate.details).toContain('"line": 3');
  });

  it('兼容适配器顶层返回（ok/version/caddyfile 不在 result 里）', () => {
    const service = extractCaddyService({
      ok: true,
      version: '2.8.4',
      installed: true,
      active: false,
      unit: 'caddy.service',
      caddyfile: '/etc/caddy/Caddyfile',
      lastReloadAt: '2026-10-26T01:00:00Z',
    } as unknown as CaddyEnvelope);
    expect(service.version).toBe('2.8.4');
    expect(service.active).toBe(false);

    const validate = extractCaddyValidate({
      ok: true,
      validate: { ok: false, message: 'bad config' },
    } as unknown as CaddyEnvelope);
    expect(validate.ok).toBe(false);
    expect(validate.message).toBe('bad config');

    const exported = extractCaddyConfig({
      ok: true,
      caddyfile: 'main content',
      snippets: ['# snippet'],
    } as unknown as CaddyEnvelope);
    expect(exported.caddyfile).toBe('main content');
    expect(exported.snippets).toEqual(['# snippet']);
  });

  it('导出配置优先取 content 并兼容对象片段', () => {
    const exported = extractCaddyConfig(
      envelope({
        content: '{ admin off }',
        caddyfile: '/etc/caddy/Caddyfile',
        snippets: ['a.example.dev { respond 200 }', { content: 'b.example.dev { respond 200 }' }],
      }),
    );
    expect(exported.caddyfile).toBe('{ admin off }');
    expect(exported.snippets).toHaveLength(2);
  });
});

function externalBlock(overrides: Partial<ExternalSiteBlock> = {}): ExternalSiteBlock {
  return {
    id: 'block-1',
    hash: 'abc123',
    address: 'blog.example.dev',
    startLine: 6,
    endLine: 11,
    text: 'blog.example.dev {\n\treverse_proxy 10.0.0.2:8080\n}',
    supported: true,
    reason: null,
    domains: ['blog.example.dev'],
    listenPort: 443,
    kind: 'proxy',
    upstreams: ['10.0.0.2:8080'],
    lbPolicy: 'round_robin',
    healthUri: '',
    root: '',
    browse: false,
    redirectTo: '',
    redirectCode: 301,
    tlsMode: 'auto',
    headers: {},
    compression: false,
    logEnabled: false,
    logPath: '',
    ...overrides,
  };
}

describe('Caddy 外部站点扫描', () => {
  it('解析 result 形态并回退默认值', () => {
    const scan = extractCaddyImportScan(
      envelope({
        exists: true,
        caddyfilePath: '/etc/caddy/Caddyfile',
        caddyfileHash: 'deadbeef',
        imports: ['sites/*.caddy'],
        backups: [{ path: '/etc/caddy/Caddyfile.khc-backup-1.bak', name: 'x', updatedAt: '2026-11-07T00:00:00Z' }],
        blocks: [
          {
            hash: 'h1',
            address: 'a.example.dev',
            startLine: 2,
            endLine: 5,
            text: 'a.example.dev { respond 200 }',
            supported: false,
            reason: '包含不支持的指令 handle',
            domains: ['a.example.dev'],
          },
        ],
      }),
    );
    expect(scan.exists).toBe(true);
    expect(scan.caddyfilePath).toBe('/etc/caddy/Caddyfile');
    expect(scan.caddyfileHash).toBe('deadbeef');
    expect(scan.imports).toEqual(['sites/*.caddy']);
    expect(scan.backups).toHaveLength(1);
    expect(scan.blocks[0]).toMatchObject({
      hash: 'h1',
      supported: false,
      reason: '包含不支持的指令 handle',
      listenPort: 443,
      kind: 'proxy',
      tlsMode: 'auto',
      redirectCode: 301,
    });
  });

  it('兼容适配器顶层返回', () => {
    const scan = extractCaddyImportScan({
      ok: true,
      exists: false,
      caddyfilePath: '/etc/caddy/Caddyfile',
      blocks: [],
    } as unknown as CaddyEnvelope);
    expect(scan.exists).toBe(false);
    expect(scan.blocks).toEqual([]);
  });
});

describe('影子导入预览', () => {
  it('解析将生成的片段、摘除区间与整树校验结果', () => {
    const preview = extractCaddyImportPreview(
      envelope({
        hash: 'a'.repeat(64),
        address: 'blog.example.dev',
        startLine: 6,
        endLine: 11,
        supported: true,
        reason: null,
        site: { domains: ['blog.example.dev'], kind: 'proxy' },
        snippet: '# Generated by khc-agent\nblog.example.dev:443 {\n    reverse_proxy 10.0.0.2:8080\n}\n',
        remove: { startLine: 6, endLine: 11, text: 'blog.example.dev { ... }' },
        import: { line: 'import khc.d/*', present: false, willAppend: true },
        validate: { ok: true, rc: 0, message: null },
        caddyfileHash: 'deadbeef',
      }),
    );
    expect(preview.supported).toBe(true);
    expect(preview.site?.domains).toEqual(['blog.example.dev']);
    expect(preview.snippet).toContain('reverse_proxy 10.0.0.2:8080');
    expect(preview.remove?.startLine).toBe(6);
    expect(preview.importInfo?.willAppend).toBe(true);
    expect(preview.validate?.ok).toBe(true);
  });

  it('不支持接管的块保留原因且没有片段', () => {
    const preview = extractCaddyImportPreview(
      envelope({
        hash: 'b'.repeat(64),
        supported: false,
        reason: '包含面板暂不支持的指令：handle',
        site: null,
        snippet: null,
        remove: null,
        import: null,
        validate: null,
      }),
    );
    expect(preview.supported).toBe(false);
    expect(preview.reason).toContain('handle');
    expect(preview.snippet).toBeNull();
    expect(preview.validate).toBeNull();
  });
});

describe('外部站点接管映射', () => {
  it('外部块转换为面板站点并避开重名', () => {
    const config = normalizeCaddyConfig({
      sites: [{ name: 'blog.example.dev', domains: ['old.example.dev'], upstreams: ['10.0.0.1:80'] }],
    });
    expect(uniqueSiteName(config, 'blog.example.dev')).toBe('blog.example.dev-2');

    const site = externalBlockToSite(config, externalBlock());
    expect(site).not.toBeNull();
    expect(site?.name).toBe('blog.example.dev-2');
    expect(site?.kind).toBe('proxy');
    expect(site?.domains).toEqual(['blog.example.dev']);
    expect(site?.upstreams).toEqual(['10.0.0.2:8080']);
    expect(site?.enabled).toBe(true);
    expect(site?.tls).toEqual({ mode: 'auto', cert: null });
  });

  it('接管映射保留负载策略、健康检查与日志路径', () => {
    const site = externalBlockToSite(
      normalizeCaddyConfig({}),
      externalBlock({
        lbPolicy: 'least_conn',
        healthUri: '/healthz',
        logEnabled: true,
        logPath: '/var/log/caddy/blog.log',
      }),
    );
    expect(site?.lbPolicy).toBe('least_conn');
    expect(site?.healthUri).toBe('/healthz');
    expect(site?.log).toEqual({ enabled: true, path: '/var/log/caddy/blog.log' });
  });

  it('缺少域名时无法映射', () => {
    const site = externalBlockToSite(normalizeCaddyConfig({}), externalBlock({ domains: [] }));
    expect(site).toBeNull();
  });

  it('域名冲突只对比启用中的面板站点', () => {
    const config = normalizeCaddyConfig({
      sites: [
        { name: 'live', domains: ['blog.example.dev'], enabled: true },
        { name: 'paused', domains: ['files.example.dev'], enabled: false },
      ],
    });
    expect(importConflict(config, { domains: ['BLOG.example.dev'], listenPort: 443 })).toContain('live');
    expect(importConflict(config, { domains: ['files.example.dev'], listenPort: 443 })).toBeNull();
    expect(importConflict(config, { domains: ['other.example.dev'], listenPort: 443 })).toBeNull();
  });

  it('不同端口的同域名仍视为域名冲突', () => {
    const config = normalizeCaddyConfig({
      sites: [{ name: 'plain', domains: ['site.example.dev'], listenPort: 80 }],
    });
    expect(importConflict(config, { domains: ['site.example.dev'], listenPort: 443 })).toContain('plain');
  });
});

describe('envelopeErrorText：旧 Agent 原始错误', () => {
  function failed(message: string, details?: Record<string, unknown>): CaddyEnvelope {
    return { ok: false, error: { message, ...(details ? { details } : {}) } } as unknown as CaddyEnvelope;
  }

  it('未知动作转成「升级 Agent」引导，不再暴露原始动作名', () => {
    const text = envelopeErrorText(failed('未知动作: caddy_import_scan'));
    expect(text).toContain('升级节点 Agent');
    expect(text).not.toContain('未知动作');
  });

  it('recipe 清单缺失同样转成升级引导', () => {
    const text = envelopeErrorText(failed('recipe 清单不存在或不是 JSON 对象: installed.json'));
    expect(text).toContain('升级节点 Agent');
    expect(text).not.toContain('installed.json');
  });

  it('普通错误仍保留原文与 details', () => {
    expect(envelopeErrorText(failed('端口冲突', { port: 80 }))).toBe('端口冲突（{"port":80}）');
  });
});

describe('D-09 站点来源 Peer 与上游同步', () => {
  const oldPeer = { name: 'phone', allowedIps: ['10.0.0.2/32'] };
  const config = normalizeCaddyConfig({
    sites: [
      {
        name: 'new-site',
        domains: ['a.example.com'],
        kind: 'proxy',
        upstreams: ['10.0.0.2:8080'],
        sourcePeer: 'phone',
        sourcePort: 8080,
      },
      {
        name: 'legacy-port-changed',
        domains: ['b.example.com'],
        kind: 'proxy',
        upstreams: ['10.0.0.2:9000'],
        sourcePort: 8080,
      },
      {
        name: 'host-changed',
        domains: ['c.example.com'],
        kind: 'proxy',
        upstreams: ['10.0.0.9:80'],
        sourcePeer: 'phone',
        sourcePort: 80,
      },
    ],
  });

  it('规范化保留 sourcePeer/sourcePort', () => {
    const site = config.sites.find((item) => item.name === 'new-site');
    expect(site?.sourcePeer).toBe('phone');
    expect(site?.sourcePort).toBe(8080);
  });

  it('受影响站点同时覆盖来源 Peer 与新老站点，并标记手工改端口', () => {
    const impacts = findSitesImpactedByPeer(config, oldPeer);
    expect(impacts.map((item) => item.site.name)).toEqual([
      'new-site',
      'legacy-port-changed',
      'host-changed',
    ]);
    expect(impacts[1]?.portManuallyChanged).toBe(true);
    expect(impacts[2]?.hostMatchesOld).toBe(false);
  });

  it('同步只替换主机、保留当前端口，并跳过已被手工改主机的站点', () => {
    const result = syncSitesToPeer(config, oldPeer, '10.0.0.5');
    expect(result.updated).toEqual(['new-site', 'legacy-port-changed']);
    expect(result.skipped).toEqual(['host-changed']);
    const site = result.config.sites.find((item) => item.name === 'legacy-port-changed');
    expect(site?.upstreams[0]).toBe('10.0.0.5:9000');
  });

  it('splitUpstreamHostPort 解析 host:port', () => {
    expect(splitUpstreamHostPort('10.0.0.2:8080')).toEqual({ host: '10.0.0.2', port: 8080 });
    expect(splitUpstreamHostPort('10.0.0.2')).toEqual({ host: '10.0.0.2', port: null });
  });
});

describe('列表工具', () => {
  it('parseList 支持逗号/空白，formatList 回写逗号', () => {
    expect(parseList('10.0.0.1, 10.0.0.2  10.0.0.3')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
    ]);
    expect(formatList(['a', 'b'])).toBe('a, b');
  });
});

describe('hasExternalBlocks：外部配置唯一显示条件', () => {
  it('0 块或未扫描 → false；有块 → true', () => {
    expect(hasExternalBlocks(undefined)).toBe(false);
    expect(hasExternalBlocks([])).toBe(false);
    expect(hasExternalBlocks([{ id: 'a' }])).toBe(true);
  });
});
