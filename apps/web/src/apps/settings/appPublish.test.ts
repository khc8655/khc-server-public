import { describe, expect, it } from 'vitest';
import type { AppManifest, Node } from '@khc/contracts';
import {
  appPublishTarget,
  appPublishUpstream,
  appPublishUrl,
  deriveAppPublishPlan,
  nodeAgentPort,
  nodePublishDomain,
} from './appPublish';

const NOW = 1_700_000_000;

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'hub-1',
    name: 'hub-1',
    endpoint: 'https://app.example.com:2053',
    tunnelEndpoint: null,
    liveEndpoint: null,
    domain: 'app.example.com',
    accessMode: 'domain',
    tunnelId: null,
    allowInsecure: false,
    preferredRoute: 'direct',
    status: 'online',
    lastSeenAt: NOW,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function manifest(publish: AppManifest['manifest']['publish'] = {
  label: 'Web 管理页',
  host: '127.0.0.1',
  portParam: 'web_port',
  port: 3430,
}): AppManifest['manifest'] {
  return {
    name: 'magpie',
    version: '0.1.4265',
    runtime: { mode: 'create', user: 'khc-app-magpie', linger: true },
    params: [
      { key: 'port', type: 'integer', default: 3425 },
      { key: 'web_port', type: 'integer', default: 3430 },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    writes: [],
    ...(publish ? { publish } : {}),
  };
}

describe('应用目录发布计划', () => {
  it('域名节点 + 清单声明的端口 → 发布到 域名:发布端口，上游是本机端口', () => {
    const result = deriveAppPublishPlan({
      manifest: manifest(),
      node: node(),
      values: { web_port: 3430 },
      publishPort: 2083,
    });
    expect(result.issue).toBeNull();
    expect(result.plan).toEqual({
      domain: 'app.example.com',
      agentPort: 2053,
      publishPort: 2083,
      upstream: '127.0.0.1:3430',
    });
    expect(appPublishUrl(result.plan!)).toBe('https://app.example.com:2083');
    expect(appPublishTarget(result.plan!)).toBe('https://app.example.com:2083 → 127.0.0.1:3430');
  });

  it('发布端口与 Agent 端口相同时报冲突，不给计划', () => {
    const result = deriveAppPublishPlan({
      manifest: manifest(),
      node: node(),
      values: { web_port: 3430 },
      publishPort: 2053,
    });
    expect(result.issue).toBe('port-conflict');
    expect(result.plan).toBeNull();
    expect(result.agentPort).toBe(2053);
  });

  it('节点没有域名时不能发布，但上游仍然给出来（面板要能说明转到哪）', () => {
    const result = deriveAppPublishPlan({
      manifest: manifest(),
      node: node({ domain: null, endpoint: 'https://203.0.113.10:8880' }),
      values: { web_port: 3430 },
      publishPort: 2083,
    });
    expect(result.issue).toBe('no-domain');
    expect(result.plan).toBeNull();
    expect(result.upstream).toBe('127.0.0.1:3430');
  });

  it('清单没声明 publish 时不发布', () => {
    const noPublish = manifest();
    delete noPublish.publish;
    const result = deriveAppPublishPlan({
      manifest: noPublish,
      node: node(),
      values: { web_port: 3430 },
      publishPort: 2083,
    });
    expect(result.issue).toBe('no-publish');
    expect(result.plan).toBeNull();
  });

  it('端口参数没填或越界时视为没有可发布端口', () => {
    expect(appPublishUpstream(manifest(), {})).toBeNull();
    expect(appPublishUpstream(manifest(), { web_port: 0 })).toBeNull();
    expect(appPublishUpstream(manifest(), { web_port: 70000 })).toBeNull();
    const result = deriveAppPublishPlan({
      manifest: manifest(),
      node: node(),
      values: {},
      publishPort: 2083,
    });
    expect(result.issue).toBe('no-port');
  });

  it('只有固定端口（无 portParam）时用清单里的 port', () => {
    const fixed = manifest({ label: '管理页', host: '127.0.0.1', port: 3430 });
    expect(appPublishUpstream(fixed, {})).toBe('127.0.0.1:3430');
  });

  it('节点域名与 Agent 端口都从节点现状推导：域名入口默认 443，IP 入口取实际端口', () => {
    expect(nodePublishDomain(node({ domain: null, endpoint: 'https://a.example.com' }))).toBe(
      'a.example.com',
    );
    expect(nodePublishDomain(node({ domain: null, endpoint: 'https://203.0.113.10:8880' }))).toBe('');
    expect(nodeAgentPort(node({ endpoint: 'https://a.example.com' }))).toBe(443);
    expect(nodeAgentPort(node({ endpoint: 'https://a.example.com:2083' }))).toBe(2083);
    expect(nodeAgentPort(undefined)).toBe(0);
  });
});
