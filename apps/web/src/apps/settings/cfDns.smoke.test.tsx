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

  it('编辑抽屉：展开已勾选 Zone 才请求并显示只读解析记录', async () => {
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
    await userEvent.click((await screen.findAllByText('主账号'))[0]!);
    const dialog = await screen.findByRole('dialog');

    // 打开抽屉不请求记录，只有点「查看解析记录」才请求
    expect(requests.some((item) => item.url.includes('/cf-dns/records'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: '查看解析记录' }));

    expect(await within(dialog).findByText('manual.example.com')).toBeTruthy();
    expect(within(dialog).getByText('198.51.100.20')).toBeTruthy();
    expect(within(dialog).getByText('Cloudflare 代理')).toBeTruthy();
    expect(within(dialog).getByText('面板代建')).toBeTruthy();
    expect(requests.some((item) => item.url === '/api/v1/cf-dns/records?zoneId=z1')).toBe(true);
  });

  it('展开 Zone 后可直接新增解析记录（子域自动补 Zone）', async () => {
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
    await userEvent.click((await screen.findAllByText('主账号'))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '查看解析记录' }));
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

  it('已有凭据按行展示，Token 状态不泄漏 Token 值', async () => {
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
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已配置').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('cf-api-token');
  });
});
