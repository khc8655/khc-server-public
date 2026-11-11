import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@khc/contracts';
import {
  cachedHostOpsStatus,
  callHostOps,
  callHostOpsTask,
  compareVersions,
  displayProcessName,
  normalizeFirewallShow,
  normalizeHostOpsConfig,
  normalizeKeys,
  normalizeOnboard,
  normalizeProbe,
  normalizeProcesses,
  normalizeStatus,
  normalizeVersion,
  onboardHostOps,
  peerHostAddress,
} from './hostOps';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host-ops 配置与结果规范化', () => {
  it('规范化 peers 配置，缺省字段给默认值', () => {
    const config = normalizeHostOpsConfig({
      peers: {
        'peer-1': { enabled: true, host: '10.8.0.12', port: 2222, user: 'ops', hostKey: 'k' },
        broken: { user: 'x' },
      },
    });
    expect(config.peers['peer-1']).toEqual({
      enabled: true,
      host: '10.8.0.12',
      port: 2222,
      user: 'ops',
      hostKey: 'k',
    });
    expect(config.peers.broken).toBeUndefined();
  });

  it('version / status 结果兼容顶层与嵌套 ops', () => {
    expect(
      normalizeVersion({ version: '1.2.0', python: '3.11', root: true, nft: false }),
    ).toEqual({ version: '1.2.0', python: '3.11', root: true, nft: false });

    const status = normalizeStatus({
      hostname: 'peer-1',
      ops: { cpu: { usagePercent: 12 }, mem: { percent: 30 } },
      collectedAt: 1_700_000_000,
    });
    expect(status.hostname).toBe('peer-1');
    expect(status.ops?.cpu?.usagePercent).toBe(12);
    expect(status.collectedAt).toBe(1_700_000_000);
  });

  it('进程字段容错并过滤非法 pid', () => {
    const processes = normalizeProcesses({
      processes: [
        { pid: 42, user: 'root', cpu: 1.5, mem: 2, startTime: 99, cmdline: 'nginx' },
        { pid: 0, cmdline: 'bad' },
        { pid: 43, cmd: 'sshd', command: 'ignored' },
      ],
    });
    expect(processes).toHaveLength(2);
    expect(processes[0]).toMatchObject({ pid: 42, cmdline: 'nginx', startTime: 99 });
    expect(processes[1]?.cmdline).toBe('sshd');
  });

  it('进程名：解释器显示脚本名，comm 被截断时用命令行补全', () => {
    expect(
      displayProcessName('python3', '/usr/bin/python3 /opt/khc-agent/khc_agent.py run --port 443'),
    ).toBe('khc_agent.py');
    expect(
      displayProcessName(
        'networkd-dispat',
        '/usr/bin/python3 /usr/bin/networkd-dispatcher --run-startup-triggers',
      ),
    ).toBe('networkd-dispatcher');
    expect(
      displayProcessName('amazon-ssm-agen', '/snap/amazon-ssm-agent/13349/amazon-ssm-agent'),
    ).toBe('amazon-ssm-agent');
    expect(displayProcessName('chronyd', '/usr/sbin/chronyd -F 1')).toBe('chronyd');
  });

  it('防火墙规则保留 locked/other，规范化 allow', () => {
    const firewall = normalizeFirewallShow({
      baseRev: 'rev-1',
      pending: { token: 'tok', secondsLeft: 42 },
      rules: [
        { id: 'r1', action: 'accept', proto: 'tcp', port: '22', source: '0.0.0.0/0', locked: true },
        { action: 'drop', proto: 'udp', port: '53', source: '10.8.0.0/24', note: 'dns' },
      ],
      other: ['table ip filter { }'],
    });
    expect(firewall.baseRev).toBe('rev-1');
    expect(firewall.rules[0]).toMatchObject({ action: 'allow', locked: true });
    expect(firewall.rules[1]).toMatchObject({ action: 'deny', port: '53', note: 'dns' });
    expect(firewall.other).toEqual(['table ip filter { }']);
    expect(firewall.pending).toEqual({ token: 'tok', secondsLeft: 42 });
  });

  it('SSH 公钥识别 Hub 运维公钥与不可移除', () => {
    const keys = normalizeKeys({
      keys: [
        {
          fingerprint: 'SHA256:abc',
          type: 'ssh-ed25519',
          comment: 'khc-hub-hub1',
          managed: true,
          hubKey: true,
        },
        { fingerprint: 'SHA256:def', type: 'ssh-ed25519', comment: 'manual', managed: false },
      ],
    });
    expect(keys[0]).toMatchObject({ hubKey: true, removable: false });
    expect(keys[1]).toMatchObject({ managed: false, removable: false });
  });

  it('probe keys[] 选择 ed25519 并返回主机密钥', () => {
    const probe = normalizeProbe({
      host: '10.8.0.12',
      port: 22,
      keys: [
        { type: 'ecdsa-sha2-nistp256', key: 'ecdsa-sha2-nistp256 AAA', fingerprint: 'SHA256:ec' },
        { type: 'ssh-ed25519', key: 'ssh-ed25519 BBB', fingerprint: 'SHA256:ed' },
      ],
    });
    expect(probe).toEqual({
      hostKey: 'ssh-ed25519 BBB',
      fingerprint: 'SHA256:ed',
      algorithm: 'ssh-ed25519',
    });
  });

  it('onboard 等顶层字段可解析', () => {
    const onboard = normalizeOnboard({
      installCommand: 'curl ... | sh',
      uninstallCommand: 'khc-host uninstall',
      publicKey: 'ssh-ed25519 AAAA hub',
      hubWgIp: '10.8.0.1',
      scriptVersion: '1.4.0',
    });
    expect(onboard?.installCommand).toContain('curl');
    expect(onboard?.scriptVersion).toBe('1.4.0');
    expect(normalizeOnboard({ nothing: true })).toBeNull();
  });

  it('地址提取与版本比较', () => {
    expect(peerHostAddress(['10.8.0.12/32', 'fd00::2/128'])).toBe('10.8.0.12');
    expect(compareVersions('1.2.0', '1.3.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
  });

  it('从 /state adapter status 读取缓存状态，无数据返回 null', () => {
    const state = {
      host: { hostname: 'hub' },
      adapters: [
        {
          name: 'host-ops',
          status: {
            peers: {
              'peer-1': {
                ops: { cpu: { usagePercent: 5 } },
                version: '1.4.0',
                collectedAt: 1_700_000_000,
              },
            },
          },
        },
      ],
      ports: [],
    } as unknown as AgentState;
    const cached = cachedHostOpsStatus(state, 'peer-1');
    expect(cached?.status?.ops?.cpu?.usagePercent).toBe(5);
    expect(cached?.version).toBe('1.4.0');
    expect(cached?.fetchedAt).toBe(1_700_000_000_000);
    expect(cachedHostOpsStatus(state, 'missing')).toBeNull();
    expect(cachedHostOpsStatus({ host: { hostname: 'h' }, adapters: [], ports: [] }, 'peer-1')).toBeNull();
  });
});

describe('host-ops 动作请求', () => {
  it('call 请求体包含 target/verb/params 与 idempotencyKey', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        ok: true,
        v: '1.4.0',
        data: { cpu: { usagePercent: 7 } },
        expectedVersion: '1.5.0',
        updateRequired: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callHostOps('hub-1', 'peer-1', 'status');
    expect(result.ok).toBe(true);
    expect(result.v).toBe('1.4.0');
    expect(result.data).toMatchObject({ cpu: { usagePercent: 7 } });
    expect(result.expectedVersion).toBe('1.5.0');
    expect(result.updateRequired).toBe(false);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[0]).toBe('/api/v1/nodes/hub-1/apps/host-ops/call');
    const body = JSON.parse(String(call[1]?.body)) as {
      params: { target: string; verb: string; params: unknown };
      idempotencyKey?: string;
    };
    expect(body.params).toEqual({ target: 'peer-1', verb: 'status', params: {} });
    expect(body.idempotencyKey).toBeTruthy();
  });

  it('onboard 顶层字段与错误码解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ok: true,
          installCommand: 'install.sh',
          uninstallCommand: 'uninstall.sh',
          publicKey: 'ssh-ed25519 AAAA',
          hubWgIp: '10.8.0.1',
          scriptVersion: '1.4.0',
        }),
      ),
    );
    const onboard = await onboardHostOps('hub-1', { peerId: 'peer-1', host: '10.8.0.12' });
    expect(onboard.ok).toBe(true);
    expect(normalizeOnboard(onboard.data)?.installCommand).toBe('install.sh');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ ok: false, error: { code: 'E_SSH_DENIED', message: 'permission denied' } }),
      ),
    );
    const denied = await callHostOps('hub-1', 'peer-1', 'status');
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('E_SSH_DENIED');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ok: false,
          error: { code: 'E_SCRIPT_OLD', message: 'script too old' },
          v: '1.2.0',
          expectedVersion: '1.4.0',
          updateRequired: true,
        }),
      ),
    );
    const old = await callHostOps('hub-1', 'peer-1', 'status');
    expect(old.error?.code).toBe('E_SCRIPT_OLD');
    expect(old.scriptVersion).toBe('1.2.0');
    expect(old.expectedVersion).toBe('1.4.0');
    expect(old.updateRequired).toBe(true);
  });
});


describe('host-ops 异步任务 call_task', () => {
  function taskFetch(taskBody: unknown, submit: unknown = { ok: true, taskId: 'task-1' }) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/apps/host-ops/call_task')) return json(submit);
      if (url.includes('/tasks/task-1')) return json(taskBody);
      return json({});
    });
  }

  it('提交 call_task 并轮询 done，解析 task.result', async () => {
    const fetchMock = taskFetch({
      ok: true,
      task: {
        id: 'task-1',
        state: 'done',
        result: {
          ok: true,
          v: '1.4.0',
          data: { token: 'fw-token-task' },
          target: 'self',
          verb: 'fw.apply',
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callHostOpsTask(
      'hub-1',
      'self',
      'fw.apply',
      { rules: [], baseRev: 'rev-1' },
      { pollIntervalMs: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.v).toBe('1.4.0');
    expect(result.data).toEqual({ token: 'fw-token-task' });

    const submit = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(submit[0]).toBe('/api/v1/nodes/hub-1/apps/host-ops/call_task');
    const body = JSON.parse(String(submit[1]?.body)) as {
      params: { target: string; verb: string; params: unknown };
      idempotencyKey?: string;
    };
    expect(body.params).toEqual({
      target: 'self',
      verb: 'fw.apply',
      params: { rules: [], baseRev: 'rev-1' },
    });
    expect(body.idempotencyKey).toBeTruthy();
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(
      '/api/v1/nodes/hub-1/tasks/task-1',
    );
  });

  it('task=error 返回 task.error', async () => {
    vi.stubGlobal(
      'fetch',
      taskFetch({
        ok: true,
        task: {
          id: 'task-1',
          state: 'error',
          error: { code: 'E_PROTECTED', message: '规则被保护', details: { id: 'ssh' } },
        },
      }),
    );
    const result = await callHostOpsTask('hub-1', 'self', 'fw.apply', {}, { pollIntervalMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_PROTECTED');
    expect(result.error?.message).toBe('规则被保护');
    expect(result.error?.details).toContain('ssh');
  });

  it('轮询超时返回 E_TASK_TIMEOUT', async () => {
    vi.stubGlobal(
      'fetch',
      taskFetch({ ok: true, task: { id: 'task-1', state: 'running' } }),
    );
    const result = await callHostOpsTask('hub-1', 'self', 'fw.apply', {}, {
      pollIntervalMs: 1,
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_TASK_TIMEOUT');
  });

  it('task=canceled 返回 E_TASK_CANCELED', async () => {
    vi.stubGlobal(
      'fetch',
      taskFetch({ ok: true, task: { id: 'task-1', state: 'canceled' } }),
    );
    const result = await callHostOpsTask('hub-1', 'self', 'fw.apply', {}, { pollIntervalMs: 1 });
    expect(result.error?.code).toBe('E_TASK_CANCELED');
  });

  it('提交失败返回结构化错误；AbortSignal 终止轮询', async () => {
    vi.stubGlobal(
      'fetch',
      taskFetch({ ok: true, task: { id: 'task-1', state: 'running' } }, {
        ok: false,
        error: { code: 'idempotency_key_required', message: '缺少幂等键' },
      }),
    );
    const denied = await callHostOpsTask('hub-1', 'self', 'fw.apply', {});
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('idempotency_key_required');

    vi.stubGlobal(
      'fetch',
      taskFetch({ ok: true, task: { id: 'task-1', state: 'running' } }),
    );
    const controller = new AbortController();
    const pending = callHostOpsTask('hub-1', 'self', 'fw.apply', {}, {
      pollIntervalMs: 50,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
