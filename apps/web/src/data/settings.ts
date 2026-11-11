/** 全局设置（只写不读，列表仅返回 key/updatedAt）。 */
import { queryOptions } from '@tanstack/react-query';
import { settingsListResponseSchema, type Setting } from '@khc/contracts';
import { apiRequest } from './client';

export async function fetchSettings(): Promise<Setting[]> {
  const body = await apiRequest('/api/v1/settings');
  return settingsListResponseSchema.parse(body).settings;
}

export async function putSetting(key: string, value: unknown): Promise<Setting> {
  const body = (await apiRequest(`/api/v1/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })) as { setting?: Setting };
  if (!body.setting) throw new Error('设置保存响应不合法');
  return body.setting;
}

export async function deleteSetting(key: string): Promise<void> {
  await apiRequest(`/api/v1/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 10_000,
  });
