import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './app/router';
import './styles/tokens.css';
import './styles/global.css';
import './ui/ui.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 请求预算：失败不自动重试（否则一次失败会放大成 2×/4× Worker 请求）；
      // 聚焦/断网恢复也不后台刷新，只保留「打开页面拉一次 + 手动刷新」。
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: {
      retry: false,
    },
  },
});

const router = createAppRouter(queryClient);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
