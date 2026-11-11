import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 单测环境没有 Workers 的 cloudflare:sockets；用 stub 让模块可解析（测试注入 mock）
      'cloudflare:sockets': fileURLToPath(
        new URL('./apps/api/test/helpers/sockets-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'apps/**/test/**/*.test.ts',
      'apps/**/src/**/*.test.{ts,tsx}',
      'packages/**/test/**/*.test.ts',
      'scripts/test/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: false,
  },
});
