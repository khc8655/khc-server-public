/**
 * 核心诊断知识库：只保留连接与 Agent 的 7 个码（#49）。
 *
 * 应用相关问题由适配器自己的 `status().problems` 提供，核心不维护应用文案，
 * 也不认识任何应用名。这里是纯数据，随 Worker 版本发布；改码/改文案时递增
 * `hintsVersion`。
 *
 * `fix.mode=action` 只允许确定安全的三个动作（重新 apply / 重启服务 / 取消换钥）；
 * 其余一律给文字建议。只读命令仅展示/复制，Worker 永不执行。
 */
import type {
  DiagnosticHint,
  DiagnosticHintCheck,
  DiagnosticHintFix,
  DiagnosticLayer,
} from '@khc/contracts';

/** 知识库版本：新增码/改文案时递增尾部序号。 */
export const hintsVersion = '2026-10-29.1';

/**
 * 诊断允许引用的一键修复动作（白名单）。
 * 与 docs/diagnostics.md §5 及 apps/web/src/registry/actions.ts 对齐；
 * Worker 不能直接 import 前端注册表（bundle 边界），因此在此显式登记并由测试校验。
 */
export const HINT_FIX_ACTION_IDS = {
  'app.apply': 'L2',
} as const satisfies Record<string, 'L1' | 'L2' | 'L3'>;

export type HintFixActionId = keyof typeof HINT_FIX_ACTION_IDS;

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

const manual = (label: string, route?: string): DiagnosticHintFix => ({
  mode: 'manual',
  label,
  ...(route ? { route } : {}),
});

const action = (label: string, actionId: HintFixActionId): DiagnosticHintFix => ({
  mode: 'action',
  label,
  actionId,
  level: HINT_FIX_ACTION_IDS[actionId],
});

const check = (text: string, command?: string): DiagnosticHintCheck => ({
  text,
  kind: 'manual',
  ...(command ? { command } : {}),
});

interface HintInput {
  code: string;
  layer: DiagnosticLayer;
  severity: 'info' | 'warn' | 'error';
  title: string;
  summary: string;
  impact: string;
  aliases: string[];
  causes: string[];
  checks: DiagnosticHintCheck[];
  fixes: DiagnosticHintFix[];
  doc: string;
}

function hint(input: HintInput): DiagnosticHint {
  const readOnly = input.fixes.length === 0 || input.fixes.every((fix) => fix.mode === 'manual');
  return { ...input, readOnly };
}

// ---------------------------------------------------------------------------
// 连接 / 传输（3）
// ---------------------------------------------------------------------------

const transportHints: DiagnosticHint[] = [
  hint({
    code: 'khc.transport.unreachable',
    layer: 'transport',
    severity: 'error',
    title: '节点不可达',
    summary: '直连与隧道两条路都失败，或响应不是合法 Agent 响应。',
    impact: '节点状态与全部远程操作不可用。',
    aliases: ['unreachable', 'timeout', 'tls', 'bad_response', '1003', '522', '524', '530'],
    causes: ['网络/安全组阻断', 'Agent 未运行或假死', 'endpoint 与 tunnel_endpoint 都配置错误', '端口被其它服务占用'],
    checks: [
      check('确认 Agent 服务', 'systemctl status khc-agent --no-pager'),
      check('确认 8880 监听', 'ss -lntp'),
      check('本机探活', 'curl -sS --max-time 3 http://127.0.0.1:8880/health'),
    ],
    fixes: [manual('人工排查网络与 Agent')],
    doc: 'docs/diagnostics.md §3.1',
  }),
  hint({
    code: 'khc.transport.auth_401',
    layer: 'transport',
    severity: 'error',
    title: 'Agent 拒绝签名',
    summary: 'HMAC 校验失败：节点凭证不同步、时钟偏差或 nonce 重放。',
    impact: '控制通道不可用；错误日志可能持续出现。',
    aliases: ['401', 'unauthorized', 'timestamp_out_of_window', 'nonce_replayed'],
    causes: ['节点凭证与控制面不一致', '节点时钟偏差超过 60 秒', 'nonce 在 120 秒内重复', '中间代理改写了请求体'],
    checks: [
      check('对比节点与控制面时间', 'timedatectl status'),
      check('确认最近是否执行过凭证轮换或重装 Agent'),
    ],
    fixes: [manual('校时'), manual('重新接入节点', '/hubs/:hubId/settings')],
    doc: 'docs/diagnostics.md §3.1',
  }),
  hint({
    code: 'khc.agent.clock_skew',
    layer: 'agent',
    severity: 'warn',
    title: '节点时钟偏差',
    summary: '节点与控制面时间偏差超过 60 秒，会触发 401。',
    impact: 'HMAC 时间窗校验失败，控制通道可能不可用。',
    aliases: ['clock_skew', 'timestamp_out_of_window', 'serverTime'],
    causes: ['节点未启用 NTP', '虚拟机暂停/迁移后时间漂移'],
    checks: [check('检查 NTP 状态', 'timedatectl status'), check('对比节点与控制面 UTC 时间', 'date -u')],
    fixes: [manual('启用 NTP 校时')],
    doc: 'docs/diagnostics.md §3.2',
  }),
];

// ---------------------------------------------------------------------------
// Agent / 配置（4）
// ---------------------------------------------------------------------------

const agentHints: DiagnosticHint[] = [
  hint({
    code: 'khc.agent.offline',
    layer: 'agent',
    severity: 'warn',
    title: '节点离线',
    summary: '控制通道不可用；超过 10 分钟升级为 error。',
    impact: '无法获取实时状态，也不能执行修复动作。',
    aliases: ['offline', 'last_seen_at'],
    causes: ['公网/隧道链路中断', 'Agent 进程退出', '安全组或防火墙变化'],
    checks: [check('确认 Agent 服务', 'systemctl status khc-agent --no-pager'), check('确认端口监听', 'ss -lntp')],
    fixes: [manual('人工恢复网络/服务')],
    doc: 'docs/diagnostics.md §3.2',
  }),
  hint({
    code: 'khc.agent.version_unsupported',
    layer: 'agent',
    severity: 'warn',
    title: 'Agent 版本不兼容',
    summary: 'Agent 未上报可识别的版本，无法确认与当前契约兼容。',
    impact: '部分应用可能无法 plan/apply；升级源显示需要更新。',
    aliases: ['version_unsupported', 'version', 'unsupported'],
    causes: ['Agent 版本过旧', '升级中断', '响应被中间代理改写'],
    checks: [check('确认 Agent 版本', 'curl -sS http://127.0.0.1:8880/health')],
    fixes: [manual('在节点设置页升级 Agent', '/hubs/:hubId/settings')],
    doc: 'docs/diagnostics.md §3.2',
  }),
  hint({
    code: 'khc.agent.state_invalid',
    layer: 'agent',
    severity: 'error',
    title: 'Agent 状态不一致',
    summary: '/state 不符合当前契约，或控制面配置的应用在节点上没有适配器。',
    impact: '节点状态无法解析，诊断与页面数据不完整。',
    aliases: ['state_invalid', 'schema', 'adapter_missing'],
    causes: ['Agent 版本过旧或过新', '适配器未安装/加载失败', '反向代理改写了响应'],
    checks: [check('确认 Agent 版本与适配器清单', 'curl -sS http://127.0.0.1:8880/adapters')],
    fixes: [action('重新应用', 'app.apply'), manual('升级或重装 Agent')],
    doc: 'docs/diagnostics.md §3.2',
  }),
  hint({
    code: 'khc.config.pending_apply',
    layer: 'config',
    severity: 'info',
    title: '配置待生效',
    summary: '已保存新配置，但节点还没有确认应用；超过 10 分钟升级为 warn。',
    impact: '节点仍按旧配置运行。',
    aliases: ['pending_apply', 'stuck_pending', 'rev', 'appliedRev'],
    causes: ['保存后未点应用', '上次 apply 正在进行', 'apply 失败'],
    checks: [check('对比 rev 与 appliedRev'), check('确认没有运行中的任务')],
    fixes: [action('重新应用', 'app.apply')],
    doc: 'docs/diagnostics.md §3.3',
  }),
];

// ---------------------------------------------------------------------------
// 汇总导出
// ---------------------------------------------------------------------------

export const diagnosticHints: DiagnosticHint[] = [...transportHints, ...agentHints];

/** code -> Hint 索引，供路由/映射复用。 */
export const hintByCode: ReadonlyMap<string, DiagnosticHint> = new Map(
  diagnosticHints.map((item) => [item.code, item] as const),
);

export const HINT_CODES: readonly string[] = diagnosticHints.map((item) => item.code);

export function getHint(code: string): DiagnosticHint | undefined {
  return hintByCode.get(code);
}
