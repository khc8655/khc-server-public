/** R1 / V4：全局应用清单与凭据状态查询（运行时从 Worker 读取）。 */
import { queryOptions } from '@tanstack/react-query';
import {
  appManifestListResponseSchema,
  appManifestResponseSchema,
  appManifestSecretsResponseSchema,
  type AppManifest,
  type AppManifestResponse,
  type AppManifestSecretStatus,
  type CreateAppManifestRequest,
  type UpdateAppManifestRequest,
} from '@khc/contracts';
import { apiRequest } from './client';

export async function fetchAppManifests(): Promise<AppManifest[]> {
  const body = await apiRequest('/api/v1/app-manifests');
  return appManifestListResponseSchema.parse(body).appManifests;
}

export async function createAppManifest(
  input: CreateAppManifestRequest,
): Promise<AppManifestResponse> {
  const body = await apiRequest('/api/v1/app-manifests', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return appManifestResponseSchema.parse(body);
}

export async function updateAppManifest(
  id: string,
  input: UpdateAppManifestRequest,
): Promise<AppManifestResponse> {
  const body = await apiRequest(`/api/v1/app-manifests/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return appManifestResponseSchema.parse(body);
}

export async function deleteAppManifest(id: string): Promise<void> {
  await apiRequest(`/api/v1/app-manifests/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchAppManifestSecrets(id: string): Promise<AppManifestSecretStatus[]> {
  const body = await apiRequest(`/api/v1/app-manifests/${encodeURIComponent(id)}/secrets`);
  return appManifestSecretsResponseSchema.parse(body).secrets;
}

export const appManifestsQueryOptions = () =>
  queryOptions({
    queryKey: ['appManifests'],
    queryFn: fetchAppManifests,
    staleTime: 10_000,
  });

export const appManifestSecretsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['appManifestSecrets', id],
    queryFn: () => fetchAppManifestSecrets(id),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
