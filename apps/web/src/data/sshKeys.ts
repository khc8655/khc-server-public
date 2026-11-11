/** P4：全局 SSH 公钥库（只存公钥）。 */
import { queryOptions } from '@tanstack/react-query';
import {
  sshKeyListResponseSchema,
  sshKeyResponseSchema,
  type CreateSshKeyRequest,
  type SshKey,
  type UpdateSshKeyRequest,
} from '@khc/contracts';
import { apiRequest } from './client';

export async function fetchSshKeys(): Promise<SshKey[]> {
  const body = await apiRequest('/api/v1/ssh-keys');
  return sshKeyListResponseSchema.parse(body).sshKeys;
}

export async function createSshKey(input: CreateSshKeyRequest): Promise<SshKey> {
  const body = await apiRequest('/api/v1/ssh-keys', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return sshKeyResponseSchema.parse(body).sshKey;
}

export async function updateSshKey(id: string, input: UpdateSshKeyRequest): Promise<SshKey> {
  const body = await apiRequest(`/api/v1/ssh-keys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return sshKeyResponseSchema.parse(body).sshKey;
}

export async function deleteSshKey(id: string): Promise<void> {
  await apiRequest(`/api/v1/ssh-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const sshKeysQueryOptions = () =>
  queryOptions({
    queryKey: ['sshKeys'],
    queryFn: fetchSshKeys,
    staleTime: 10_000,
  });
