// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui/primitives';
import { AppManifests } from './AppManifests';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const manifest = {
  name: '示例应用',
  version: '1.2.3',
  runtime: { user: 'khc-app-demo', linger: true },
  params: [],
  scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
  sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
  writes: [],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastContextProvider value={{ show: vi.fn() }}>
        <AppManifests />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

describe('应用管理（R1 架子）', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('空清单显示引导，并提供添加入口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ appManifests: [] })));
    renderPage();
    expect(await screen.findByText('还没有应用')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '添加应用' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/不需要发布新版 Agent/)).toBeTruthy();
  });

  it('清单运行时读取，展示 id / 版本 / 运行用户', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json({
          appManifests: [
            { id: 'demo-app', manifest, enabled: true, createdAt: 1, updatedAt: 2 },
          ],
        });
      }),
    );
    renderPage();
    expect(await screen.findByText('demo-app')).toBeTruthy();
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(screen.getByText('khc-app-demo')).toBeTruthy();
    expect(calls).toContain('/api/v1/app-manifests');
  });
});
