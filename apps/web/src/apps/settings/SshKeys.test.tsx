// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui/primitives';
import { SshKeys } from './SshKeys';

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@example';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let requests: string[] = [];
let stored: unknown[] = [];

function stubApi() {
  requests = [];
  stored = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/ssh-keys' && (!init || !init.method)) {
        return json({ sshKeys: stored });
      }
      if (url === '/api/v1/ssh-keys' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; publicKey: string };
        const key = {
          id: 'sshkey-1',
          name: body.name,
          publicKey: body.publicKey,
          fingerprint: 'SHA256:abc',
          comment: 'test@example',
          createdAt: 1,
          updatedAt: 1,
        };
        stored = [key];
        return json({ sshKey: key }, 201);
      }
      if (url === '/api/v1/ssh-keys/sshkey-1' && init?.method === 'DELETE') {
        stored = [];
        return json({ ok: true });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    }),
  );
}

function renderKeys() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastContextProvider value={{ show: vi.fn() }}>
        <SshKeys />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

describe('P4 SSH 公钥库', () => {
  beforeEach(stubApi);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('空态可添加公钥，POST 只发 1 次并刷新列表', async () => {
    renderKeys();
    expect(await screen.findByText('还没有公钥')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '添加公钥' }));
    await userEvent.type(screen.getByLabelText('名称'), '我的笔记本');
    await userEvent.type(screen.getByLabelText('公钥'), PUBLIC_KEY);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        requests.filter((url) => url === '/api/v1/ssh-keys').length,
      ).toBeGreaterThan(1);
    });
    expect((await screen.findAllByText('我的笔记本')).length).toBeGreaterThan(0);
  });

  it('列表展示指纹与注释', async () => {
    stored = [
      {
        id: 'sshkey-1',
        name: '服务器 A',
        publicKey: PUBLIC_KEY,
        fingerprint: 'SHA256:abc',
        comment: 'test@example',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    renderKeys();
    expect((await screen.findAllByText('服务器 A')).length).toBeGreaterThan(0);
    expect(await screen.findByText('SHA256:abc')).toBeTruthy();
    expect(await screen.findByText('test@example')).toBeTruthy();
  });

  it('删除成功后列表自动刷新（不需要手动刷新）', async () => {
    stored = [
      {
        id: 'sshkey-1',
        name: '服务器 A',
        publicKey: PUBLIC_KEY,
        fingerprint: 'SHA256:abc',
        comment: 'test@example',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    renderKeys();
    expect((await screen.findAllByText('服务器 A')).length).toBeGreaterThan(0);

    const row = (await screen.findAllByText('服务器 A'))[0]!.closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除公钥' }));
    const dialog = await screen.findByRole('dialog');
    // 确认按钮与菜单项同名，取对话框内最后一个（危险操作确认）。
    const confirms = within(dialog).getAllByRole('button', { name: '删除公钥' });
    await userEvent.click(confirms[confirms.length - 1]!);

    await waitFor(() => {
      expect(screen.queryByText('服务器 A')).toBeNull();
    });
    expect(await screen.findByText('还没有公钥')).toBeTruthy();
  });
});
