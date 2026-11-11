/** 全局证书库 API + certificates 适配器动作（签发/导入/解析）。 */
import { queryOptions } from '@tanstack/react-query';
import {
  agentEnvelopeSchema,
  certificateBindResponseSchema,
  certificateListResponseSchema,
  certificateMaterialResponseSchema,
  certificateResponseSchema,
  type AgentEnvelope,
  type Certificate,
  type CertificateBindResponse,
  type CertificateMaterialResponse,
  type CreateCertificateRequest,
  type TaskResponse,
  type UpdateCertificateRequest,
} from '@khc/contracts';
import { apiRequest } from './client';
import { fetchTask } from './apps';

export interface CertActionEnvelope extends AgentEnvelope {
  result?:
    | (NonNullable<AgentEnvelope['result']> & {
        certPem?: unknown;
        keyPem?: unknown;
        notAfter?: unknown;
        issuer?: unknown;
        domains?: unknown;
      })
    | undefined;
  /** 兼容 Agent 顶层字段 */
  certPem?: unknown;
  keyPem?: unknown;
  notAfter?: unknown;
  issuer?: unknown;
  domains?: unknown;
}

export interface CertificateMaterial {
  certPem: string;
  keyPem: string;
  notAfter: number | null;
  domains: string[];
  issuer: string | null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Agent 返回的 notAfter 可能是 ISO8601 字符串（openssl），统一转成 Unix 秒。 */
function asEpochSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function extractCertificateResult(
  envelope: CertActionEnvelope,
): CertificateMaterial | null {
  const result = envelope.result;
  const certPem =
    asString(result?.certPem) || asString(envelope.certPem) || asString(result?.cards?.[0]?.value);
  const keyPem = asString(result?.keyPem) || asString(envelope.keyPem);
  if (!certPem || !keyPem) return null;
  const domains =
    asStringList(result?.domains).length > 0
      ? asStringList(result?.domains)
      : asStringList(envelope.domains);
  return {
    certPem,
    keyPem,
    notAfter: asEpochSeconds(result?.notAfter) ?? asEpochSeconds(envelope.notAfter),
    issuer: asString(result?.issuer) || asString(envelope.issuer) || null,
    domains,
  };
}

/** 任务（ACME）结果里取证书材料：兼容 result 直接字段 / 嵌套 result / cards。 */
export function extractTaskCertificateResult(task: TaskResponse['task']): CertificateMaterial | null {
  const record = task.result;
  if (!record) return null;
  const nested =
    record.result !== null && typeof record.result === 'object' && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : record;
  const certPem = asString(nested.certPem) || asString(record.certPem);
  const keyPem = asString(nested.keyPem) || asString(record.keyPem);
  if (!certPem || !keyPem) return null;
  return {
    certPem,
    keyPem,
    notAfter: asEpochSeconds(nested.notAfter) ?? asEpochSeconds(record.notAfter),
    issuer: asString(nested.issuer) || asString(record.issuer) || null,
    domains: asStringList(nested.domains).length
      ? asStringList(nested.domains)
      : asStringList(record.domains),
  };
}

export interface InspectResult {
  notAfter: number | null;
  domains: string[];
}

export function extractInspectResult(envelope: CertActionEnvelope): InspectResult | null {
  const result = envelope.result;
  const notAfter = asEpochSeconds(result?.notAfter) ?? asEpochSeconds(envelope.notAfter);
  const domains = asStringList(result?.domains).length
    ? asStringList(result?.domains)
    : asStringList(envelope.domains);
  if (notAfter === null && domains.length === 0) return null;
  return { notAfter, domains };
}

export async function fetchCertificates(): Promise<Certificate[]> {
  const body = await apiRequest('/api/v1/certs');
  return certificateListResponseSchema.parse(body).certificates;
}

export async function createCertificate(input: CreateCertificateRequest): Promise<Certificate> {
  const body = await apiRequest('/api/v1/certs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return certificateResponseSchema.parse(body).certificate;
}

export async function deleteCertificate(id: string): Promise<void> {
  await apiRequest(`/api/v1/certs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 续期成功后替换同一条证书记录（材料 + 到期时间）。 */
export async function updateCertificate(
  id: string,
  input: UpdateCertificateRequest,
): Promise<Certificate> {
  const body = await apiRequest(`/api/v1/certs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return certificateResponseSchema.parse(body).certificate;
}

/** 把证书安装到节点 Agent 的 TLS 目录并热重载（控制通道 HTTPS）。 */
export async function bindCertificate(
  id: string,
  nodeId: string,
): Promise<CertificateBindResponse> {
  const body = await apiRequest(`/api/v1/certs/${encodeURIComponent(id)}/bind`, {
    method: 'POST',
    body: JSON.stringify({ nodeId }),
  });
  return certificateBindResponseSchema.parse(body);
}

export async function fetchCertificateMaterial(id: string): Promise<CertificateMaterialResponse> {
  const body = await apiRequest(`/api/v1/certs/${encodeURIComponent(id)}/material`);
  return certificateMaterialResponseSchema.parse(body);
}

export const certificatesQueryOptions = () =>
  queryOptions({
    queryKey: ['certs'],
    queryFn: fetchCertificates,
    staleTime: 10_000,
  });

export async function runCertificateAction(
  hubId: string,
  action: 'issue_selfsigned' | 'issue_acme' | 'inspect',
  params: Record<string, unknown>,
): Promise<CertActionEnvelope> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/certificates/${action}`,
    { method: 'POST', body: JSON.stringify({ params }) },
  );
  return agentEnvelopeSchema.parse(body) as CertActionEnvelope;
}

export async function fetchCertificateTask(
  hubId: string,
  taskId: string,
): Promise<TaskResponse> {
  return fetchTask(hubId, taskId);
}
