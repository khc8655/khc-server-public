// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

const pickMock = vi.hoisted(() => vi.fn());

vi.mock('../../data/backup', async () => {
  const actual = await vi.importActual<typeof import('../../data/backup')>('../../data/backup');
  return { ...actual, pickBackupFile: pickMock };
});

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const node = {
  id: 'tyo-1',
  name: 'tyo-1',
  endpoint: 'https://203.0.113.10:8880',
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

const backup = {
  format: 'khc-backup/v1',
  version: 1,
  exportedAt: NOW - 100,
  node: {
    id: 'tyo-1',
    name: 'tyo-1',
    endpoint: 'https://203.0.113.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    preferredRoute: 'direct',
  },
  apps: [
    { app: 'wireguard', schemaVersion: 1, config: { peers: [] } },
    { app: 'caddy-site', schemaVersion: 1, config: { sites: [] } },
  ],
};

function backupFile() {
  const text = JSON.stringify(backup);
  return {
    name: 'backup.json',
    size: text.length,
    lastModified: 123,
    text: async () => text,
  } as File;
}

let requests: { url: string; init?: RequestInit }[] = [];
let cleanupRemaining: { item: string; reason: string }[] = [];
let cfDnsDeleteResult: unknown = null;
/** 批次 Q：host-ops 适配器是否安装在节点上（决定删除节点清理项的默认值/可用性）。 */
let hostOpsAdapterInstalled = true;

function mockApi() {
  requests = [];
  cleanupRemaining = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1' && init?.method === 'PATCH') {
        return json({ node: { ...node, ...JSON.parse(String(init.body ?? '{}')) } });
      }
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/tunnels') return json({ tunnels: [] });
      if (url === '/api/v1/cf-dns/zones') {
        return json({
          zones: [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }],
        });
      }
      if (url.startsWith('/api/v1/cf-dns/records')) {
        return json({
          zoneId: 'z1',
          zoneName: 'example.com',
          records: [
            {
              id: 'rec-1',
              type: 'A',
              name: 'agent.example.com',
              content: '203.0.113.10',
              proxied: false,
              comment: null,
              managed: false,
            },
          ],
        });
      }
      if (url === '/api/v1/cf-dns/records/tyo-1') {
        if (cfDnsDeleteResult instanceof Response) return cfDnsDeleteResult;
        return json(cfDnsDeleteResult ?? { deleted: true, errors: [] });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/host-ops/call') {
        return json({
          ok: true,
          data: { cleaned: ['wg-conf', 'caddy-khcd'], remaining: cleanupRemaining },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [
            { app: 'wireguard', schemaVersion: 1, config: {}, rev: 1, appliedRev: 1, updatedAt: NOW },
            { app: 'caddy-site', schemaVersion: 1, config: {}, rev: 1, appliedRev: 1, updatedAt: NOW },
          ],
          adapters: hostOpsAdapterInstalled
            ? [{ name: 'host-ops', version: '1.0.0', api: 1 }]
            : [],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/export') return json(backup);
      if (url === '/api/v1/nodes/tyo-1/import') {
        return json({
          ok: true,
          nodeId: 'tyo-1',
          apps: [
            { app: 'wireguard', rev: 3, schemaVersion: 1 },
            { app: 'caddy-site', rev: 4, schemaVersion: 1 },
          ],
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  pickMock.mockReset();
  pickMock.mockResolvedValue(null);
  cfDnsDeleteResult = null;
  hostOpsAdapterInstalled = true;
  URL.createObjectURL = vi.fn(() => 'blob:backup');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openBackupSegment() {
  await userEvent.click(await screen.findByRole('button', { name: '备份与恢复' }));
}

async function openImportDrawer() {
  await userEvent.click(await screen.findByRole('button', { name: '导入备份…' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
}

describe('节点设置四分区（ui-redesign T4）', () => {
  it('默认 Agent 与接入分区；证书摘要卡已移除', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    expect(await screen.findByRole('heading', { name: '节点设置' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '安装 Agent' })).toBeTruthy();
    // 观测入口由节点域名自动推导，设置页不再要求手填 liveEndpoint。
    expect(screen.queryByText('实时观测')).toBeNull();
    expect(screen.queryByText('SSL 证书与 HTTPS 配置')).toBeNull();
  });

  it('接入方式抽屉：存量 IP 节点默认 IP 直连，域名模式选记录后同步 domain', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    await userEvent.click(await screen.findByRole('button', { name: '修改接入方式' }));
    const dialog = await screen.findByRole('dialog');
    // 存量 endpoint 是裸 IP → 表单归到「IP 直连」，展示自动生成地址。
    expect((within(dialog).getByLabelText('主机 / IP') as HTMLInputElement).value).toBe(
      '203.0.113.10',
    );
    expect(
      (within(dialog).getByLabelText('接入地址（自动生成）') as HTMLInputElement).value,
    ).toBe('http://203.0.113.10:8880');

    await userEvent.click(within(dialog).getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await within(dialog).findByLabelText('Zone'), 'z1');
    await userEvent.selectOptions(await within(dialog).findByLabelText('已有解析记录'), 'rec-1');
    expect((within(dialog).getByLabelText('当前域名') as HTMLInputElement).value).toBe(
      'agent.example.com',
    );
    expect((within(dialog).getByLabelText('HTTPS 端口') as HTMLSelectElement).value).toBe('443');
    expect(
      (within(dialog).getByLabelText('接入地址（自动生成）') as HTMLInputElement).value,
    ).toBe('https://agent.example.com');

    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const patch = requests.find(
        (item) => item.url === '/api/v1/nodes/tyo-1' && item.init?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.init?.body))).toMatchObject({
        accessMode: 'domain',
        endpoint: 'https://agent.example.com',
        domain: 'agent.example.com',
      });
    });
    expect(await screen.findByText('接入方式已保存')).toBeTruthy();
  });

  it('备份分区展示导出说明与入口；导出触发 GET 并显示下载文件名', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    await openBackupSegment();
    expect(await screen.findByText('备份范围')).toBeTruthy();
    expect(screen.getByText(/不含节点 token、证书私钥或 DNS 凭据/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出备份' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导入备份…' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '导出备份' }));
    await waitFor(() => {
      expect(document.body.textContent).toContain('khc-backup-tyo-1-');
    });
    expect(requests.some((item) => item.url === '/api/v1/nodes/tyo-1/export')).toBe(true);
  });

  it('导入抽屉三步：选择文件 → 预览 → 确认，结果在抽屉内展示', async () => {
    pickMock.mockResolvedValue(backupFile());
    await renderRoute('/hubs/tyo-1/settings');
    await openBackupSegment();
    await openImportDrawer();

    expect(await screen.findByText('尚未选择备份文件')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择备份文件' }));

    expect(await screen.findByText('来源节点')).toBeTruthy();
    expect((await screen.findAllByText('wireguard')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('覆盖').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '导入备份' }));
    expect(await screen.findByText('确认导入备份？')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect((await screen.findAllByText('配置已导入，需逐项应用')).length).toBeGreaterThan(0);
    expect(await screen.findByText('新 rev')).toBeTruthy();
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes/tyo-1/import' && item.init?.method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ format: 'khc-backup/v1' });

    await userEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(await waitFor(() => screen.queryByRole('dialog'))).toBeNull();
  });

  it('重复导入同一文件时在确认步骤提示', async () => {
    pickMock.mockResolvedValue(backupFile());
    await renderRoute('/hubs/tyo-1/settings');
    await openBackupSegment();
    await openImportDrawer();

    await userEvent.click(await screen.findByRole('button', { name: '选择备份文件' }));
    await userEvent.click(screen.getByRole('button', { name: '导入备份' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect((await screen.findAllByText('配置已导入，需逐项应用')).length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole('button', { name: '完成' }));

    await openImportDrawer();
    await userEvent.click(await screen.findByRole('button', { name: '选择备份文件' }));
    expect(await screen.findByText('该备份刚刚已导入')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '导入备份' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('重复导入');
  });

  it('非法 JSON 显示文件错误', async () => {
    pickMock.mockResolvedValue({
      name: 'bad.json',
      size: 5,
      lastModified: 1,
      text: async () => '{bad',
    } as File);
    await renderRoute('/hubs/tyo-1/settings');
    await openBackupSegment();
    await openImportDrawer();
    await userEvent.click(await screen.findByRole('button', { name: '选择备份文件' }));
    expect(await screen.findByText('文件不是合法 JSON')).toBeTruthy();
  });
});
