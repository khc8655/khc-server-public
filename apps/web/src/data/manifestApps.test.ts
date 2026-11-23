import { describe, expect, it } from 'vitest';
import type { AgentState, AppManifest } from '@khc/contracts';
import { ApiError } from './client';
import {
  appStatus,
  canUpgrade,
  installActionForSchema,
  installedCatalogState,
  manifestErrorView,
  missingNodeFeatures,
  normalizeResultCards,
  toAppView,
  uninstallActionForSchema,
} from './manifestApps';

const validV1Manifest: AppManifest = {
  id: 'demo-v1',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    name: 'Demo V1',
    version: '1.0.0',
    runtime: { mode: 'create', user: 'khc-app-demo', linger: true },
    params: [{ key: 'web_port', type: 'integer', default: 3000 }],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    writes: [],
    publish: { label: 'Web', host: '127.0.0.1', portParam: 'web_port', port: 3000 },
  },
};

const validV2Manifest: AppManifest = {
  id: 'demo-v2',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    schema: 2,
    name: 'Demo V2',
    version: '2.0.0',
    runtime: { mode: 'root', linger: true },
    params: [
      {
        key: 'preset',
        type: 'enum',
        default: 'lite',
        options: [
          { value: 'lite', label: '轻量' },
          { value: 'full', label: '完整', requires: { memMB: 800 } },
        ],
      },
    ],
    scripts: { install: '#!/bin/sh\n', upgrade: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), upgrade: '1'.repeat(64), uninstall: '2'.repeat(64) },
    writes: [],
    units: [{ name: 'demo-v2.service', scope: 'system' }],
    health: { type: 'http', url: 'http://127.0.0.1:7860/health', expectStatus: 200, graceSec: 30, intervalSec: 2, timeoutMs: 1000 },
    sources: [{ host: 'example.com', purpose: '动态脚本', pinned: false }],
  },
};

function makeState(
  catalogStatus: Record<string, unknown>,
  caps?: { schemas: number[]; features: string[] },
): AgentState {
  return {
    host: {
      hostname: 'h1',
      os: 'Ubuntu',
      kernel: '6.8',
      uptime: 100,
      load: [0, 0, 0],
      disk: { total: 100, used: 10, free: 90, percent: 10 },
      mem: { total: 1000, available: 800, used: 200, percent: 20 },
    },
    adapters: [{ name: 'app-catalog', version: '1.0.0', appliedRev: null, status: catalogStatus }],
    ports: [],
    agent: {
      version: '0.8.0',
      serverTime: 1_700_000_000,
      ...(caps ? { capabilities: { appManifest: caps } } : {}),
    },
  };
}

describe('manifestApps 纯函数单测（V4）', () => {
  it('toAppView：v1 归一化为 v2、计算 dynamicScript 与 requiredFeatures，坏清单不调用 toManifestV2', () => {
    const v1 = toAppView(validV1Manifest);
    expect(v1.schema).toBe(1);
    expect(v1.invalid).toBe(false);
    expect(v1.dynamicScript).toBe(false);
    expect(v1.def.endpoints?.[0]?.id).toBe('web');
    expect(installActionForSchema(v1.schema)).toBe('recipe_install');
    expect(uninstallActionForSchema(v1.schema)).toBe('recipe_uninstall');

    const v2 = toAppView(validV2Manifest);
    expect(v2.schema).toBe(2);
    expect(v2.dynamicScript).toBe(true);
    expect(v2.requiredFeatures).toContain('upgrade');
    expect(v2.requiredFeatures).toContain('params.enum');
    expect(installActionForSchema(v2.schema)).toBe('manifest_install');
    expect(uninstallActionForSchema(v2.schema)).toBe('manifest_uninstall');

    const broken: AppManifest = {
      id: 'broken-app',
      enabled: true,
      invalid: true,
      error: 'sha256 不匹配',
      createdAt: 1,
      updatedAt: 2,
    };
    const brokenView = toAppView(broken);
    expect(brokenView.invalid).toBe(true);
    expect(brokenView.error).toBe('sha256 不匹配');
    expect(brokenView.def.name).toBe('broken-app');
  });

  it('installedCatalogState：按 manifestId/instance 字段定位条目（含非默认实例），支持 stale/pending', () => {
    const state = makeState({
      stale: { since: 1700000000, reason: 'timeout' },
      installedDetail: {
        'arbitrary-key-1': {
          manifestId: 'demo-v2',
          instance: 'custom-inst',
          version: '1.9.0',
          schema: 2,
          source: 'manifest',
          units: [{ name: 'demo-v2.service', scope: 'system', active: 'active' }],
          lastHealth: { ok: true, checkedAt: '2026-11-23T00:00:00Z', version: '1.9.0' },
        },
        'legacy-recipe': {
          version: '1.0.0',
          source: 'recipe',
        },
      },
    });
    const parsed = installedCatalogState(state);
    expect(parsed.stale).toBe(true);
    expect(parsed.pending).toBe(false);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      manifestId: 'demo-v2',
      instance: 'custom-inst',
      version: '1.9.0',
      schema: 2,
      source: 'manifest',
    });
    expect(parsed.entries[1]).toMatchObject({
      manifestId: 'legacy-recipe',
      source: 'recipe',
    });

    const pendingState = installedCatalogState(makeState({ error: 'status timeout', pending: true }));
    expect(pendingState.pending).toBe(true);
    expect(pendingState.error).toBe('status timeout');
  });

  it('appStatus：覆盖 运行中 / 异常 / 已安装 / 未读取 四态', () => {
    const base = {
      manifestId: 'demo-v2',
      instance: 'demo-v2',
      version: '1.0.0',
      schema: 2 as const,
      units: [{ name: 'u.service', scope: 'user' as const, active: 'active' }],
      endpoints: [],
      source: 'manifest',
    };
    expect(appStatus({ ...base, lastHealth: { ok: true } })).toEqual({ tone: 'ok', label: '运行中' });
    expect(appStatus({ ...base, lastHealth: { ok: false, error: '500' } })).toEqual({
      tone: 'danger',
      label: '异常',
    });
    expect(
      appStatus({ ...base, units: [{ name: 'u.service', scope: 'user', active: 'failed' }] }),
    ).toEqual({ tone: 'danger', label: '异常' });
    expect(appStatus({ ...base, units: [], lastHealth: undefined })).toEqual({
      tone: 'neutral',
      label: '已安装',
    });
    expect(appStatus({ ...base, lastHealth: { ok: true } }, { stale: true, pending: false })).toEqual({
      tone: 'neutral',
      label: '未读取',
    });
    expect(appStatus({ ...base, lastHealth: { ok: true } }, { stale: false, pending: true })).toEqual({
      tone: 'neutral',
      label: '未读取',
    });
  });

  it('canUpgrade 与 missingNodeFeatures：按契约能力推导判定', () => {
    const v2View = toAppView(validV2Manifest);
    const v1View = toAppView(validV1Manifest);
    const oldState = makeState({}, { schemas: [1], features: [] });
    const fullState = makeState({}, { schemas: [1, 2], features: ['schema2', 'upgrade', 'units', 'health.http', 'params.enum'] });

    expect(missingNodeFeatures(v1View, oldState)).toEqual([]);
    expect(missingNodeFeatures(v2View, oldState)).toEqual(v2View.requiredFeatures);
    expect(missingNodeFeatures(v2View, fullState)).toEqual([]);

    const entry = {
      manifestId: 'demo-v2',
      instance: 'demo-v2',
      version: '1.0.0',
      schema: 2 as const,
      units: [],
      endpoints: [],
      source: 'manifest',
    };
    expect(canUpgrade(v2View, entry, fullState)).toBe(true);
    expect(canUpgrade(v2View, { ...entry, version: '2.0.0' }, fullState)).toBe(false);
    expect(canUpgrade(v2View, entry, oldState)).toBe(false);
    expect(canUpgrade(v1View, { ...entry, schema: 1 }, fullState)).toBe(false);
  });

  it('normalizeResultCards：v2 按 kind/primary 渲染，v1 仅将 http(s):// 值转为 url', () => {
    const v2Cards = normalizeResultCards(2, [
      { title: '打开', value: 'https://a.example.com', kind: 'url', primary: true, copy: true },
      { title: '密钥', value: 'sec-123', kind: 'secret' },
      { title: '命令', value: 'curl https://x', kind: 'command' },
      { title: '说明', value: 'ok' },
    ]);
    expect(v2Cards).toEqual([
      { title: '打开', value: 'https://a.example.com', kind: 'url', primary: true, copy: true },
      { title: '密钥', value: 'sec-123', kind: 'secret', primary: false, copy: false },
      { title: '命令', value: 'curl https://x', kind: 'command', primary: false, copy: false },
      { title: '说明', value: 'ok', kind: 'text', primary: false, copy: false },
    ]);

    const v1Cards = normalizeResultCards(1, [
      { title: 'Web 登录', value: 'https://legacy.example.com/?k=1', copy: true },
      { title: '监听', value: '127.0.0.1:3430' },
    ]);
    expect(v1Cards[0]?.kind).toBe('url');
    expect(v1Cards[1]?.kind).toBe('text');
  });

  it('manifestErrorView：覆盖 §3.1 全部错误码映射', () => {
    expect(
      manifestErrorView(
        new ApiError(409, 'agent_upgrade_required', '旧版', undefined, {
          missing: ['schema2', 'units'],
          minAgentVersion: '0.8.0',
        }),
      ),
    ).toMatchObject({ actionKind: 'upgrade-agent', missingFeatures: ['schema2', 'units'] });

    expect(
      manifestErrorView(
        new ApiError(422, 'preflight_failed', '预检未通过', undefined, {
          checks: [{ name: 'mem', ok: false, message: '内存不足' }],
        }),
      ).checks,
    ).toEqual([{ name: 'mem', ok: false, message: '内存不足' }]);

    expect(
      manifestErrorView(
        new ApiError(400, 'secret_not_configured', '凭据未配置', undefined, { name: 'api_key' }),
      ),
    ).toMatchObject({ actionKind: 'config-secrets', secretNames: ['api_key'] });

    expect(
      manifestErrorView(
        new ApiError(400, 'secret_host_not_allowed', '主机越界', undefined, {
          name: 'api_key',
          host: 'xng.khc6.cn',
        }),
      ),
    ).toMatchObject({
      actionKind: 'config-secrets',
      secretNames: ['api_key'],
      detail: '凭据 api_key 未授权发送给 xng.khc6.cn',
    });

    expect(
      manifestErrorView(
        new ApiError(502, 'hook_failed', '步骤失败', undefined, {
          stage: 'preInstall',
          status: 503,
          error: 'upstream busy',
        }),
      ),
    ).toMatchObject({ title: 'preInstall 失败（HTTP 503）', detail: 'upstream busy' });

    expect(
      manifestErrorView(
        new ApiError(502, 'hook_extract_failed', '提取失败', undefined, {
          stage: 'preUpgrade',
          error: 'missing /ticket',
        }),
      ),
    ).toMatchObject({ title: 'preUpgrade 执行失败', detail: 'missing /ticket' });

    expect(
      manifestErrorView(new ApiError(400, 'insecure_channel_secret', '明文通道')),
    ).toMatchObject({ actionKind: 'switch-channel' });

    expect(
      manifestErrorView(
        new ApiError(500, 'health_failed', '健康检查未通过', undefined, {
          logs: { 'demo.service': 'line1\nline2' },
        }),
      ),
    ).toMatchObject({ title: '健康检查未通过', logs: '[demo.service]\nline1\nline2' });

    expect(manifestErrorView(new ApiError(400, 'manifest_invalid', '清单非法')).title).toBe('清单非法');
    expect(manifestErrorView(new ApiError(409, 'not_installed', '未安装')).title).toBe('未安装');
  });

  it('源码扫描：apps/web/src 非测试文件不含应用名、public_url 与 recipe_installed', () => {
    const modules = import.meta.glob(['../**/*.ts', '../**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const entries = Object.entries(modules).filter(
      ([file]) => !/\.(test|smoke\.test)\.(ts|tsx)$/.test(file),
    );
    expect(entries.length).toBeGreaterThan(20);
    const forbidden = ['magpie', 'khcsearch', 'public_url', 'recipe_installed'];
    const hits: string[] = [];

    for (const [file, text] of entries) {
      for (const token of forbidden) {
        if (text.includes(token)) {
          hits.push(`${file} -> ${token}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
