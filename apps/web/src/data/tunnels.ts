/** 全局隧道配置 API 封装（面板只存域名/源站端口/Token，不做 Cloudflare Tunnel CRUD）。 */
import {
  createTunnelRequestSchema,
  tunnelListResponseSchema,
  tunnelResponseSchema,
  updateTunnelRequestSchema,
  type CreateTunnelRequest,
  type Tunnel,
  type UpdateTunnelRequest,
} from '@khc/contracts';
import { apiRequest } from './client';

export async function listTunnels(): Promise<Tunnel[]> {
  const body = await apiRequest<unknown>('/api/v1/tunnels');
  return tunnelListResponseSchema.parse(body).tunnels;
}

export async function createTunnel(input: CreateTunnelRequest): Promise<Tunnel> {
  const payload = createTunnelRequestSchema.parse(input);
  const body = await apiRequest<unknown>('/api/v1/tunnels', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return tunnelResponseSchema.parse(body).tunnel;
}

export async function updateTunnel(id: string, patch: UpdateTunnelRequest): Promise<Tunnel> {
  const payload = updateTunnelRequestSchema.parse(patch);
  const body = await apiRequest<unknown>(`/api/v1/tunnels/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return tunnelResponseSchema.parse(body).tunnel;
}

export async function deleteTunnel(id: string): Promise<void> {
  await apiRequest(`/api/v1/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
