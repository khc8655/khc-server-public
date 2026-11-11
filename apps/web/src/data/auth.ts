/** 认证 API 封装：页面不得直接 fetch，只通过 data/ 调用。 */
import { queryOptions } from '@tanstack/react-query';
import { loginResponseSchema, meResponseSchema } from '@khc/contracts';
import { apiRequest } from './client';

export async function login(password: string): Promise<void> {
  loginResponseSchema.parse(
    await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  );
}

export async function logout(): Promise<void> {
  await apiRequest('/api/v1/auth/logout', { method: 'POST' });
}

export const meQueryOptions = () =>
  queryOptions({
    queryKey: ['auth', 'me'],
    queryFn: async () => meResponseSchema.parse(await apiRequest('/api/v1/auth/me')),
    retry: false,
    staleTime: 60_000,
  });
