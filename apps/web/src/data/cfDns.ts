import {
  cfDnsAccountCreateRequestSchema,
  cfDnsAccountResponseSchema,
  cfDnsAccountUpdateRequestSchema,
  cfDnsAccountsResponseSchema,
  cfDnsConfigRequestSchema,
  cfDnsRecordCreateForZoneRequestSchema,
  cfDnsRecordDeleteResponseSchema,
  cfDnsRecordItemResponseSchema,
  cfDnsRecordResponseSchema,
  cfDnsRecordUpdateRequestSchema,
  cfDnsStatusResponseSchema,
  cfDnsTestResponseSchema,
  cfDnsZoneListResponseSchema,
  cfDnsZoneRecordsResponseSchema,
  type CfDnsAccount,
  type CfDnsRecordCreateForZoneRequest,
  type CfDnsRecordUpdateRequest,
  type CfDnsZoneOption,
  type CfDnsZoneRecord,
  type CfDnsZoneRef,
} from '@khc/contracts';
import { apiRequest } from './client';

/** CF DNS 集成（#E1 / 第 5 步）：多凭据设置、代建/联动删除；Token 只写不读。 */

export interface CfDnsStatus {
  enabled: boolean;
  configured: boolean;
  hasToken: boolean;
  zoneName: string | null;
}

export async function fetchCfDnsStatus(): Promise<CfDnsStatus> {
  const body = await apiRequest<unknown>('/api/v1/cf-dns');
  return cfDnsStatusResponseSchema.parse(body);
}

export async function saveCfDnsConfig(input: {
  enabled: boolean;
  zoneName: string | null;
  token?: string;
}): Promise<CfDnsStatus> {
  const payload = cfDnsConfigRequestSchema.parse(input);
  const body = await apiRequest<unknown>('/api/v1/cf-dns', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return cfDnsStatusResponseSchema.parse(body);
}

export interface CfDnsTestResult {
  tokenStatus: string;
  zone: { id: string; name: string; status: string };
}

export async function testCfDnsConnection(): Promise<CfDnsTestResult> {
  const body = await apiRequest<unknown>('/api/v1/cf-dns/test', { method: 'POST' });
  return cfDnsTestResponseSchema.parse(body);
}

export async function fetchCfDnsAccounts(): Promise<CfDnsAccount[]> {
  const body = await apiRequest<unknown>('/api/v1/cf-dns/accounts');
  return cfDnsAccountsResponseSchema.parse(body).accounts;
}

export async function createCfDnsAccount(input: {
  name: string;
  token: string;
}): Promise<{ account: CfDnsAccount; zones: CfDnsZoneRef[] }> {
  const payload = cfDnsAccountCreateRequestSchema.parse(input);
  const body = await apiRequest<unknown>('/api/v1/cf-dns/accounts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const parsed = cfDnsAccountResponseSchema.parse(body);
  return { account: parsed.account, zones: parsed.zones ?? parsed.account.zones };
}

export async function updateCfDnsAccount(
  id: string,
  patch: { name?: string; enabled?: boolean; enabledZoneIds?: string[] },
): Promise<CfDnsAccount> {
  const payload = cfDnsAccountUpdateRequestSchema.parse(patch);
  const body = await apiRequest<unknown>(`/api/v1/cf-dns/accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return cfDnsAccountResponseSchema.parse(body).account;
}

export async function deleteCfDnsAccount(id: string): Promise<CfDnsAccount[]> {
  const body = await apiRequest<unknown>(`/api/v1/cf-dns/accounts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return cfDnsAccountsResponseSchema.parse(body).accounts;
}

export async function refreshCfDnsAccount(
  id: string,
): Promise<{ account: CfDnsAccount; zones: CfDnsZoneRef[] }> {
  const body = await apiRequest<unknown>(
    `/api/v1/cf-dns/accounts/${encodeURIComponent(id)}/refresh`,
    // 写请求守卫要求有 body 时必须 application/json；带显式 JSON 空对象，
    // 避免浏览器把无 body 的 POST 当作非 JSON 写请求而 415。
    { method: 'POST', body: '{}' },
  );
  const parsed = cfDnsAccountResponseSchema.parse(body);
  return { account: parsed.account, zones: parsed.zones ?? parsed.account.zones };
}

export async function fetchCfDnsZones(): Promise<CfDnsZoneOption[]> {
  const body = await apiRequest<unknown>('/api/v1/cf-dns/zones');
  return cfDnsZoneListResponseSchema.parse(body).zones;
}

/** 只读：已启用 Zone 下的 A/AAAA/CNAME 记录，用于添加节点时选择已有记录。 */
export async function fetchCfDnsRecords(
  zoneId: string,
): Promise<{ zoneId: string; zoneName: string; records: CfDnsZoneRecord[] }> {
  const body = await apiRequest<unknown>(
    `/api/v1/cf-dns/records?zoneId=${encodeURIComponent(zoneId)}`,
  );
  return cfDnsZoneRecordsResponseSchema.parse(body);
}

/** 全局域名管理：单条解析记录增改删（设置页「域名」）。 */
export async function createCfDnsRecord(
  zoneId: string,
  input: CfDnsRecordCreateForZoneRequest,
): Promise<CfDnsZoneRecord> {
  const payload = cfDnsRecordCreateForZoneRequestSchema.parse(input);
  const body = await apiRequest<unknown>(
    `/api/v1/cf-dns/records/${encodeURIComponent(zoneId)}`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  return cfDnsRecordItemResponseSchema.parse(body).record;
}

export async function updateCfDnsRecord(
  zoneId: string,
  recordId: string,
  patch: CfDnsRecordUpdateRequest,
): Promise<CfDnsZoneRecord> {
  const payload = cfDnsRecordUpdateRequestSchema.parse(patch);
  const body = await apiRequest<unknown>(
    `/api/v1/cf-dns/records/${encodeURIComponent(zoneId)}/${encodeURIComponent(recordId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
  return cfDnsRecordItemResponseSchema.parse(body).record;
}

export async function deleteCfDnsRecord(zoneId: string, recordId: string): Promise<void> {
  await apiRequest(
    `/api/v1/cf-dns/records/${encodeURIComponent(zoneId)}/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' },
  );
}

export interface CfDnsRecordResult {
  created: boolean;
  record: { id: string; type: 'A' | 'AAAA'; name: string; content: string };
  domain?: string;
}

export async function createCfDnsRecordForNode(
  nodeId: string,
  input?: { zoneId: string; subdomain?: string },
): Promise<CfDnsRecordResult> {
  const body = await apiRequest<unknown>('/api/v1/cf-dns/records', {
    method: 'POST',
    body: JSON.stringify(input ? { nodeId, ...input } : { nodeId }),
  });
  return cfDnsRecordResponseSchema.parse(body);
}

export interface CfDnsDeleteResult {
  deleted: boolean;
  errors: string[];
}

export async function deleteCfDnsRecordsForNode(nodeId: string): Promise<CfDnsDeleteResult> {
  const body = await apiRequest<unknown>(
    `/api/v1/cf-dns/records/${encodeURIComponent(nodeId)}`,
    { method: 'DELETE' },
  );
  return cfDnsRecordDeleteResponseSchema.parse(body);
}
