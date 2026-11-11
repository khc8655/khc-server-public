import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticCheck, DiagnosticHint, NodeDiagnosticsResponse } from '@khc/contracts';
import {
  DiagnosticsTimeoutError,
  diagnosticCounts,
  diagnosticHintFor,
  diagnosticHintsQueryOptions,
  diagnosticIssueChecks,
  fetchDiagnosticHints,
  fetchNodeDiagnostics,
  indexDiagnosticHints,
  nodeDiagnosticsQueryOptions,
  severityTone,
} from './diagnostics';
import { ApiError } from './client';

const hintsBody = {
  hintsVersion: '2026-10-29.1',
  hints: [
    {
      code: 'khc.transport.unreachable',
      layer: 'transport',
      severity: 'error',
      title: '节点不可达',
      summary: '直连与隧道两条路都失败。',
      impact: '节点状态与全部远程操作不可用。',
      aliases: ['unreachable'],
      causes: ['网络阻断'],
      checks: [
        { text: '确认 Agent 服务', kind: 'manual', command: 'systemctl status khc-agent --no-pager' },
        { text: '确认端口监听', kind: 'manual' },
      ],
      fixes: [{ mode: 'manual', label: '人工排查网络与 Agent' }],
      readOnly: true,
      doc: 'docs/diagnostics.md §3.1',
    },
  ],
};

const diagnosticsBody: NodeDiagnosticsResponse = {
  nodeId: 'tyo-1',
  generatedAt: 1_700_000_000,
  durationMs: 12,
  hintsVersion: '2026-10-29.1',
  reachable: true,
  route: 'direct',
  via: 'tcp',
  checks: [
    {
      id: 'problem.demo-app.unit_failed',
      code: 'khc.demo-app.unit_failed',
      severity: 'error',
      title: '单元未运行',
      detail: 'demo 服务未运行',
      app: 'demo-app',
      actions: [{ id: 'app.apply', label: '重新应用' }],
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('诊断数据层', () => {
  it('拉取知识库并建立 code 索引', async () => {
    const fetchMock = vi.fn(async () => json(hintsBody));
    vi.stubGlobal('fetch', fetchMock);
    const body = await fetchDiagnosticHints();
    expect(body.hintsVersion).toBe('2026-10-29.1');
    const hintsCall = fetchMock.mock.calls[0] as unknown as [string];
    expect(hintsCall[0]).toBe('/api/v1/diagnostics/hints');
    const hints = indexDiagnosticHints(body.hints as DiagnosticHint[]);
    expect(diagnosticHintFor(hints, { code: 'khc.transport.unreachable' })?.title).toBe('节点不可达');
    expect(diagnosticHintFor(hints, { code: 'khc.demo-app.unit_failed' })).toBeNull();
  });

  it('拉取节点诊断不带 depth（只有一档）并解析空 checks', async () => {
    const fetchMock = vi.fn(async () => json(diagnosticsBody));
    vi.stubGlobal('fetch', fetchMock);
    const body = await fetchNodeDiagnostics('tyo-1');
    expect(body.checks).toHaveLength(1);
    const diagnosticsCall = fetchMock.mock.calls[0] as unknown as [string];
    expect(diagnosticsCall[0]).toBe('/api/v1/nodes/tyo-1/diagnostics');

    vi.stubGlobal('fetch', vi.fn(async () => json({ ...diagnosticsBody, checks: [] })));
    const empty = await fetchNodeDiagnostics('tyo-1');
    expect(empty.checks).toEqual([]);
  });

  it('鉴权错误保留 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({ error: { code: 'unauthorized', message: '未登录' } }, 401),
    ));
    await expect(fetchNodeDiagnostics('tyo-1')).rejects.toBeInstanceOf(ApiError);
  });

  it('请求超时抛 DiagnosticsTimeoutError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const pending = fetchNodeDiagnostics('tyo-1');
    const expectation = expect(pending).rejects.toBeInstanceOf(DiagnosticsTimeoutError);
    await vi.advanceTimersByTimeAsync(8_000);
    await expectation;
  });

  it('问题列表按严重度排序并统计', () => {
    const checks: DiagnosticCheck[] = [
      { id: 'b.info', code: 'khc.agent.clock_skew', severity: 'info', title: 'info', detail: '' },
      { id: 'c.warn', code: 'khc.config.pending_apply', severity: 'warn', title: 'warn', detail: '' },
      { id: 'd.error', code: 'khc.transport.unreachable', severity: 'error', title: 'error', detail: '' },
    ];
    const issues = diagnosticIssueChecks({ ...diagnosticsBody, checks });
    expect(issues.map((item) => item.severity)).toEqual(['error', 'warn', 'info']);
    expect(diagnosticCounts(checks)).toEqual({ error: 1, warn: 1, info: 1 });
    expect(severityTone('error')).toBe('danger');
    expect(severityTone('warn')).toBe('warn');
    expect(severityTone('info')).toBe('info');
  });

  it('query options 使用 5 分钟 hints 缓存与 10 秒诊断缓存', () => {
    expect(diagnosticHintsQueryOptions().staleTime).toBe(5 * 60_000);
    const options = nodeDiagnosticsQueryOptions('tyo-1');
    expect(options.staleTime).toBe(10_000);
    expect(options.retry).toBe(false);
  });
});
