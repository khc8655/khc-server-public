import { describe, expect, it } from 'vitest';
import type { AppConfigRecord } from '../src/domain/repos';
import {
  desiredMode,
  summarizeAppConfig,
  summarizeAppSummaries,
  summarizeNodeApps,
} from '../src/lib/node-summary';

function record(app: string, config: Record<string, unknown>): AppConfigRecord {
  return {
    nodeId: 'nd_x',
    app,
    schemaVersion: 1,
    config,
    rev: 1,
    appliedRev: 1,
    secretsEnc: null,
    updatedAt: 0,
  };
}

describe('summarizeNodeApps（D1 期望配置派生，显示即开启）', () => {
  it('无任何配置：全部 null（UI 整行不渲染）', () => {
    expect(summarizeNodeApps([])).toEqual({ mode: null, peers: null, sites: null, forwards: null });
  });

  it('WireGuard 缺省视为启用：mode=wg，peers 计全长（含停用）', () => {
    const summary = summarizeNodeApps([
      record('wireguard', { peers: [{ name: 'a', enabled: true }, { name: 'b', enabled: false }] }),
    ]);
    expect(summary).toEqual({ mode: 'wg', peers: 2, sites: null, forwards: null });
  });

  it('WireGuard 已开启但 0 Peer：peers=0（区别于 null 的未开启）', () => {
    expect(summarizeNodeApps([record('wireguard', { peers: [] })]).peers).toBe(0);
  });

  it('enabled=false → 纯 Caddy：即使库里留着 Peer 也不展示', () => {
    const summary = summarizeNodeApps([
      record('wireguard', { enabled: false, peers: [{ name: 'a' }] }),
      record('caddy-site', { sites: [{ enabled: true }, { enabled: false }, {}] }),
    ]);
    expect(summary).toEqual({
      mode: 'caddy',
      peers: null,
      sites: { total: 3, disabled: 1 },
      forwards: null,
    });
  });

  it('有配置行但条数为 0：保留 0，不折成 null（UI 必须明确表达）', () => {
    const summary = summarizeNodeApps([
      record('caddy-site', { sites: [] }),
      record('port-forward', { forwards: [] }),
    ]);
    expect(summary.sites).toEqual({ total: 0, disabled: 0 });
    expect(summary.forwards).toBe(0);
    const withRules = summarizeNodeApps([
      record('port-forward', { forwards: [{ name: 'ssh' }, { name: 'dns' }] }),
    ]);
    expect(withRules.forwards).toBe(2);
  });

  it('形状异常的配置不炸：非数组按空计，非对象项不计停用', () => {
    const summary = summarizeNodeApps([
      record('wireguard', { peers: 'broken' }),
      record('caddy-site', { sites: [null, 'x', { enabled: false }] }),
      record('port-forward', { forwards: { length: 99 } }),
    ]);
    expect(summary).toEqual({
      mode: 'wg',
      peers: 0,
      sites: { total: 3, disabled: 1 },
      forwards: 0,
    });
  });

  it('summarizeAppConfig：单行只产出模式与计数（summary_json 的唯一写入口径）', () => {
    expect(summarizeAppConfig('wireguard', { peers: [{}, {}], enabled: false })).toEqual({
      mode: 'caddy',
      peers: 2,
    });
    expect(summarizeAppConfig('caddy-site', { sites: [{ enabled: true }, { enabled: false }] })).toEqual({
      sites: { total: 2, disabled: 1 },
    });
    expect(summarizeAppConfig('port-forward', { forwards: [{}] })).toEqual({ forwards: 1 });
    // 未知应用不落任何字段
    expect(summarizeAppConfig('host-ops', { anything: 'x' })).toEqual({});
  });

  it('summarizeAppSummaries：有行即非 null，与完整配置派生结果一致', () => {
    const configs = [
      record('wireguard', { peers: [{ name: 'a' }] }),
      record('caddy-site', { sites: [] }),
    ];
    const rows = configs.map((item) => ({
      app: item.app,
      summary: summarizeAppConfig(item.app, item.config),
    }));
    expect(summarizeAppSummaries(rows)).toEqual(summarizeNodeApps(configs));
  });

  it('summary_json 只含模式与计数：不出现私钥/证书/密码/哈希类字段', () => {
    const leaks = {
      privateKey: 'PRIVATE KEY',
      certPem: 'CERT PEM',
      passwordHash: 'hash',
      peers: [{ name: 'a', privateKey: 'x' }],
      sites: [{ name: 's', tls: { cert: 'CERT' } }],
      forwards: [{ name: 'f', secret: 'y' }],
    };
    const dumped = JSON.stringify(summarizeAppConfig('wireguard', leaks));
    expect(dumped).not.toMatch(/PRIVATE KEY|CERT PEM|hash|privateKey|certPem|passwordHash|secret/);
    expect(JSON.parse(dumped)).toEqual({ mode: 'wg', peers: 1 });
  });

  it('desiredMode 唯一真源：无记录 null / 缺省 wg / 显式 false caddy', () => {
    expect(desiredMode([])).toBeNull();
    expect(desiredMode([record('wireguard', {})])).toBe('wg');
    expect(desiredMode([record('wireguard', { enabled: true })])).toBe('wg');
    expect(desiredMode([record('wireguard', { enabled: false })])).toBe('caddy');
  });
});