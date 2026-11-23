// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExpiringCertSummary } from '@khc/contracts';
import { ToastContextProvider } from '../ui';
import { resetAutoRenewAttemptedForTests, useAutoRenewCerts } from './useAutoRenewCerts';

function Harness({ certs }: { certs: ExpiringCertSummary[] }) {
  useAutoRenewCerts(certs);
  return null;
}

describe('useAutoRenewCerts', () => {
  beforeEach(() => {
    resetAutoRenewAttemptedForTests();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('只对 ≤15 天且 renewable && autoSync 的证书触发一次续期，并在同会话去重', async () => {
    const renewed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const match = url.match(/\/api\/v1\/certs\/([^/]+)\/renew$/);
        if (match && init?.method === 'POST') {
          renewed.push(decodeURIComponent(match[1]!));
          return new Response(
            JSON.stringify({
              certificate: {
                id: match[1],
                name: 'cert-1',
                domains: ['*.example.com'],
                issuer: 'acme',
                notAfter: Math.floor(Date.now() / 1000) + 90 * 86400,
                sourceNodeId: null,
                createdAt: 1,
                updatedAt: 2,
              },
              syncResults: [
                {
                  nodeId: 'n1',
                  nodeName: 'vm-1',
                  status: 'synced',
                  appliedApps: ['caddy-site'],
                  tlsBound: true,
                  error: null,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    const certs: ExpiringCertSummary[] = [
      { id: 'due-ok', name: 'due-ok', daysLeft: 15, nodeId: null, renewable: true, autoSync: true },
      { id: 'due-nosync', name: 'due-nosync', daysLeft: 5, nodeId: null, renewable: true, autoSync: false },
      { id: 'due-self', name: 'due-self', daysLeft: 5, nodeId: null, renewable: false, autoSync: true },
      { id: 'far-ok', name: 'far-ok', daysLeft: 16, nodeId: null, renewable: true, autoSync: true },
    ];

    const toastSpy = { show: vi.fn() };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ToastContextProvider value={toastSpy}>
          <Harness certs={certs} />
        </ToastContextProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(renewed).toEqual(['due-ok']));
    await waitFor(() => expect(toastSpy.show).toHaveBeenCalled());

    // 同会话再次渲染同一批临期列表不会重复触发
    rerender(
      <QueryClientProvider client={queryClient}>
        <ToastContextProvider value={toastSpy}>
          <Harness certs={[...certs]} />
        </ToastContextProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renewed).toEqual(['due-ok']);
  });
});
