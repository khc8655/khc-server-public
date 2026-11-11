import { afterEach, describe, expect, it } from 'vitest';
import { assertHubWriteAllowed, setHubWriteGuard } from './writeGuard';

afterEach(() => setHubWriteGuard(null));

describe('浏览器侧写闸门：保存类放行、执行类拦截', () => {
  it('控制面不可达时放行保存类 PUT（应用配置与节点字段），拦截执行类 POST', () => {
    setHubWriteGuard({ hubId: 'hub_a', canMutate: false, reason: '只读' });
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/caddy-site', { method: 'PUT' })).not.toThrow();
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a', { method: 'PUT' })).not.toThrow();
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/caddy-site/apply', { method: 'POST' })).toThrow('只读');
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/wireguard/plan', { method: 'POST' })).toThrow('只读');
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/caddy-site', { method: 'GET' })).not.toThrow();
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/live-ticket', { method: 'POST' })).not.toThrow();
    expect(() => assertHubWriteAllowed('/api/v1/certs', { method: 'POST' })).not.toThrow();
  });

  it('保存类放行仅限精确的 PUT 路径；其他 method 的同前缀仍拦截', () => {
    setHubWriteGuard({ hubId: 'hub_a', canMutate: false, reason: '只读' });
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/caddy-site', { method: 'DELETE' })).toThrow('只读');
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/agent/upgrade', { method: 'POST' })).toThrow('只读');
  });

  it('离线时放行「生成安装/卸载命令」（纯文本产出，不触达 Hub）', () => {
    // 2026-11-07 真机：卸载后节点必然离线，若拦截就等于卸载成了单程票。
    setHubWriteGuard({ hubId: 'hub_a', canMutate: false, reason: '只读' });
    expect(() =>
      assertHubWriteAllowed('/api/v1/nodes/hub_a/agent/install-command', { method: 'POST' }),
    ).not.toThrow();
    expect(() =>
      assertHubWriteAllowed('/api/v1/nodes/hub_a/agent/uninstall-command', { method: 'POST' }),
    ).not.toThrow();
    // 但真正的执行类（下发升级）仍然拦截
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/agent/upgrade', { method: 'POST' })).toThrow('只读');
  });

  it('控制面可达时不拦截', () => {
    setHubWriteGuard({ hubId: 'hub_a', canMutate: true, reason: '' });
    expect(() => assertHubWriteAllowed('/api/v1/nodes/hub_a/apps/caddy-site/apply', { method: 'POST' })).not.toThrow();
  });
});
