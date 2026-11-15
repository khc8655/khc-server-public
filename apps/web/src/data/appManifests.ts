/** R1：全局应用清单（运行时从 Worker 读取，不再构建期生成）。 */
import { queryOptions } from '@tanstack/react-query';
import {
  appManifestListResponseSchema,
  appManifestResponseSchema,
  type AppManifest,
  type CreateAppManifestRequest,
  type UpdateAppManifestRequest,
} from '@khc/contracts';
import { apiRequest } from './client';

export async function fetchAppManifests(): Promise<AppManifest[]> {
  const body = await apiRequest('/api/v1/app-manifests');
  return appManifestListResponseSchema.parse(body).appManifests;
}

export async function createAppManifest(input: CreateAppManifestRequest): Promise<AppManifest> {
  const body = await apiRequest('/api/v1/app-manifests', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return appManifestResponseSchema.parse(body).appManifest;
}

export async function updateAppManifest(
  id: string,
  input: UpdateAppManifestRequest,
): Promise<AppManifest> {
  const body = await apiRequest(`/api/v1/app-manifests/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return appManifestResponseSchema.parse(body).appManifest;
}

export async function deleteAppManifest(id: string): Promise<void> {
  await apiRequest(`/api/v1/app-manifests/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const appManifestsQueryOptions = () =>
  queryOptions({
    queryKey: ['appManifests'],
    queryFn: fetchAppManifests,
    staleTime: 10_000,
  });
