// @vitest-environment jsdom
/**
 * 旧 /services 路由 302 重定向到「应用」页（U3：取消「对外服务」Tab）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

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

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [
            {
              app: 'caddy-site',
              schemaVersion: 1,
              config: {
                sites: [
                  {
                    name: 'blog',
                    domains: ['blog.example.dev'],
                    listenPort: 443,
                    kind: 'proxy',
                    upstreams: ['10.99.0.2:8080'],
                    enabled: true,
                  },
                ],
              },
              rev: 1,
              appliedRev: 1,
              updatedAt: NOW,
            },
          ],
          adapters: [{ name: 'caddy-site', version: '1.0.0', api: 1 }],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') {
        return json({
          app: {
            app: 'caddy-site',
            schemaVersion: 1,
            config: {
              sites: [
                {
                  name: 'blog',
                  domains: ['blog.example.dev'],
                  listenPort: 443,
                  kind: 'proxy',
                  upstreams: ['10.99.0.2:8080'],
                  enabled: true,
                },
              ],
            },
            rev: 1,
            appliedRev: 1,
            updatedAt: NOW,
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: {
            host: { hostname: 'tyo-1' },
            adapters: [{ name: 'caddy-site', version: '1.0.0', status: { installed: true, running: true } }],
            ports: [],
          },
        });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('旧 /services 暗路由重定向（U3）', () => {
  it('/hubs/:id/services 302 重定向到「应用」页（/hubs/:id/sites）', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter(
      queryClient,
      createMemoryHistory({ initialEntries: ['/hubs/tyo-1/services'] }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: '应用' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/sites');
    expect((await screen.findAllByText(/https:\/\/blog\.example\.dev/)).length).toBeGreaterThan(0);
  });
});
