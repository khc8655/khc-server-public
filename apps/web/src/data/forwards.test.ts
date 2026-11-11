import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  findForwardStatus,
  forwardApiError,
  forwardEnvelopeError,
  normalizeForwardConfig,
  normalizeForwardStatus,
  removeForward,
  runForwardAction,
  setForwardEnabled,
  upsertForward,
  type ForwardConfig,
} from './forwards';

function config(): ForwardConfig {
  return {
    forwards: [
      {
        name: 'ssh',
        protocol: 'tcp',
        listenHost: '0.0.0.0',
        listenPort: 7001,
        targetHost: '10.99.0.2',
        targetPort: 22,
        enabled: true,
        note: '手机 SSH',
      },
      {
        name: 'dns',
        protocol: 'udp',
        listenHost: '0.0.0.0',
        listenPort: 5300,
        targetHost: '10.99.0.2',
        targetPort: 53,
        enabled: false,
        note: '',
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('端口转发配置规范化', () => {
  it('兼容 forwards 数组与空配置', () => {
    const parsed = normalizeForwardConfig({
      forwards: [
        {
          name: 'ssh',
          protocol: 'tcp',
          listenHost: '0.0.0.0',
          listenPort: 7001,
          targetHost: '10.99.0.2',
          targetPort: 22,
          enabled: true,
          note: 'x',
        },
      ],
    });
    expect(parsed.forwards).toHaveLength(1);
    expect(parsed.forwards[0]).toMatchObject({
      name: 'ssh',
      protocol: 'tcp',
      listenHost: '0.0.0.0',
      listenPort: 7001,
      targetHost: '10.99.0.2',
      targetPort: 22,
    });
    expect(normalizeForwardConfig(null)).toEqual({ forwards: [] });
    expect(normalizeForwardConfig([{ name: 'a', protocol: 'udp' }]).forwards[0]).toMatchObject({
      name: 'a',
      protocol: 'udp',
      enabled: true,
    });
  });

  it('upsert / remove / setEnabled 不修改原对象', () => {
    const base = config();
    const added = upsertForward(base, {
      name: 'web',
      protocol: 'tcp',
      listenHost: '0.0.0.0',
      listenPort: 8080,
      targetHost: '10.99.0.3',
      targetPort: 80,
      enabled: true,
      note: '',
    });
    expect(base.forwards).toHaveLength(2);
    expect(added.forwards).toHaveLength(3);

    const renamed = upsertForward(
      base,
      { ...base.forwards[0]!, name: 'ssh2' },
      'ssh',
    );
    expect(renamed.forwards[0]?.name).toBe('ssh2');
    expect(removeForward(base, 'ssh').forwards.map((item) => item.name)).toEqual(['dns']);
    expect(setForwardEnabled(base, 'dns', true).forwards[1]?.enabled).toBe(true);
  });
});

describe('端口转发状态解析', () => {
  it('解析 forwards/units 并剥离 unit 名称', () => {
    const status = normalizeForwardStatus([
      {
        name: 'port-forward',
        status: {
          installed: true,
          running: true,
          socatVersion: '1.8.0.0',
          forwards: [
            {
              unit: 'khc-forward-ssh.service',
              protocol: 'tcp',
              listenPort: 7001,
              active: true,
              enabled: true,
            },
            {
              name: 'dns',
              protocol: 'udp',
              active: false,
              error: 'unit failed',
            },
          ],
        },
      },
    ]);
    expect(status?.installed).toBe(true);
    expect(status?.socatVersion).toBe('1.8.0.0');
    expect(status?.rules[0]).toMatchObject({ name: 'ssh', active: true, protocol: 'tcp' });
    expect(status?.rules[1]).toMatchObject({ name: 'dns', active: false, error: 'unit failed' });
    expect(status?.total).toBe(2);
  });

  it('按 name 或 listenPort+protocol 匹配', () => {
    const status = normalizeForwardStatus([
      {
        name: 'port-forward',
        status: {
          units: [{ unit: 'khc-forward-ssh.service', protocol: 'tcp', listenPort: 7001, active: true }],
        },
      },
    ]);
    expect(findForwardStatus(status, { name: 'ssh', protocol: 'tcp', listenPort: 1 })?.name).toBe(
      'ssh',
    );
    expect(
      findForwardStatus(status, { name: 'other', protocol: 'tcp', listenPort: 7001 })?.active,
    ).toBe(true);
    expect(findForwardStatus(null, { name: 'ssh', protocol: 'tcp', listenPort: 1 })).toBeNull();
  });

  it('缺少适配器返回 null，状态错误保留', () => {
    expect(normalizeForwardStatus([])).toBeNull();
    const status = normalizeForwardStatus([
      { name: 'port-forward', status: { installed: false, error: 'socat 未安装' } },
    ]);
    expect(status?.installed).toBe(false);
    expect(status?.error).toBe('socat 未安装');
  });
});

describe('错误与动作', () => {
  it('envelope 错误提取 details', () => {
    const error = forwardEnvelopeError(
      {
        ok: false,
        error: { code: 'validation_failed', message: '端口冲突', details: { port: 7001 } },
      } as never,
      '应用失败',
    );
    expect(error?.message).toBe('端口冲突');
    expect(error?.details).toContain('"port": 7001');
    expect(
      forwardEnvelopeError({ ok: true } as never, '应用失败'),
    ).toBeNull();
  });

  it('ApiError 转结构化错误', () => {
    const error = forwardApiError(
      new ApiError(400, 'validation_failed', 'bad', { port: '冲突' }),
      '应用失败',
    );
    expect(error.message).toBe('bad');
    expect(error.details).toContain('冲突');
  });

  it('runForwardAction 调用 plan/apply 端点', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, rev: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await runForwardAction('hub-1', 'apply');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[0]).toBe('/api/v1/nodes/hub-1/apps/port-forward/apply');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ params: {} });
  });
});
