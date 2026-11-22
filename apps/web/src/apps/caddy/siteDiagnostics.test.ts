import { describe, expect, it } from 'vitest';
import { normalizeCaddyConfig, type CaddySite, type CaddySiteHealth } from '../../data/sites';
import { diagnoseSiteIssues } from './siteDiagnostics';

function site(overrides: Partial<CaddySite> = {}): CaddySite {
  const base = normalizeCaddyConfig({
    sites: [
      {
        name: 'llproxy',
        domains: ['test.16666.cyou'],
        listenPort: 8779,
        kind: 'proxy',
        upstreams: ['127.0.0.1:8787'],
        enabled: true,
      },
    ],
  }).sites[0]!;
  return { ...base, ...overrides };
}

function health(overrides: Partial<CaddySiteHealth> = {}): CaddySiteHealth {
  return {
    name: 'llproxy',
    domain: 'test.16666.cyou',
    state: 'down',
    status: null,
    latencyMs: null,
    error: 'dial tcp 127.0.0.1:8787: connect: connection refused',
    upstreams: ['127.0.0.1:8787'],
    ...overrides,
  };
}

describe('diagnoseSiteIssues', () => {
  it('本机上游端口未在 ops.network.listening 列表中监听 → local_port_not_listening', () => {
    const issues = diagnoseSiteIssues({
      rows: [{ site: site(), health: health() }],
      ops: { network: { listening: { items: [{ proto: 'tcp', address: '0.0.0.0', port: 9099 }] } } },
      backendContext: {},
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('local_port_not_listening');
    expect(issues[0]?.linkTarget).toBe('ops');
    expect(issues[0]?.summary).toContain('127.0.0.1:8787');
    expect(issues[0]?.summary).toContain('未监听');
  });

  it('ops 无监听快照时不误报「未监听」，降级为 upstream_unreachable', () => {
    const issues = diagnoseSiteIssues({
      rows: [{ site: site(), health: health({ status: 502 }) }],
      ops: {},
      backendContext: {},
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('upstream_unreachable');
    expect(issues[0]?.statusLabel).toBe('HTTP 502');
    expect(issues[0]?.summary).toContain('HTTP 502');
  });

  it('Peer 离线 → peer_offline', () => {
    const issues = diagnoseSiteIssues({
      rows: [
        {
          site: site({ name: 'sg-app', upstreams: ['10.99.0.5:8080'] }),
          health: health({ name: 'sg-app', status: 502, upstreams: ['10.99.0.5:8080'] }),
        },
      ],
      ops: {},
      backendContext: {
        wireguard: {
          installed: true,
          peers: [{ name: 'sg-nat', allowedIps: ['10.99.0.5/32'], online: false }],
        },
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('peer_offline');
    expect(issues[0]?.linkTarget).toBe('wireguard');
    expect(issues[0]?.summary).toContain('sg-nat');
  });

  it('WireGuard 已装但私网地址无匹配 Peer → peer_missing', () => {
    const issues = diagnoseSiteIssues({
      rows: [
        {
          site: site({ name: 'peer-app-sg', upstreams: ['10.99.0.4:8080'] }),
          health: health({ name: 'peer-app-sg', status: 502, upstreams: ['10.99.0.4:8080'] }),
        },
      ],
      ops: {},
      backendContext: { wireguard: { installed: true, peers: [] } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('peer_missing');
    expect(issues[0]?.linkTarget).toBe('wireguard');
    expect(issues[0]?.summary).toContain('10.99.0.4');
  });

  it('健康站点与已停用站点不进入排查列表', () => {
    const issues = diagnoseSiteIssues({
      rows: [
        { site: site({ name: 'ok-site' }), health: health({ name: 'ok-site', state: 'ok', status: 200 }) },
        { site: site({ name: 'off-site', enabled: false }), health: health({ name: 'off-site' }) },
      ],
      ops: {},
      backendContext: {},
    });
    expect(issues).toEqual([]);
  });
});
