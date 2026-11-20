import { describe, expect, it } from 'vitest';
import type { AgentState, Certificate, TlsProbe } from '@khc/contracts';
import type { AppConfigLike } from '../src/lib/node-summary';
import {
  EXPIRY_TODO_DAYS,
  certCoversDomain,
  classifySiteHealth,
  collectExpiringCerts,
  daysLeftFromNotAfter,
  projectNodeOverview,
  projectNodeProbe,
} from '../src/lib/node-overview';

const NOW = 1_700_000_000;

function makeCert(overrides: Partial<Certificate> & Pick<Certificate, 'id' | 'name' | 'domains'>): Certificate {
  return {
    issuer: 'acme',
    notAfter: NOW + 30 * 86_400,
    sourceNodeId: null,
    createdAt: NOW - 86_400,
    updatedAt: NOW - 86_400,
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    host: { hostname: 'hk-1', os: 'Debian 12', kernel: '6.1.0', uptime: 3600 },
    adapters: [],
    ports: [],
    ...overrides,
  };
}

describe('classifySiteHealth（§2.1 + P-8 应用在线判定）', () => {
  it('按规则判定 ok / 4xx / 500 / 502-504 / 自签 / down / unknown', () => {
    expect(classifySiteHealth({ state: 'ok', status: 200 })).toBe('online');
    expect(classifySiteHealth({ state: 'ok', status: 302 })).toBe('online');
    expect(classifySiteHealth({ state: 'warn', status: 401 })).toBe('online');
    expect(classifySiteHealth({ state: 'warn', status: 404 })).toBe('online');
    // P-8：500 仍算在线，只把 502/503/504 视为上游端口 down
    expect(classifySiteHealth({ state: 'warn', status: 500 })).toBe('online');
    expect(classifySiteHealth({ state: 'warn', status: 502 })).toBe('issue');
    expect(classifySiteHealth({ state: 'warn', status: 503 })).toBe('issue');
    expect(classifySiteHealth({ state: 'warn', status: 504 })).toBe('issue');
    // 自签证书但 HTTP 正常或无状态码
    expect(
      classifySiteHealth({ state: 'warn', status: 200, error: 'TLS 证书校验失败（自签/internal 证书）' }),
    ).toBe('online');
    expect(
      classifySiteHealth({ state: 'warn', status: null, error: 'TLS 证书校验失败（自签/internal 证书）' }),
    ).toBe('online');
    // 关键碰撞：自签证书 + 上游 502 必须判为 issue，不能被自签分支放行
    expect(
      classifySiteHealth({ state: 'warn', status: 502, error: 'TLS 证书校验失败（自签/internal 证书）' }),
    ).toBe('issue');
    expect(classifySiteHealth({ state: 'down', status: null, error: 'connection refused' })).toBe('issue');
    expect(classifySiteHealth({ state: 'down', status: 502 })).toBe('issue');
    expect(classifySiteHealth({ state: 'unknown', status: null })).toBe('unknown');
    expect(classifySiteHealth(null)).toBe('unknown');
    expect(classifySiteHealth(undefined)).toBe('unknown');
    expect(classifySiteHealth([])).toBe('unknown');
    expect(classifySiteHealth({})).toBe('unknown');
  });
});

describe('certCoversDomain', () => {
  it('支持大小写、末尾点与单层通配 *.example.com', () => {
    expect(certCoversDomain('app.example.com', ['app.example.com'])).toBe(true);
    expect(certCoversDomain('APP.EXAMPLE.COM.', ['app.example.com.'])).toBe(true);
    expect(certCoversDomain('api.example.com', ['*.example.com'])).toBe(true);
    expect(certCoversDomain('example.com', ['*.example.com'])).toBe(false);
    expect(certCoversDomain('a.b.example.com', ['*.example.com'])).toBe(false);
    expect(certCoversDomain('', ['*.example.com'])).toBe(false);
    expect(certCoversDomain('.example.com', ['*.example.com'])).toBe(false);
  });
});

describe('collectExpiringCerts', () => {
  it('收录 ≤14 天与已过期证书并按剩余天数升序排列', () => {
    const certs: Certificate[] = [
      makeCert({ id: 'c_ok', name: 'ok', notAfter: NOW + 20 * 86_400, domains: ['ok.test'] }),
      makeCert({ id: 'c_14', name: 'day14', notAfter: NOW + EXPIRY_TODO_DAYS * 86_400, domains: ['d14.test'] }),
      makeCert({ id: 'c_exp', name: 'expired', notAfter: NOW - 2 * 86_400, domains: ['exp.test'], sourceNodeId: 'nd_1' }),
      makeCert({ id: 'c_zero', name: 'today', notAfter: NOW - 10, domains: ['zero.test'] }),
      makeCert({ id: 'c_null', name: 'nodate', notAfter: null, domains: ['nd.test'] }),
    ];
    const items = collectExpiringCerts(certs, NOW);
    expect(items).toEqual([
      { id: 'c_exp', name: 'expired', daysLeft: -2, nodeId: 'nd_1' },
      { id: 'c_zero', name: 'today', daysLeft: 0, nodeId: null },
      { id: 'c_14', name: 'day14', daysLeft: 14, nodeId: null },
    ]);
    expect(daysLeftFromNotAfter(NOW - 10, NOW)).toBe(0);
  });
});

describe('projectNodeOverview & projectNodeProbe', () => {
  it('首页探针投影与 VM 概况投影严格同源，且过滤停用项与秘密字段', () => {
    const node = {
      id: 'nd_1',
      domain: 'hk.example.com',
      endpoint: 'https://hk.example.com:8443',
      accessMode: 'domain' as const,
    };
    const configs: AppConfigLike[] = [
      {
        app: 'caddy-site',
        config: {
          sites: [
            { name: 'web', kind: 'proxy', domains: ['web.example.com'], upstreams: ['127.0.0.1:8080'], enabled: true },
            { name: 'hermes', kind: 'proxy', domains: ['hermes.example.com'], upstreams: ['10.8.0.2:3000'], enabled: true },
            { name: 'api', kind: 'proxy', domains: ['api.example.com'], upstreams: ['127.0.0.1:9000'], enabled: true },
            { name: 'paused', kind: 'proxy', domains: ['paused.example.com'], upstreams: ['127.0.0.1:9001'], enabled: false },
            { name: 'docs', kind: 'static', domains: ['docs.example.com'], root: '/var/www', enabled: true },
            { name: 'go', kind: 'redirect', domains: ['go.example.com'], redirectTo: 'https://web.example.com', enabled: true },
            { name: 'off-static', kind: 'static', domains: ['x.example.com'], root: '/tmp', enabled: false },
          ],
        },
      },
      {
        app: 'wireguard',
        config: {
          enabled: true,
          interface: { name: 'wg0', listenPort: 51820, privateKey: 'SECRET_KEY' },
          peers: [
            { name: 'macbook', enabled: true, privateKey: 'PEER_SECRET' },
            { name: 'nas', enabled: true },
            { name: 'old-phone', enabled: false },
          ],
        },
      },
      {
        app: 'port-forward',
        config: {
          forwards: [
            { name: 'ssh', listenPort: 2222, targetHost: '10.8.0.2', targetPort: 22, protocol: 'tcp', enabled: true },
            { name: 'dns', listenPort: 5353, targetHost: '10.8.0.2', targetPort: 53, protocol: 'udp', enabled: true },
            { name: 'off', listenPort: 9999, targetHost: '10.8.0.2', targetPort: 99, protocol: 'tcp', enabled: false },
          ],
        },
      },
    ];
    const certs: Certificate[] = [
      makeCert({ id: 'c_node', name: 'hk-cert', domains: ['hk.example.com'], sourceNodeId: 'nd_1', notAfter: NOW + 10 * 86_400 }),
      makeCert({ id: 'c_other', name: 'other', domains: ['other.test'], sourceNodeId: 'nd_2', notAfter: NOW + 5 * 86_400 }),
    ];
    const state = makeState({
      agent: { version: '0.6.3', serverTime: NOW, tls: { enabled: true, notAfter: NOW + 63 * 86_400 } },
      adapters: [
        {
          name: 'caddy-site',
          version: '1.2.0',
          status: {
            siteHealth: [
              { name: 'web', domain: 'web.example.com', state: 'ok', status: 200, upstreams: ['127.0.0.1:8080'] },
              { name: 'hermes', domain: 'hermes.example.com', state: 'warn', status: 502, error: 'TLS 证书校验失败（自签/internal 证书）', upstreams: ['10.8.0.2:3000'] },
              { name: 'api', domain: 'api.example.com', state: 'warn', status: 500, upstreams: ['127.0.0.1:9000'] },
              { name: 'docs', domain: 'docs.example.com', state: 'ok', status: 200, upstreams: [] },
            ],
          },
        },
        {
          name: 'wireguard',
          version: '1.0.0',
          status: {
            peers: [
              { name: 'macbook', online: true, latestHandshake: NOW - 30 },
              { name: 'nas', online: false, latestHandshake: NOW - 7200 },
            ],
          },
        },
        {
          name: 'port-forward',
          version: '1.0.0',
          status: {
            forwards: [
              { name: 'ssh', listenPort: 2222, targetHost: '10.8.0.2', targetPort: 22, protocol: 'tcp', active: true },
              { name: 'dns', listenPort: 5353, targetHost: '10.8.0.2', targetPort: 53, protocol: 'udp', active: false },
            ],
          },
        },
      ],
      ops: {
        failedUnits: ['caddy.service'],
        services: {
          services: [
            { name: 'khc-agent', state: 'active' },
            { name: 'caddy', state: 'active' },
          ],
          failedUnits: ['ignored.service'],
        },
      },
    });
    const tls: TlsProbe = { state: 'verified', endpoint: node.endpoint, detail: null, checkedAt: NOW };

    const overview = projectNodeOverview({ node, configs, certs, state, tls, now: NOW });
    const probe = projectNodeProbe({ node, configs, certs, state, tls, now: NOW });

    expect(overview.apps).toEqual({
      online: 2,
      total: 3,
      staticCount: 1,
      redirectCount: 1,
      issues: [{ name: 'hermes', domain: 'hermes.example.com', state: 'warn', status: 502 }],
      items: [
        { name: 'web', domain: 'web.example.com', upstream: '127.0.0.1:8080', verdict: 'online', status: 200, error: null },
        { name: 'hermes', domain: 'hermes.example.com', upstream: '10.8.0.2:3000', verdict: 'issue', status: 502, error: 'TLS 证书校验失败（自签/internal 证书）' },
        { name: 'api', domain: 'api.example.com', upstream: '127.0.0.1:9000', verdict: 'online', status: 500, error: null },
      ],
    });
    expect(overview.peers).toEqual({
      enabled: true,
      online: 1,
      total: 2,
      offline: ['nas'],
      interfaceName: 'wg0',
      listenPort: 51820,
      items: [
        { name: 'macbook', online: true, latestHandshake: NOW - 30 },
        { name: 'nas', online: false, latestHandshake: NOW - 7200 },
      ],
    });
    expect(overview.forwards).toEqual({
      total: 2,
      tcpCount: 1,
      udpCount: 1,
      items: [
        { name: 'ssh', listenPort: 2222, targetHost: '10.8.0.2', targetPort: 22, protocol: 'tcp', active: true },
        { name: 'dns', listenPort: 5353, targetHost: '10.8.0.2', targetPort: 53, protocol: 'udp', active: false },
      ],
    });
    expect(overview.certs).toEqual({
      count: 1,
      soonestDaysLeft: 10,
      expiring: [{ id: 'c_node', name: 'hk-cert', daysLeft: 10, nodeId: 'nd_1' }],
    });
    expect(overview.accessCert).toEqual({ daysLeft: 63, tlsState: 'verified' });
    expect(overview.host).toEqual({
      hostname: 'hk-1',
      os: 'Debian 12',
      kernel: '6.1.0',
      uptime: 3600,
      agentVersion: '0.6.3',
    });
    expect(overview.managedServices).toEqual([
      { name: 'khc-agent', state: 'active' },
      { name: 'caddy', state: 'active' },
    ]);
    expect(overview.failedUnits).toEqual(['caddy.service']);

    // 探针与概况字段完全一致
    expect(probe.apps).toEqual({
      online: overview.apps.online,
      total: overview.apps.total,
      issues: overview.apps.issues,
      staticCount: overview.apps.staticCount,
      redirectCount: overview.apps.redirectCount,
    });
    expect(probe.peers).toEqual({
      online: overview.peers.online,
      total: overview.peers.total,
      enabled: overview.peers.enabled,
      offline: overview.peers.offline,
      interfaceName: overview.peers.interfaceName,
      listenPort: overview.peers.listenPort,
    });
    expect(probe.forwards).toEqual({
      total: overview.forwards.total,
      tcpCount: overview.forwards.tcpCount,
      udpCount: overview.forwards.udpCount,
    });
    expect(probe.certs).toEqual(overview.certs);
    expect(probe.accessCert).toEqual(overview.accessCert);

    const serialized = JSON.stringify(overview);
    expect(serialized).not.toMatch(/SECRET_KEY|PEER_SECRET/);
  });

  it('缺字段与非法结构安全返回空或 null，不抛出也不伪造数字', () => {
    const node = { id: 'nd_bad', domain: null, endpoint: 'http://1.2.3.4:8880', accessMode: 'ip' as const };
    const configs: AppConfigLike[] = [
      { app: 'caddy-site', config: { sites: [null, 'bad', { kind: 'proxy' }] } },
      { app: 'wireguard', config: { interface: 'bad', peers: 'bad' } },
      { app: 'port-forward', config: { forwards: [{ name: '', listenPort: 80 }, { name: 'ok', listenPort: 99999 }] } },
    ];
    const brokenState = {
      host: {},
      adapters: [
        { name: 'caddy-site', version: '1.0.0', status: { siteHealth: 'bad' } },
        { name: 'wireguard', version: '1.0.0', status: { peers: 'bad' } },
      ],
      ports: [],
    } as unknown as AgentState;

    const overview = projectNodeOverview({ node, configs, certs: [], state: brokenState, tls: null, now: NOW });
    expect(overview.apps).toEqual({ online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] });
    expect(overview.peers).toEqual({ enabled: true, online: null, total: 0, offline: [], interfaceName: null, listenPort: null, items: [] });
    expect(overview.forwards).toEqual({ total: 0, tcpCount: 0, udpCount: 0, items: [] });
    expect(overview.accessCert).toEqual({ daysLeft: null, tlsState: 'none' });
    expect(overview.failedUnits).toBeNull();
  });

  it('全部站点 health 为 unknown 时 apps.online 为 null（不伪造 0 在线）', () => {
    const node = { id: 'nd_u', domain: null, endpoint: 'https://u.test:8443', accessMode: 'domain' as const };
    const configs: AppConfigLike[] = [
      { app: 'caddy-site', config: { sites: [{ name: 'a', domains: ['a.test'], upstreams: ['127.0.0.1:8080'] }] } },
    ];
    const state = makeState({
      adapters: [{ name: 'caddy-site', version: '1.2.0', status: { siteHealth: [{ name: 'a', state: 'unknown' }] } }],
    });
    const overview = projectNodeOverview({ node, configs, certs: [], state, tls: null, now: NOW });
    expect(overview.apps.total).toBe(1);
    expect(overview.apps.online).toBeNull();
    expect(overview.apps.issues).toEqual([]);
  });

  it('wireguard.enabled=false 隐藏全部 Peer（即使库里留有 Peer）', () => {
    const node = { id: 'nd_caddy', domain: 'c.test', endpoint: 'https://c.test:8443', accessMode: 'domain' as const };
    const configs: AppConfigLike[] = [
      { app: 'wireguard', config: { enabled: false, peers: [{ name: 'p1', enabled: true }] } },
    ];
    const overview = projectNodeOverview({ node, configs, certs: [], state: null, tls: null, now: NOW });
    expect(overview.peers).toEqual({
      enabled: false,
      total: 0,
      online: null,
      offline: [],
      interfaceName: null,
      listenPort: null,
      items: [],
    });
  });

  it('无 D1 配置时可回退旧 Agent /state 投影', () => {
    const node = { id: 'nd_legacy', domain: null, endpoint: 'https://leg.test:8443', accessMode: 'domain' as const };
    const state = makeState({
      adapters: [
        {
          name: 'caddy-site',
          version: '1.0.0',
          status: {
            siteHealth: [
              { name: 'proxy1', domain: 'p1.test', state: 'ok', status: 200, upstreams: ['127.0.0.1:8000'] },
              { name: 'static1', domain: 's1.test', state: 'ok', status: 200, upstreams: [] },
            ],
          },
        },
        {
          name: 'wireguard',
          version: '1.0.0',
          status: { enabled: true, interface: 'wg0', listenPort: 51820, peers: [{ name: 'peer1', online: true }] },
        },
        {
          name: 'port-forward',
          version: '1.0.0',
          status: { forwards: [{ name: 'ssh', listenPort: 2222, targetHost: '10.0.0.2', targetPort: 22, protocol: 'tcp', active: true }] },
        },
      ],
    });
    const overview = projectNodeOverview({ node, configs: [], certs: [], state, tls: null, now: NOW });
    expect(overview.apps.total).toBe(1);
    expect(overview.apps.online).toBe(1);
    expect(overview.peers.total).toBe(1);
    expect(overview.peers.online).toBe(1);
    expect(overview.forwards.total).toBe(1);
  });

  it('IP 直连节点通过 $cert 引用导入证书、已过期证书进待办、且接入证书为 none', () => {
    const node = { id: 'nd_ip', domain: null, endpoint: 'http://203.0.113.8:8880', accessMode: 'ip' as const };
    const configs: AppConfigLike[] = [
      {
        app: 'caddy-site',
        config: {
          sites: [
            {
              name: 'app1',
              kind: 'proxy',
              domains: ['app.example.com'],
              upstreams: ['127.0.0.1:8080'],
              tls: { mode: 'manual', cert: { $cert: 'cert_imported' } },
            },
          ],
        },
      },
    ];
    const certs: Certificate[] = [
      makeCert({ id: 'cert_imported', name: 'imported-pem', domains: ['app.example.com'], sourceNodeId: null, notAfter: NOW - 3 * 86_400 }),
    ];
    const tls: TlsProbe = { state: 'none', endpoint: node.endpoint, detail: null, checkedAt: NOW };
    const overview = projectNodeOverview({ node, configs, certs, state: null, tls, now: NOW });
    expect(overview.certs).toEqual({
      count: 1,
      soonestDaysLeft: -3,
      expiring: [{ id: 'cert_imported', name: 'imported-pem', daysLeft: -3, nodeId: 'nd_ip' }],
    });
    expect(overview.accessCert).toEqual({ daysLeft: null, tlsState: 'none' });
  });

  it('接入证书优先级：agent.tls > certificates 适配器 > D1 证书库；Tunnel 始终 null', () => {
    const nodeDomain = { id: 'nd_d', domain: 'gw.example.com', endpoint: 'https://gw.example.com:8443', accessMode: 'domain' as const };
    const certs: Certificate[] = [
      makeCert({ id: 'c_d1', name: 'd1', domains: ['*.example.com'], notAfter: NOW + 40 * 86_400 }),
    ];
    const tls: TlsProbe = { state: 'verified', endpoint: nodeDomain.endpoint, detail: null, checkedAt: NOW };

    // 1. agent.tls 优先
    const s1 = makeState({
      agent: { version: '0.6.3', serverTime: NOW, tls: { enabled: true, notAfter: NOW + 12 * 86_400 } },
      adapters: [{ name: 'certificates', version: '1.0.0', status: { tls: { present: true, daysLeft: 25 } } }],
    });
    expect(projectNodeOverview({ node: nodeDomain, configs: [], certs, state: s1, tls, now: NOW }).accessCert).toEqual({
      daysLeft: 12,
      tlsState: 'verified',
    });

    // 2. certificates 适配器次之（支持 ISO notAfter 字符串）
    const isoFuture = new Date((NOW + 25 * 86_400) * 1000).toISOString();
    const s2 = makeState({
      adapters: [{ name: 'certificates', version: '1.0.0', status: { tls: { present: true, notAfter: isoFuture } } }],
    });
    expect(projectNodeOverview({ node: nodeDomain, configs: [], certs, state: s2, tls, now: NOW }).accessCert).toEqual({
      daysLeft: 25,
      tlsState: 'verified',
    });

    // 3. 回退 D1 证书库通配匹配
    expect(projectNodeOverview({ node: nodeDomain, configs: [], certs, state: null, tls, now: NOW }).accessCert).toEqual({
      daysLeft: 40,
      tlsState: 'verified',
    });

    // 4. Tunnel 模式由 Cloudflare 边缘托管，daysLeft 为 null
    const nodeTunnel = { id: 'nd_t', domain: 't.example.com', endpoint: 'https://t.example.com', accessMode: 'tunnel' as const };
    expect(projectNodeOverview({ node: nodeTunnel, configs: [], certs, state: s1, tls, now: NOW }).accessCert).toEqual({
      daysLeft: null,
      tlsState: 'verified',
    });
  });

  it('failedUnits 三态：ops.failedUnits > ops.services.failedUnits > null', () => {
    const node = { id: 'nd_f', domain: null, endpoint: 'https://f.test', accessMode: 'domain' as const };
    const sTop = makeState({ ops: { failedUnits: [] } });
    expect(projectNodeOverview({ node, configs: [], certs: [], state: sTop, tls: null, now: NOW }).failedUnits).toEqual([]);

    const sSvc = makeState({ ops: { services: { failedUnits: ['khc-agent.service'] } } });
    expect(projectNodeOverview({ node, configs: [], certs: [], state: sSvc, tls: null, now: NOW }).failedUnits).toEqual(['khc-agent.service']);

    const sNone = makeState({ ops: {} });
    expect(projectNodeOverview({ node, configs: [], certs: [], state: sNone, tls: null, now: NOW }).failedUnits).toBeNull();
    expect(projectNodeOverview({ node, configs: [], certs: [], state: null, tls: null, now: NOW }).failedUnits).toBeNull();
  });
});
