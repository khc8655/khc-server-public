import { createApp } from './app';
import { D1NodeRepo } from './db/d1/nodes';
import { D1AppConfigRepo } from './db/d1/apps';
import { D1AuditRepo } from './db/d1/audit';
import { D1CertificateRepo } from './db/d1/certs';
import { D1SettingsRepo } from './db/d1/settings';
import { D1SshKeyRepo } from './db/d1/sshKeys';
import { D1TunnelRepo } from './db/d1/tunnels';
import { HttpAgentClient } from './lib/node-client';
import type { FetchLike, TcpFetchLike } from './lib/node-client';
import type { Env } from './types';

export interface WorkerRuntime {
  agent: HttpAgentClient;
  app: ReturnType<typeof createApp>;
}

/** 仅供单测注入 Agent 传输实现；生产路径不传，使用全局 fetch / tcpFetch 默认值。 */
export interface WorkerRuntimeOptions {
  fetchImpl?: FetchLike;
  tcpFetchImpl?: TcpFetchLike;
}

/**
 * §3.1：client/app 按 env 的 D1 绑定缓存，使 node-client 的 cooldown Map 与
 * snapshot 的 inflight 去重在同一 isolate 内跨请求共享。
 * Workers 每次请求的 env 可能是新对象，但绑定实例（env.DB）在同一 isolate 内
 * 稳定，故以绑定引用为 WeakMap 键（未绑定 DB 时回退到 env 本身）。
 */
const runtimeByBinding = new WeakMap<object, WorkerRuntime>();

function buildRuntime(env: Env, options: WorkerRuntimeOptions): WorkerRuntime {
  const nodes = new D1NodeRepo(env.DB);
  // §3.8：preferred_route 是节点创建/配置时选定的接入方案，运行时只走该方案，
  // 不再回写 D1；故不再构造 onRouteSuccess 回调。
  const agent = new HttpAgentClient(options.fetchImpl, options.tcpFetchImpl);
  // A-11：密钥 id + 轮换窗口旧钥（可缺省；缺省时密文前缀 k1、无旧钥回退）
  const encOptions = {
    keyId: env.MASTER_ENC_KEY_ID,
    previousKey: env.MASTER_ENC_KEY_PREVIOUS,
  };
  const app = createApp({
    nodes,
    apps: new D1AppConfigRepo(env.DB, env.MASTER_ENC_KEY, encOptions),
    audit: new D1AuditRepo(env.DB),
    certs: new D1CertificateRepo(env.DB, env.MASTER_ENC_KEY, encOptions),
    settings: new D1SettingsRepo(env.DB, env.MASTER_ENC_KEY, encOptions),
    sshKeys: new D1SshKeyRepo(env.DB),
    tunnels: new D1TunnelRepo(env.DB),
    agent,
  });
  return { agent, app };
}

/** 同一 isolate 内按绑定复用；单测可传 options 注入传输实现。 */
export function getWorkerRuntime(env: Env, options: WorkerRuntimeOptions = {}): WorkerRuntime {
  const key = (env.DB ?? env) as object;
  const cached = runtimeByBinding.get(key);
  if (cached) return cached;
  const runtime = buildRuntime(env, options);
  runtimeByBinding.set(key, runtime);
  return runtime;
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return getWorkerRuntime(env).app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
