/** C4 诊断数据层：错误码知识库 + 节点只读诊断。 */
import { queryOptions } from '@tanstack/react-query';
import {
  diagnosticHintsResponseSchema,
  nodeDiagnosticsResponseSchema,
  type DiagnosticCheck,
  type DiagnosticHint,
  type DiagnosticHintsResponse,
  type DiagnosticSeverity,
  type NodeDiagnosticsResponse,
} from '@khc/contracts';
import { apiRequest } from './client';

export const DIAGNOSTICS_TIMEOUT_MS = 8_000;

export class DiagnosticsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagnosticsTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DiagnosticsTimeoutError(message)), DIAGNOSTICS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchDiagnosticHints(): Promise<DiagnosticHintsResponse> {
  const body = await withTimeout(
    apiRequest<unknown>('/api/v1/diagnostics/hints'),
    '诊断知识库请求超时',
  );
  return diagnosticHintsResponseSchema.parse(body);
}

export async function fetchNodeDiagnostics(hubId: string): Promise<NodeDiagnosticsResponse> {
  const body = await withTimeout(
    apiRequest<unknown>(`/api/v1/nodes/${encodeURIComponent(hubId)}/diagnostics`),
    '诊断检查超时',
  );
  return nodeDiagnosticsResponseSchema.parse(body);
}

/** 错误码目录 5 分钟缓存（服务端 also Cache-Control max-age=300）。 */
export const diagnosticHintsQueryOptions = () =>
  queryOptions({
    queryKey: ['diagnostics', 'hints'],
    queryFn: fetchDiagnosticHints,
    staleTime: 5 * 60_000,
    retry: false,
  });

export const nodeDiagnosticsQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'diagnostics'],
    queryFn: () => fetchNodeDiagnostics(hubId),
    staleTime: 10_000,
    retry: false,
    enabled: Boolean(hubId),
  });

export function indexDiagnosticHints(hints: DiagnosticHint[] | undefined): Map<string, DiagnosticHint> {
  const map = new Map<string, DiagnosticHint>();
  for (const hint of hints ?? []) map.set(hint.code, hint);
  return map;
}

export function diagnosticHintFor(
  hints: Map<string, DiagnosticHint>,
  check: Pick<DiagnosticCheck, 'code'>,
): DiagnosticHint | null {
  return hints.get(check.code) ?? null;
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/** 服务端只返回问题；前端仍按严重度做一次稳定排序（同严重度保持后端顺序）。 */
export function diagnosticIssueChecks(response: NodeDiagnosticsResponse | undefined): DiagnosticCheck[] {
  if (!response) return [];
  return response.checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => {
      const rank = SEVERITY_RANK[a.check.severity] - SEVERITY_RANK[b.check.severity];
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(({ check }) => check);
}

export interface DiagnosticCounts {
  error: number;
  warn: number;
  info: number;
}

export function diagnosticCounts(checks: DiagnosticCheck[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { error: 0, warn: 0, info: 0 };
  for (const check of checks) counts[check.severity] += 1;
  return counts;
}

export function severityTone(severity: DiagnosticSeverity): 'warn' | 'danger' | 'info' {
  if (severity === 'error') return 'danger';
  if (severity === 'warn') return 'warn';
  return 'info';
}

export function isDiagnosticsTimeout(error: unknown): boolean {
  return error instanceof DiagnosticsTimeoutError;
}
