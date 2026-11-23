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
let certs: Array<Record<string, unknown>> = [];
let issueCertFails = false;
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
      if (url === '/api/v1/certs') return json({ certificates: certs });
      if (url === '/api/v1/certs/issue-dns01' && init?.method === 'POST') {
        if (issueCertFails) {
          return json({ error: { code: 'acme_failed', message: 'CF DNS-01 鉴权超时' } }, 502);
        }
        const payload = JSON.parse(String(init.body)) as { name: string; domains: string[] };
        const issued = {
          id: `cert-${certs.length + 1}`,
          name: payload.name,
          domains: payload.domains,
          issuer: 'acme',
          acmeProvider: 'cf-dns01',
          acmeCa: 'letsencrypt',
          autoSync: true,
          renewable: true,
          notAfter: Math.floor(Date.now() / 1000) + 90 * 86400,
          sourceNodeId: null,
          createdAt: 1,
          updatedAt: 1,
        };
        certs = [issued, ...certs];
        return json({ certificate: issued }, 201);
      }
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
      if (url === '/api/v1/cf-dns/records?zoneId=z2') {
        return json({ zoneId: 'z2', zoneName: 'second.example.com', records: [] });
      }
      if (url.startsWith('/api/v1/cf-dns/records/z1/') && init?.method === 'DELETE') {
        const id = url.split('/').pop();
        records = records.filter((item) => item.id !== id);
        return json({ ok: true });
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
  certs = [];
  issueCertFails = false;
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderSettings(path = '/settings?tab=accounts') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '设置' });
  return router;
}

describe('设置页：账号与域名管理分离（S1）', () => {
  it('账号分段（?tab=cloudflare 兼容映射）展示凭据空态与「添加凭据」，不渲染「应用目录」Tab', async () => {
    await renderSettings('/settings?tab=cloudflare');
    expect(await screen.findByText('还没有 Cloudflare 凭据')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '添加凭据' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '应用目录' })).toBeNull();
  });

  it('旧 ?tab=catalog 兼容落到「应用管理」', async () => {
    await renderSettings('/settings?tab=catalog');
    expect(await screen.findByText('应用定义存在控制面')).toBeTruthy();
  });

  it('添加凭据抽屉含服务商栏位，提交后进入编辑态可取消勾选 Zone', async () => {
    await renderSettings();
    const buttons = screen.getAllByRole('button', { name: '添加凭据' });
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cloudflare')).toBeTruthy();

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

  it('账号与域名管理职责分离：账号卡无「查看域名」假跳转，切换到域名管理仅列已启用域名', async () => {
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
    await renderSettings('/settings?tab=accounts');
    expect((await screen.findAllByText('主账号')).length).toBeGreaterThan(0);
    expect(screen.getByText('Cloudflare')).toBeTruthy();
    expect(screen.getByText('已启用 1 个域名')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看域名' })).toBeNull();
    expect(screen.queryByText('example.com')).toBeNull();
    expect(document.body.textContent).not.toContain('cf-api-token');

    await userEvent.click(screen.getByRole('button', { name: '域名管理' }));
    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.queryByText('second.example.com')).toBeNull();
  });

  it('域名管理无账号时提示前往配置账号，点击按钮跳到账号分段', async () => {
    await renderSettings('/settings?tab=domain');
    expect(await screen.findByText('还没有配置 DNS 账号')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '前往配置账号' }));
    expect(await screen.findByText('还没有 Cloudflare 凭据')).toBeTruthy();
  });

  it('域名管理「管理记录」按需请求解析记录，显示只读记录与代理标记', async () => {
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
    await renderSettings('/settings?tab=domain');
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
    await renderSettings('/settings?tab=domain');
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
    await renderSettings('/settings?tab=domain');
    await userEvent.click(await screen.findByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('manual.example.com');

    await userEvent.click(within(dialog).getByRole('button', { name: '检测解析' }));
    expect(await within(dialog).findByText(/解析已生效/)).toBeTruthy();
    expect(within(dialog).getByText(/检测时间 .* · 基于公共 DoH 递归解析/)).toBeTruthy();
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
    await renderSettings('/settings?tab=domain');
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

  it('Token 默认掩码支持显隐切换；抽屉内行内删记录不叠 Dialog 且只重拉当前 Zone', async () => {
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
    await renderSettings('/settings?tab=accounts');
    await userEvent.click(screen.getAllByRole('button', { name: '添加凭据' })[0]!);
    const createDrawer = await screen.findByRole('dialog');
    const tokenInput = within(createDrawer).getByLabelText('API Token') as HTMLInputElement;
    expect(tokenInput.type).toBe('password');
    await userEvent.click(within(createDrawer).getByRole('button', { name: '显示' }));
    expect(tokenInput.type).toBe('text');
    await userEvent.click(within(createDrawer).getByRole('button', { name: '隐藏' }));
    expect(tokenInput.type).toBe('password');
    await userEvent.click(within(createDrawer).getByRole('button', { name: '关闭' }));

    await userEvent.click(screen.getByRole('button', { name: '域名管理' }));
    const manageBtns = await screen.findAllByRole('button', { name: '管理记录' });
    await userEvent.click(manageBtns[0]!);
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('manual.example.com');
    const beforeCount = requests.length;

    await userEvent.click(within(drawer).getByRole('button', { name: '删除' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await userEvent.click(within(drawer).getByRole('button', { name: '删除记录' }));

    await waitFor(() => {
      expect(within(drawer).queryByText('manual.example.com')).toBeNull();
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const followUps = requests.slice(beforeCount).map((item) => item.url);
    expect(followUps).toContain('/api/v1/cf-dns/records?zoneId=z1');
    expect(followUps).not.toContain('/api/v1/cf-dns/records?zoneId=z2');
  });

  it('添加 A 记录默认同时签发 DNS-01 泛域名证书；失败不回滚 DNS 并支持重试', async () => {
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
    issueCertFails = true;
    await renderSettings('/settings?tab=domain');
    await userEvent.click(await screen.findByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('manual.example.com');

    await userEvent.click(within(dialog).getByRole('button', { name: '添加记录' }));
    const certCheckbox = within(dialog).getByRole('checkbox', {
      name: /同时签发 HTTPS 证书/,
    }) as HTMLInputElement;
    expect(certCheckbox.checked).toBe(true);

    await userEvent.type(within(dialog).getByLabelText('记录名'), 'vm1');
    await userEvent.type(within(dialog).getByLabelText('内容'), '198.51.100.40');
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    // 证书签发失败：DNS 记录不回滚且保留在列表，抽屉顶部展示重试横幅
    expect(await within(dialog).findByText('vm1.example.com')).toBeTruthy();
    expect(await within(dialog).findByText(/解析已添加，但证书签发失败：CF DNS-01 鉴权超时/)).toBeTruthy();

    issueCertFails = false;
    await userEvent.click(within(dialog).getByRole('button', { name: '重试签发证书' }));
    await waitFor(() => {
      expect(within(dialog).queryByText(/解析已添加，但证书签发失败/)).toBeNull();
    });
    const issueReq = requests.find((item) => item.url === '/api/v1/certs/issue-dns01');
    expect(JSON.parse(String(issueReq?.init?.body))).toMatchObject({
      accountId: 'acc-1',
      domains: ['*.example.com'],
    });
  });

  it('已有有效泛域名证书时提示免签且列表显示证书就绪标签；无证行支持补签', async () => {
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
    await renderSettings('/settings?tab=domain');
    await userEvent.click(await screen.findByRole('button', { name: '管理记录' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('无证书')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: '签发证书' }));
    expect(await within(dialog).findByText('证书就绪：*.example.com')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: '添加记录' }));
    expect(await within(dialog).findByText(/已被有效证书「\*\.example\.com」覆盖/)).toBeTruthy();
  });
});
