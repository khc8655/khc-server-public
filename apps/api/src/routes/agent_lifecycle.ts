/**
 * C5：Agent 生命周期命令（docs/agent-lifecycle.md）。
 *
 * 三个 POST 只**生成**安装/升级/卸载命令给主人复制粘贴，不远程执行：
 *   POST /api/v1/nodes/:id/agent/install-command
 *   POST /api/v1/nodes/:id/agent/upgrade-command
 *   POST /api/v1/nodes/:id/agent/uninstall-command
 *
 * - requireAuth；节点不存在 404；MASTER_ENC_KEY 缺失 503（nodeToken 解密失败）；
 * - 命令内含一次性节点 token -> `Cache-Control: no-store`；
 * - 审计 `agent.command` 只记 `{type, mode(, purge)}`，绝不记 command/token/packageUrl。
 */

import { Hono } from 'hono';
import {
  agentCommandRequestSchema,
  agentCommandResponseSchema,
  agentUninstallCommandRequestSchema,
  agentUpgradeRequestSchema,
  agentUpgradeResponseSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { requireAuth } from '../middleware/auth';
import { parseJsonBody } from '../lib/validate';
import {
  buildAgentInstallCommand,
  buildAgentUninstallCommand,
  buildAgentUpgradeCommand,
} from '../lib/agent-commands';
import { HubUnreachableError } from '../lib/node-client';
import {
  assertAgentReleaseAllowed,
  loadAgentReleaseManifest,
  loadAgentReleases,
} from '../lib/agent-releases';
import { AppError } from '../lib/errors';
import { decryptSecret } from '../lib/crypto';
import { throwAgentError } from './nodes';
import { nodeToken, requireNode } from './helpers';
import type { StoredNode } from '../domain/repos';
import type { Env } from '../types';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const AGENT_UPGRADE_TIMEOUT_MS = 10_000;

/** 审计只允许出现 host，绝不落完整 URL（可能带签名 token）。 */
function packageHost(packageUrl: string): string {
  try {
    return new URL(packageUrl).host;
  } catch {
    return 'invalid';
  }
}

function unreachableMessage(error: unknown): string {
  if (error instanceof HubUnreachableError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 节点入口协议：决定安装/升级命令带可信证书参数还是显式的 --insecure-http。 */
function nodeEndpointScheme(endpoint: string): 'http' | 'https' {
  return /^https:\/\//i.test(endpoint) ? 'https' : 'http';
}

/**
 * 从节点 endpoint 推导 Agent 监听端口：显式端口优先；无显式端口按入口协议取默认。
 * 面板访问 https 域名时用的是 443，若这里回落 8880，Agent 会监听在面板探测不到的端口。
 */
function nodeAgentPort(endpoint: string): number {
  // URL 会吞掉 :80/:443 默认端口，先按原始字符串取显式端口。
  const explicit = endpoint.match(/:([0-9]{1,5})(?:\/|$)/);
  if (explicit) return Number(explicit[1]);
  return /^https:\/\//i.test(endpoint) ? 443 : 8880;
}

/** endpoint 的 hostname：用于 HTTPS 安装命令的证书前置提示（裸 IP 会被提前阻断）。 */
function nodeEndpointHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return undefined;
  }
}

/**
 * PR1：按接入方式决定 Agent 监听参数。
 * - tunnel：Agent 只监听 127.0.0.1:<originPort>，返回 cloudflared token 供安装命令注册隧道；
 * - ip / domain：沿用 endpoint 推导的端口与协议。
 */
async function commandTarget(
  deps: AppDeps,
  env: Env,
  node: StoredNode,
): Promise<{
  host?: string;
  port: number;
  scheme: 'http' | 'https';
  hostName?: string;
  tunnelToken?: string;
}> {
  if (node.accessMode === 'tunnel') {
    const tunnel = node.tunnelId ? await deps.tunnels.get(node.tunnelId) : null;
    if (!tunnel) {
      throw new AppError(
        409,
        'tunnel_missing',
        '节点引用的隧道配置不存在；请在面板重新选择隧道或改为其他接入方式',
      );
    }
    if (!env.MASTER_ENC_KEY) throw new AppError(503, 'misconfigured', 'MASTER_ENC_KEY 未配置');
    const tunnelToken = await decryptSecret(env.MASTER_ENC_KEY, tunnel.tokenEnc, {
      previousKey: env.MASTER_ENC_KEY_PREVIOUS,
    });
    if (!tunnelToken) {
      throw new AppError(409, 'tunnel_token_unavailable', '隧道 Token 无法解密，请重新保存隧道配置');
    }
    return {
      host: '127.0.0.1',
      port: tunnel.originPort,
      scheme: 'http',
      hostName: '127.0.0.1',
      tunnelToken,
    };
  }
  return {
    port: nodeAgentPort(node.endpoint),
    scheme: nodeEndpointScheme(node.endpoint),
    hostName: nodeEndpointHost(node.endpoint),
  };
}

/**
 * A-4：观测层渲染参数。面板前端用 `window.location.origin` 取票并作为 EventSource
 * 的 Origin 直连节点观测层——两者都等于**用户在浏览器里看到的**面板地址。
 *
 * 注意不能直接用 `c.req.url` 的 origin：生产入口是第三方边缘（回源 Host 为
 * `*.workers.dev`），Worker 看到的 origin 是 workers.dev，而浏览器用的是
 * `https://panel.example.com` → 装完节点后浏览器直连观测会被 CORS 拒（2026-11-07 真机：
 * 页面顶部报「实时观测不可用 … Agent 的 KHC_LIVE_ORIGINS 未包含当前面板域名」）。
 * 因此优先用显式配置的 `LIVE_ORIGINS`（对外入口白名单），没有配置才退回请求 origin。
 * 旧节点（unit 无 KHC_LIVE_ORIGINS）留空不校验，升级/重装命令会顺带补上。
 */
function liveObservationOptions(
  c: { req: { url: string }; env: { LIVE_ORIGINS?: string } },
  nodeId: string,
) {
  const configured = (c.env.LIVE_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = configured.length > 0 ? configured : [new URL(c.req.url).origin];
  return { liveOrigins: origins, nodeId };
}

export function agentLifecycleRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use('/nodes/*', requireAuth);

  /** #32：返回已签名的发布版本；未配置清单时返回空（UI 仍可高级手填）。 */
  router.get('/agent/releases', async (c) => {
    const releases = (await loadAgentReleases(c.env, new URL(c.req.url).origin)) ?? [];
    c.header('Cache-Control', 'private, max-age=60');
    return c.json({ releases });
  });

  /** 安装命令：下载 -> 校验 -> 写 token -> install.sh（system/user 两种写法）。 */
  router.post('/nodes/:id/agent/install-command', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    // 先拿 token：MASTER_ENC_KEY 缺失时统一 503（三个接口一致）。
    const token = await nodeToken(c.env, node);
    const body = await parseJsonBody(c, agentCommandRequestSchema);
    await assertAgentReleaseAllowed(c.env, body.packageUrl, body.sha256, {
      origin: new URL(c.req.url).origin,
    });
    const target = await commandTarget(deps, c.env, node);
    const command = buildAgentInstallCommand({
      mode: body.mode,
      packageUrl: body.packageUrl,
      sha256: body.sha256,
      host: target.host,
      port: target.port,
      install: body.installOptions,
      endpointScheme: target.scheme,
      endpointHost: target.hostName,
      tunnelToken: target.tunnelToken,
      ...liveObservationOptions(c, node.id),
    });
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'agent.command',
      detail: { type: 'install', mode: body.mode },
    });
    return c.json(
      agentCommandResponseSchema.parse({
        command,
        mode: body.mode,
        packageUrl: body.packageUrl,
        sha256: body.sha256,
        token,
      }),
      200,
      NO_STORE,
    );
  });

  /** 升级命令：install.sh --no-start 后重启服务（systemd system/user）。 */
  router.post('/nodes/:id/agent/upgrade-command', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const body = await parseJsonBody(c, agentCommandRequestSchema);
    await assertAgentReleaseAllowed(c.env, body.packageUrl, body.sha256, {
      origin: new URL(c.req.url).origin,
    });
    const target = await commandTarget(deps, c.env, node);
    const command = buildAgentUpgradeCommand({
      mode: body.mode,
      packageUrl: body.packageUrl,
      sha256: body.sha256,
      host: target.host,
      port: target.port,
      endpointScheme: target.scheme,
      ...liveObservationOptions(c, node.id),
    });
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'agent.command',
      detail: { type: 'upgrade', mode: body.mode },
    });
    return c.json(
      agentCommandResponseSchema.parse({
        command,
        mode: body.mode,
        packageUrl: body.packageUrl,
        sha256: body.sha256,
      }),
      200,
      NO_STORE,
    );
  });

  /** 卸载命令：下载 -> 校验 -> uninstall.sh [--purge]；命令里不含 token。
   *  调用方无需知道包地址/sha256：未显式传入时由 Worker 用已签名的最新发布包注入。 */
  router.post('/nodes/:id/agent/uninstall-command', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const body = await parseJsonBody(c, agentUninstallCommandRequestSchema);
    let packageUrl = body.packageUrl;
    let sha256 = body.sha256;
    if (!packageUrl || !sha256) {
      const releases = await loadAgentReleases(c.env, new URL(c.req.url).origin);
      const latest = releases?.[0];
      if (!latest) {
        throw new AppError(
          503,
          'release_unavailable',
          '未配置已签名的 Agent 发布清单，无法生成卸载命令',
        );
      }
      packageUrl = latest.url;
      sha256 = latest.sha256;
    } else {
      await assertAgentReleaseAllowed(c.env, packageUrl, sha256, {
        origin: new URL(c.req.url).origin,
      });
    }
    const command = buildAgentUninstallCommand({
      mode: body.mode,
      packageUrl,
      sha256,
      purge: body.purge,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'agent.command',
      detail: { type: 'uninstall', mode: body.mode, purge: body.purge },
    });
    return c.json(
      agentCommandResponseSchema.parse({
        command,
        mode: body.mode,
        // 必须用注入后的局部变量：调用方不传包信息时由 Worker 从签名清单补齐，
        // 回显 body.packageUrl/sha256（undefined）会触发契约校验失败 → 500。
        packageUrl,
        sha256,
      }),
      200,
      NO_STORE,
    );
  });

  /**
   * 阶段二：Agent 拉取式自升级/重装。
   *
   * Worker 同步转发 Agent `POST /upgrade`（Agent 立即 202 accepted，重启由 Agent
   * 侧 detached 调度）；Worker 返回 202 + taskId，审计只记 host/sha 前缀。
   */
  router.post('/nodes/:id/agent/upgrade', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const token = await nodeToken(c.env, node);
    const body = await parseJsonBody(c, agentUpgradeRequestSchema);
    // 一次性取出清单：既用于 URL/sha 校验，也把原文转发给 Agent 自验（A-5）。
    const origin = new URL(c.req.url).origin;
    const manifestSource = await loadAgentReleaseManifest(c.env, origin);
    await assertAgentReleaseAllowed(c.env, body.packageUrl, body.sha256, {
      releases: manifestSource ? manifestSource.releases : null,
      origin,
    });

    let response;
    try {
      response = await deps.agent.call(
        node,
        token,
        'POST',
        '/upgrade',
        {
          packageUrl: body.packageUrl,
          sha256: body.sha256,
          reinstall: body.reinstall,
          // A-5：签名清单原文由服务端注入（无视调用方传入值），Agent 端用
          // 内置公钥独立验签，拒绝清单外的自建包。来源与校验一致（assets 优先）。
          manifest: manifestSource?.raw,
        },
        { timeoutMs: AGENT_UPGRADE_TIMEOUT_MS },
      );
    } catch (error) {
      throw new HubUnreachableError(unreachableMessage(error), {});
    }
    if (response.status >= 400) throwAgentError(response.status, response.body);
    const parsed = agentUpgradeResponseSchema.parse(response.body);

    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'agent.upgrade',
      detail: {
        urlHost: packageHost(body.packageUrl),
        shaPrefix: body.sha256.slice(0, 12),
        reinstall: body.reinstall,
      },
    });
    return c.json(parsed, 202, NO_STORE);
  });

  return router;
}
