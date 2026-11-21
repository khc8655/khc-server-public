// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Node } from '@khc/contracts';
import {
  TUNNELS_SETTINGS_HREF,
  accessDraftIssue,
  initialAccessDraft,
  isAccessDraftSubmittable,
  toCreatePayload,
  toPatchPayload,
  type NodeAccessDraft,
} from './AccessForm';

function draft(patch: Partial<NodeAccessDraft> = {}): NodeAccessDraft {
  return {
    name: 'node-9',
    accessMode: 'domain',
    domainSource: 'record',
    zoneId: 'z1',
    recordId: 'rec-1',
    domain: 'agent.example.com',
    domainPort: '443',
    tunnelId: '',
    tunnelHostname: '',
    ipHost: '',
    ipPort: '8880',
    insecureConfirmed: false,
    dnsZoneId: '',
    dnsSubdomain: '',
    autoPublish: false,
    upstreamPort: '8080',
    ...patch,
  };
}

describe('AccessForm 纯函数', () => {
  it('域名模式：create / patch payload 自动生成 https endpoint 与 domain', () => {
    expect(toCreatePayload(draft())).toEqual({
      name: 'node-9',
      accessMode: 'domain',
      endpoint: 'https://agent.example.com',
      domain: 'agent.example.com',
    });
    expect(toPatchPayload(draft({ domainPort: '8443' }))).toEqual({
      accessMode: 'domain',
      endpoint: 'https://agent.example.com:8443',
      domain: 'agent.example.com',
    });
  });

  it('Tunnel 模式：payload 只带 tunnelId（endpoint 由服务端推导）', () => {
    const tunnelDraft = draft({
      accessMode: 'tunnel',
      tunnelId: 't1',
      tunnelHostname: 'agent.example.com',
    });
    expect(toCreatePayload(tunnelDraft)).toEqual({
      name: 'node-9',
      accessMode: 'tunnel',
      tunnelId: 't1',
    });
    expect(toPatchPayload(tunnelDraft)).toEqual({
      accessMode: 'tunnel',
      tunnelId: 't1',
    });
  });

  it('IP 模式：payload 固定 http + allowInsecure', () => {
    const ipDraft = draft({
      accessMode: 'ip',
      ipHost: '198.51.100.20',
      ipPort: '8880',
      insecureConfirmed: true,
    });
    expect(toCreatePayload(ipDraft)).toEqual({
      name: 'node-9',
      accessMode: 'ip',
      endpoint: 'http://198.51.100.20:8880',
      allowInsecure: true,
    });
    expect(toPatchPayload(ipDraft)).toEqual({
      accessMode: 'ip',
      endpoint: 'http://198.51.100.20:8880',
      allowInsecure: true,
    });
  });

  it('IP 未确认明文风险时不可提交', () => {
    const ipDraft = draft({
      accessMode: 'ip',
      ipHost: '198.51.100.20',
      ipPort: '8880',
      insecureConfirmed: false,
    });
    expect(accessDraftIssue(ipDraft)).toBe('请确认明文 HTTP 风险');
    expect(isAccessDraftSubmittable(ipDraft)).toBe(false);
    expect(isAccessDraftSubmittable({ ...ipDraft, insecureConfirmed: true })).toBe(true);
  });

  it('域名模式：手动输入域名时不带 Zone / 记录，仍生成 https endpoint', () => {
    const manual = draft({ domainSource: 'manual', zoneId: '', recordId: '', domain: 'app.other.net' });
    expect(toCreatePayload(manual)).toEqual({
      name: 'node-9',
      accessMode: 'domain',
      endpoint: 'https://app.other.net',
      domain: 'app.other.net',
    });
    expect(toPatchPayload({ ...manual, domainPort: '8443' })).toEqual({
      accessMode: 'domain',
      endpoint: 'https://app.other.net:8443',
      domain: 'app.other.net',
    });
  });

  it('域名模式：手动输入时框空 / 非法域名不可提交', () => {
    expect(accessDraftIssue(draft({ domainSource: 'manual', zoneId: '', recordId: '', domain: '' }))).toBe(
      '请填写域名',
    );
    expect(
      accessDraftIssue(draft({ domainSource: 'manual', zoneId: '', recordId: '', domain: 'not a domain' })),
    ).toBe('域名格式不正确');
    expect(
      isAccessDraftSubmittable(
        draft({ domainSource: 'manual', zoneId: '', recordId: '', domain: 'https://app.other.net/x' }),
      ),
    ).toBe(true);
  });

  it('一键发布与 Agent 自己抢 443 时不可提交；改用 8443 后可提交', () => {
    const clash = draft({ autoPublish: true, domainPort: '443' });
    expect(accessDraftIssue(clash)).toBe(
      '自动发布要把 443 留给 Caddy：请把 HTTPS 端口改为 8443，或取消自动发布',
    );
    expect(isAccessDraftSubmittable(clash)).toBe(false);
    expect(isAccessDraftSubmittable({ ...clash, domainPort: '8443' })).toBe(true);
    // 不自动发布时 443 仍然合法（Agent 独占 443 是域名模式的默认形态）
    expect(isAccessDraftSubmittable({ ...clash, autoPublish: false })).toBe(true);
  });

  it('存量节点有域名时默认落到「手动输入」，域名可直接改', () => {
    const existing = initialAccessDraft({
      id: 'n2',
      name: 'existing',
      endpoint: 'https://app.other.net',
      tunnelEndpoint: null,
      liveEndpoint: null,
      preferredRoute: 'direct',
      accessMode: 'domain',
      domain: 'app.other.net',
      status: 'offline',
      lastSeenAt: null,
      createdAt: 1,
      updatedAt: 1,
    } as Node);
    expect(existing.domainSource).toBe('manual');
    expect(existing.domain).toBe('app.other.net');
  });

  it('Tunnel 空态链接指向设置页隧道分段', () => {
    expect(TUNNELS_SETTINGS_HREF).toBe('/settings?tab=tunnels');
  });

  it('存量旧隧道节点：展示 Tunnel 但 tunnelId 为空，禁止静默保存', () => {
    const legacy = initialAccessDraft({
      id: 'n1',
      name: 'legacy',
      endpoint: 'https://old.example.com',
      tunnelEndpoint: null,
      liveEndpoint: null,
      preferredRoute: 'tunnel',
      accessMode: 'domain',
      status: 'offline',
      lastSeenAt: null,
      createdAt: 1,
      updatedAt: 1,
    } as Node);
    expect(legacy.accessMode).toBe('tunnel');
    expect(legacy.tunnelId).toBe('');
    expect(accessDraftIssue(legacy)).toBe('请选择一条隧道配置');
  });
});
