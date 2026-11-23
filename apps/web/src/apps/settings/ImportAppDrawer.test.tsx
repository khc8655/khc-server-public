// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui/primitives';
import { ImportAppDrawer } from './ImportAppDrawer';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sha = (c: string) => c.repeat(64);
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 2,
    name: '示例',
    version: '1.0.0',
    runtime: { mode: 'create', user: 'khc-app-demo', linger: true },
    params: [],
    scripts: { install: 'echo i', uninstall: 'echo u' },
    sha256: { install: sha('a'), uninstall: sha('b') },
    writes: [],
    ...overrides,
  };
}

function renderDrawer(rows: unknown[] = [], fetchImpl?: (u: string, i: RequestInit) => Promise<Response>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastContextProvider value={{ show: vi.fn() }}>
        <ImportAppDrawer rows={rows as never} onClose={onClose} fetchImpl={fetchImpl} />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('清单 JSON'), { target: { value: text } });
}

describe('导入应用抽屉', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('新 ID：粘贴 → 检查 → 确认导入走 POST', async () => {
    window.scrollTo = vi.fn();
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return json({ appManifest: { id: 'demo', enabled: true, createdAt: 1, updatedAt: 1, manifest: manifest() } }, 201);
      }),
    );
    const { onClose } = renderDrawer();
    paste(JSON.stringify({ id: 'demo', manifest: manifest() }));
    await userEvent.click(screen.getByRole('button', { name: '检查' }));
    expect(await screen.findByText('将新增应用 demo')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/app-manifests');
    expect(post?.body).toMatchObject({ id: 'demo', enabled: true });
  });

  it('ID 已存在：展示差异，create → root 用 danger 提示，确认后走 PUT', async () => {
    window.scrollTo = vi.fn();
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url: String(input) });
        return json({ appManifest: { id: 'demo', enabled: true, createdAt: 1, updatedAt: 2, manifest: manifest() }, warnings: ['提醒 A'] });
      }),
    );
    const { onClose } = renderDrawer([
      { id: 'demo', enabled: true, createdAt: 1, updatedAt: 1, manifest: manifest() },
    ]);
    paste(
      JSON.stringify({
        id: 'demo',
        manifest: manifest({ version: '1.1.0', runtime: { mode: 'root', linger: true }, sha256: { install: sha('c'), uninstall: sha('b') } }),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: '检查' }));
    expect(await screen.findByText(/已存在，确认后将覆盖/)).toBeTruthy();
    expect(screen.getByText('运行方式提升为 root')).toBeTruthy();
    expect(screen.getByTestId('diff-version').textContent).toContain('1.1.0');
    expect(screen.getByTestId('diff-sha256.install')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '确认更新' }));
    expect(await screen.findByText('提醒 A')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.url).toBe('/api/v1/app-manifests/demo');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('契约校验失败：按字段路径列出，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDrawer();
    paste(JSON.stringify({ id: 'demo', manifest: manifest({ params: [{ key: 'Bad', type: 'integer' }] }) }));
    await userEvent.click(screen.getByRole('button', { name: '检查' }));
    expect(await screen.findByText('manifest.params.0.key')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Worker 拒绝保存时按 fields 路径标出', async () => {
    window.scrollTo = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          { error: { code: 'manifest_invalid', message: '清单不合法', fields: { 'manifest.hooks.preUninstall': '引用了无默认值的参数 tag' } } },
          400,
        ),
      ),
    );
    renderDrawer();
    paste(JSON.stringify({ id: 'demo', manifest: manifest() }));
    await userEvent.click(screen.getByRole('button', { name: '检查' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText('manifest.hooks.preUninstall')).toBeTruthy();
    expect(screen.getByText(/引用了无默认值的参数 tag/)).toBeTruthy();
  });

  it('URL 来源：非 https 拒绝；跨域失败给出文件导入提示', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderDrawer([], fetchImpl);
    await userEvent.click(screen.getByRole('button', { name: '从 URL' }));
    const input = screen.getByLabelText('清单地址');
    await userEvent.type(input, 'http://example.com/m.json');
    await userEvent.click(screen.getByRole('button', { name: '拉取并检查' }));
    expect(await screen.findByText('只允许 https:// 地址')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'https://example.com/m.json');
    await userEvent.click(screen.getByRole('button', { name: '拉取并检查' }));
    expect(await screen.findByText(/该地址不允许跨域读取，请下载后用文件导入/)).toBeTruthy();
  });

  it('URL 来源：拉取成功后进入差异确认', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'demo', manifest: manifest() }), { status: 200 }));
    renderDrawer([], fetchImpl);
    await userEvent.click(screen.getByRole('button', { name: '从 URL' }));
    await userEvent.type(screen.getByLabelText('清单地址'), 'https://example.com/m.json');
    await userEvent.click(screen.getByRole('button', { name: '拉取并检查' }));
    expect(await screen.findByText('将新增应用 demo')).toBeTruthy();
  });

  it('文件来源：超过 512KB 拒绝', async () => {
    renderDrawer();
    await userEvent.click(screen.getByRole('button', { name: '上传文件' }));
    const file = new File(['x'], 'big.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 512 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText('清单文件'), { target: { files: [file] } });
    expect(await screen.findByText('内容超过 512KB，已拒绝')).toBeTruthy();
  });
});
