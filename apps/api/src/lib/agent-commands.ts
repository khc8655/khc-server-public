/**
 * C5：Agent 生命周期命令生成（docs/agent-lifecycle.md）。
 *
 * **纯函数，不执行任何命令、不访问网络/文件系统。** 只把（已校验的）packageUrl/sha256
 * 与节点 token 拼成主人在目标 VM 上粘贴执行的 shell。
 *
 * 安全约定：
 * - 所有插值都经过 {@link shellQuote}（POSIX 单引号转义），token/URL/sha 不直接拼进 shell；
 * - token 只出现在返回值里，调用方不得写日志/审计；
 * - 命令使用 `curl` 下载 + `sha256sum -c` 校验后再解包执行包内脚本；
 * - system 模式需 sudo；user 模式全部在用户态（token 写 `$HOME/.config/khc-agent`）。
 */

import type { AgentCommandMode, AgentInstallOptions } from '@khc/contracts';

export const AGENT_DEFAULT_HOST = '0.0.0.0';
export const AGENT_DEFAULT_PORT = 8880;

/** system 模式 token 路径（与 agent/install.sh 一致）。 */
export const SYSTEM_TOKEN_DIR = '/etc/khc-agent';
export const SYSTEM_TOKEN_FILE = '/etc/khc-agent/token';
/** user 模式 token 路径（与 agent/install.sh 一致；`~` 在 shell 里自动展开）。 */
export const USER_TOKEN_DIR = '~/.config/khc-agent';
export const USER_TOKEN_FILE = '~/.config/khc-agent/token';

const SAFE_HOST_RE = /^[A-Za-z0-9.:[\]_-]+$/;

export interface AgentCommandOptions {
  mode: AgentCommandMode;
  packageUrl: string;
  /** 64 位 hex（小写；调用方已校验） */
  sha256: string;
  /** Agent 监听地址，默认 0.0.0.0 */
  host?: string;
  /** Agent 监听端口，默认 8880 */
  port?: number;
  /** P0-1：安装命令可选组件（--with-caddy / --tls / --tls-cn；与 agent/install.sh 参数对齐） */
  install?: AgentInstallOptions;
  /** A-4：观测层 Origin allowlist（面板域名），渲染进 systemd unit 的 KHC_LIVE_ORIGINS */
  liveOrigins?: string[];
  /** A-4：观测层票据绑定的节点 ID，渲染进 unit 的 KHC_NODE_ID */
  nodeId?: string;
  /**
   * 节点入口协议（来自 node.endpoint）：
   * - `https`：安装命令带 `--tls-cert/--tls-key`（acme.sh 约定路径）；升级命令不带，靠 install.sh 沿用 unit 里的证书路径；
   * - `http`：明文入口，命令显式带 `--insecure-http`（install.sh 默认拒绝非回环明文监听）；
   * - 未传：不追加传输参数（纯函数调用方自行负责）。
   */
  endpointScheme?: 'http' | 'https';
  /**
   * 节点 endpoint 的 hostname（来自 node.endpoint）。仅用于 https 安装命令的
   * 证书前置提示：裸 IP 无法签发公网可信证书，提前阻断并给出域名 / Tunnel 两条路。
   */
  endpointHost?: string;
  /**
   * PR1：Cloudflare Tunnel 模式的 cloudflared token。
   * 提供时安装命令会在最前面注册隧道服务（Agent 只监听回环，endpointScheme=http）。
   */
  tunnelToken?: string;
}

/**
 * 控制通道证书的约定路径（与 docs/runbook/node-onboarding.md §4.1 的 acme.sh --install-cert 一致）。
 * user 模式的 `~` 不加引号，交给 shell 展开成绝对路径（install.sh 只接受绝对路径）。
 */
export const SYSTEM_TLS_CERT = '/etc/khc-agent/tls/fullchain.pem';
export const SYSTEM_TLS_KEY = '/etc/khc-agent/tls/key.pem';
export const USER_TLS_CERT = '~/.config/khc-agent/tls/fullchain.pem';
export const USER_TLS_KEY = '~/.config/khc-agent/tls/key.pem';

/** 可用于 ACME 自动签发的域名：仅系统模式、且不是裸 IP（公网 CA 不给 IP 签发）。 */
function acmeDomain(options: AgentCommandOptions): string | null {
  const host = options.endpointHost?.trim() ?? '';
  if (!host || isIpLiteralHost(host)) return null;
  return options.mode === 'system' ? host : null;
}

/** 传输参数：https 入口 → ACME 自动签发 + 可信证书路径；http 入口 → 显式声明明文（仅测试）。 */
function transportFlags(options: AgentCommandOptions, kind: 'install' | 'upgrade'): string[] {
  if (options.endpointScheme === 'http') return ['--insecure-http'];
  if (options.endpointScheme === 'https' && kind === 'install') {
    const paths =
      options.mode === 'system'
        ? ['--tls-cert', SYSTEM_TLS_CERT, '--tls-key', SYSTEM_TLS_KEY]
        : ['--tls-cert', USER_TLS_CERT, '--tls-key', USER_TLS_KEY];
    const acme = acmeDomain(options);
    return [...(acme ? ['--acme', shellQuote(acme)] : []), ...paths];
  }
  return [];
}

/** A-4：观测层参数 → install.sh flags；Origin/ID 都过 shellQuote，不直接拼 shell。 */
function liveFlags(options: { liveOrigins?: string[]; nodeId?: string }): string[] {
  const flags: string[] = [];
  if (options.liveOrigins?.length) {
    flags.push('--live-origins', shellQuote(options.liveOrigins.join(',')));
  }
  if (options.nodeId) {
    flags.push('--node-id', shellQuote(options.nodeId));
  }
  return flags;
}

/** P0-1：把安装选项拼成 install.sh 的额外 flags（CN 已被契约 regex 校验，无空白/引号，可直接插值）。 */
function installExtraFlags(install: AgentInstallOptions | undefined): string[] {
  if (!install) return [];
  const flags: string[] = [];
  if (install.withCaddy) flags.push('--with-caddy');
  // --tls-cn 只对自签证书生效：install.sh 在非 --tls 分支会明确警告并忽略，这里不再下发。
  if (install.tls) {
    flags.push('--tls');
    if (install.tlsCn) flags.push('--tls-cn', install.tlsCn);
  }
  return flags;
}

/** 裸 IP 字面量（含 IPv6 方括号）：公网 CA 不签发 IP 证书，Cloudflare 也不接受自签。 */
export function isIpLiteralHost(host: string): boolean {
  const value = host.trim();
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ||
    value.startsWith('[') ||
    value.includes(':')
  );
}

/**
 * HTTPS 安装命令的证书前置检查：在提示粘贴 token **之前**执行。
 *
 * 背景（2026-11-07 真机）：面板把「同时安装 Caddy」理解为会替 Agent 申请证书，
 * 但 install.sh 只安装 caddy 软件包、不会写 `/etc/khc-agent/tls/`；旧命令先读 token、
 * 再在 install.sh 里报「证书文件不存在」，用户粘贴的 token 白费且失败点在最末尾。
 * 这里把校验提前，并在失败时给出可直接复制的 acme.sh 命令。
 */
function tlsPreflightLines(
  options: AgentCommandOptions,
  certPath: string,
  keyPath: string,
): string[] {
  if (options.endpointScheme !== 'https') return [];
  const system = options.mode === 'system';
  const host = options.endpointHost?.trim() ?? '';
  const ipOnly = isIpLiteralHost(host);
  if (system && !ipOnly && host) {
    // 一键签发：install.sh 会自动用 acme.sh 申请证书（ALPN 走 443），不再要求主人预置证书。
    return [
      `# 证书：缺失时自动用 ACME 签发（TLS-ALPN-01 走 443，失败回退 HTTP-01 走 80），无需手动准备（域名 ${host}）。`,
    ];
  }
  const hostLabel = host && !ipOnly ? host : '<证书域名>';
  const installDir = system ? '/etc/khc-agent/tls' : '~/.config/khc-agent/tls';
  const sudo = system ? 'sudo ' : '';
  const reloadCmd = system ? 'systemctl reload khc-agent' : 'systemctl --user reload khc-agent';
  const shellCert = system ? certPath : `"$HOME/${certPath.replace(/^~\//, '')}"`;
  const shellKey = system ? keyPath : `"$HOME/${keyPath.replace(/^~\//, '')}"`;
  const hint = ipOnly
    ? [
        '[khc-agent] ERROR: 节点入口是裸 IP 的 HTTPS，无法完成可信证书校验；安装已中止（未写入节点 token）。',
        '',
        '公网 CA 不为裸 IP 签发证书，Cloudflare 传输层也不接受自签证书（fetch 与 TCP 都强制校验证书）。',
        '请任选其一后重新生成安装命令：',
        '  A. 给本机绑定域名（推荐）：把域名 A/AAAA 记录指向本机，在面板把节点 endpoint 改成 https://<域名>:<端口>；',
        '  B. 改用 Cloudflare Tunnel（方案 B）：Agent 监听 127.0.0.1，节点用隧道域名，Worker 面对 Cloudflare 的可信证书。',
        '本命令不会降级为自签或明文 HTTP。',
      ]
    : [
        '[khc-agent] ERROR: 缺少可信 TLS 证书，安装已中止（未写入节点 token）。',
        '',
        '节点入口是 HTTPS，Agent 启动前必须在固定路径读到证书：',
        `  证书  ${installDir}/fullchain.pem`,
        `  私钥  ${installDir}/key.pem`,
        '',
        '「同时安装 Caddy」只安装软件包，不会替 Agent 申请或写入证书。',
        '请先签发并安装证书（二选一），然后重新执行本命令：',
        '',
        '① DNS-01（推荐；不需要开放 80 端口，以 Cloudflare 为例）',
        '  curl https://get.acme.sh | sh -s email=you@example.com',
        "  export CF_Token='<Cloudflare API Token>'",
        `  ~/.acme.sh/acme.sh --issue --dns dns_cf -d ${hostLabel}`,
        `  ${sudo}install -d -m 0750 ${installDir}`,
        `  ${sudo}~/.acme.sh/acme.sh --install-cert -d ${hostLabel} \\`,
        `    --key-file ${installDir}/key.pem \\`,
        `    --fullchain-file ${installDir}/fullchain.pem \\`,
        `    --reloadcmd "${reloadCmd}"`,
        '',
        `② HTTP-01（需要 ${hostLabel} 已解析到本机且 80 端口可入站）`,
        `  ${sudo}systemctl stop caddy 2>/dev/null || true`,
        '  curl https://get.acme.sh | sh -s email=you@example.com',
        `  ~/.acme.sh/acme.sh --issue -d ${hostLabel} --standalone`,
        `  ${sudo}install -d -m 0750 ${installDir}`,
        `  ${sudo}~/.acme.sh/acme.sh --install-cert -d ${hostLabel} \\`,
        `    --key-file ${installDir}/key.pem \\`,
        `    --fullchain-file ${installDir}/fullchain.pem \\`,
        `    --reloadcmd "${reloadCmd}"`,
        '',
        '完成后可先执行 ./install.sh --check 复核，再重新粘贴本命令。',
      ];
  return [
    '# 前置：HTTPS 直连必须有可信证书；缺失时在提示 token 前直接失败（不写入 token）。',
    `cert=${shellCert}`,
    `key=${shellKey}`,
    'if [ ! -s "$cert" ] || [ ! -s "$key" ]; then',
    "  cat >&2 <<'KHC_TLS_HINT'",
    ...hint,
    'KHC_TLS_HINT',
    '  exit 1',
    'fi',
  ];
}

export interface AgentUninstallCommandOptions {
  mode: AgentCommandMode;
  packageUrl: string;
  sha256: string;
  purge?: boolean;
}

/** POSIX 单引号转义：' -> '\'' ，结果可安全作为 shell 的单个 token。 */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandHostPort(options: { host?: string; port?: number }): { host: string; port: number } {
  const host = options.host ?? AGENT_DEFAULT_HOST;
  if (!SAFE_HOST_RE.test(host)) throw new Error(`非法监听地址: ${host}`);
  const port = options.port ?? AGENT_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`非法监听端口: ${port}`);
  return { host, port };
}

/** 下载 -> 校验 -> 解包（与 docs/agent-lifecycle.md §3 模板一致）。 */
function downloadAndVerify(packageUrl: string, sha256: string): string[] {
  return [
    'set -euo pipefail',
    '# 避免含 token 的命令写入 shell history（对支持的 shell 生效）。',
    'unset HISTFILE',
    'tmp="$(mktemp -d)"',
    `trap 'rm -rf "$tmp"' EXIT`,
    `curl -fsSL ${shellQuote(packageUrl)} -o "$tmp/agent.tgz"`,
    `printf '%s  %s\\n' ${shellQuote(sha256)} "$tmp/agent.tgz" | sha256sum -c -`,
    'tar -xzf "$tmp/agent.tgz" -C "$tmp"',
  ];
}

/** 把 Worker 里的节点 token 写成 Agent 期望的 token 文件（先建目录、0600 落盘）。 */
function readTokenFromStdin(mode: AgentCommandMode): string[] {
  // 长期 token 不写进命令文本（避免 shell history/剪贴板）；由 UI 单独展示，粘贴时 read -s 不回显。
  const dir = mode === 'system' ? SYSTEM_TOKEN_DIR : USER_TOKEN_DIR;
  const file = mode === 'system' ? SYSTEM_TOKEN_FILE : USER_TOKEN_FILE;
  const prefix = mode === 'system' ? 'sudo ' : '';
  return [
    `printf '粘贴节点 token（输入不回显）: ' >&2`,
    // 强制从终端读，避免粘贴的多行命令把下一行当成 token；/dev/tty 不依赖 stdin 来源。
    'IFS= read -rs KHC_TOKEN </dev/tty',
    'printf "\\n" >&2',
    `${prefix}install -d -m 0750 ${dir}`,
    `printf '%s\\n' "$KHC_TOKEN" | ${prefix}install -m 0600 /dev/stdin ${file}`,
    'unset KHC_TOKEN',
  ];
}

function modeFlags(mode: AgentCommandMode, extra: string[] = []): string {
  return [mode === 'system' ? '--system' : '--user', ...extra].join(' ');
}

/** 整段包进子 shell：失败只退出子 shell，不关 SSH；trap 在结束即清理。 */
function wrapSubshell(lines: string[]): string {
  return ['(', ...lines, ')'].join('\n') + '\n';
}

/** Tunnel 模式：先注册 cloudflared 服务，再装 Agent（Agent 只监听 127.0.0.1）。 */
function cloudflaredSetupLines(token: string): string[] {
  return [
    '# 1) 注册 Cloudflare Tunnel（Token 只在本机命令中出现；cloudflared 必须是已安装状态）',
    'if ! command -v cloudflared >/dev/null 2>&1; then',
    "  echo '[khc-agent] 未找到 cloudflared，请先安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' >&2",
    '  exit 1',
    'fi',
    `sudo cloudflared service install ${shellQuote(token)}`,
    '# 2) Cloudflare 回源到 127.0.0.1，Agent 不再暴露公网端口',
  ];
}

/** 安装命令：证书/环境前置检查 -> 写 token -> 执行包内 install.sh。 */
export function buildAgentInstallCommand(options: AgentCommandOptions): string {
  const { host, port } = commandHostPort(options);
  const extra = [
    ...installExtraFlags(options.install),
    ...transportFlags(options, 'install'),
    ...liveFlags(options),
  ];
  const tlsPaths =
    options.endpointScheme === 'https'
      ? options.mode === 'system'
        ? { cert: SYSTEM_TLS_CERT, key: SYSTEM_TLS_KEY }
        : { cert: USER_TLS_CERT, key: USER_TLS_KEY }
      : null;
  const modeFlag = modeFlags(options.mode, ['--check', ...extra]);
  const lines = [
    ...(options.tunnelToken ? cloudflaredSetupLines(options.tunnelToken) : []),
    ...downloadAndVerify(options.packageUrl, options.sha256),
    'cd "$tmp"/khc-agent-*',
    // 先校验证书：缺失时立即失败并给出签发命令，不消耗用户粘贴的 token。
    ...(tlsPaths ? tlsPreflightLines(options, tlsPaths.cert, tlsPaths.key) : []),
    // 环境前置检查（root/python/systemd/端口）：不写系统、不消耗 token。
    options.mode === 'system'
      ? `sudo ./install.sh ${modeFlag} --host ${host} --port ${port}`
      : `./install.sh ${modeFlag} --host ${host} --port ${port}`,
    ...readTokenFromStdin(options.mode),
    options.mode === 'system'
      ? `sudo ./install.sh ${modeFlags('system', extra)} --host ${host} --port ${port}`
      : `./install.sh ${modeFlags('user', extra)} --host ${host} --port ${port}`,
  ];
  return wrapSubshell(lines);
}

/** 升级命令：同安装（写 token + 覆盖程序），`--no-start` 后显式重启服务。 */
export function buildAgentUpgradeCommand(options: AgentCommandOptions): string {
  const { host, port } = commandHostPort(options);
  // A-4：升级同样重渲染 unit——观测层 allowlist 必须随命令带上，否则重装后丢失
  //（Agent 拉取式自升级只补沙箱行、不重渲染 unit，不受影响）。
  // https 节点不传证书路径：install.sh 从现有 unit 沿用，避免覆盖用户自定义的证书位置。
  const extra = [...transportFlags(options, 'upgrade'), ...liveFlags(options)];
  const lines = [
    ...downloadAndVerify(options.packageUrl, options.sha256),
    // 升级不需要重写 token：它已存在；也不再让长期 token 出现在升级命令里。
    'cd "$tmp"/khc-agent-*',
    options.mode === 'system'
      ? `sudo ./install.sh ${modeFlags('system', ['--no-start', ...extra])} --host ${host} --port ${port}`
      : `./install.sh ${modeFlags('user', ['--no-start', ...extra])} --host ${host} --port ${port}`,
    options.mode === 'system' ? 'sudo systemctl restart khc-agent' : 'systemctl --user restart khc-agent',
  ];
  return wrapSubshell(lines);
}

/** 卸载命令：下载/校验/解包后执行包内 uninstall.sh（可选 --purge）。 */
export function buildAgentUninstallCommand(options: AgentUninstallCommandOptions): string {
  const purge = options.purge === true;
  const flags = [purge ? '--purge' : null, options.mode === 'system' ? '--system' : '--user'].filter(
    (item): item is string => item !== null,
  );
  const lines = [
    ...downloadAndVerify(options.packageUrl, options.sha256),
    'cd "$tmp"/khc-agent-*',
    options.mode === 'system' ? `sudo ./uninstall.sh ${flags.join(' ')}` : `./uninstall.sh ${flags.join(' ')}`,
  ];
  return wrapSubshell(lines);
}

/** 简短别名（同一实现；路由/测试可按 install/upgrade/uninstall 语义导入）。 */
export const buildInstallCommand = buildAgentInstallCommand;
export const buildUpgradeCommand = buildAgentUpgradeCommand;
export const buildUninstallCommand = buildAgentUninstallCommand;
