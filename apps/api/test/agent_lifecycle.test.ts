import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentCommandRequestSchema,
  agentCommandResponseSchema,
  agentUninstallCommandRequestSchema,
  agentUpgradeRequestSchema,
  agentUpgradeResponseSchema,
} from '@khc/contracts';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import {
  AGENT_DEFAULT_HOST,
  SYSTEM_TLS_CERT,
  SYSTEM_TLS_KEY,
  USER_TLS_CERT,
  USER_TLS_KEY,
  buildAgentInstallCommand,
  buildAgentUninstallCommand,
  buildAgentUpgradeCommand,
  shellQuote,
} from '../src/lib/agent-commands';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const PACKAGE_URL = 'https://downloads.example.com/khc-agent/khc-agent-0.1.0.tar.gz';
const SHA256 = 'a'.repeat(64);
const SHA256_UPPER = 'A'.repeat(64);

/** 固定 Ed25519 测试清单：签名对象为 manifestPayload 的 canonical JSON，勿改字段值。 */
const manifestPayload = {
  version: 1,
  generatedAt: 1793091106,
  releases: [
    {
      version: '0.1.0',
      url: 'https://releases.example.com/agent/khc-agent-0.1.0.tar.gz',
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  ],
};
const manifestSignature =
  'JqU2aZWxLfaLoMOJcYKudxptHKMJb6PbAG3HeHwSBl5Rd6dx2rx7VbKLSGdBzsHYYHs3DrbcWNdsz4DpT1zxAw==';
const manifestPubkey = 'jDLCFXgGGib1BGypjdthOWc2nYrVdEkSagptdvBRIAc=';

beforeEach(() => resetRateLimitForTests());

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

/**
 * 通过 Node 的 child_process 跑 bash（只做语法检查 / printf 回读，不执行生成命令）。
 * 本包 devDependencies 没有 @types/node（本任务 scope 不允许改 package.json），
 * 因此用非字面量 specifier 动态导入，并用本地类型描述用到的部分。
 */
async function runBash(args: string[], input?: string): Promise<SpawnResult> {
  const specifier = ['node', 'child_process'].join(':');
  const childProcess = (await import(specifier)) as {
    spawnSync: (
      command: string,
      args: string[],
      options: { input?: string; encoding: 'utf8' },
    ) => SpawnResult;
  };
  return childProcess.spawnSync('bash', args, { input, encoding: 'utf8' });
}

/** 在测试里用真实 bash 做语法检查（不执行命令本身）。 */
async function assertBashSyntax(command: string): Promise<void> {
  const result = await runBash(['-n'], command);
  expect(result.error, `bash 不可用: ${String(result.error)}`).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

/** 用 bash 解析单个 token（只 printf，不执行 token 内容）。 */
async function bashPrint(value: string): Promise<string> {
  const result = await runBash(['-c', `printf '%s' ${value}`]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

async function setup() {
  const ctx = makeTestContext();
  const cookie = await loginAsAdmin(ctx);
  const node = await createNode(ctx, cookie);
  return { ctx, cookie, node };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function post(ctx: Setup['ctx'], cookie: string, path: string, payload: unknown) {
  return ctx.app.request(
    path,
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

function installPath(nodeId: string): string {
  return `/api/v1/nodes/${nodeId}/agent/install-command`;
}
function upgradePath(nodeId: string): string {
  return `/api/v1/nodes/${nodeId}/agent/upgrade-command`;
}
function uninstallPath(nodeId: string): string {
  return `/api/v1/nodes/${nodeId}/agent/uninstall-command`;
}

async function generateCommand(
  setupValue: Setup,
  kind: 'install' | 'upgrade' | 'uninstall',
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path =
    kind === 'install'
      ? installPath(setupValue.node.id)
      : kind === 'upgrade'
        ? upgradePath(setupValue.node.id)
        : uninstallPath(setupValue.node.id);
  const res = await post(setupValue.ctx, setupValue.cookie, path, payload);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 命令模板：install / upgrade / uninstall × system / user
// ---------------------------------------------------------------------------

describe('install-command', () => {
  it('system 模式：下载校验 + 写 token + sudo install.sh --system', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256_UPPER,
    });
    expect(status).toBe(200);
    const parsed = agentCommandResponseSchema.parse(body);
    expect(parsed.mode).toBe('system');
    expect(parsed.packageUrl).toBe(PACKAGE_URL);
    expect(parsed.sha256).toBe(SHA256); // 统一小写

    const command = parsed.command;
    expect(command).toContain('set -euo pipefail');
    expect(command).toContain(`curl -fsSL ${shellQuote(PACKAGE_URL)} -o "$tmp/agent.tgz"`);
    expect(command).toContain(`printf '%s  %s\\n' ${shellQuote(SHA256)} "$tmp/agent.tgz" | sha256sum -c -`);
    expect(command).toContain('tar -xzf "$tmp/agent.tgz" -C "$tmp"');
    expect(command.startsWith('(')).toBe(true);
    expect(command.trimEnd().endsWith(')')).toBe(true);
    expect(command).toContain('read -rs KHC_TOKEN </dev/tty');
    expect(command).not.toContain('| sudo install -d');
    expect(command).toContain("printf '粘贴节点 token（输入不回显）: ' >&2");
    expect(command).toContain('read -rs KHC_TOKEN');
    expect(command).toContain('cd "$tmp"/khc-agent-*');
    expect(command).toContain('sudo ./install.sh --system');
    expect(command).toContain(`--host ${AGENT_DEFAULT_HOST} --port 8443`);
    expect(command).not.toContain('--user');
    expect(command).not.toContain('--no-start');
    await assertBashSyntax(command);
  });

  it('user 模式：token 写到 $HOME/.config、不 sudo、install.sh --user', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'install', {
      mode: 'user',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('install -d -m 0750 ~/.config/khc-agent');
    expect(command).toContain('~/.config/khc-agent/token');
    expect(command).toContain('read -rs KHC_TOKEN </dev/tty');
    expect(command).toContain('./install.sh --user');
    expect(command).toContain(`--host ${AGENT_DEFAULT_HOST} --port 8443`);
    expect(command).not.toContain('sudo');
    expect(command).not.toContain('/etc/khc-agent');
    await assertBashSyntax(command);
  });

  it('installOptions：--with-caddy/--tls/--tls-cn 追加到 install.sh；--tls-cn 只随自签下发', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      installOptions: { withCaddy: true, tls: true, tlsCn: 'agent.example.com' },
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('--with-caddy --tls --tls-cn agent.example.com');
    await assertBashSyntax(command);

    // 域名节点默认：只带 Caddy；--tls-cn 只对自签生效，非自签时不再下发
    const domain = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      installOptions: { withCaddy: true, tls: false, tlsCn: 'agent.example.com' },
    });
    const domainCommand = agentCommandResponseSchema.parse(domain.body).command;
    expect(domainCommand).toContain('--with-caddy');
    expect(domainCommand).not.toContain('--tls-cn');
    // 不带自签 --tls（--tls-cert / --tls-key 是别的参数）
    expect(domainCommand).not.toMatch(/--tls(?!-cert|-key)/);
    await assertBashSyntax(domainCommand);

    const plain = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    const plainCommand = agentCommandResponseSchema.parse(plain.body).command;
    expect(plainCommand).not.toContain('--with-caddy');
    expect(plainCommand).not.toMatch(/--tls(?!-cert|-key)/);
    expect(plainCommand).not.toContain('--tls-cn');
  });

  it('https 入口节点：install 带约定路径的 --tls-cert/--tls-key（system 与 user 各一套），不带 --insecure-http', async () => {
    const value = await setup(); // 默认节点入口 https://hub.example.com:8443
    const system = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    const systemCommand = agentCommandResponseSchema.parse(system.body).command;
    expect(systemCommand).toContain(`--tls-cert ${SYSTEM_TLS_CERT} --tls-key ${SYSTEM_TLS_KEY}`);
    expect(systemCommand).toContain('/etc/khc-agent/tls/fullchain.pem');
    expect(systemCommand).not.toContain('--insecure-http');
    // 域名 + system：证书缺失时由 install.sh 自动签（ALPN:443），不再要求预置证书
    expect(systemCommand).toContain("--acme 'hub.example.com'");
    expect(systemCommand).toContain('自动用 ACME 签发');
    expect(systemCommand).not.toContain('缺少可信 TLS 证书');
    expect(systemCommand).toContain('sudo ./install.sh --system --check');
    await assertBashSyntax(systemCommand);

    const user = await generateCommand(value, 'install', {
      mode: 'user',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    const userCommand = agentCommandResponseSchema.parse(user.body).command;
    // ~ 不加引号，由 shell 展开成绝对路径（install.sh 只接受绝对路径）
    expect(userCommand).toContain(`--tls-cert ${USER_TLS_CERT} --tls-key ${USER_TLS_KEY}`);
    expect(userCommand).not.toContain("'~");
    expect(userCommand).toContain('cert="$HOME/.config/khc-agent/tls/fullchain.pem"');
    // user 模式无法绑定 443 自动签发，仍保留手动签发指引，并在 token 之前失败
    expect(userCommand).toContain('缺少可信 TLS 证书');
    const certCheckAt = userCommand.indexOf('if [ ! -s "$cert" ]');
    const tokenAt = userCommand.indexOf('read -rs KHC_TOKEN');
    expect(certCheckAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(certCheckAt);
    expect(userCommand).toContain('./install.sh --user --check');
    await assertBashSyntax(userCommand);
  });

  it('https + 裸 IP：前置提示明确阻断，不降级为自签或明文', async () => {
    const value = await setup();
    const res = await value.ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(value.cookie),
        body: JSON.stringify({ name: 'IP HTTPS', endpoint: 'https://203.0.113.9:8443' }),
      },
      value.ctx.env,
    );
    expect(res.status).toBe(201);
    const ipNode = (await res.json()) as { node: { id: string } };
    const ip = { ...value, node: { id: ipNode.node.id, token: '' } };
    const { status, body } = await generateCommand(ip, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('裸 IP 的 HTTPS');
    expect(command).toContain('Cloudflare Tunnel');
    expect(command).not.toContain('--insecure-http');
    expect(command).not.toContain('--tls-self-signed');
    await assertBashSyntax(command);
  });

  it('http 入口节点：install/upgrade 显式带 --insecure-http，且不带 --tls-cert', async () => {
    const value = await setup();
    const res = await value.ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(value.cookie),
        body: JSON.stringify({ name: '明文测试', endpoint: 'http://10.0.0.5:8880' }),
      },
      value.ctx.env,
    );
    expect(res.status).toBe(201);
    const plainNode = (await res.json()) as { node: { id: string } };
    const plain = { ...value, node: { id: plainNode.node.id, token: '' } };
    for (const kind of ['install', 'upgrade'] as const) {
      const { status, body } = await generateCommand(plain, kind, {
        mode: 'system',
        packageUrl: PACKAGE_URL,
        sha256: SHA256,
      });
      expect(status, kind).toBe(200);
      const command = agentCommandResponseSchema.parse(body).command;
      expect(command, kind).toContain('--insecure-http');
      expect(command, kind).toContain('--port 8880');
      expect(command, kind).not.toContain('--tls-cert');
      await assertBashSyntax(command);
    }
  });

  it('https 入口无显式端口：Agent 使用 443（与面板探测端口一致）', async () => {
    const value = await setup();
    const res = await value.ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(value.cookie),
        body: JSON.stringify({ name: '域名 443', endpoint: 'https://hub.example.com' }),
      },
      value.ctx.env,
    );
    expect(res.status).toBe(201);
    const domainNode = (await res.json()) as { node: { id: string } };
    const domain = { ...value, node: { id: domainNode.node.id, token: '' } };
    for (const kind of ['install', 'upgrade'] as const) {
      const { status, body } = await generateCommand(domain, kind, {
        mode: 'system',
        packageUrl: PACKAGE_URL,
        sha256: SHA256,
      });
      expect(status, kind).toBe(200);
      const command = agentCommandResponseSchema.parse(body).command;
      expect(command, kind).toContain(`--host ${AGENT_DEFAULT_HOST} --port 443`);
      expect(command, kind).not.toContain('--port 8880');
      await assertBashSyntax(command);
    }
  });

  it('https 入口节点：upgrade 不传证书路径（交给 install.sh 沿用 unit 里的配置），也不带 --insecure-http', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'upgrade', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).not.toContain('--tls-cert');
    expect(command).not.toContain('--tls-key');
    expect(command).not.toContain('--insecure-http');
    await assertBashSyntax(command);
  });

  it('纯函数未声明 endpointScheme 时不追加任何传输参数', () => {
    const command = buildAgentInstallCommand({
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(command).not.toContain('--tls-cert');
    expect(command).not.toContain('--insecure-http');
  });

  it('installOptions.tlsCn 非法字符（空白/注入）被契约拒绝 400', async () => {
    const value = await setup();
    for (const tlsCn of ['a b', 'a;touch /tmp/pwned', "a'b", '']) {
      const { status, body } = await generateCommand(value, 'install', {
        mode: 'system',
        packageUrl: PACKAGE_URL,
        sha256: SHA256,
        installOptions: { tls: true, tlsCn },
      });
      expect(status, `tlsCn=${JSON.stringify(tlsCn)}`).toBe(400);
      const error = body.error as { code: string; fields?: Record<string, string> };
      expect(error.code).toBe('validation_failed');
    }
  });

  it('A-4：install/upgrade 命令带 --live-origins（面板 origin）与 --node-id（节点 ID），单引号包裹', async () => {
    const value = await setup();
    for (const kind of ['install', 'upgrade'] as const) {
      const { status, body } = await generateCommand(value, kind, {
        mode: 'system',
        packageUrl: PACKAGE_URL,
        sha256: SHA256,
      });
      expect(status, kind).toBe(200);
      const command = agentCommandResponseSchema.parse(body).command;
      // 未配置 LIVE_ORIGINS → 退回请求 origin（测试基址 http://localhost）；都经 shellQuote 单引号包裹
      expect(command, kind).toContain(`--live-origins ${shellQuote('http://localhost')}`);
      expect(command, kind).toContain(`--node-id ${shellQuote(value.node.id)}`);
      await assertBashSyntax(command);
    }
  });

  it('A-4：配置 LIVE_ORIGINS 时用它渲染 --live-origins，而不是回源 Host（workers.dev）', async () => {
    const value = await setup();
    // 生产：浏览器用 https://panel.example.com，而 Worker 看到的 c.req.url 是 *.workers.dev
    value.ctx.env.LIVE_ORIGINS = 'https://panel.example.com';
    for (const kind of ['install', 'upgrade'] as const) {
      const { status, body } = await generateCommand(value, kind, {
        mode: 'system',
        packageUrl: PACKAGE_URL,
        sha256: SHA256,
      });
      expect(status, kind).toBe(200);
      const command = agentCommandResponseSchema.parse(body).command;
      expect(command, kind).toContain(`--live-origins ${shellQuote('https://panel.example.com')}`);
      expect(command, kind).not.toContain('http://localhost');
      await assertBashSyntax(command);
    }
  });

  it('A-4：LIVE_ORIGINS 多个 origin 逗号拼成一个参数，空白被裁剪', async () => {
    const value = await setup();
    value.ctx.env.LIVE_ORIGINS = ' https://panel.example.com , https://panel.example.com ';
    const { status, body } = await generateCommand(value, 'install', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain(
      `--live-origins ${shellQuote('https://panel.example.com,https://panel.example.com')}`,
    );
    await assertBashSyntax(command);
  });

  it('upgrade 命令忽略 installOptions（不出现 --with-caddy/--tls）', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'upgrade', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      installOptions: { withCaddy: true, tls: true, tlsCn: 'agent.example.com' },
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).not.toContain('--with-caddy');
    expect(command).not.toContain('--tls-cn');
    await assertBashSyntax(command);
  });

  it('三种命令响应都带 Cache-Control: no-store', async () => {
    const value = await setup();
    const payload = { mode: 'system', packageUrl: PACKAGE_URL, sha256: SHA256 };
    for (const kind of ['install', 'upgrade', 'uninstall'] as const) {
      const path =
        kind === 'install' ? installPath(value.node.id) : kind === 'upgrade' ? upgradePath(value.node.id) : uninstallPath(value.node.id);
      const res = await post(value.ctx, value.cookie, path, payload);
      expect(res.status, kind).toBe(200);
      expect(res.headers.get('cache-control'), kind).toBe('no-store');
    }
  });

  it('install 响应单独返回 token，命令文本不包含 token', async () => {
    const value = await setup();
    const path = installPath(value.node.id);
    const res = await post(value.ctx, value.cookie, path, {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toBe(value.node.token);
    expect(Object.keys(body).sort()).toEqual(['command', 'mode', 'packageUrl', 'sha256', 'token']);
    expect(String(body.command)).toContain('read -rs KHC_TOKEN');
    expect(String(body.command)).not.toContain(value.node.token);
  });
});

describe('upgrade-command', () => {
  it('system 模式：--no-start 后 sudo systemctl restart', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'upgrade', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('sudo ./install.sh --system --no-start');
    expect(command).toContain(`--host ${AGENT_DEFAULT_HOST} --port 8443`);
    expect(command).toContain('sudo systemctl restart khc-agent');
    expect(command).not.toContain('/etc/khc-agent/token');
    await assertBashSyntax(command);
  });

  it('user 模式：systemctl --user restart、无 sudo', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'upgrade', {
      mode: 'user',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('./install.sh --user --no-start');
    expect(command).toContain(`--host ${AGENT_DEFAULT_HOST} --port 8443`);
    expect(command).toContain('systemctl --user restart khc-agent');
    expect(command).not.toContain('sudo');
    await assertBashSyntax(command);
  });
});

describe('uninstall-command', () => {
  it('system 模式 purge=true：uninstall.sh --system --purge，且命令不含 token', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'uninstall', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      purge: true,
    });
    expect(status).toBe(200);
    const parsed = agentCommandResponseSchema.parse(body);
    const command = parsed.command;
    expect(command).toContain('sudo ./uninstall.sh --purge --system');
    expect(command).toContain('sha256sum -c -');
    expect(command).toContain('tar -xzf "$tmp/agent.tgz" -C "$tmp"');
    expect(command).not.toContain(value.node.token);
    expect(command).not.toContain('--host');
    expect(command).not.toContain('/etc/khc-agent/token');
    await assertBashSyntax(command);
  });

  it('不传包地址/sha256：由 Worker 注入已签名发布包；未配置清单时 503', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'uninstall', { mode: 'system' });
    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe('release_unavailable');
  });

  it('user 模式 purge 缺省=false：uninstall.sh --user、无 --purge/sudo', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'uninstall', {
      mode: 'user',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(status).toBe(200);
    const command = agentCommandResponseSchema.parse(body).command;
    expect(command).toContain('./uninstall.sh --user');
    expect(command).not.toContain('--purge');
    expect(command).not.toContain('sudo');
    expect(command).not.toContain(value.node.token);
    await assertBashSyntax(command);
  });

  it('purge=false 显式传入时不出现 --purge', async () => {
    const value = await setup();
    const { body } = await generateCommand(value, 'uninstall', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      purge: false,
    });
    expect(String(body.command)).toContain('sudo ./uninstall.sh --system');
    expect(String(body.command)).not.toContain('--purge');
  });
});

// ---------------------------------------------------------------------------
// 纯函数 / shell 转义 / bash 语法
// ---------------------------------------------------------------------------

describe('agent-commands 纯函数', () => {
  it('shellQuote 单引号安全转义并可通过 bash 还原', async () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    const tricky = "http://x/'; touch /tmp/pwned; '`id`$(id)";
    const quoted = shellQuote(tricky);
    expect(await bashPrint(quoted)).toBe(tricky);
    expect(quoted.startsWith("'")).toBe(true);
  });

  it('安装命令不内嵌 token，改为 read -s 从 stdin 读取', async () => {
    const command = buildAgentInstallCommand({
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    await assertBashSyntax(command);
    expect(command).toContain('read -rs KHC_TOKEN');
    expect(command).not.toContain('tok-123');
  });

  it('6 种命令变体都通过 bash -n', async () => {
    const base = { packageUrl: PACKAGE_URL, sha256: SHA256 };
    const commands = [
      buildAgentInstallCommand({ ...base, mode: 'system' }),
      buildAgentInstallCommand({ ...base, mode: 'user' }),
      buildAgentUpgradeCommand({ ...base, mode: 'system' }),
      buildAgentUpgradeCommand({ ...base, mode: 'user' }),
      buildAgentUninstallCommand({ mode: 'system', packageUrl: PACKAGE_URL, sha256: SHA256, purge: true }),
      buildAgentUninstallCommand({ mode: 'user', packageUrl: PACKAGE_URL, sha256: SHA256, purge: false }),
    ];
    for (const command of commands) await assertBashSyntax(command);
  });

  it('非法 host/port 直接抛错（防止拼进 shell）', () => {
    const base = { mode: 'system' as const, packageUrl: PACKAGE_URL, sha256: SHA256, token: 't' };
    expect(() => buildAgentInstallCommand({ ...base, host: '0.0.0.0; rm -rf /' })).toThrow();
    expect(() => buildAgentInstallCommand({ ...base, port: 0 })).toThrow();
    expect(() => buildAgentInstallCommand({ ...base, port: 70000 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 参数校验（URL / sha / mode / purge 注入拒绝）
// ---------------------------------------------------------------------------

describe('参数校验', () => {
  const cases: Array<{ name: string; payload: Record<string, unknown>; field: string }> = [
    { name: 'http URL', payload: { mode: 'system', packageUrl: 'http://evil.test/a.tgz', sha256: SHA256 }, field: 'packageUrl' },
    { name: 'JS/伪协议', payload: { mode: 'system', packageUrl: 'javascript:alert(1)', sha256: SHA256 }, field: 'packageUrl' },
    { name: 'URL 空白', payload: { mode: 'system', packageUrl: 'https://a.test/a b.tgz', sha256: SHA256 }, field: 'packageUrl' },
    { name: 'URL 换行', payload: { mode: 'system', packageUrl: 'https://a.test/a\n.tgz', sha256: SHA256 }, field: 'packageUrl' },
    { name: 'URL 单引号注入', payload: { mode: 'system', packageUrl: "https://a.test/a'; touch /tmp/pwned; '", sha256: SHA256 }, field: 'packageUrl' },
    { name: 'URL 反引号注入', payload: { mode: 'system', packageUrl: 'https://a.test/`id`.tgz', sha256: SHA256 }, field: 'packageUrl' },
    { name: 'URL 超长', payload: { mode: 'system', packageUrl: `https://a.test/${'x'.repeat(2048)}`, sha256: SHA256 }, field: 'packageUrl' },
    { name: 'sha 太短', payload: { mode: 'system', packageUrl: PACKAGE_URL, sha256: 'a'.repeat(63) }, field: 'sha256' },
    { name: 'sha 太长', payload: { mode: 'system', packageUrl: PACKAGE_URL, sha256: 'a'.repeat(65) }, field: 'sha256' },
    { name: 'sha 非 hex', payload: { mode: 'system', packageUrl: PACKAGE_URL, sha256: 'g'.repeat(64) }, field: 'sha256' },
    { name: 'sha 空', payload: { mode: 'system', packageUrl: PACKAGE_URL, sha256: '' }, field: 'sha256' },
    { name: 'mode 非法', payload: { mode: 'root', packageUrl: PACKAGE_URL, sha256: SHA256 }, field: 'mode' },
    { name: '缺 packageUrl', payload: { mode: 'system', sha256: SHA256 }, field: 'packageUrl' },
    { name: '缺 sha256', payload: { mode: 'system', packageUrl: PACKAGE_URL }, field: 'sha256' },
  ];

  it.each(cases)('拒绝非法参数：$name', async ({ payload, field }) => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'install', payload);
    expect(status).toBe(400);
    const error = body.error as { code: string; fields?: Record<string, string> };
    expect(error.code).toBe('validation_failed');
    expect(error.fields?.[field]).toBeTruthy();
    // 校验失败不写 agent.command 审计（建节点时有一条 node.create）
    expect(value.ctx.audit.entries.filter((entry) => entry.action === 'agent.command')).toHaveLength(0);
  });

  it('uninstall 的 purge 必须是布尔', async () => {
    const value = await setup();
    const { status, body } = await generateCommand(value, 'uninstall', {
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      purge: 'yes',
    });
    expect(status).toBe(400);
    const error = body.error as { code: string; fields?: Record<string, string> };
    expect(error.fields?.purge).toBeTruthy();
  });

  it('sha256 大写会被规范化为小写（contracts 单测）', () => {
    const parsed = agentCommandRequestSchema.parse({
      mode: 'system',
      packageUrl: PACKAGE_URL,
      sha256: SHA256_UPPER,
    });
    expect(parsed.sha256).toBe(SHA256);
    const uninstall = agentUninstallCommandRequestSchema.parse({
      mode: 'user',
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(uninstall.purge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 鉴权 / 404 / 503
// ---------------------------------------------------------------------------

describe('鉴权与错误码', () => {
  const endpoints = ['install-command', 'upgrade-command', 'uninstall-command'];
  const payload = { mode: 'system', packageUrl: PACKAGE_URL, sha256: SHA256 };

  it('未登录 401', async () => {
    const value = await setup();
    for (const endpoint of endpoints) {
      const res = await value.ctx.app.request(
        `/api/v1/nodes/${value.node.id}/agent/${endpoint}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
        value.ctx.env,
      );
      expect(res.status, endpoint).toBe(401);
    }
  });

  it('节点不存在 404', async () => {
    const value = await setup();
    for (const endpoint of endpoints) {
      const res = await post(value.ctx, value.cookie, `/api/v1/nodes/n_missing/agent/${endpoint}`, payload);
      expect(res.status, endpoint).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
  });

  it('MASTER_ENC_KEY 缺失：仅 install 503，升级/卸载不再需要 token', async () => {
    const value = await setup();
    const env = value.ctx.env as unknown as Record<string, unknown>;
    delete env.MASTER_ENC_KEY;
    for (const endpoint of endpoints) {
      const res = await post(value.ctx, value.cookie, `/api/v1/nodes/${value.node.id}/agent/${endpoint}`, payload);
      if (endpoint === 'install-command') {
        expect(res.status, endpoint).toBe(503);
        const parsed = (await res.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe('server_misconfigured');
      } else {
        expect(res.status, endpoint).toBe(200);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 审计：agent.command 只记 type/mode，不含 token/command
// ---------------------------------------------------------------------------

describe('审计', () => {
  const payload = { mode: 'system', packageUrl: PACKAGE_URL, sha256: SHA256 };

  it('三种命令各写一条 agent.command，detail 只含 type/mode/purge', async () => {
    const value = await setup();
    await generateCommand(value, 'install', payload);
    await generateCommand(value, 'upgrade', { ...payload, mode: 'user' });
    await generateCommand(value, 'uninstall', { ...payload, purge: true });

    const entries = value.ctx.audit.entries.filter((entry) => entry.action === 'agent.command');
    expect(entries).toHaveLength(3);
    const types = entries.map((entry) => entry.detail?.type);
    expect(types).toEqual(['install', 'upgrade', 'uninstall']);
    for (const entry of entries) {
      expect(entry.action).toBe('agent.command');
      expect(entry.nodeId).toBe(value.node.id);
      expect(entry.actor).toBeTruthy();
      expect(entry.detail?.mode).toBeTruthy();
    }
    expect(entries[2]?.detail).toEqual({ type: 'uninstall', mode: 'system', purge: true });
  });

  it('审计与响应头都不泄漏 token / command', async () => {
    const value = await setup();
    await generateCommand(value, 'install', payload);
    const entries = value.ctx.audit.entries.filter((entry) => entry.action === 'agent.command');
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(value.node.token);
    expect(serialized).not.toContain('curl -fsSL');
    expect(serialized).not.toContain(PACKAGE_URL);
    expect(serialized).not.toContain(SHA256);
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(value.node.token);
    }
  });
});


// ---------------------------------------------------------------------------
// C5 阶段二：Agent 拉取式自升级 / 重装
// ---------------------------------------------------------------------------

const UPGRADE_URL = 'https://downloads.example.com/khc-agent/khc-agent-0.2.0.tar.gz?token=super-secret';
const AGENT_UPGRADE_PATH = 202;

function agentUpgradePath(nodeId: string): string {
  return `/api/v1/nodes/${nodeId}/agent/upgrade`;
}

describe('agent upgrade（拉取式）', () => {
  it('202 accepted + taskId 透传；请求体与审计字段正确', async () => {
    const value = await setup();
    value.ctx.agent.handler = async (method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/upgrade');
      expect(body).toEqual({ packageUrl: UPGRADE_URL, sha256: SHA256, reinstall: false });
      return {
        status: AGENT_UPGRADE_PATH,
        body: {
          ok: true,
          accepted: true,
          taskId: 'task_up_1',
          fromVersion: '0.1.0',
          mode: 'system',
        },
      };
    };

    const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), {
      packageUrl: UPGRADE_URL,
      sha256: SHA256_UPPER,
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = agentUpgradeResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      ok: true,
      accepted: true,
      taskId: 'task_up_1',
      fromVersion: '0.1.0',
      mode: 'system',
    });

    const audits = value.ctx.audit.entries.filter((entry) => entry.action === 'agent.upgrade');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toEqual({
      urlHost: 'downloads.example.com',
      shaPrefix: SHA256.slice(0, 12),
      reinstall: false,
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('/khc-agent-0.2.0.tar.gz');
    expect(serialized).not.toContain(value.node.token);
    expect(serialized).not.toContain(SHA256);
  });

  it('reinstall=true 原样转发', async () => {
    const value = await setup();
    let forwarded: unknown;
    value.ctx.agent.handler = async (_method, _path, body) => {
      forwarded = body;
      return { status: 202, body: { ok: true, accepted: true, taskId: 't2' } };
    };
    const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), {
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
      reinstall: true,
    });
    expect(res.status).toBe(202);
    expect(agentUpgradeRequestSchema.parse(forwarded)).toMatchObject({ reinstall: true });
    const audit = value.ctx.audit.entries.find((entry) => entry.action === 'agent.upgrade');
    expect(audit?.detail).toMatchObject({ reinstall: true });
  });

  it('非法 URL/sha/reinstall：400 且不调用 Agent、不写审计', async () => {
    const value = await setup();
    const cases = [
      { packageUrl: 'http://downloads.example.com/a.tgz', sha256: SHA256 },
      { packageUrl: PACKAGE_URL, sha256: 'not-hex' },
      { packageUrl: PACKAGE_URL, sha256: SHA256, reinstall: 'yes' },
    ];
    for (const payload of cases) {
      const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), payload);
      expect(res.status).toBe(400);
    }
    expect(value.ctx.agent.requests).toHaveLength(0);
    expect(value.ctx.audit.entries.filter((entry) => entry.action === 'agent.upgrade')).toHaveLength(0);
  });

  it('Agent busy / HTTP 错误透传；不写审计', async () => {
    const value = await setup();
    value.ctx.agent.handler = async () => ({
      status: 409,
      body: { ok: false, error: { code: 'upgrade_busy', message: '已有升级任务' } },
    });
    const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), {
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('upgrade_busy');
    expect(value.ctx.audit.entries.filter((entry) => entry.action === 'agent.upgrade')).toHaveLength(0);
  });

  it('Agent 不可达 → 502，不写审计', async () => {
    const value = await setup();
    value.ctx.agent.handler = async () => {
      throw new Error('connect timeout');
    };
    const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), {
      packageUrl: PACKAGE_URL,
      sha256: SHA256,
    });
    expect(res.status).toBe(502);
    expect(value.ctx.audit.entries.filter((entry) => entry.action === 'agent.upgrade')).toHaveLength(0);
  });

  it('鉴权 401 / 节点不存在 404 / MASTER_ENC_KEY 缺失 503', async () => {
    const value = await setup();
    const payload = { packageUrl: PACKAGE_URL, sha256: SHA256 };

    const anon = await value.ctx.app.request(
      agentUpgradePath(value.node.id),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      value.ctx.env,
    );
    expect(anon.status).toBe(401);

    const missing = await post(value.ctx, value.cookie, agentUpgradePath('n_missing'), payload);
    expect(missing.status).toBe(404);

    const env = value.ctx.env as unknown as Record<string, unknown>;
    const saved = env.MASTER_ENC_KEY;
    delete env.MASTER_ENC_KEY;
    try {
      const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), payload);
      expect(res.status).toBe(503);
    } finally {
      env.MASTER_ENC_KEY = saved;
    }
    expect(value.ctx.agent.requests).toHaveLength(0);
    expect(value.ctx.audit.entries.filter((entry) => entry.action === 'agent.upgrade')).toHaveLength(0);
  });
});


describe('签名发布清单（#32）', () => {
  it('只接受清单内 URL/sha；篡改签名拒绝', async () => {
    const value = await setup();
    const release = manifestPayload.releases[0]!;
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify({
      payload: manifestPayload,
      signature: manifestSignature,
    });

    const allowed = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: release.url,
      sha256: release.sha256,
    });
    expect(allowed.status).toBe(200);

    const unknown = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: 'https://evil.example.com/khc-agent.tgz',
      sha256: release.sha256,
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_not_in_manifest',
    );

    const tampered = JSON.parse(value.ctx.env.AGENT_RELEASE_MANIFEST);
    tampered.payload.releases[0].sha256 = 'b'.repeat(64);
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify(tampered);
    const rejected = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: release.url,
      sha256: release.sha256,
    });
    expect(rejected.status).toBe(403);
    expect(((await rejected.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_signature_invalid',
    );
  });

  it('A-5：远程升级把签名清单原文转发给 Agent（服务端注入，调用方传值被覆盖）', async () => {
    const value = await setup();
    const release = manifestPayload.releases[0]!;
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    const manifestRaw = JSON.stringify({ payload: manifestPayload, signature: manifestSignature });
    value.ctx.env.AGENT_RELEASE_MANIFEST = manifestRaw;
    let forwarded: unknown;
    value.ctx.agent.handler = async (_method, _path, body) => {
      forwarded = body;
      return { status: 202, body: { ok: true, accepted: true, taskId: 't5' } };
    };
    const res = await post(value.ctx, value.cookie, agentUpgradePath(value.node.id), {
      packageUrl: release.url,
      sha256: release.sha256,
      // 调用方伪造的 manifest 必须被服务端覆盖为 env 里的清单原文
      manifest: '{"payload":{"version":1,"releases":[{"url":"https://evil.example/x.tar.gz"}]}}',
    });
    expect(res.status).toBe(202);
    expect((forwarded as { manifest?: string }).manifest).toBe(manifestRaw);
  });

  /** 模拟随部署发布的静态清单：null = 404（未发布）。 */
  function setBundledManifest(value: Setup['ctx'], body: string | null): void {
    const env = value.env as unknown as {
      ASSETS: { fetch: (input: Request) => Promise<Response> };
    };
    env.ASSETS = {
      fetch: async () =>
        body === null
          ? new Response('not found', { status: 404 })
          : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    };
  }

  function getReleases(value: Setup) {
    return value.ctx.app.request(
      '/api/v1/agent/releases',
      { headers: { cookie: value.cookie } },
      value.ctx.env,
    );
  }

  it('清单随 assets 发布时优先读取（secret 里的旧清单被忽略）', async () => {
    const value = await setup();
    const release = manifestPayload.releases[0]!;
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    // secret 里放一份被改过 payload 的清单：若 secret 优先会验签失败 403。
    const stale = {
      payload: { ...manifestPayload, releases: [{ ...release, version: '0.0.9' }] },
      signature: manifestSignature,
    };
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify(stale);
    setBundledManifest(value.ctx, JSON.stringify({ payload: manifestPayload, signature: manifestSignature }));

    const res = await getReleases(value);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: { version: string }[] };
    expect(body.releases.map((item) => item.version)).toEqual(['0.1.0']);
  });

  it('assets 清单缺失时回退 secret', async () => {
    const value = await setup();
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify({
      payload: manifestPayload,
      signature: manifestSignature,
    });
    setBundledManifest(value.ctx, null);

    const res = await getReleases(value);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: { version: string }[] };
    expect(body.releases.map((item) => item.version)).toEqual(['0.1.0']);
  });

  it('assets 清单签名不匹配时拒绝（不回落 secret）', async () => {
    const value = await setup();
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify({
      payload: manifestPayload,
      signature: manifestSignature,
    });
    const tampered = {
      payload: {
        ...manifestPayload,
        releases: [{ ...manifestPayload.releases[0]!, sha256: 'b'.repeat(64) }],
      },
      signature: manifestSignature,
    };
    setBundledManifest(value.ctx, JSON.stringify(tampered));

    const res = await getReleases(value);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_signature_invalid',
    );
  });

  it('assets 清单 JSON 损坏时报错', async () => {
    const value = await setup();
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    setBundledManifest(value.ctx, '{ not json');

    const res = await getReleases(value);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_manifest_invalid',
    );
  });
});

describe('release source 约束', () => {
  it('配置 AGENT_RELEASE_BASE 后拒绝其它来源', async () => {
    const value = await setup();
    value.ctx.env.AGENT_RELEASE_BASE = 'https://releases.example.com/agent/';
    const blocked = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: 'https://evil.example.com/khc-agent.tgz',
      sha256: SHA256,
    });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_source_not_allowed',
    );
    const allowed = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: 'https://releases.example.com/agent/khc-agent.tgz',
      sha256: SHA256,
    });
    expect(allowed.status).toBe(200);
  });

  it('生产未配置清单时 fail-closed', async () => {
    const value = await setup();
    value.ctx.env.ENVIRONMENT = 'production';
    delete value.ctx.env.AGENT_RELEASE_MANIFEST;
    delete value.ctx.env.AGENT_RELEASE_PUBKEY;
    const res = await post(value.ctx, value.cookie, installPath(value.node.id), {
      mode: 'system',
      packageUrl: 'https://releases.example.com/agent/khc-agent-0.1.0.tar.gz',
      sha256: SHA256,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
      'release_manifest_required',
    );
  });

  it('卸载命令不传包信息：由签名清单注入并返回 200（回归：曾回显 undefined 导致 500）', async () => {
    const value = await setup();
    const release = manifestPayload.releases[0]!;
    value.ctx.env.AGENT_RELEASE_PUBKEY = manifestPubkey;
    value.ctx.env.AGENT_RELEASE_MANIFEST = JSON.stringify({
      payload: manifestPayload,
      signature: manifestSignature,
    });

    const { status, body } = await generateCommand(value, 'uninstall', { mode: 'system' });
    expect(status).toBe(200);
    const parsed = agentCommandResponseSchema.parse(body);
    expect(parsed.packageUrl).toBe(release.url);
    expect(parsed.sha256).toBe(release.sha256);
    expect(parsed.command).toContain(release.url);
    expect(parsed.command).toContain(release.sha256);
    await assertBashSyntax(parsed.command);
  });
});
