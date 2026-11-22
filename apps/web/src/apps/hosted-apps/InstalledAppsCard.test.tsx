// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui';
import { InstalledAppsCard } from './InstalledAppsCard';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const magpieManifest = {
  id: 'magpie',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    name: 'magpie',
    version: '0.1.4265',
    runtime: { mode: 'create', user: 'khc-app-magpie', linger: true },
    params: [
      { key: 'web_port', type: 'integer', label: 'Web 端口', default: 3430, min: 1024, max: 65535 },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    publish: { label: 'Web', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
    writes: [],
  },
};

describe('InstalledAppsCard 已安装的托管应用', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('读取 recipe_installed 顶层 installed 字段，并支持异步卸载任务轮询与列表即时刷新', async () => {
    let installedMap: Record<string, { version: string; installedAt: string }> = {
      magpie: { version: '0.1.4265', installedAt: '2026-11-22T00:53:28Z' },
    };
    let taskPolls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_installed') {
          return json({
            ok: true,
            installed: installedMap,
            recipes: [],
            cards: [],
            result: { cards: [] },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_uninstall') {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            params: { manifestId: 'magpie', values: {} },
          });
          return json({ ok: true, accepted: true, taskId: 'task-uninst-1', result: { taskId: 'task-uninst-1' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-uninst-1') {
          taskPolls += 1;
          if (taskPolls < 2) {
            return json({
              task: { id: 'task-uninst-1', state: 'running', progress: 50, logs: [], result: null, error: null },
            });
          }
          installedMap = {};
          return json({
            task: { id: 'task-uninst-1', state: 'done', progress: 100, logs: [], result: {}, error: null },
          });
        }
        return json({});
      }),
    );

    const showToast = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastContextProvider value={{ show: showToast }}>
          <InstalledAppsCard hubId="hub-1" pollIntervalMs={5} />
        </ToastContextProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('magpie')).toBeTruthy();
    const uninstallBtn = screen.getByRole('button', { name: '卸载' }) as HTMLButtonElement;
    expect(uninstallBtn.disabled).toBe(false);

    await userEvent.click(uninstallBtn);
    const confirmDialog = await screen.findByRole('dialog');
    await userEvent.type(within(confirmDialog).getByRole('textbox'), 'magpie');
    await userEvent.click(within(confirmDialog).getByRole('button', { name: '卸载' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('这台机器还没装托管应用')).toBeTruthy();
    expect(taskPolls).toBeGreaterThanOrEqual(2);
  });
});
