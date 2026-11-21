// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

/**
 * 设置页 Cloudflare DNS 分段（B 列表对象）：
 * 一条凭据一行；页头「添加凭据」打开同一抽屉；Zone 复选；Token 只写不读。
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const zones = [
  { id: 'z1', name: 'example.com' },
  { id: 'z2', name: 'second.example.com' },
];

let accounts: Array<Record<string, unknown>> = [];
let records: Array<Record<string, unknown>> = [];
let requests: { url: string; init?: RequestInit }[] = [];

function defaultRecords(): Array<Record<string, unknown>> {
  return [
    {
      id: 'r1',
      type: 'A',
      name: 'manual.example.com',
      content: '198.51.100.20',
      proxied: true,
      comment: null,
      managed: true,
    },
  ];
}

function mockApi() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/settings') return json({ settings: [] });
      if (url === '/api/v1/nodes') return json({ nodes: [] });
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/cf-dns/resolve-check' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { name: string; type?: string };
        return json({
          name: payload.name,
          type: payload.type ?? 'A',
          resolved: true,
          answers: ['198.51.100.20'],
          status: 0,
          checkedAt: 1,
        });
      }
      if (url === '/api/v1/cf-dns/records?zoneId=z1') {
        return json({ zoneId: 'z1', zoneName: 'example.com', records });
      }
      if (url === '/api/v1/cf-dns/records/z1' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const record = { id: 'r2', ...payload, comment: null, managed: false };
        records = [...records, record];
        return json({ record }, 201);
      }
      if (url === '/api/v1/cf-dns/accounts') {
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as { name: string };
          const account = {
            id: 'acc-1',
            name: payload.name,
            accountName: '示例账号',
            hasToken: true,
            enabled: true,
            zones,
            enabledZoneIds: zones.map((zone) => zone.id),
          };
          accounts = [account];
          return json({ account, zones }, 201);
        }
        return json({ accounts });
      }
      if (url.startsWith('/api/v1/cf-dns/accounts/') && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body)) as { enabledZoneIds?: string[] };
        accounts = accounts.map((account) => ({
          ...account,
          enabledZoneIds: payload.enabledZoneIds ?? account.enabledZoneIds,
        }));
        return json({ account: accounts[0] });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  accounts = [];
  records = defaultRecords();
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ['/settings?tab=cloudflare'] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '设置' });
}

describe('设置页 Cloudflare DNS 凭据', () => {
  it('空列表显示说明与空态，页头主操作是「添加凭据」', async () => {
    await renderSettings();
    expect(await screen.findByText('还没有 Cloudflare 凭据')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '添加凭据' }).length).toBeGreaterThan(0);
  });

  it('添加凭据：提交名称与 Token，成功后进入编辑态可取消勾选 Zone', async () => {
    await renderSettings();
    const buttons = screen.getAllByRole('button', { name: '添加凭据' });
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(within(dialog).getByLabelText('凭据名称（备注）'), '主账号');
    await userEvent.type(within(dialog).getByLabelText('API Token'), 'cf-api-token-0123456789abcdef');
    await userEvent.click(within(dialog).getByRole('button', { name: '验证并添加' }));

    await waitFor(() => {
      const post = requests.find(
        (item) => item.url === '/api/v1/cf-dns/accounts' && item.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
    const post = requests.find(
      (item) => item.url === '/api/v1/cf-dns/accounts' && item.init?.method === 'POST',
    );
    const payload = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(payload).toEqual({ name: '主账号', token: 'cf-api-token-0123456789abcdef' });

    // 拉取成功后切成编辑态，Zone 全部默认勾选
    await screen.findByRole('heading', { name: '编辑 Cloudflare 凭据' });
    const second = screen.getByRole('checkbox', { name: 'second.example.com' }) as HTMLInputElement;
    expect(second.checked).toBe(true);
    await userEvent.click(second);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        requests.some(
          (item) => item.url === '/api/v1/cf-dns/accounts/acc-1' && item.init?.method === 'PUT',
        ),
      ).toBe(true);
    });
    const put = requests.find(
      (item) => item.url === '/api/v1/cf-dns/accounts/acc-1' && item.init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.init?.body))).toMatchObject({
      name: '主账号',
      enabledZoneIds: ['z1'],
    });
  });

  it('域名卡片「管理记录」才请求解析记录，显示只读记录与绑定信息', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1'],
      },
    ];
    await renderSettings();
    // 首屏不请求解析记录：域名的记录数在卡片里按需加载，不进抽屉不点就不请求
    await screen.findByText('example.com');
    await userEvent.click(screen.getByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('manual.example.com')).toBeTruthy();
    expect(within(dialog).getByText('198.51.100.20')).toBeTruthy();
    expect(within(dialog).getByText('Cloudflare 代理')).toBeTruthy();
    expect(within(dialog).getByText('面板代建')).toBeTruthy();
    expect(requests.some((item) => item.url === '/api/v1/cf-dns/records?zoneId=z1')).toBe(true);
  });

  it('域名抽屉里可直接新增解析记录（子域自动补 Zone）', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1'],
      },
    ];
    await renderSettings();
    await userEvent.click(await screen.findByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('manual.example.com');

    await userEvent.click(within(dialog).getByRole('button', { name: '添加记录' }));
    await userEvent.type(within(dialog).getByLabelText('记录名'), 'api');
    await userEvent.type(within(dialog).getByLabelText('内容'), '198.51.100.30');
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    await waitFor(() => {
      const post = requests.find(
        (item) => item.url === '/api/v1/cf-dns/records/z1' && item.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.init?.body))).toMatchObject({
        type: 'A',
        name: 'api.example.com',
        content: '198.51.100.30',
        proxied: false,
      });
    });
    expect(await within(dialog).findByText('api.example.com')).toBeTruthy();
  });

  it('已有凭据按卡片展示：账户 / 域名 / Token 状态，不泄漏 Token 值', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1'],
      },
    ];
    await renderSettings();
    expect((await screen.findAllByText('主账号')).length).toBeGreaterThan(0);
    // 只启用 z1：卡内只列出 example.com，second.example.com 不在启用范围
    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.queryByText('second.example.com')).toBeNull();
    expect(screen.getAllByText('已配置').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('cf-api-token');
  });

  it('解析检测：单条记录一键查出公网解析结果', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1'],
      },
    ];
    await renderSettings();
    await userEvent.click(await screen.findByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('manual.example.com');

    await userEvent.click(within(dialog).getByRole('button', { name: '检测解析' }));
    expect(await within(dialog).findByText('解析已生效')).toBeTruthy();
    const post = requests.find((item) => item.url === '/api/v1/cf-dns/resolve-check');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: 'manual.example.com',
      type: 'A',
    });
  });

  it('移除域名：只取消启用，不动 Cloudflare 上的记录', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1', 'z2'],
      },
    ];
    await renderSettings();
    const removeButtons = await screen.findAllByRole('button', { name: '移除域名' });
    await userEvent.click(removeButtons[0]!);

    await waitFor(() => {
      const put = requests.find(
        (item) => item.url === '/api/v1/cf-dns/accounts/acc-1' && item.init?.method === 'PUT',
      );
      expect(JSON.parse(String(put?.init?.body))).toEqual({ enabledZoneIds: ['z2'] });
    });
    // 移除域名绝不触发 CF 记录删除
    expect(requests.some((item) => item.init?.method === 'DELETE')).toBe(false);
  });

  it('「添加域名」弹窗：只列未启用域名，写入 enabledZoneIds（与添加节点共用同一实现）', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: '示例账号',
        hasToken: true,
        enabled: true,
        zones,
        enabledZoneIds: ['z1'],
      },
    ];
    await renderSettings();
    // 等账户加载完，「添加域名」才从禁用变为可点
    await screen.findAllByText('主账号');
    await userEvent.click(await screen.findByRole('button', { name: '添加域名' }));

    const dialog = await screen.findByRole('dialog', { name: '添加域名' });
    // 单账户自动选中；已添加的 z1 标记为「已添加」且不可选
    const added = within(dialog).getByRole('option', { name: 'example.com' }) as HTMLOptionElement;
    expect(added.disabled).toBe(true);
    await userEvent.selectOptions(
      within(dialog).getByLabelText('域名（主账号）'),
      'z2',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    await waitFor(() => {
      const put = requests.find(
        (item) => item.url === '/api/v1/cf-dns/accounts/acc-1' && item.init?.method === 'PUT',
      );
      expect(JSON.parse(String(put?.init?.body))).toEqual({ enabledZoneIds: ['z1', 'z2'] });
    });
    expect(await screen.findByText('已添加域名：second.example.com')).toBeTruthy();
  });
});
