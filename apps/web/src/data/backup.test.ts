import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupErrorText,
  backupFilename,
  fetchNodeBackup,
  importNodeBackup,
  parseBackupText,
} from './backup';

const validBackup = {
  format: 'khc-backup/v1',
  version: 1,
  exportedAt: 1_700_000_000,
  node: {
    id: 'node-1',
    name: 'vm1-HK / 海外',
    endpoint: 'https://203.0.113.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    preferredRoute: 'direct',
  },
  apps: [
    { app: 'wireguard', schemaVersion: 1, config: { peers: [] } },
    { app: 'caddy-site', schemaVersion: 2, config: { sites: [] } },
  ],
};

function meta(name = 'backup.json', size = 1000) {
  return { name, size, lastModified: 123 };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('备份文件解析', () => {
  it('解析合法备份并生成预览', () => {
    const parsed = parseBackupText(JSON.stringify(validBackup), meta());
    expect(parsed.nodeName).toBe('vm1-HK / 海外');
    expect(parsed.apps).toEqual([
      { app: 'wireguard', schemaVersion: 1 },
      { app: 'caddy-site', schemaVersion: 2 },
    ]);
    expect(parsed.payload).toMatchObject({ format: 'khc-backup/v1', version: 1 });
    expect(parsed.signature).toBe('backup.json:1000:123');
  });

  it('schemaVersion 缺省按 1 处理', () => {
    const backup = {
      ...validBackup,
      apps: [{ app: 'wireguard', config: {} }],
    };
    expect(parseBackupText(JSON.stringify(backup), meta()).apps[0]?.schemaVersion).toBe(1);
  });

  it('拒绝非法 JSON / 格式 / 版本 / 应用列表', () => {
    expect(() => parseBackupText('{bad', meta())).toThrow('不是合法 JSON');
    expect(() =>
      parseBackupText(JSON.stringify({ ...validBackup, format: 'other' }), meta()),
    ).toThrow('不是 KHC 备份文件');
    expect(() =>
      parseBackupText(JSON.stringify({ ...validBackup, version: 2 }), meta()),
    ).toThrow('不支持的备份版本');
    expect(() =>
      parseBackupText(JSON.stringify({ ...validBackup, apps: 'x' }), meta()),
    ).toThrow('缺少 apps 数组');
    expect(() =>
      parseBackupText(
        JSON.stringify({ ...validBackup, apps: [{ app: 'Bad_Name', config: {} }] }),
        meta(),
      ),
    ).toThrow('应用名不合法');
    expect(() =>
      parseBackupText(
        JSON.stringify({
          ...validBackup,
          apps: [
            { app: 'wireguard', config: {} },
            { app: 'wireguard', config: {} },
          ],
        }),
        meta(),
      ),
    ).toThrow('应用重复');
  });

  it('拒绝超大文件与非 .json', () => {
    expect(() => parseBackupText('{}', meta('backup.txt'))).toThrow('.json');
    expect(() => parseBackupText('{}', meta('backup.json', 2 * 1024 * 1024 + 1))).toThrow(
      '2 MB',
    );
  });

  it('缺少节点 / 导出时间时报错', () => {
    const noNode = { ...validBackup, node: undefined };
    expect(() => parseBackupText(JSON.stringify(noNode), meta())).toThrow('节点信息');
    const noTime = { ...validBackup, exportedAt: 'yesterday' };
    expect(() => parseBackupText(JSON.stringify(noTime), meta())).toThrow('exportedAt');
  });
});

describe('导出文件名', () => {
  it('安全化节点名并追加日期', () => {
    const name = backupFilename('vm1/HK 海外', 'node-1', new Date(2026, 9, 26));
    expect(name).toBe('khc-backup-vm1-HK-2026-10-26.json');
    expect(backupFilename('', 'node/1', new Date(2026, 0, 2))).toBe(
      'khc-backup-node-1-2026-01-02.json',
    );
    expect(backupFilename('', '', new Date(2026, 0, 2))).toBe('khc-backup-node-2026-01-02.json');
  });
});

describe('备份 API', () => {
  it('导出请求并返回安全文件名', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validBackup));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchNodeBackup('node-1');
    expect(result.backup.apps).toHaveLength(2);
    expect(result.filename).toMatch(/^khc-backup-vm1-HK-\d{4}-\d{2}-\d{2}\.json$/);
    const call = fetchMock.mock.calls[0] as unknown as [string];
    expect(call[0]).toBe('/api/v1/nodes/node-1/export');
  });

  it('导入 POST 备份 payload 并返回新 rev', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        nodeId: 'node-1',
        apps: [{ app: 'wireguard', rev: 3, schemaVersion: 1 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await importNodeBackup('node-1', validBackup);
    expect(result.apps[0]).toMatchObject({ app: 'wireguard', rev: 3 });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[0]).toBe('/api/v1/nodes/node-1/import');
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ format: 'khc-backup/v1' });
  });

  it('导出响应不合法时报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ nope: true })));
    await expect(fetchNodeBackup('node-1')).rejects.toThrow('导出响应格式不合法');
  });

  it('错误文案统一', () => {
    expect(backupErrorText(new Error('boom'))).toBe('boom');
    expect(backupErrorText(null)).toBe('操作失败');
  });
});
