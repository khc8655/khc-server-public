import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterState, AgentOps, AgentState, DiagnosticCheck } from '@khc/contracts';
import {
  adapterProblemSchema,
  agentOpsSchema,
  diagnosticHintSchema,
  diagnosticHintsResponseSchema,
  nodeDiagnosticsResponseSchema,
} from '@khc/contracts';
import {
  CORE_DIAGNOSTIC_CODES,
  HINT_CODES,
  HINT_FIX_ACTION_IDS,
  classifyTransport,
  diagnosticHints,
  evaluateDiagnostics,
  finalizeChecks,
  hintsVersion,
  sortChecks,
  type EvalConfig,
  type EvalInput,
} from '../src/lib/diagnostics';
import {
  adjustAcmeProblems,
  certificateProblems,
  isCertificateRelevant,
  selectRelevantCertificates,
} from '../src/lib/app-diagnostics/certificates';
import { hostProblems } from '../src/lib/app-diagnostics/host';
import { HubUnreachableError } from '../src/lib/node-client';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const NOW = 1_760_000_000;
const DAY = 86_400;

// ---------------------------------------------------------------------------
// 目录：核心 7 码
// ---------------------------------------------------------------------------

describe('核心诊断知识库（7 码）', () => {
  it('版本、数量、层级与唯一性', () => {
    expect(hintsVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(HINT_CODES).toEqual([...CORE_DIAGNOSTIC_CODES]);
    expect(diagnosticHints).toHaveLength(7);
    const layers = new Set(diagnosticHints.map((hint) => hint.layer));
    expect([...layers].sort()).toEqual(['agent', 'config', 'transport']);
  });

  it('每条 Hint 通过契约校验，causes/checks 非空', () => {
    for (const hint of diagnosticHints) {
      expect(diagnosticHintSchema.safeParse(hint).success, hint.code).toBe(true);
      expect(hint.causes.length).toBeGreaterThan(0);
      expect(hint.checks.length).toBeGreaterThan(0);
      expect(hint.code.startsWith(`khc.${hint.layer}.`)).toBe(true);
      expect(hint.doc).toMatch(/^docs\/diagnostics\.md/);
    }
  });

  it('核心知识库只引用白名单动作（应用动作由适配器自带）', () => {
    const actionFixes = diagnosticHints.flatMap((hint) =>
      hint.fixes.filter((fix) => fix.mode === 'action'),
    );
    expect(new Set(Object.keys(HINT_FIX_ACTION_IDS))).toEqual(new Set(['app.apply']));
    for (const fix of actionFixes) {
      expect(fix.actionId).toBeTruthy();
      expect(fix.level).toBe(HINT_FIX_ACTION_IDS[fix.actionId as keyof typeof HINT_FIX_ACTION_IDS]);
    }
    expect(diagnosticHints).toHaveLength(7);
    expect(diagnosticHintsResponseSchema.safeParse({ hintsVersion, hints: diagnosticHints }).success).toBe(true);
  });

  it('只读命令无 shell 插值/拼接，且不含凭据字样', () => {
    for (const hint of diagnosticHints) {
      for (const check of hint.checks) {
        if (!check.command) continue;
        expect(check.command, hint.code).not.toMatch(/[;&|<>`$\\]/);
        expect(check.command.length).toBeLessThanOrEqual(300);
        expect(check.command.toLowerCase()).not.toContain('token');
        expect(check.command.toLowerCase()).not.toContain('password');
        expect(check.command.toLowerCase()).not.toContain('private');
      }
    }
  });

  it('核心 diagnostics 目录不出现任何应用名（#49 验收）', () => {
    const dir = join(process.cwd(), 'apps/api/src/lib/diagnostics');
    const forbidden = /\b(wireguard|caddy|certificates?|port-?forward|acme)\b/i;
    for (const file of readdirSync(dir).filter((name: string) => name.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(forbidden);
    }
  });

  it('适配器问题契约只接受稳定 slug 与三档严重度', () => {
    expect(
      adapterProblemSchema.safeParse({
        code: 'interface_down',
        severity: 'error',
        title: '接口未运行',
        hint: '说明',
        action: { id: 'app.apply', label: '重新应用' },
        evidence: { port: 1 },
      }).success,
    ).toBe(true);
    expect(adapterProblemSchema.safeParse({ code: 'Interface-Down', severity: 'error', title: 'x' }).success).toBe(false);
    expect(adapterProblemSchema.safeParse({ code: 'x', severity: 'ok', title: 'x' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 传输分类（旧码合并）
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<EvalInput> = {}): EvalInput {
  return {
    node: { lastSeenAt: NOW - 5 },
    state: baseState(),
    configs: baseConfigs(),
    now: NOW,
    reachable: true,
    ...overrides,
  };
}

describe('传输错误归类', () => {
  const cases: Array<[string, EvalInput['error'], Record<string, string> | undefined, string]> = [
    ['401', { status: 401, message: 'unauthorized' }, undefined, 'khc.transport.auth_401'],
    ['错误信封 unauthorized', { body: { error: { code: 'unauthorized' } } }, undefined, 'khc.transport.auth_401'],
    ['timeout', { message: 'TCP 连接超时（>8000ms）' }, undefined, 'khc.transport.unreachable'],
    ['abort', { message: 'The operation was aborted' }, undefined, 'khc.transport.unreachable'],
    ['tls', { message: 'certificate verify failed' }, undefined, 'khc.transport.unreachable'],
    ['bad response', { body: { error: { code: 'bad_agent_response' } } }, undefined, 'khc.transport.unreachable'],
    ['530', undefined, { direct: '连接失败', tunnel: 'HTTP 530' }, 'khc.transport.unreachable'],
    ['1003', undefined, { direct: 'error 1003 Direct IP access not allowed' }, 'khc.transport.unreachable'],
    ['522', { message: 'Cloudflare error 522' }, undefined, 'khc.transport.unreachable'],
    ['524', { message: 'HTTP 524 timeout' }, undefined, 'khc.transport.unreachable'],
  ];

  it('每个旧码都落到 7 个核心码之一', () => {
    for (const [name, error, routeErrors, expected] of cases) {
      const verdict = classifyTransport(baseInput({ reachable: false, error, routeErrors }));
      expect(verdict.code, name).toBe(expected);
    }
  });

  it('原因进 evidence，不新增码', () => {
    const verdict = classifyTransport(
      baseInput({ reachable: false, routeErrors: { direct: 'timeout', tunnel: 'HTTP 530' } }),
    );
    expect(verdict.code).toBe('khc.transport.unreachable');
    expect(verdict.evidence.cf).toBe(530);
    expect(verdict.evidence.reason).toBe('cf_530');
    expect(String(verdict.evidence.tunnel)).toContain('530');
  });
});

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

function adapterState(name: string, status: Record<string, unknown>, appliedRev = 1): AdapterState {
  return { name, version: '1.0.0', appliedRev, status };
}

function baseState(): AgentState {
  return {
    host: { hostname: 'hub-a' },
    agent: { version: '0.1.0', serverTime: NOW },
    adapters: [adapterState('demo-app', { running: true })],
    ports: [{ proto: 'tcp', port: 443, app: 'demo-app' }],
  };
}

function baseConfigs(): EvalConfig[] {
  return [{ app: 'demo-app', rev: 1, appliedRev: 1, updatedAt: NOW - 60 }];
}

function findCheck(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`missing check ${id}: ${checks.map((item) => item.id).join(',')}`);
  return found;
}

describe('诊断求值：只返回问题', () => {
  it('全部正常时返回空数组（不再有 OK 行）', () => {
    expect(evaluateDiagnostics(baseInput())).toEqual([]);
  });

  it('不可达：unreachable + offline，不产生应用 unknown 行', () => {
    const checks = evaluateDiagnostics(
      baseInput({
        reachable: false,
        state: null,
        node: { lastSeenAt: NOW - 7200 },
        routeErrors: { direct: 'TCP 连接超时（>3000ms）', tunnel: 'HTTP 530' },
      }),
    );
    expect(checks.map((check) => check.code).sort()).toEqual([
      'khc.agent.offline',
      'khc.transport.unreachable',
    ]);
    expect(findCheck(checks, 'agent.offline').severity).toBe('error');
    expect(findCheck(checks, 'transport.reachability').evidence?.cf).toBe(530);
  });

  it('离线分级：10 分钟内 warn，超过 error', () => {
    const recent = evaluateDiagnostics(
      baseInput({
        reachable: false,
        state: null,
        node: { lastSeenAt: NOW - 120 },
      }),
    );
    expect(findCheck(recent, 'agent.offline').severity).toBe('warn');
    const old = evaluateDiagnostics(
      baseInput({
        reachable: false,
        state: null,
        node: { lastSeenAt: NOW - 3600 },
      }),
    );
    expect(findCheck(old, 'agent.offline').severity).toBe('error');
  });

  it('时钟偏差 >60s 才报；版本缺失/非法才报', () => {
    const skewed = baseState();
    skewed.agent = { version: '0.1.0', serverTime: NOW - 120 };
    const skewChecks = evaluateDiagnostics(baseInput({ state: skewed }));
    expect(findCheck(skewChecks, 'agent.clock').code).toBe('khc.agent.clock_skew');
    expect(findCheck(skewChecks, 'agent.clock').evidence?.skewSeconds).toBe(120);

    const missing = baseState();
    delete (missing as { agent?: unknown }).agent;
    const missingChecks = evaluateDiagnostics(baseInput({ state: missing }));
    expect(findCheck(missingChecks, 'agent.version').code).toBe('khc.agent.version_unsupported');
    // serverTime 缺失时不再制造 unknown 行
    expect(missingChecks.some((check) => check.id === 'agent.clock')).toBe(false);
  });

  it('state 不合法 / 缺适配器 → agent.state_invalid', () => {
    const invalid = evaluateDiagnostics(baseInput({ state: null }));
    expect(findCheck(invalid, 'agent.state_schema').code).toBe('khc.agent.state_invalid');

    const configs = [...baseConfigs(), { app: 'other-app', rev: 1, appliedRev: 1, updatedAt: NOW }];
    const missing = evaluateDiagnostics(baseInput({ configs }));
    const check = findCheck(missing, 'agent.state_schema');
    expect(check.severity).toBe('error');
    expect(check.detail).toContain('other-app');
  });

  it('配置待生效一个码：超过 10 分钟或 apply 失败升级为 warn', () => {
    const fresh = evaluateDiagnostics(
      baseInput({ configs: [{ ...baseConfigs()[0]!, rev: 2, appliedRev: 1, updatedAt: NOW - 60 }] }),
    );
    const freshCheck = findCheck(fresh, 'config.sync');
    expect(freshCheck).toMatchObject({ severity: 'info', code: 'khc.config.pending_apply' });

    const stuck = evaluateDiagnostics(
      baseInput({ configs: [{ ...baseConfigs()[0]!, rev: 2, appliedRev: 1, updatedAt: NOW - 3600 }] }),
    );
    const stuckCheck = findCheck(stuck, 'config.sync');
    expect(stuckCheck).toMatchObject({ severity: 'warn', code: 'khc.config.pending_apply' });

    const failed = evaluateDiagnostics(
      baseInput({
        configs: [
          {
            ...baseConfigs()[0]!,
            rev: 2,
            appliedRev: 1,
            lastApplyError: { code: 'apply_failed', message: 'restart failed' },
          },
        ],
      }),
    );
    const failedCheck = findCheck(failed, 'config.sync');
    expect(failedCheck.severity).toBe('warn');
    expect(failedCheck.evidence?.errorCode).toBe('apply_failed');
    expect(failedCheck.detail).toContain('restart failed');
  });

  it('适配器 problems 通用渲染：命名空间、app、action、evidence', () => {
    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        running: false,
        problems: [
          {
            code: 'unit_failed',
            severity: 'error',
            title: '单元未运行',
            hint: 'demo 服务未运行',
            action: { id: 'app.apply', label: '重新应用' },
            evidence: { unit: 'demo.service', active: false },
          },
        ],
      }),
    ];
    const check = findCheck(evaluateDiagnostics(baseInput({ state })), 'problem.demo-app.unit_failed');
    expect(check).toMatchObject({
      code: 'khc.demo-app.unit_failed',
      app: 'demo-app',
      severity: 'error',
      title: '单元未运行',
      detail: 'demo 服务未运行',
    });
    expect(check.actions?.[0]).toMatchObject({ id: 'app.apply' });
    expect(check.evidence).toMatchObject({ unit: 'demo.service', active: false });
  });

  it('非法 problems 被忽略；核心码命名空间不会被适配器占用', () => {
    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        problems: [
          { code: 'BAD', severity: 'error', title: 'x' },
          { code: 'good_one', severity: 'warn', title: '正常问题' },
        ],
      }),
      adapterState('agent', {
        problems: [{ code: 'offline', severity: 'warn', title: '伪造离线' }],
      }),
    ];
    const checks = evaluateDiagnostics(baseInput({ state }));
    expect(checks.filter((check) => check.app === 'demo-app')).toHaveLength(1);
    expect(findCheck(checks, 'problem.demo-app.good_one').code).toBe('khc.demo-app.good_one');
    expect(checks.some((check) => check.id === 'problem.agent.offline')).toBe(false);
  });

  it('控制面补充问题（证书）与适配器问题统一渲染', () => {
    const checks = evaluateDiagnostics(
      baseInput({
        extraProblems: [
          {
            app: 'certificates',
            problems: certificateProblems(
              [
                {
                  id: 'cert_1',
                  name: 'site',
                  domains: ['site.test'],
                  issuer: 'acme',
                  notAfter: NOW + 9 * DAY,
                  sourceNodeId: 'nd_1',
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
              NOW,
            ),
          },
        ],
      }),
    );
    const check = findCheck(checks, 'problem.certificates.expiring');
    expect(check.code).toBe('khc.certificates.expiring');
    expect(check.severity).toBe('warn');
    expect(check.evidence?.domain).toBe('site.test');
    expect(check.evidence?.daysLeft).toBe(9);
  });

  it('排序、去重与 30 条上限', () => {
    const many: DiagnosticCheck[] = Array.from({ length: 35 }, (_, index) => ({
      id: `demo.check_${index}`,
      code: 'khc.demo.check',
      severity: index < 2 ? 'error' : index < 5 ? 'warn' : 'info',
      title: 'x',
      detail: 'x',
    }));
    const finalized = finalizeChecks(many);
    expect(finalized.checks).toHaveLength(30);
    expect(finalized.truncated).toBe(true);
    const ranks = finalized.checks.map((check) => ({ error: 0, warn: 1, info: 2 })[check.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(sortChecks(many)[0]?.severity).toBe('error');

    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        problems: [
          { code: 'same', severity: 'warn', title: 'a' },
          { code: 'same', severity: 'warn', title: 'b' },
        ],
      }),
    ];
    const deduped = evaluateDiagnostics(baseInput({ state }));
    expect(new Set(deduped.map((check) => check.id)).size).toBe(deduped.length);
  });

  it('适配器 hint/evidence 脱敏且有界', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----';
    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        problems: [
          {
            code: 'leak',
            severity: 'error',
            title: 'x',
            hint: `${pem} Bearer abc.def token=supersecret ${'y'.repeat(100)}`,
            evidence: { message: `${pem} Bearer abc.def token=supersecret` },
          },
        ],
      }),
    ];
    const check = findCheck(evaluateDiagnostics(baseInput({ state })), 'problem.demo-app.leak');
    expect(check.detail).not.toContain('PRIVATE KEY');
    expect(check.detail).not.toContain('abc.def');
    expect(check.detail).not.toContain('supersecret');
    expect(check.detail.length).toBeLessThanOrEqual(300);
    expect(String(check.evidence?.message)).not.toContain('PRIVATE KEY');
    expect(String(check.evidence?.message).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// 证书来源
// ---------------------------------------------------------------------------

describe('控制面证书 → 通用问题', () => {
  const cert = (overrides: Partial<Parameters<typeof certificateProblems>[0][number]> = {}) => ({
    id: 'cert_1',
    name: 'site',
    domains: ['site.test'],
    issuer: 'acme',
    notAfter: NOW + 90 * DAY,
    sourceNodeId: 'nd_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('分级：>30 天无问题，<=30 info，<=14 warn，<=3/过期 error', () => {
    expect(certificateProblems([cert()], NOW)).toEqual([]);
    expect(certificateProblems([cert({ notAfter: NOW + 20 * DAY })], NOW)[0]?.severity).toBe('info');
    expect(certificateProblems([cert({ notAfter: NOW + 9 * DAY })], NOW)[0]?.severity).toBe('warn');
    expect(certificateProblems([cert({ notAfter: NOW + 2 * DAY })], NOW)[0]?.severity).toBe('error');
    expect(certificateProblems([cert({ notAfter: NOW - DAY })], NOW)[0]?.title).toBe('证书已过期');
  });

  it('只报最紧急的一张', () => {
    const problems = certificateProblems(
      [cert({ id: 'a', notAfter: NOW + 20 * DAY }), cert({ id: 'b', notAfter: NOW + 5 * DAY })],
      NOW,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.evidence?.daysLeft).toBe(5);
  });

  it('相关性：本节点签发或被配置引用', () => {
    const configs = [{ app: 'caddy-site', config: { site: { $cert: 'cert_x' } } }];
    expect(isCertificateRelevant('nd_1', configs, { id: 'cert_x', sourceNodeId: null })).toBe(true);
    expect(isCertificateRelevant('nd_1', configs, { id: 'cert_y', sourceNodeId: null })).toBe(false);
    expect(isCertificateRelevant('nd_1', [], { id: 'cert_z', sourceNodeId: 'nd_1' })).toBe(true);
    expect(
      selectRelevantCertificates('nd_1', configs, [
        cert({ id: 'cert_x', sourceNodeId: null }),
        cert({ id: 'cert_y', sourceNodeId: null }),
      ]).map((item) => item.id),
    ).toEqual(['cert_x']);
  });
});

// ---------------------------------------------------------------------------
// 主机问题（/state.ops → app-diagnostics/host.ts）
// ---------------------------------------------------------------------------

const hostOps = (fields: Record<string, unknown>): AgentOps => agentOpsSchema.parse(fields);
const hostCodes = (fields: Record<string, unknown>): string[] =>
  hostProblems(hostOps(fields), NOW).map((problem) => problem.code);
const oneProblem = (fields: Record<string, unknown>, code: string) => {
  const found = hostProblems(hostOps(fields), NOW).find((problem) => problem.code === code);
  if (!found) throw new Error(`missing host problem ${code}`);
  return found;
};

describe('主机问题：7 类问题由 /state.ops 派生', () => {
  it('disk_full：空间/inode ≥85% warn、≥95% error，低于 85% 不报', () => {
    expect(hostCodes({ disks: [{ name: 'root', path: '/', percent: 84.9 }] })).toEqual([]);
    expect(oneProblem({ disks: [{ name: 'root', path: '/', percent: 85 }] }, 'disk_full').severity).toBe('warn');
    expect(oneProblem({ disks: [{ name: 'root', path: '/', percent: 95 }] }, 'disk_full').severity).toBe('error');
    const inode = oneProblem(
      { disks: [{ name: 'data', path: '/var/lib/khc-agent', percent: 10, inodesPercent: 96 }] },
      'disk_full',
    );
    expect(inode.severity).toBe('error');
    expect(inode.evidence).toMatchObject({ disk: 'data', metric: 'inodes', percent: 96 });
    expect(inode.hint).toContain('主机运维');
  });

  it('memory_low：有 swap 需可用内存 <10% 且 swap >50%；无 swap 时只看 <5%', () => {
    const withSwap = { mem: { total: 1000, available: 50, percent: 95 }, swap: { total: 1000, percent: 60 } };
    expect(oneProblem(withSwap, 'memory_low').severity).toBe('warn');
    expect(oneProblem(withSwap, 'memory_low').evidence).toMatchObject({ hasSwap: true, swapPercent: 60 });
    expect(hostCodes({ ...withSwap, swap: { total: 1000, percent: 50 } })).toEqual([]);
    expect(hostCodes({ ...withSwap, mem: { total: 1000, available: 100, percent: 90 } })).toEqual([]);
    const noSwap = { mem: { total: 1000, available: 40, percent: 96 }, swap: null };
    expect(oneProblem(noSwap, 'memory_low').evidence).toMatchObject({ hasSwap: false, swapPercent: null });
    expect(hostCodes({ ...noSwap, mem: { total: 1000, available: 50, percent: 95 } })).toEqual([]);
    expect(hostCodes({ mem: { total: 1000, available: 40, percent: 96 }, swap: undefined })).toContain('memory_low');
  });

  it('units_failed：过滤受管单元，evidence 只列前 5 个名字', () => {
    expect(
      hostCodes({ services: { failedUnits: ['caddy.service', 'khc-agent.service', 'wg-quick@wg0.service'] } }),
    ).toEqual([]);
    expect(hostCodes({ services: { failedUnits: [] } })).toEqual([]);
    const problem = oneProblem(
      { services: { failedUnits: ['a.service', 'b.service', 'c.service', 'd.service', 'e.service', 'f.service'] } },
      'units_failed',
    );
    expect(problem.severity).toBe('warn');
    expect(problem.evidence).toMatchObject({
      count: 6,
      units: 'a.service, b.service, c.service, d.service, e.service',
    });
    expect(String(problem.evidence?.units)).not.toContain('f.service');
  });

  it('reboot_required：info 且指向主机运维页', () => {
    expect(hostCodes({ rebootRequired: false })).toEqual([]);
    const problem = oneProblem({ rebootRequired: true }, 'reboot_required');
    expect(problem.severity).toBe('info');
    expect(problem.hint).toContain('主机运维');
  });

  it('oom_killed：lastIncreaseAt 在 24h 内才报，0/超时/未来不报', () => {
    expect(oneProblem({ oom: { total: 3, lastIncreaseAt: NOW - 3600 } }, 'oom_killed').severity).toBe('warn');
    expect(oneProblem({ oom: { total: 3, lastIncreaseAt: NOW - 3600 } }, 'oom_killed').evidence).toMatchObject({
      total: 3,
      lastIncreaseAt: NOW - 3600,
    });
    expect(hostCodes({ oom: { total: 3, lastIncreaseAt: 0 } })).toEqual([]);
    expect(hostCodes({ oom: { total: 3, lastIncreaseAt: NOW - DAY - 1 } })).toEqual([]);
    expect(hostCodes({ oom: { total: 3, lastIncreaseAt: NOW + 60 } })).toEqual([]);
  });

  it('fs_readonly：error', () => {
    expect(hostCodes({ rootReadonly: false })).toEqual([]);
    const problem = oneProblem({ rootReadonly: true }, 'fs_readonly');
    expect(problem.severity).toBe('error');
    expect(problem.hint).toContain('主机运维');
  });

  it('memory_pressure：avg60 > 20 才报', () => {
    expect(hostCodes({ memoryPressure: 20 })).toEqual([]);
    expect(hostCodes({ memoryPressure: null })).toEqual([]);
    const problem = oneProblem({ memoryPressure: 25.5 }, 'memory_pressure');
    expect(problem.severity).toBe('warn');
    expect(problem.evidence).toMatchObject({ avg60: 25.5 });
  });

  it('旧 Agent 不上报 ops 新字段时跳过；7 类问题形状合法、无 action', () => {
    expect(hostProblems(null, NOW)).toEqual([]);
    expect(hostProblems(undefined, NOW)).toEqual([]);
    expect(hostProblems(hostOps({}), NOW)).toEqual([]);
    // 旧 Agent 只有原来的 mem/swap/disks/services/rebootRequired，不产生新字段相关告警
    const legacy = hostOps({
      mem: { total: 1000, available: 900, percent: 10 },
      swap: { total: 1000, percent: 0 },
      disks: [{ name: 'root', path: '/', percent: 10, inodesPercent: 1 }],
      services: { failedUnits: [] },
      rebootRequired: false,
    });
    expect(hostProblems(legacy, NOW)).toEqual([]);
    expect('oom' in legacy && 'rootReadonly' in legacy && 'memoryPressure' in legacy).toBe(false);

    const all = hostProblems(
      hostOps({
        disks: [{ name: 'root', path: '/', percent: 96 }],
        mem: { total: 1000, available: 50 },
        swap: { total: 1000, percent: 60 },
        services: { failedUnits: ['demo.service'] },
        rebootRequired: true,
        oom: { total: 2, lastIncreaseAt: NOW - 60 },
        rootReadonly: true,
        memoryPressure: 30,
      }),
      NOW,
    );
    expect(all.map((problem) => problem.code).sort()).toEqual(
      [
        'disk_full',
        'memory_low',
        'units_failed',
        'reboot_required',
        'oom_killed',
        'fs_readonly',
        'memory_pressure',
      ].sort(),
    );
    for (const problem of all) {
      expect(adapterProblemSchema.safeParse(problem).success).toBe(true);
      expect(problem.action).toBeUndefined();
      expect(problem.hint).toContain('主机运维');
    }
  });
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function okState(): Record<string, unknown> {
  const state = baseState();
  state.agent = { version: '0.1.0', serverTime: Math.floor(Date.now() / 1000) };
  return state as unknown as Record<string, unknown>;
}

beforeEach(() => resetRateLimitForTests());

describe('ACME 缺失告警口径（3A）', () => {
  const acmeProblem = {
    code: 'acme_failed',
    severity: 'error',
    title: 'ACME 环境不可用',
    hint: '节点缺少 acme.sh，无法签发或续期 ACME 证书。',
    evidence: { reason: 'env_missing', acme: 'missing', openssl: 'ok' },
  };

  function state(): AgentState {
    return {
      host: { hostname: 'hub' },
      adapters: [
        { name: 'certificates', version: '1.0.0', status: { problems: [acmeProblem] } },
        {
          name: 'wireguard',
          version: '1.0.0',
          status: {
            problems: [{ code: 'interface_down', severity: 'error', title: '接口未运行', hint: '' }],
          },
        },
      ],
      ports: [],
    } as unknown as AgentState;
  }

  const problemsOf = (adjusted: AgentState | null, name: string) =>
    (adjusted?.adapters.find((item) => item.name === name)?.status?.problems ?? []) as Array<
      Record<string, unknown>
    >;

  it('节点没有 ACME 证书时降为 info，并给出安装命令', () => {
    const problems = problemsOf(adjustAcmeProblems(state(), false), 'certificates');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('info');
    expect(problems[0]?.title).toBe('ACME 环境未安装（可选）');
    expect(String(problems[0]?.hint)).toContain('get.acme.sh');
  });

  it('节点存在 ACME 证书时保持 error（续期会失败）', () => {
    const problems = problemsOf(adjustAcmeProblems(state(), true), 'certificates');
    expect(problems[0]?.severity).toBe('error');
  });

  it('不影响其他适配器的问题', () => {
    const problems = problemsOf(adjustAcmeProblems(state(), false), 'wireguard');
    expect(problems[0]?.severity).toBe('error');
  });
});

describe('诊断 API 路由', () => {
  it('hints：未登录 401；登录 200 + 缓存头 + layer 过滤', async () => {
    const ctx = makeTestContext();
    const anon = await ctx.app.request('/api/v1/diagnostics/hints', {}, ctx.env);
    expect(anon.status).toBe(401);

    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request('/api/v1/diagnostics/hints', { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const body = (await res.json()) as { hintsVersion: string; hints: unknown[] };
    expect(diagnosticHintsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.hints).toHaveLength(7);

    const filtered = await ctx.app.request(
      '/api/v1/diagnostics/hints?layer=transport',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const filteredBody = (await filtered.json()) as { hints: Array<{ layer: string }> };
    expect(filteredBody.hints).toHaveLength(2);
    expect(filteredBody.hints.every((hint) => hint.layer === 'transport')).toBe(true);

    const bad = await ctx.app.request(
      '/api/v1/diagnostics/hints?layer=wireguard',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(bad.status).toBe(400);
  });

  it('diagnostics：未登录 401 / 节点不存在 404 / 旧 depth 参数被忽略', async () => {
    const ctx = makeTestContext();
    const anon = await ctx.app.request('/api/v1/nodes/nd_x/diagnostics', {}, ctx.env);
    expect(anon.status).toBe(401);

    const cookie = await loginAsAdmin(ctx);
    const missing = await ctx.app.request(
      '/api/v1/nodes/nd_x/diagnostics',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(missing.status).toBe(404);

    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: okState() });
    const legacy = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics?depth=full`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(legacy.status).toBe(200);
    expect(ctx.agent.requests).toHaveLength(1);
    expect(ctx.agent.requests[0]?.path).toBe('/state');
  });

  it('只调 /state 一次；200 + no-store；不写 D1/audit；无问题为空', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'demo-app', { config: {}, schemaVersion: 1, actor: 'test' });
    await ctx.apps.setAppliedRev(id, 'demo-app', 1);
    ctx.agent.handler = async () => ({ status: 200, body: okState() });
    ctx.audit.entries.length = 0;
    const updateSpy = vi.spyOn(ctx.nodes, 'update');
    const auditSpy = vi.spyOn(ctx.audit, 'log');

    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      reachable: boolean;
      route: string;
      via: string;
      checks: DiagnosticCheck[];
      hintsVersion: string;
      truncated?: boolean;
      summary?: unknown;
    };
    expect(nodeDiagnosticsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.hintsVersion).toBe(hintsVersion);
    expect(body.summary).toBeUndefined();
    expect(body.checks).toEqual([]);
    expect(ctx.agent.requests).toHaveLength(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(ctx.audit.entries).toHaveLength(0);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('适配器 problems 出现在响应里（应用名不被核心引用）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'demo-app', { config: {}, schemaVersion: 1, actor: 'test' });
    await ctx.apps.setAppliedRev(id, 'demo-app', 1);
    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        problems: [
          {
            code: 'unit_failed',
            severity: 'error',
            title: '单元未运行',
            hint: 'demo 服务未运行',
            action: { id: 'app.apply', label: '重新应用' },
          },
        ],
      }),
    ];
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...state } });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await res.json()) as { checks: Array<{ id: string; code: string; app?: string; actions?: unknown[] }> };
    const check = body.checks.find((item) => item.id === 'problem.demo-app.unit_failed');
    expect(check).toMatchObject({ code: 'khc.demo-app.unit_failed', app: 'demo-app' });
    expect(check?.actions).toHaveLength(1);
  });

  it('节点不可达：200 + reachable:false，且 ≤4s', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达（直连与隧道均失败）', {
        direct: 'TCP 连接超时（>3000ms）',
        tunnel: 'HTTP 530',
      });
    };
    const started = Date.now();
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(Date.now() - started).toBeLessThanOrEqual(4000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reachable: boolean;
      route: unknown;
      durationMs: number;
      checks: DiagnosticCheck[];
    };
    expect(body.reachable).toBe(false);
    expect(body.route).toBeNull();
    const codes = body.checks.map((check) => check.code);
    expect(codes).toContain('khc.transport.unreachable');
    expect(codes).toContain('khc.agent.offline');
    expect(nodeDiagnosticsResponseSchema.safeParse(body).success).toBe(true);
  });

  it('/state 结构不合法 → reachable:true + agent.state_invalid', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, foo: 'bar' } });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; checks: DiagnosticCheck[] };
    expect(body.reachable).toBe(true);
    expect(findCheck(body.checks, 'agent.state_schema').code).toBe('khc.agent.state_invalid');
  });

  it('证书相关：D1 证书合并为 certificates.expiring', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.certs.create({
      name: 'site',
      domains: ['site.test'],
      issuer: 'acme',
      notAfter: Math.floor(Date.now() / 1000) + 5 * DAY,
      certPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----',
      sourceNodeId: id,
    });
    ctx.agent.handler = async () => ({ status: 200, body: okState() });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await res.json()) as { checks: DiagnosticCheck[] };
    const expiry = body.checks.find((check) => check.id === 'problem.certificates.expiring');
    expect(expiry?.severity).toBe('warn');
    expect(expiry?.app).toBe('certificates');
    expect(expiry?.evidence?.domain).toBe('site.test');
  });

  it('安全：响应不含凭据/PEM，detail/evidence 有界', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id, token } = await createNode(ctx, cookie);
    const state = baseState();
    state.adapters = [
      adapterState('demo-app', {
        problems: [
          {
            code: 'leak',
            severity: 'error',
            title: 'x',
            hint: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
            evidence: { message: 'Bearer abc.def token=supersecret' },
          },
        ],
      }),
    ];
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...okState() } });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('Bearer abc.def');
    expect(raw).not.toContain('supersecret');
    const body = JSON.parse(raw) as { checks: DiagnosticCheck[] };
    for (const check of body.checks) {
      expect(check.detail.length).toBeLessThanOrEqual(300);
      for (const value of Object.values(check.evidence ?? {})) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('主机问题经路由渲染为 khc.host.*，响应 ≤64KB 且无 action', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'demo-app', { config: {}, schemaVersion: 1, actor: 'test' });
    await ctx.apps.setAppliedRev(id, 'demo-app', 1);
    const now = Math.floor(Date.now() / 1000);
    const state = okState();
    state.ops = {
      disks: [{ name: 'root', path: '/', percent: 96, inodesPercent: 97 }],
      mem: { total: 1000, available: 50, percent: 95 },
      swap: { total: 1000, percent: 60 },
      services: { failedUnits: ['demo.service', 'other.service'] },
      rebootRequired: true,
      oom: { total: 2, lastIncreaseAt: now - 60 },
      rootReadonly: true,
      memoryPressure: 30,
    };
    ctx.agent.handler = async () => ({ status: 200, body: state });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(64 * 1024);
    const body = JSON.parse(raw) as { checks: DiagnosticCheck[] };
    expect(nodeDiagnosticsResponseSchema.safeParse(body).success).toBe(true);
    const hostChecks = body.checks.filter((check) => check.app === 'host');
    expect(hostChecks.map((check) => check.code).sort()).toEqual(
      [
        'khc.host.disk_full',
        'khc.host.memory_low',
        'khc.host.units_failed',
        'khc.host.reboot_required',
        'khc.host.oom_killed',
        'khc.host.fs_readonly',
        'khc.host.memory_pressure',
      ].sort(),
    );
    for (const check of hostChecks) {
      expect(check.actions ?? []).toEqual([]);
      expect(check.detail).toContain('主机运维');
      expect(check.detail.length).toBeLessThanOrEqual(300);
      for (const value of Object.values(check.evidence ?? {})) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200);
      }
    }
    expect(ctx.agent.requests).toHaveLength(1);
  });

  it('大量问题仍受 30 条截断与 64KB 上限约束', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'demo-app', { config: {}, schemaVersion: 1, actor: 'test' });
    await ctx.apps.setAppliedRev(id, 'demo-app', 1);
    const state = okState();
    state.ops = {
      disks: [{ name: 'root', path: '/', percent: 96 }],
      services: { failedUnits: Array.from({ length: 50 }, (_, i) => `unit-${i}.service`) },
      rootReadonly: true,
    };
    state.adapters = [
      {
        name: 'demo-app',
        version: '1.0.0',
        status: {
          problems: Array.from({ length: 40 }, (_, i) => ({
            code: `noisy_${i}`,
            severity: 'error',
            title: '噪声问题',
            hint: 'x'.repeat(400),
            evidence: { blob: 'y'.repeat(150) },
          })),
        },
      },
    ];
    ctx.agent.handler = async () => ({ status: 200, body: state });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(64 * 1024);
    const body = JSON.parse(raw) as { checks: DiagnosticCheck[]; truncated?: boolean };
    expect(nodeDiagnosticsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.checks.length).toBeLessThanOrEqual(30);
    expect(body.truncated).toBe(true);
    for (const check of body.checks) {
      expect(check.detail.length).toBeLessThanOrEqual(300);
      for (const value of Object.values(check.evidence ?? {})) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('MASTER_ENC_KEY 缺失 → 503（不误报节点不可达）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    (ctx.env as unknown as { MASTER_ENC_KEY?: string }).MASTER_ENC_KEY = undefined;
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(503);
    expect(ctx.agent.requests).toHaveLength(0);
  });
});
