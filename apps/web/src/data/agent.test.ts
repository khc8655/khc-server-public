import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentCommandError,
  fetchAgentReleases,
  generateAgentCommand,
  rollbackTarget,
  validatePackageUrl,
  validateRunMode,
  validateSha256,
} from './agent';

const SHA = 'a'.repeat(64);
const URL = 'https://example.com/khc-agent-0.2.0.tar.gz';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agent 命令校验', () => {
  it('packageUrl 只接受 https 且无空白控制字符', () => {
    expect(validatePackageUrl(URL)).toBeNull();
    expect(validatePackageUrl('http://example.com/a.tgz')).toContain('https');
    expect(validatePackageUrl('https://example.com/a b.tgz')).toContain('空白');
    expect(validatePackageUrl('not-a-url')).toContain('合法');
    expect(validatePackageUrl('')).toContain('请填写');
    expect(validatePackageUrl(`https://example.com/${'a'.repeat(2048)}`)).toContain('2048');
  });

  it('sha256 必须 64 位十六进制', () => {
    expect(validateSha256(SHA)).toBeNull();
    expect(validateSha256('A'.repeat(64))).toBeNull();
    expect(validateSha256('abc')).toContain('64');
    expect(validateSha256('g'.repeat(64))).toContain('64');
    expect(validateSha256('')).toContain('请填写');
  });

  it('运行模式仅 system/user', () => {
    expect(validateRunMode('system')).toBe(true);
    expect(validateRunMode('user')).toBe(true);
    expect(validateRunMode('root')).toBe(false);
  });
});

describe('Agent 命令生成', () => {
  it('install 请求包含 mode/packageUrl/sha256', async () => {
    const fetchMock = vi.fn(async () =>
      json({ command: 'curl ...', mode: 'system', packageUrl: URL, sha256: SHA }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateAgentCommand('hub-1', 'install', {
      mode: 'system',
      packageUrl: URL,
      sha256: SHA,
    });
    expect(result.command).toBe('curl ...');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/v1/nodes/hub-1/agent/install-command');
    expect(JSON.parse(String(call[1].body))).toEqual({
      packageUrl: URL,
      sha256: SHA,
      mode: 'system',
    });
  });

  it('upgrade / uninstall 使用对应端点与参数', async () => {
    const fetchMock = vi.fn(async () => json({ command: 'ok', mode: 'user', packageUrl: URL, sha256: SHA }));
    vi.stubGlobal('fetch', fetchMock);
    await generateAgentCommand('hub-1', 'upgrade', {
      mode: 'user',
      packageUrl: URL,
      sha256: SHA,
    });
    await generateAgentCommand('hub-1', 'uninstall', {
      mode: 'system',
      packageUrl: URL,
      sha256: SHA,
      purge: true,
    });
    const paths = (fetchMock.mock.calls as unknown as [string][]).map((call) => call[0]);
    expect(paths).toEqual([
      '/api/v1/nodes/hub-1/agent/upgrade-command',
      '/api/v1/nodes/hub-1/agent/uninstall-command',
    ]);
    const uninstall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(uninstall[1].body))).toEqual({
      mode: 'system',
      packageUrl: URL,
      sha256: SHA,
      purge: true,
    });
  });

  it('本地校验失败不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateAgentCommand('hub-1', 'install', {
        mode: 'system',
        packageUrl: 'http://example.com/a.tgz',
        sha256: SHA,
      }),
    ).rejects.toBeInstanceOf(AgentCommandError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('服务端未返回 command 时报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ mode: 'system' })));
    await expect(
      generateAgentCommand('hub-1', 'install', {
        mode: 'system',
        packageUrl: URL,
        sha256: SHA,
      }),
    ).rejects.toMatchObject({ field: 'response' });
  });
});

describe('已签名发布清单', () => {
  it('解析合法 releases，过滤非法项', async () => {
    const fetchMock = vi.fn(async () => json({
      releases: [
        { version: '0.1.0', url: URL, sha256: SHA },
        { version: '', url: URL, sha256: SHA },
        { version: '0.1.1', url: URL, sha256: 'bad' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const releases = await fetchAgentReleases();
    expect(releases).toEqual([{ version: '0.1.0', url: URL, sha256: SHA }]);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/agent/releases');
  });
});

describe('回滚目标（ADR-0019）', () => {
  const latest = { version: '0.1.41', url: 'https://x/khc-agent-0.1.41.tar.gz', sha256: SHA };
  const previous = { version: '0.1.40', url: 'https://x/khc-agent-0.1.40.tar.gz', sha256: 'b'.repeat(64) };

  it('节点正跑最新版时才给出上一版', () => {
    expect(rollbackTarget([latest, previous], '0.1.41')).toEqual(previous);
  });

  it('清单只有一条（本次发版不含 N-1）→ 不可回滚', () => {
    expect(rollbackTarget([latest], '0.1.41')).toBeNull();
  });

  it('节点不是最新版 → 不可回滚（那是升级不是回滚）', () => {
    expect(rollbackTarget([latest, previous], '0.1.40')).toBeNull();
  });

  it('版本号未知 → 不可回滚', () => {
    expect(rollbackTarget([latest, previous], null)).toBeNull();
  });
});
