import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MANIFEST_FEATURES,
  TemplateRenderError,
  agentSelfSchema,
  appManifestAnyDefinitionSchema,
  appManifestDefinitionSchema,
  appManifestDefinitionV2Schema,
  appSecretKey,
  appSecretValueSchema,
  listTemplateVars,
  renderTemplate,
  requiredAgentFeatures,
  resultCardSchema,
  toManifestV2,
  type AppManifestDefinitionV2Input,
} from '../src/index';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(HERE, '../test-vectors/manifest-template.json');
const MAGPIE_PATH = path.resolve(HERE, '../../../apps/manifests/magpie/manifest.json');

interface TemplateVector {
  template: string;
  vars: Record<string, unknown>;
  expect?: string;
  error?: 'template_missing_var' | 'template_invalid_syntax';
}

function minimalV2(overrides: Partial<AppManifestDefinitionV2Input> = {}): AppManifestDefinitionV2Input {
  return {
    schema: 2,
    name: 'demo-v2',
    version: '1.0.0',
    runtime: { mode: 'create', linger: true },
    params: [],
    scripts: {
      install: '#!/usr/bin/env bash\necho install\n',
      uninstall: '#!/usr/bin/env bash\necho uninstall\n',
    },
    sha256: {
      install: SHA_A,
      uninstall: SHA_B,
    },
    writes: [],
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe('manifest-v2: schema 交叉校验 1–10（每条一正一反）', () => {
  it('1. sha256 键集合必须与 scripts 严格一致', () => {
    const valid = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        scripts: { install: 'i', uninstall: 'u', upgrade: 'up' },
        sha256: { install: SHA_A, uninstall: SHA_B, upgrade: SHA_C },
      }),
    );
    expect(valid.success).toBe(true);

    const missingSha = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        scripts: { install: 'i', uninstall: 'u', upgrade: 'up' },
        sha256: { install: SHA_A, uninstall: SHA_B },
      }),
    );
    expect(missingSha.success).toBe(false);
    if (!missingSha.success) {
      expect(missingSha.error.issues[0]?.path).toEqual(['sha256', 'upgrade']);
    }

    const extraSha = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        scripts: { install: 'i', uninstall: 'u' },
        sha256: { install: SHA_A, uninstall: SHA_B, upgrade: SHA_C },
      }),
    );
    expect(extraSha.success).toBe(false);
    if (!extraSha.success) {
      expect(extraSha.error.issues[0]?.path).toEqual(['sha256', 'upgrade']);
    }
  });

  it('2. options 仅在 enum 时出现且必填；enum 默认值必须命中 options.value', () => {
    const ok = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
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
      }),
    );
    expect(ok.success).toBe(true);

    const enumWithoutOptions = appManifestDefinitionV2Schema.safeParse(
      minimalV2({ params: [{ key: 'preset', type: 'enum' }] }),
    );
    expect(enumWithoutOptions.success).toBe(false);
    if (!enumWithoutOptions.success) {
      expect(enumWithoutOptions.error.issues[0]?.path).toEqual(['params', 0, 'options']);
    }

    const stringWithOptions = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [
          {
            key: 'preset',
            type: 'string',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ],
      }),
    );
    expect(stringWithOptions.success).toBe(false);
    if (!stringWithOptions.success) {
      expect(stringWithOptions.error.issues[0]?.path).toEqual(['params', 0, 'options']);
    }

    const badDefault = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [
          {
            key: 'preset',
            type: 'enum',
            default: 'unknown',
            options: [
              { value: 'lite', label: '轻量' },
              { value: 'full', label: '完整' },
            ],
          },
        ],
      }),
    );
    expect(badDefault.success).toBe(false);
    if (!badDefault.success) {
      expect(badDefault.error.issues[0]?.path).toEqual(['params', 0, 'default']);
    }
  });

  it('3. derive 仅允许非 secret 的 string 参数，且引用 endpoint id 必须存在', () => {
    const ok = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [
          { key: 'port', type: 'integer', default: 7860 },
          { key: 'public_url', type: 'string', derive: 'endpoint:mcp.publicUrl' },
        ],
        endpoints: [
          { id: 'mcp', label: 'MCP', protocol: 'http', portParam: 'port' },
        ],
      }),
    );
    expect(ok.success).toBe(true);

    const badEndpoint = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'public_url', type: 'string', derive: 'endpoint:missing.publicUrl' }],
      }),
    );
    expect(badEndpoint.success).toBe(false);
    if (!badEndpoint.success) {
      expect(badEndpoint.error.issues[0]?.path).toEqual(['params', 0, 'derive']);
    }

    const deriveOnSecret = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'public_url', type: 'string', secret: true, derive: 'endpoint:web.publicUrl' }],
        endpoints: [{ id: 'web', label: 'Web', protocol: 'http', port: 8080 }],
      }),
    );
    expect(deriveOnSecret.success).toBe(false);

    const deriveOnInt = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'p', type: 'integer', derive: 'endpoint:web.publicUrl' }],
        endpoints: [{ id: 'web', label: 'Web', protocol: 'http', port: 8080 }],
      }),
    );
    expect(deriveOnInt.success).toBe(false);
  });

  it('4. endpoint 与 tcp health 的 port/portParam 必须二选一且 portParam 为 integer 参数', () => {
    const ok = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'port', type: 'integer', default: 7860 }],
        endpoints: [{ id: 'mcp', label: 'MCP', protocol: 'http', portParam: 'port' }],
        health: { type: 'tcp', port: 7860 },
      }),
    );
    expect(ok.success).toBe(true);

    const both = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'port', type: 'integer' }],
        endpoints: [{ id: 'mcp', label: 'MCP', protocol: 'http', port: 7860, portParam: 'port' }],
      }),
    );
    expect(both.success).toBe(false);

    const neither = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        health: { type: 'tcp' },
      }),
    );
    expect(neither.success).toBe(false);

    const nonIntParam = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        params: [{ key: 'port', type: 'string' }],
        health: { type: 'tcp', portParam: 'port' },
      }),
    );
    expect(nonIntParam.success).toBe(false);
    if (!nonIntParam.success) {
      expect(nonIntParam.error.issues[0]?.path).toEqual(['health', 'portParam']);
    }
  });

  it('5. endpoint id 唯一；publish: caddy 只允许 http；默认 publish 随 protocol', () => {
    const parsed = appManifestDefinitionV2Schema.parse(
      minimalV2({
        endpoints: [
          { id: 'web', label: 'Web', protocol: 'http', port: 8080 },
          { id: 'sock', label: 'TCP', protocol: 'tcp', port: 9000 },
        ],
      }),
    );
    expect(parsed.endpoints?.[0]?.publish).toBe('caddy');
    expect(parsed.endpoints?.[1]?.publish).toBe('none');

    const dupId = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        endpoints: [
          { id: 'web', label: 'Web1', protocol: 'http', port: 8080 },
          { id: 'web', label: 'Web2', protocol: 'http', port: 8081 },
        ],
      }),
    );
    expect(dupId.success).toBe(false);
    if (!dupId.success) {
      expect(dupId.error.issues[0]?.path).toEqual(['endpoints', 1, 'id']);
    }

    const tcpCaddy = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        endpoints: [{ id: 'sock', label: 'TCP', protocol: 'tcp', port: 9000, publish: 'caddy' }],
      }),
    );
    expect(tcpCaddy.success).toBe(false);
    if (!tcpCaddy.success) {
      expect(tcpCaddy.error.issues[0]?.path).toEqual(['endpoints', 0, 'publish']);
    }
  });

  it('6. unit scope 与 runtime.mode 对应，unit.name 允许 {{instance}} 但拒越界变量', () => {
    const rootOk = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        runtime: { mode: 'root', linger: false },
        units: [{ name: 'khcsearch-{{instance}}', scope: 'system' }],
      }),
    );
    expect(rootOk.success).toBe(true);

    const userMismatch = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        runtime: { mode: 'create', linger: true },
        units: [{ name: 'sys.service', scope: 'system' }],
      }),
    );
    expect(userMismatch.success).toBe(false);
    if (!userMismatch.success) {
      expect(userMismatch.error.issues[0]?.path).toEqual(['units', 0, 'scope']);
    }

    const rootWithUserUnit = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        runtime: { mode: 'root', linger: true },
        units: [{ name: 'usr.service', scope: 'user' }],
      }),
    );
    expect(rootWithUserUnit.success).toBe(false);

    const unitWithNodeVar = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        runtime: { mode: 'create', linger: true },
        units: [{ name: 'app-{{node.id}}', scope: 'user' }],
      }),
    );
    expect(unitWithNodeVar.success).toBe(false);
  });

  it('7. secret 引用只许出现在 hook headers/body 且必须在 secrets[] 声明；facts 禁入 preInstall', () => {
    const ok = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        secrets: [{ name: 'provision_key', label: 'Provision Key' }],
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://hub.example.com/provision',
            headers: { Authorization: 'Bearer {{secret.provision_key}}' },
            body: { node: '{{node.name}}-{{instance}}', keyEcho: '{{secret.provision_key}}' },
            extract: { hub_node_id: '/node/id' },
            public: ['hub_node_id'],
          },
          preUninstall: {
            method: 'DELETE',
            url: 'https://hub.example.com/nodes/{{facts.hub_node_id}}',
            headers: { Authorization: 'Bearer {{secret.provision_key}}' },
          },
        },
      }),
    );
    expect(ok.success).toBe(true);

    const secretInUrl = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        secrets: [{ name: 'k', label: 'K' }],
        hooks: {
          preInstall: {
            method: 'GET',
            url: 'https://hub.example.com/api?k={{secret.k}}',
          },
        },
      }),
    );
    expect(secretInUrl.success).toBe(false);
    if (!secretInUrl.success) {
      expect(secretInUrl.error.issues[0]?.path).toEqual(['hooks', 'preInstall', 'url']);
    }

    const undeclaredSecret = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://hub.example.com/api',
            headers: { Authorization: 'Bearer {{secret.missing}}' },
          },
        },
      }),
    );
    expect(undeclaredSecret.success).toBe(false);
    if (!undeclaredSecret.success) {
      expect(undeclaredSecret.error.issues[0]?.path).toEqual([
        'hooks',
        'preInstall',
        'headers',
        'Authorization',
      ]);
    }

    const factsInPreInstall = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://hub.example.com/nodes/{{facts.hub_node_id}}',
          },
        },
      }),
    );
    expect(factsInPreInstall.success).toBe(false);
  });

  it('8. hook public 键必须全部存在 extract 中', () => {
    const ok = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://hub.example.com/provision',
            extract: { ticket: '/install/ticket', hub_node_id: '/node/id' },
            public: ['hub_node_id'],
          },
        },
      }),
    );
    expect(ok.success).toBe(true);

    const bad = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://hub.example.com/provision',
            extract: { ticket: '/install/ticket' },
            public: ['hub_node_id'],
          },
        },
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.path).toEqual(['hooks', 'preInstall', 'public', 0]);
    }
  });

  it('9. health(http) 仅允许 http://127.0.0.1: 与 http://[::1]: 回环前缀', () => {
    const okV4 = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        health: { type: 'http', url: 'http://127.0.0.1:{{params.port}}/health', versionPointer: '/ver' },
      }),
    );
    expect(okV4.success).toBe(true);

    const okV6 = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        health: { type: 'http', url: 'http://[::1]:7860/readyz' },
      }),
    );
    expect(okV6.success).toBe(true);

    for (const badUrl of [
      'http://localhost:7860/health',
      'https://127.0.0.1:7860/health',
      'http://10.0.0.1:7860/health',
      'http://127.0.0.1:80@evil.com/health',
    ]) {
      const bad = appManifestDefinitionV2Schema.safeParse(
        minimalV2({ health: { type: 'http', url: badUrl } }),
      );
      expect(bad.success).toBe(false);
    }
  });

  it('10. hook url 必须 https:// 开头且主机部分不含模板，并拒绝未知字段 (.strict)', () => {
    const badScheme = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: { preInstall: { method: 'POST', url: 'http://hub.example.com/a' } },
      }),
    );
    expect(badScheme.success).toBe(false);

    const templateHost = appManifestDefinitionV2Schema.safeParse(
      minimalV2({
        hooks: { preInstall: { method: 'POST', url: 'https://{{params.host}}/a' } },
      }),
    );
    expect(templateHost.success).toBe(false);
    if (!templateHost.success) {
      expect(templateHost.error.issues[0]?.path).toEqual(['hooks', 'preInstall', 'url']);
    }

    const unknownField = appManifestDefinitionV2Schema.safeParse({
      ...minimalV2(),
      unexpected: true,
    });
    expect(unknownField.success).toBe(false);
  });
});

describe('manifest-v2: 上限边界与 JSON Pointer / RFC 6901', () => {
  it('params 33、endpoints 9、脚本 64KB+1、body 8KB+1、body 深度 5 全部拒绝', () => {
    const params32 = Array.from({ length: 32 }, (_, i) => ({
      key: `p_${i}`,
      type: 'string' as const,
    }));
    expect(appManifestDefinitionV2Schema.safeParse(minimalV2({ params: params32 })).success).toBe(true);
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({ params: [...params32, { key: 'p_32', type: 'string' }] }),
      ).success,
    ).toBe(false);

    const endpoints8 = Array.from({ length: 8 }, (_, i) => ({
      id: `ep-${i}`,
      label: `EP ${i}`,
      protocol: 'http' as const,
      port: 8000 + i,
    }));
    expect(
      appManifestDefinitionV2Schema.safeParse(minimalV2({ endpoints: endpoints8 })).success,
    ).toBe(true);
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          endpoints: [
            ...endpoints8,
            { id: 'ep-8', label: 'EP 8', protocol: 'http', port: 8008 },
          ],
        }),
      ).success,
    ).toBe(false);

    const script64k = 'a'.repeat(64 * 1024);
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({ scripts: { install: script64k, uninstall: 'u' } }),
      ).success,
    ).toBe(true);
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({ scripts: { install: `${script64k}x`, uninstall: 'u' } }),
      ).success,
    ).toBe(false);

    // {"v":"..."} => 8 字节外框 + payload
    const bodyAtLimit = { v: 'x'.repeat(8 * 1024 - 8) };
    expect(JSON.stringify(bodyAtLimit).length).toBe(8 * 1024);
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          hooks: { preInstall: { method: 'POST', url: 'https://hub.example.com/a', body: bodyAtLimit } },
        }),
      ).success,
    ).toBe(true);

    const bodyOverLimit = { v: 'x'.repeat(8 * 1024 - 7) };
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          hooks: { preInstall: { method: 'POST', url: 'https://hub.example.com/a', body: bodyOverLimit } },
        }),
      ).success,
    ).toBe(false);

    const depth4 = { a: { b: { c: { d: 1 } } } };
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          hooks: { preInstall: { method: 'POST', url: 'https://hub.example.com/a', body: depth4 } },
        }),
      ).success,
    ).toBe(true);

    const depth5 = { a: { b: { c: { d: { e: 1 } } } } };
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          hooks: { preInstall: { method: 'POST', url: 'https://hub.example.com/a', body: depth5 } },
        }),
      ).success,
    ).toBe(false);
  });

  it('extract 与 versionPointer 拒绝根路径与非法 ~ 转义', () => {
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          hooks: {
            preInstall: {
              method: 'POST',
              url: 'https://hub.example.com/a',
              extract: { a: '/x~1y/m~0n' },
            },
          },
        }),
      ).success,
    ).toBe(true);

    for (const badPtr of ['', 'no-slash', '/bad~2', '/trailing~']) {
      expect(
        appManifestDefinitionV2Schema.safeParse(
          minimalV2({
            hooks: {
              preInstall: {
                method: 'POST',
                url: 'https://hub.example.com/a',
                extract: { a: badPtr },
              },
            },
          }),
        ).success,
      ).toBe(false);
    }
  });
});

describe('manifest-v2: 模板引擎与共享测试向量', () => {
  it('packages/contracts/test-vectors/manifest-template.json 全部 ≥20 条向量通过', () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as TemplateVector[];
    expect(vectors.length).toBeGreaterThanOrEqual(20);

    for (const vec of vectors) {
      if (vec.error) {
        let caught: unknown;
        try {
          renderTemplate(vec.template, vec.vars);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(TemplateRenderError);
        expect((caught as TemplateRenderError).code).toBe(vec.error);
      } else {
        expect(renderTemplate(vec.template, vec.vars)).toBe(vec.expect);
      }
    }
  });

  it('listTemplateVars 去重保留顺序、缺少变量报错含变量名但不含凭据值、schema 拒绝未知变量', () => {
    expect(
      listTemplateVars('https://hub.example.com/{{instance}}/{{node.id}}/{{instance}}/{{params.p}}'),
    ).toEqual(['instance', 'node.id', 'params.p']);

    let missingErr: TemplateRenderError | null = null;
    try {
      renderTemplate('Bearer {{secret.api_key}} / {{params.missing}}', {
        secret: { api_key: 'super-secret-value-never-echo' },
      });
    } catch (err) {
      missingErr = err as TemplateRenderError;
    }
    expect(missingErr).toBeInstanceOf(TemplateRenderError);
    expect(missingErr?.code).toBe('template_missing_var');
    expect(missingErr?.variable).toBe('params.missing');
    expect(missingErr?.message).toContain('params.missing');
    expect(missingErr?.message).not.toContain('super-secret-value-never-echo');

    // 支持平铺键且防范原型链属性
    expect(renderTemplate('{{params.port}}', { 'params.port': 7860 })).toBe('7860');
    expect(() => renderTemplate('{{params.toString}}', { params: {} })).toThrow(TemplateRenderError);

    // schema 层在校验阶段即拒绝未知变量
    expect(
      appManifestDefinitionV2Schema.safeParse(
        minimalV2({
          health: { type: 'http', url: 'http://127.0.0.1:8080/{{unknown_var}}' },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('manifest-v2: v1 → v2 归一化与能力推导', () => {
  it('magpie 真实清单归一化后通过 v2 schema，不修改入参，快照匹配 endpoints 与 derive', () => {
    const rawJson = JSON.parse(fs.readFileSync(MAGPIE_PATH, 'utf8')) as { manifest: unknown };
    const parsedV1 = appManifestDefinitionSchema.parse(rawJson.manifest);
    const frozenInput = deepFreeze(structuredClone(parsedV1));

    const v2 = toManifestV2(frozenInput);
    expect(appManifestDefinitionV2Schema.safeParse(v2).success).toBe(true);
    expect(v2.schema).toBe(2);
    expect(v2.endpoints).toEqual([
      {
        id: 'web',
        label: 'Web 管理页',
        protocol: 'http',
        portParam: 'web_port',
        bind: 'loopback',
        publish: 'caddy',
      },
    ]);
    const publicUrlParam = v2.params.find((p) => p.key === 'public_url');
    expect(publicUrlParam?.derive).toBe('endpoint:web.publicUrl');

    // v1 publish 非 loopback host 且无 portParam 时映射为 bind: any 与 port
    const customV1 = {
      ...parsedV1,
      publish: { label: 'UI', host: '0.0.0.0', port: 9090 },
    };
    const customV2 = toManifestV2(customV1);
    expect(customV2.endpoints).toEqual([
      {
        id: 'web',
        label: 'UI',
        protocol: 'http',
        port: 9090,
        bind: 'any',
        publish: 'caddy',
      },
    ]);

    // v2 输入原样返回深拷贝
    const copyV2 = toManifestV2(v2);
    expect(copyV2).toEqual(v2);
    expect(copyV2).not.toBe(v2);
    copyV2.writes.push('/tmp/mutated');
    expect(v2.writes).not.toContain('/tmp/mutated');
  });

  it('requiredAgentFeatures：最小清单得 [schema2]，全量清单得完整排序去重能力列表', () => {
    const min = appManifestDefinitionV2Schema.parse(minimalV2());
    expect(requiredAgentFeatures(min)).toEqual(['schema2']);

    const full = appManifestDefinitionV2Schema.parse(
      minimalV2({
        runtime: { mode: 'root', linger: false },
        params: [
          {
            key: 'preset',
            type: 'enum',
            options: [
              { value: 'lite', label: 'Lite' },
              { value: 'full', label: 'Full' },
            ],
          },
        ],
        requires: { arch: ['amd64'], os: ['debian'], diskMB: 1024 },
        hooks: {
          preInstall: { method: 'POST', url: 'https://hub.example.com/p' },
          preUpgrade: { method: 'POST', url: 'https://hub.example.com/u' },
        },
        scripts: { install: 'i', uninstall: 'u', upgrade: 'up' },
        sha256: { install: SHA_A, uninstall: SHA_B, upgrade: SHA_C },
        units: [{ name: 'khc-app', scope: 'system' }],
        health: { type: 'http', url: 'http://127.0.0.1:7860/health' },
      }),
    );
    expect(requiredAgentFeatures(full)).toEqual([
      'health.http',
      'hookEnv',
      'params.enum',
      'preflight',
      'schema2',
      'units',
      'upgrade',
    ]);

    const tcpManifest = appManifestDefinitionV2Schema.parse(
      minimalV2({ health: { type: 'tcp', port: 8080 } }),
    );
    expect(requiredAgentFeatures(tcpManifest)).toEqual(['health.tcp', 'schema2']);

    const unitManifest = appManifestDefinitionV2Schema.parse(
      minimalV2({
        units: [{ name: 'u1', scope: 'user' }],
        health: { type: 'unit' },
      }),
    );
    expect(requiredAgentFeatures(unitManifest)).toEqual(['health.unit', 'schema2', 'units']);

    expect(AGENT_MANIFEST_FEATURES).toContain('schema2');
    expect(AGENT_MANIFEST_FEATURES).toContain('hookEnv');
    expect(AGENT_MANIFEST_FEATURES).toContain('params.enum');
  });
});

describe('manifest-v2: §6 其他兼容契约新增', () => {
  it('resultCardSchema、agentSelfSchema、appSecretValueSchema、appManifestAnyDefinitionSchema 均向后兼容', () => {
    expect(resultCardSchema.parse({ title: 'T', value: 'V' })).toEqual({ title: 'T', value: 'V' });
    expect(
      resultCardSchema.parse({ title: 'URL', value: 'https://a.example.com', kind: 'url', primary: true }),
    ).toMatchObject({ kind: 'url', primary: true });

    expect(
      agentSelfSchema.parse({
        version: '0.8.0',
        serverTime: 1795400000,
        capabilities: {
          appManifest: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        },
      }).capabilities?.appManifest?.schemas,
    ).toEqual([1, 2]);

    expect(
      appSecretValueSchema.parse({ value: 'secret-token', allowHosts: ['XNG.KHC6.CN'] }),
    ).toEqual({ value: 'secret-token', allowHosts: ['xng.khc6.cn'] });
    expect(
      appSecretValueSchema.safeParse({ value: 's', allowHosts: ['https://xng.khc6.cn'] }).success,
    ).toBe(false);
    expect(appSecretKey('khcsearch', 'provision_key')).toBe('app.khcsearch.provision_key');

    const rawMagpie = JSON.parse(fs.readFileSync(MAGPIE_PATH, 'utf8')) as { manifest: unknown };
    expect(appManifestAnyDefinitionSchema.safeParse(rawMagpie.manifest).success).toBe(true);
    expect(appManifestAnyDefinitionSchema.safeParse(minimalV2()).success).toBe(true);
  });
});
