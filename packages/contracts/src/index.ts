import { z } from 'zod';

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

/** 当前 API 主版本，出现在 /api/v1 路径与 version 响应中 */
export const API_VERSION = 'v1' as const;

/** 服务名，用于探活/版本响应的强校验 */
export const SERVICE_NAME = 'khc-server' as const;

/** 统一错误格式：{"error":{"code","message","fields?"}} */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/**
 * 构建标识（ADR-0013 的 L3 层）：把线上运行的版本追溯到具体提交。
 * 来自 Cloudflare 官方 version metadata binding；本地开发/未配置时缺失，
 * 因此全部 optional —— 旧客户端解析不受影响。
 */
export const buildInfoSchema = z.object({
  /** 部署时打的版本标签，CI 取 commit sha 前 12 位 */
  commit: z.string().min(1).max(64).optional(),
  /** 版本创建时间（ISO 8601） */
  builtAt: z.string().min(1).max(64).optional(),
  /** Cloudflare Worker Version ID */
  versionId: z.string().min(1).max(64).optional(),
});
export type BuildInfo = z.infer<typeof buildInfoSchema>;

/** GET /api/v1/health */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal(SERVICE_NAME),
  version: z.string().min(1),
  env: z.string().min(1),
  time: z.number().int().nonnegative(),
  ...buildInfoSchema.shape,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** GET /api/v1/version */
export const versionResponseSchema = z.object({
  name: z.literal(SERVICE_NAME),
  version: z.string().min(1),
  apiVersion: z.literal(API_VERSION),
  ...buildInfoSchema.shape,
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

export const authUserSchema = z.object({ name: z.string().min(1) });
export type AuthUser = z.infer<typeof authUserSchema>;

/** POST /api/v1/auth/login */
export const loginRequestSchema = z.object({
  password: z.string().min(1).max(256),
  totp: z.string().min(6).max(8).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  ok: z.literal(true),
  user: authUserSchema,
  expiresAt: z.number().int().positive(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * TOTP 二次验证（§3.4）。GET /api/v1/auth/totp/setup 是唯一会下发 secret 的响应：
 * 一次性生成且仅在未启用时可用；之后任何响应/日志/审计都不再回显该值。
 */
export const totpSetupResponseSchema = z.object({
  secret: z.string().min(1),
  otpauthUri: z.string().min(1),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

/** POST /api/v1/auth/totp/enable | /auth/totp/disable：只提交 6 位验证码 */
export const totpCodeRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '验证码必须是 6 位数字'),
});
export type TotpCodeRequest = z.infer<typeof totpCodeRequestSchema>;

/** GET /api/v1/auth/me */
export const meResponseSchema = z.object({ user: authUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

// ---------------------------------------------------------------------------
// 节点（v3：endpoint 是 Agent 的 HTTPS 地址，可为直连或隧道）
// ---------------------------------------------------------------------------

export const preferredRouteSchema = z.enum(['direct', 'tunnel']);
export type PreferredRoute = z.infer<typeof preferredRouteSchema>;

/**
 * 节点接入方式（唯一入口语义）：
 * - domain：域名 + ACME 公网证书，Agent 监听 443/自定义 HTTPS 端口；
 * - tunnel：Cloudflare Tunnel，Agent 只监听回环，面板安装 cloudflared；
 * - ip：裸 IP 直连（仅 http，需显式 allowInsecure）。
 */
export const nodeAccessModeSchema = z.enum(['domain', 'tunnel', 'ip']);
export type NodeAccessMode = z.infer<typeof nodeAccessModeSchema>;

export const nodeStatusSchema = z.enum(['unknown', 'online', 'offline']);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

/**
 * 节点应用摘要（2026-11-10）：全部由 D1 期望配置派生，零节点连接。
 * 未配置的项为 null，UI 不渲染（显示即开启）；只有 GET /nodes 与 GET /nodes/:id 携带。
 */
export const nodeAppSummarySchema = z.object({
  /** 期望模式：wg=组网节点，caddy=Caddy 网关，null=未配置 WireGuard */
  mode: z.enum(['wg', 'caddy']).nullable(),
  /** WireGuard 开启时的 Peer 总数（含停用）；未开启/未配置为 null */
  peers: z.number().int().nonnegative().nullable(),
  /** 已发布站点计数（total 含停用）；无站点为 null */
  sites: z
    .object({
      total: z.number().int().nonnegative(),
      disabled: z.number().int().nonnegative(),
    })
    .nullable(),
  /** 端口转发规则数；无规则为 null */
  forwards: z.number().int().nonnegative().nullable(),
});
export type NodeAppSummary = z.infer<typeof nodeAppSummarySchema>;

export const nodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  tunnelEndpoint: z.string().nullable(),
  /** 6.4a 观测层入口（如 https://hub.example.com）；空表示不启用直连观测 */
  liveEndpoint: z.string().nullable(),
  /** 面板代建 DNS 时选定的域名（如 hub.example.com）；未绑定为 null */
  domain: z.string().nullable().optional(),
  /** 接入方式；服务端总会返回，默认值仅用于兼容旧客户端/旧 fixture */
  accessMode: nodeAccessModeSchema.default('domain'),
  /** 引用的全局隧道 id（accessMode=tunnel 时有值） */
  tunnelId: z.string().nullable().default(null),
  /** 是否允许明文 http 入口（IP 直连模式必须为 true） */
  allowInsecure: z.boolean().default(false),
  preferredRoute: preferredRouteSchema,
  status: nodeStatusSchema,
  lastSeenAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** D1 派生应用摘要；仅列表与详情路由返回，创建/修改响应不带 */
  summary: nodeAppSummarySchema.optional(),
});
export type Node = z.infer<typeof nodeSchema>;

/** Agent 入口地址：允许域名或裸 IP（IP 由 Worker 走 TCP socket，域名走 fetch） */
const endpointUrlSchema = z
  .string()
  .trim()
  .url()
  .max(255)
  .regex(/^https?:\/\//i, '必须是 http(s) 地址');

/** POST /api/v1/nodes：响应里一次性返回 token（之后不再回显） */
export const createNodeRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** tunnel 模式可省略：服务端用隧道域名推导为 https://<hostname> */
  endpoint: endpointUrlSchema.optional(),
  tunnelEndpoint: endpointUrlSchema.optional(),
  liveEndpoint: endpointUrlSchema.optional(),
  /** 选用已有 CF 解析记录时写入节点域名（不新建 DNS 记录） */
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/, '域名格式不正确')
    .optional(),
  /** 接入方式；不传时按 tunnelId / endpoint 协议推导 */
  accessMode: nodeAccessModeSchema.optional(),
  /** 引用全局隧道配置（accessMode=tunnel 时必填） */
  tunnelId: z.string().trim().min(1).max(64).nullish(),
  preferredRoute: preferredRouteSchema.optional(),
  /** 允许明文 http 入口（IP 直连模式）；生产环境仅此项为 true 时跳过 https 门禁 */
  allowInsecure: z.boolean().optional(),
});
export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;

/** PATCH /api/v1/nodes/:id */
export const updateNodeRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  endpoint: endpointUrlSchema.optional(),
  tunnelEndpoint: endpointUrlSchema.nullish(),
  liveEndpoint: endpointUrlSchema.nullish(),
  /** 改接入方式时同步绑定域名；传 null 表示清除（如切回裸 IP / 自定义入口） */
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/, '域名格式不正确')
    .nullish(),
  preferredRoute: preferredRouteSchema.optional(),
  /** 接入方式；改为 tunnel 时必须同时给出 tunnelId，改为 ip 时必须 allowInsecure=true */
  accessMode: nodeAccessModeSchema.optional(),
  tunnelId: z.string().trim().min(1).max(64).nullish(),
  allowInsecure: z.boolean().optional(),
  /** 轮换节点 token（明文，仅在请求中出现；存储走加密 tokenEnc，审计只记 tokenRotated） */
  token: z.string().trim().min(16).max(128).optional(),
});
export type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;

export const nodeResponseSchema = z.object({ node: nodeSchema });
export type NodeResponse = z.infer<typeof nodeResponseSchema>;

export const nodeWithTokenResponseSchema = z.object({
  node: nodeSchema,
  token: z.string().min(1),
});
export type NodeWithTokenResponse = z.infer<typeof nodeWithTokenResponseSchema>;

export const nodeListResponseSchema = z.object({ nodes: z.array(nodeSchema) });
export type NodeListResponse = z.infer<typeof nodeListResponseSchema>;

// ---------------------------------------------------------------------------
// 全局隧道配置（PR1）：面板只存「域名 / 源站端口 / Token」，不做 CF Tunnel CRUD
// ---------------------------------------------------------------------------

/** 隧道对外域名（CNAME 指向 <id>.cfargotunnel.com，橙云）。 */
export const tunnelHostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/, '域名格式不正确');

export const tunnelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hostname: z.string().min(1),
  /** Agent 在本机监听的端口（cloudflared 回源 127.0.0.1:<originPort>） */
  originPort: z.number().int().min(1).max(65535),
  /** 是否已保存可解密的 Token（响应永不回显明文） */
  hasToken: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Tunnel = z.infer<typeof tunnelSchema>;

export const tunnelListResponseSchema = z.object({ tunnels: z.array(tunnelSchema) });
export type TunnelListResponse = z.infer<typeof tunnelListResponseSchema>;

export const tunnelResponseSchema = z.object({ tunnel: tunnelSchema });
export type TunnelResponse = z.infer<typeof tunnelResponseSchema>;

export const createTunnelRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  hostname: tunnelHostnameSchema,
  originPort: z.number().int().min(1).max(65535).default(8880),
  /** cloudflared token；只写不读 */
  token: z.string().trim().min(20).max(4096),
});
export type CreateTunnelRequest = z.infer<typeof createTunnelRequestSchema>;

export const updateTunnelRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  hostname: tunnelHostnameSchema.optional(),
  originPort: z.number().int().min(1).max(65535).optional(),
  /** 不传 = 保留已存 Token */
  token: z.string().trim().min(20).max(4096).optional(),
});
export type UpdateTunnelRequest = z.infer<typeof updateTunnelRequestSchema>;

/**
 * POST /api/v1/nodes/probe：一次请求探测全部节点（首页打开时只发一次）。
 * 单个节点失败只影响自己这一项（reachable:false），整体始终 200。
 */
export const nodeProbeAppSchema = z.object({
  name: z.string().min(1),
  /** 适配器自报是否已安装；未上报为 null（不伪造） */
  installed: z.boolean().nullable(),
  /** 适配器自报是否运行中；未上报为 null */
  running: z.boolean().nullable(),
});
export type NodeProbeApp = z.infer<typeof nodeProbeAppSchema>;

export const nodeProbeItemSchema = z.object({
  id: z.string().min(1),
  reachable: z.boolean(),
  route: preferredRouteSchema.nullable(),
  via: z.enum(['fetch', 'tcp']).nullable(),
  error: z.string().nullable(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  /**
   * 适配器实装/运行状态（来自 /state，只含名称与布尔值，不含任何 secrets）。
   * 节点不可达或 /state 解析失败时缺失；前端据 D1 摘要与它的差集表达
   * 「实装未纳管」与「D1 有、实装无」。
   */
  apps: z.array(nodeProbeAppSchema).optional(),
});
export type NodeProbeItem = z.infer<typeof nodeProbeItemSchema>;

export const nodeProbeResponseSchema = z.object({
  probedAt: z.number().int().nonnegative(),
  nodes: z.array(nodeProbeItemSchema),
});
export type NodeProbeResponse = z.infer<typeof nodeProbeResponseSchema>;

// ---------------------------------------------------------------------------
// 应用配置 / Agent 契约（Worker 对 config 只存储不解析）
// ---------------------------------------------------------------------------

/** 最近一次 apply 失败摘要（D6：app_configs.last_apply_error） */
export const appApplyErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
  at: z.number().int().nonnegative().optional(),
});
export type AppApplyError = z.infer<typeof appApplyErrorSchema>;

export const appConfigSchema = z.object({
  app: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()),
  rev: z.number().int().nonnegative(),
  appliedRev: z.number().int().nonnegative().nullable(),
  /** 最近一次 apply 失败的错误摘要；成功 apply / 重新保存配置后为 null */
  lastApplyError: appApplyErrorSchema.nullable().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

/** PUT /api/v1/nodes/:id/apps/:app */
export const putAppConfigRequestSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  schemaVersion: z.number().int().positive().default(1),
  note: z.string().max(255).optional(),
});
export type PutAppConfigRequest = z.infer<typeof putAppConfigRequestSchema>;

export const appConfigResponseSchema = z.object({ app: appConfigSchema });
export type AppConfigResponse = z.infer<typeof appConfigResponseSchema>;

export const appConfigListResponseSchema = z.object({
  apps: z.array(appConfigSchema),
  adapters: z.array(
    z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        api: z.number().int().positive(),
      })
      .passthrough(),
  ),
  adaptersError: z.string().nullable(),
});
export type AppConfigListResponse = z.infer<typeof appConfigListResponseSchema>;

export const revisionSchema = z.object({
  app: z.string().min(1),
  rev: z.number().int().nonnegative(),
  config: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type Revision = z.infer<typeof revisionSchema>;

export const revisionListResponseSchema = z.object({
  revisions: z.array(revisionSchema),
});
export type RevisionListResponse = z.infer<typeof revisionListResponseSchema>;

/** POST /api/v1/nodes/:id/apps/:app/:action 的请求体 */
export const appActionRequestSchema = z.object({
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type AppActionRequest = z.infer<typeof appActionRequestSchema>;

// ---------------------------------------------------------------------------
// Agent 返回的通用信封（Worker 原样透传，前端通用组件渲染）
// ---------------------------------------------------------------------------

export const agentErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AgentError = z.infer<typeof agentErrorSchema>;

export const resultCardSchema = z.object({
  title: z.string().min(1),
  value: z.string(),
  copy: z.boolean().optional(),
  qr: z.boolean().optional(),
});
export type ResultCard = z.infer<typeof resultCardSchema>;

export const fileChangeSchema = z.object({
  path: z.string().min(1),
  diff: z.string(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const agentEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    rev: z.number().int().nonnegative().optional(),
    appliedRev: z.number().int().nonnegative().optional(),
    /** D-2/T2.2：Agent 当前持久化的 rev epoch（apply 响应回传；未采纳时缺省） */
    epoch: z.string().min(1).max(128).optional(),
    changes: z.array(fileChangeSchema).optional(),
    warnings: z.array(z.string()).optional(),
    result: z
      .object({ cards: z.array(resultCardSchema).optional() })
      .passthrough()
      .optional(),
    taskId: z.string().optional(),
    error: agentErrorSchema.nullable().optional(),
  })
  .passthrough();
export type AgentEnvelope = z.infer<typeof agentEnvelopeSchema>;

export const taskStateSchema = z.enum(['pending', 'running', 'done', 'error', 'canceled']);
export type TaskState = z.infer<typeof taskStateSchema>;

export const agentTaskSchema = z
  .object({
    id: z.string().min(1),
    state: taskStateSchema,
    progress: z.number().optional(),
    logs: z.array(z.string()).optional(),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    error: agentErrorSchema.nullable().optional(),
  })
  .passthrough();
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const taskResponseSchema = z.object({ task: agentTaskSchema });
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/**
 * B3：任务摘要（随 /state 与 10 秒快照下发，可选字段）。
 * 只含状态/进度/末几行脱敏日志，不含 result 与 error.details。
 */
export const agentTaskSummarySchema = z.object({
  id: z.string().min(1),
  app: z.string().min(1),
  action: z.string().min(1),
  state: taskStateSchema,
  progress: z.number().int().min(0).max(100),
  /** Unix 秒 */
  createdAt: z.number().int().nonnegative(),
  /** Unix 秒 */
  updatedAt: z.number().int().nonnegative(),
  /** 末几行日志；Agent 侧已脱敏与截断 */
  logs: z.array(z.string()),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
});
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;

export const agentTasksSchema = z.object({
  items: z.array(agentTaskSummarySchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AgentTasks = z.infer<typeof agentTasksSchema>;

export const adapterInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    api: z.number().int().positive(),
    requiresRoot: z.boolean().optional(),
    requires_root: z.boolean().optional(),
    // Agent 返回动作元数据（对象）；兼容旧的字符串数组
    actions: z
      .union([z.array(z.string()), z.record(z.string(), z.unknown())])
      .optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    /** P1：Agent 能力声明（如 {pkgInstall:true, recipeInstall:true}）；旧 Agent 缺省。 */
    capabilities: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;

export const adapterStateSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    appliedRev: z.number().int().nonnegative().nullable().optional(),
    status: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AdapterState = z.infer<typeof adapterStateSchema>;

export const portEntrySchema = z.object({
  proto: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  app: z.string().min(1),
});
export type PortEntry = z.infer<typeof portEntrySchema>;

export const agentHostSchema = z
  .object({
    hostname: z.string().optional(),
    os: z.string().optional(),
    kernel: z.string().optional(),
    uptime: z.number().optional(),
    load: z.array(z.number()).optional(),
    disk: z.record(z.string(), z.unknown()).optional(),
    mem: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentHost = z.infer<typeof agentHostSchema>;


export const agentOpsSchema = z
  .object({
    cpu: z
      .object({
        cores: z.number().int().nonnegative().optional(),
        model: z.string().nullable().optional(),
        usagePercent: z.number().nullable().optional(),
        load: z.array(z.number()).nullable().optional(),
      })
      .partial()
      .optional(),
    mem: z
      .object({
        total: z.number().optional(),
        used: z.number().optional(),
        available: z.number().optional(),
        percent: z.number().optional(),
      })
      .partial()
      .nullable()
      .optional(),
    swap: z.record(z.string(), z.unknown()).nullable().optional(),
    disks: z
      .array(
        z
          .object({
            name: z.string().optional(),
            path: z.string().optional(),
            total: z.number().optional(),
            used: z.number().optional(),
            free: z.number().optional(),
            percent: z.number().optional(),
            inodesPercent: z.number().nullable().optional(),
          })
          .partial(),
      )
      .optional(),
    network: z.record(z.string(), z.unknown()).nullable().optional(),
    services: z
      .object({
        services: z.array(z.object({ name: z.string(), state: z.string() })).optional(),
        failedUnits: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    processes: z
      .array(
        z
          .object({
            pid: z.number().int().optional(),
            name: z.string().optional(),
            cpu: z.number().optional(),
            mem: z.number().optional(),
          })
          .partial(),
      )
      .optional(),
    rebootRequired: z.boolean().optional(),
    collectedAt: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type AgentOps = z.infer<typeof agentOpsSchema>;

/** D7：Agent 自身上报（向后兼容的可选字段） */
export const agentSelfSchema = z
  .object({
    version: z.string().min(1).max(64),
    /** Agent 当前 Unix 秒（用于诊断时钟偏差） */
    serverTime: z.number().int().nonnegative(),
    /** 从 wireguard 已生效配置 enabled 派生；未配置时不返回 */
    mode: z.enum(['wg', 'caddy']).optional(),
    /** D-2/T2.2：Agent 持久化的 rev epoch；旧 Agent（<0.1.13）不返回（Worker 按"待升级"处理） */
    epoch: z.string().min(1).max(128).optional(),
    /** Agent 自身 TLS 监听状态（仅 `--tls-cert` 启用时出现；方案 A 由 Caddy 终止 TLS 时不上报） */
    tls: z
      .object({
        enabled: z.boolean(),
        notAfter: z.number().int().nonnegative().optional(),
        names: z.array(z.string()).optional(),
        error: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type AgentSelf = z.infer<typeof agentSelfSchema>;

export const agentStateSchema = z
  .object({
    host: agentHostSchema,
    adapters: z.array(adapterStateSchema),
    ports: z.array(portEntrySchema),
    ops: agentOpsSchema.optional(),
    agent: agentSelfSchema.optional(),
    /** B3：任务摘要；旧 Agent 不返回（前端降级为「升级后可见」） */
    tasks: agentTasksSchema.optional(),
  })
  .passthrough();
export type AgentState = z.infer<typeof agentStateSchema>;

/** GET /api/v1/nodes/:id/state */
export const nodeStateResponseSchema = z.object({
  reachable: z.boolean(),
  route: preferredRouteSchema.nullable(),
  /** fetch = 域名/标准端口；tcp = 裸 IP / 非标端口（cloudflare:sockets） */
  via: z.enum(['fetch', 'tcp']).nullable(),
  state: agentStateSchema.nullable(),
  error: z.string().nullable(),
  /**
   * D-2/T2.2：Agent 回传的 epoch 与节点当前 rev_epoch 不一致 = "旧纪元"
   * （Agent 记着被删/被恢复前控制面的 rev 基线）。下一次 apply 会自动重置
   * Agent 基线并重新下发。旧 Agent 不回传 epoch 时不判定（视为待升级）。
   */
  epochStale: z.boolean().optional(),
});
export type NodeStateResponse = z.infer<typeof nodeStateResponseSchema>;

/**
 * 轻量快照（10s 轮询用）：只含主机指标与 CPU/内存/磁盘/负载，
 * 不含适配器状态/端口等需要子进程或网络探测的字段（那些走 `/state` 一次性探测）。
 */
export const agentSnapshotSchema = z
  .object({
    host: agentHostSchema.optional(),
    ops: agentOpsSchema.optional(),
    agent: agentSelfSchema.optional(),
    /** B3：任务摘要（进行中 + 最近终态，有上限）；旧 Agent 不返回 */
    tasks: agentTasksSchema.optional(),
    /** Agent 采集时刻（Unix 秒） */
    ts: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;

/** GET /api/v1/nodes/:id/snapshot（无域名节点的控制面转发通道） */
export const nodeSnapshotResponseSchema = z.object({
  reachable: z.boolean(),
  route: preferredRouteSchema.nullable(),
  via: z.enum(['fetch', 'tcp']).nullable(),
  snapshot: agentSnapshotSchema.nullable(),
  error: z.string().nullable(),
  /** 命中 Worker 2 秒去重（多标签页合并）时为 true */
  cached: z.boolean().optional(),
});
export type NodeSnapshotResponse = z.infer<typeof nodeSnapshotResponseSchema>;

/** POST /api/v1/nodes/:id/apps/:app/rollback/:rev */
export const rollbackResponseSchema = z.object({
  ok: z.literal(true),
  app: appConfigSchema,
  appliedRev: z.number().int().nonnegative().nullable(),
});
export type RollbackResponse = z.infer<typeof rollbackResponseSchema>;


// ---------------------------------------------------------------------------
// C4：备份 / 恢复（节点全拓扑，不含私钥/证书 PEM）
// ---------------------------------------------------------------------------

export const backupAppSchema = z.object({
  app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  schemaVersion: z.number().int().positive().default(1),
  config: z.record(z.string(), z.unknown()),
});
export type BackupApp = z.infer<typeof backupAppSchema>;

export const backupManifestSchema = z.object({
  /** 导出时按字段名剥离的键（小写）；导入时不会接受这些键的新值。 */
  stripped: z.array(z.string()).default([]),
  /** 当前主密钥 id（来自 MASTER_ENC_KEY_ID，缺省 k1）；灾备恢复时先核对。 */
  encKeyId: z.string().min(1).default('k1'),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const backupExportSchema = z.object({
  format: z.literal('khc-backup/v1'),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  manifest: backupManifestSchema.optional(),
  node: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    endpoint: z.string().min(1),
    tunnelEndpoint: z.string().nullable(),
    liveEndpoint: z.string().nullable(),
    preferredRoute: preferredRouteSchema,
  }),
  apps: z.array(backupAppSchema),
});
export type BackupExport = z.infer<typeof backupExportSchema>;

export const backupImportRequestSchema = backupExportSchema;
export type BackupImportRequest = z.infer<typeof backupImportRequestSchema>;

export const backupImportResponseSchema = z.object({
  ok: z.literal(true),
  nodeId: z.string().min(1),
  apps: z.array(
    z.object({
      app: z.string().min(1),
      rev: z.number().int().nonnegative(),
      schemaVersion: z.number().int().positive(),
    }),
  ),
});
export type BackupImportResponse = z.infer<typeof backupImportResponseSchema>;

// ---------------------------------------------------------------------------
// C3：证书库（全局）
// ---------------------------------------------------------------------------

export const certificateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domains: z.array(z.string().min(1)),
  issuer: z.string().nullable(),
  notAfter: z.number().int().nonnegative().nullable(),
  sourceNodeId: z.string().nullable(),
  /** ACME 签发参数（只含非敏感元数据：provider / 设置键 / CA / 密钥类型） */
  acmeProvider: z.string().nullable().optional(),
  acmeCredentialKey: z.string().nullable().optional(),
  acmeCa: z.string().nullable().optional(),
  acmeKeyType: z.enum(['rsa', 'ec']).nullable().optional(),
  /** 能一键续期：来源节点 + provider + 凭据键齐全 */
  renewable: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Certificate = z.infer<typeof certificateSchema>;

const certificateAcmeMetaSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  credentialKey: z.string().trim().min(1).max(128),
  ca: z.string().trim().max(512).optional(),
  keyType: z.enum(['rsa', 'ec']).optional(),
});

export const createCertificateRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  domains: z.array(z.string().trim().min(1).max(255)).min(1),
  issuer: z.enum(['acme', 'selfsigned', 'manual']).default('manual'),
  notAfter: z.number().int().nonnegative().optional(),
  certPem: z.string().min(1).max(64 * 1024),
  keyPem: z.string().min(1).max(64 * 1024),
  sourceNodeId: z.string().trim().max(128).optional(),
  /** ACME 签发时记录参数，供后续一键续期 */
  acme: certificateAcmeMetaSchema.optional(),
});
export type CreateCertificateRequest = z.infer<typeof createCertificateRequestSchema>;

/** 续期成功后替换证书材料（元数据沿用，不需要重新提交） */
export const updateCertificateRequestSchema = z.object({
  certPem: z.string().min(1).max(64 * 1024),
  keyPem: z.string().min(1).max(64 * 1024),
  notAfter: z.number().int().nonnegative().optional(),
  domains: z.array(z.string().trim().min(1).max(255)).min(1).optional(),
  issuer: z.enum(['acme', 'selfsigned', 'manual']).optional(),
});
export type UpdateCertificateRequest = z.infer<typeof updateCertificateRequestSchema>;

/** 把证书安装到节点的 Agent TLS 目录并热重载 */
export const bindCertificateRequestSchema = z.object({
  nodeId: z.string().trim().min(1).max(128),
});
export type BindCertificateRequest = z.infer<typeof bindCertificateRequestSchema>;

export const certificateBindResponseSchema = z.object({
  ok: z.boolean(),
  nodeId: z.string().min(1),
  certPath: z.string().nullable(),
  keyPath: z.string().nullable(),
  notAfter: z.number().int().nonnegative().nullable(),
  reloaded: z.boolean(),
  restartRequired: z.boolean(),
  message: z.string().nullable(),
});
export type CertificateBindResponse = z.infer<typeof certificateBindResponseSchema>;


export const certificateResponseSchema = z.object({ certificate: certificateSchema });
export type CertificateResponse = z.infer<typeof certificateResponseSchema>;
export const certificateListResponseSchema = z.object({ certificates: z.array(certificateSchema) });
export type CertificateListResponse = z.infer<typeof certificateListResponseSchema>;
export const certificateMaterialResponseSchema = z.object({
  id: z.string().min(1),
  domains: z.array(z.string()),
  certPem: z.string(),
  keyPem: z.string(),
});
export type CertificateMaterialResponse = z.infer<typeof certificateMaterialResponseSchema>;

// ---------------------------------------------------------------------------
// P4：全局 SSH 公钥库（只存公钥，绝不存私钥）
// ---------------------------------------------------------------------------

export const sshKeySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  publicKey: z.string().min(1),
  fingerprint: z.string().min(1),
  comment: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type SshKey = z.infer<typeof sshKeySchema>;

export const createSshKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  publicKey: z.string().trim().min(1).max(8 * 1024),
});
export type CreateSshKeyRequest = z.infer<typeof createSshKeyRequestSchema>;

export const updateSshKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
});
export type UpdateSshKeyRequest = z.infer<typeof updateSshKeyRequestSchema>;

export const sshKeyResponseSchema = z.object({ sshKey: sshKeySchema });
export type SshKeyResponse = z.infer<typeof sshKeyResponseSchema>;
export const sshKeyListResponseSchema = z.object({ sshKeys: z.array(sshKeySchema) });
export type SshKeyListResponse = z.infer<typeof sshKeyListResponseSchema>;

// ---------------------------------------------------------------------------
// C3：全局设置（只写不读，列表脱敏）
// ---------------------------------------------------------------------------

export const settingKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/i, '设置键只允许字母/数字/._-');

export const settingSchema = z.object({
  key: settingKeySchema,
  updatedAt: z.number().int().nonnegative(),
});
export type Setting = z.infer<typeof settingSchema>;

export const settingsListResponseSchema = z.object({ settings: z.array(settingSchema) });
export type SettingsListResponse = z.infer<typeof settingsListResponseSchema>;

export const putSettingRequestSchema = z.object({
  value: z.unknown(),
});
export type PutSettingRequest = z.infer<typeof putSettingRequestSchema>;

// ---------------------------------------------------------------------------
// 6.4a：浏览器观测层票据（服务端凭证；浏览器只拿 ticket）
// ---------------------------------------------------------------------------

export const liveTicketRequestSchema = z.object({
  /** snap：15 分钟可复用的快照轮询票（10s 轮询不重复换票） */
  scope: z.enum(['live', 'nudge', 'snap']).default('live'),
  /** 浏览器页面 Origin；Hub 用它校验观测请求来源 */
  origin: z.string().trim().max(255).optional(),
});
export type LiveTicketRequest = z.infer<typeof liveTicketRequestSchema>;

export const liveTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  livePath: z.string().min(1),
  /** 浏览器直连快照路径（scope=snap） */
  snapshotPath: z.string().min(1).optional(),
});
export type LiveTicketResponse = z.infer<typeof liveTicketResponseSchema>;

// ---------------------------------------------------------------------------
// C4：诊断（只读；错误码目录 + 运行时检查）
// 见 docs/diagnostics.md §4.1 / §4.2
// ---------------------------------------------------------------------------

/**
 * 核心诊断只覆盖连接与 Agent；应用问题由适配器通过 `problems` 上报，
 * 核心只做通用渲染与排序。见 docs/diagnostics.md §3。
 */
export const diagnosticLayerSchema = z.enum(['transport', 'agent', 'config']);
export type DiagnosticLayer = z.infer<typeof diagnosticLayerSchema>;

export const diagnosticFixModeSchema = z.enum(['action', 'config', 'manual']);
export type DiagnosticFixMode = z.infer<typeof diagnosticFixModeSchema>;

export const diagnosticHintCheckSchema = z.object({
  text: z.string().min(1).max(200),
  kind: z.enum(['auto', 'manual']),
  /** 只读命令：仅展示/复制，Worker 永远不执行 */
  command: z.string().max(300).optional(),
});
export type DiagnosticHintCheck = z.infer<typeof diagnosticHintCheckSchema>;

export const diagnosticHintFixSchema = z.object({
  mode: diagnosticFixModeSchema,
  label: z.string().min(1).max(24),
  actionId: z.string().max(64).optional(),
  level: z.enum(['L1', 'L2', 'L3']).optional(),
  route: z.string().max(200).optional(),
});
export type DiagnosticHintFix = z.infer<typeof diagnosticHintFixSchema>;

export const diagnosticHintSchema = z.object({
  code: z.string().regex(/^khc\.[a-z]+\.[a-z0-9_]+$/),
  layer: diagnosticLayerSchema,
  severity: z.enum(['info', 'warn', 'error']),
  title: z.string().min(1).max(40),
  summary: z.string().min(1).max(80),
  impact: z.string().min(1).max(80),
  aliases: z.array(z.string().max(64)).max(8),
  causes: z.array(z.string().max(160)).min(1).max(6),
  checks: z.array(diagnosticHintCheckSchema).min(1).max(8),
  fixes: z.array(diagnosticHintFixSchema).max(6),
  readOnly: z.boolean(),
  doc: z.string().max(120),
});
export type DiagnosticHint = z.infer<typeof diagnosticHintSchema>;

export const diagnosticHintsResponseSchema = z.object({
  hintsVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  hints: z.array(diagnosticHintSchema),
});
export type DiagnosticHintsResponse = z.infer<typeof diagnosticHintsResponseSchema>;

/** 诊断只展示问题，不再有 ok / unknown 行。 */
export const diagnosticSeveritySchema = z.enum(['info', 'warn', 'error']);
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;

export const diagnosticEvidenceValueSchema = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type DiagnosticEvidenceValue = z.infer<typeof diagnosticEvidenceValueSchema>;

/** 诊断里“下一步可以做什么”的动作引用（由前端动作注册表执行）。 */
export const diagnosticActionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(24).optional(),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
export type DiagnosticAction = z.infer<typeof diagnosticActionSchema>;

/**
 * 适配器 status().problems 的条目（Agent 原样上报）。
 * `code` 是应用内的稳定 slug（如 `interface_down`），核心渲染时补上应用命名空间。
 */
export const adapterProblemSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(48),
  severity: diagnosticSeveritySchema,
  title: z.string().min(1).max(40),
  hint: z.string().max(1000).optional(),
  action: diagnosticActionSchema.optional(),
  evidence: z.record(z.string().max(64), diagnosticEvidenceValueSchema).optional(),
});
export type AdapterProblem = z.infer<typeof adapterProblemSchema>;

export const diagnosticCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  code: z.string().regex(/^khc\.[a-z][a-z0-9-]*\.[a-z0-9_]+$/),
  severity: diagnosticSeveritySchema,
  title: z.string().min(1).max(40),
  detail: z.string().max(300),
  /** 应用问题的归属应用（适配器 name）；核心码不带该字段。 */
  app: z.string().max(64).optional(),
  evidence: z.record(z.string().max(64), diagnosticEvidenceValueSchema).optional(),
  actions: z.array(diagnosticActionSchema).max(3).optional(),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;

export const nodeDiagnosticsResponseSchema = z.object({
  nodeId: z.string().min(1),
  generatedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  hintsVersion: z.string(),
  reachable: z.boolean(),
  route: preferredRouteSchema.nullable(),
  via: z.enum(['fetch', 'tcp']).nullable(),
  checks: z.array(diagnosticCheckSchema),
  truncated: z.boolean().optional(),
});
export type NodeDiagnosticsResponse = z.infer<typeof nodeDiagnosticsResponseSchema>;

// ---------------------------------------------------------------------------
// C4：双模式预检（docs/dual-mode.md §6.1）
// ---------------------------------------------------------------------------

export const modeIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fixRoute: z.string().optional(),
  /** 阻断/影响的机器可读细节（例如冲突的 proto/port/occupiedBy）。 */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ModeIssue = z.infer<typeof modeIssueSchema>;

/** 节点模式只剩 3 态：wg / caddy / unknown（Agent 不可达或未配置）。 */
export const nodeModeValueSchema = z.enum(['wg', 'caddy', 'unknown']);
export type NodeModeValue = z.infer<typeof nodeModeValueSchema>;

export const modeTargetSchema = z.enum(['wg', 'caddy']);
export type ModeTarget = z.infer<typeof modeTargetSchema>;

export const nodeModeSchema = z.object({
  nodeId: z.string().min(1),
  mode: nodeModeValueSchema,
  /** 下一个可切换到的模式；unknown 时为 null。 */
  target: modeTargetSchema.nullable(),
  reachable: z.boolean(),
  blockers: z.array(modeIssueSchema),
  warnings: z.array(modeIssueSchema),
  checkedAt: z.number().int().nonnegative(),
});
export type NodeMode = z.infer<typeof nodeModeSchema>;

// ---------------------------------------------------------------------------
// C5：Agent 生命周期命令生成（docs/agent-lifecycle.md）
// Worker 只生成可复制的 shell 命令，不远程执行；命令内含一次性节点 token，
// 因此响应必须 no-store，且审计只记 type/mode，不记 command/token。
// ---------------------------------------------------------------------------

export const agentCommandModeSchema = z.enum(['system', 'user']);
export type AgentCommandMode = z.infer<typeof agentCommandModeSchema>;

/** 安装/升级/卸载（审计用）。 */
export const agentCommandTypeSchema = z.enum(['install', 'upgrade', 'uninstall']);
export type AgentCommandType = z.infer<typeof agentCommandTypeSchema>;

/** 包下载地址：必须 https、无空白/控制字符、≤2048，且禁止引号/反引号（防 shell 注入）。 */
export const agentPackageUrlSchema = z
  .string()
  .min(1, 'packageUrl 不能为空')
  .max(2048, 'packageUrl 不能超过 2048 字符')
  // 注意：zod 的 .url() 会规范化输入（例如吞掉换行），因此空白/控制字符
  // 必须在 .url() 之前按原始字符串拒绝，否则 "https://a/a\n.tgz" 会被悄悄修正。
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), 'packageUrl 不允许空白或控制字符')
  .refine((value) => !/['`]/.test(value), 'packageUrl 不允许引号或反引号')
  .url('packageUrl 必须是合法 URL')
  .regex(/^https:\/\//i, 'packageUrl 必须是 https 地址');

/** 包校验和：64 位 hex，统一转小写。 */
export const agentSha256Schema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, 'sha256 必须是 64 位 hex')
  .transform((value) => value.toLowerCase());

/** POST /api/v1/nodes/:id/agent/{install,upgrade}-command */
/** 安装命令的可选组件（P0-1）：与 install.sh 的 --with-caddy/--tls/--tls-cn 对齐。 */
export const agentInstallOptionsSchema = z.object({
  withCaddy: z.boolean().optional(),
  tls: z.boolean().optional(),
  /** 自签证书 CN：域名形态，禁止空白/引号/控制字符（会拼进 shell 命令） */
  tlsCn: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.*-]+$/, '证书 CN 只允许域名形态字符（字母/数字/./-/*）')
    .optional(),
});
export type AgentInstallOptions = z.output<typeof agentInstallOptionsSchema>;

export const agentCommandRequestSchema = z.object({
  mode: agentCommandModeSchema,
  packageUrl: agentPackageUrlSchema,
  sha256: agentSha256Schema,
  /** 仅安装命令使用：附加 --with-caddy/--tls/--tls-cn（默认不带，避免装进不需要的组件） */
  installOptions: agentInstallOptionsSchema.optional(),
});
export type AgentCommandRequest = z.input<typeof agentCommandRequestSchema>;
export type AgentCommandPayload = z.output<typeof agentCommandRequestSchema>;

/**
 * POST /api/v1/nodes/:id/agent/uninstall-command。
 * 卸载只需要下载 uninstall.sh：调用方可不传包信息，由 Worker 用已签名的最新发布包注入。
 * 过渡期仍接受显式 packageUrl/sha256（旧客户端/手工高级路径）。
 */
export const agentUninstallCommandRequestSchema = z.object({
  mode: agentCommandModeSchema,
  packageUrl: agentPackageUrlSchema.optional(),
  sha256: agentSha256Schema.optional(),
  purge: z.boolean().default(false),
});
export type AgentUninstallCommandRequest = z.input<typeof agentUninstallCommandRequestSchema>;
export type AgentUninstallCommandPayload = z.output<typeof agentUninstallCommandRequestSchema>;
/** 命名别名（同一 schema，便于调用方按 uninstall 语义导入）。 */
export const agentCommandUninstallRequestSchema = agentUninstallCommandRequestSchema;

/** 响应：{command, mode, packageUrl, sha256}；token 只在 command 里。 */
export const agentCommandResponseSchema = z.object({
  command: z.string().min(1).max(20_000),
  mode: agentCommandModeSchema,
  packageUrl: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** 仅 install-command 返回：长期节点 token，由 UI 单独展示/复制，不写入 shell 命令。 */
  token: z.string().min(1).max(512).optional(),
});
export type AgentCommandResponse = z.infer<typeof agentCommandResponseSchema>;

// ---------------------------------------------------------------------------
// C5 阶段二：Agent 拉取式自升级/重装（docs/agent-lifecycle.md §7）
// Worker 只转发一次 POST；审计只记 url host 与 sha 前缀，不记完整 URL/token。
// ---------------------------------------------------------------------------

export const agentUpgradeRequestSchema = z.object({
  packageUrl: agentPackageUrlSchema,
  sha256: agentSha256Schema,
  /** 允许目标版本 == 当前版本（重装）；升级默认拒绝同版本。 */
  reinstall: z.boolean().default(false),
  /**
   * A-5：签名清单原文（AGENT_RELEASE_MANIFEST secret 的字符串）。服务端
   * （Worker）原样转发给 Agent；Agent 用包内内置公钥独立验签——由 Worker
   * 注入，不接受面板直传，调用方无需也不应传该字段。
   */
  manifest: z.string().min(1).max(64 * 1024).optional(),
});
export type AgentUpgradeRequest = z.input<typeof agentUpgradeRequestSchema>;
export type AgentUpgradePayload = z.output<typeof agentUpgradeRequestSchema>;

/** Agent 立即返回 202 accepted；真正结果在任务 /tasks/:id 与 /state.agent.version。 */
export const agentUpgradeResponseSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.literal(true),
    taskId: z.string().min(1).optional(),
    fromVersion: z.string().min(1).optional(),
    targetVersion: z.string().min(1).optional(),
    mode: agentCommandModeSchema.optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type AgentUpgradeResponse = z.infer<typeof agentUpgradeResponseSchema>;

// ---------------------------------------------------------------------------
// Cloudflare DNS 集成（#E1 / 第 5 步）：最小权限 Token（单 Zone 的
// Zone→DNS→Edit + Zone→Zone→Read），加密存储、只写不读。
// ---------------------------------------------------------------------------

/** Zone 名（如 example.com）；只允许普通域名，禁止 URL / 通配符。 */
export const cfZoneNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, 'Zone 名必须是普通域名（如 example.com）');

export const cfDnsConfigRequestSchema = z.object({
  enabled: z.boolean(),
  zoneName: cfZoneNameSchema.nullable(),
  /** 不传 = 保留已存 Token（编辑 Zone/开关时不需重填） */
  token: z.string().trim().min(20).max(200).optional(),
});
export type CfDnsConfigRequest = z.infer<typeof cfDnsConfigRequestSchema>;

/** 状态只读：永不回显 Token 值，只报告是否已配置。 */
export const cfDnsStatusResponseSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  hasToken: z.boolean(),
  zoneName: z.string().nullable(),
});
export type CfDnsStatusResponse = z.infer<typeof cfDnsStatusResponseSchema>;

/** 单条凭据（账号）里可用的 Zone；Token 只存密文，响应永不回显。 */
export const cfDnsZoneRefSchema = z.object({ id: z.string(), name: z.string() });
export type CfDnsZoneRef = z.infer<typeof cfDnsZoneRefSchema>;

export const cfDnsAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Cloudflare 账号名（/zones 返回的 account.name；拿不到为 null） */
  accountName: z.string().nullable(),
  /** 是否已保存可解密的 Token（响应永不回显明文） */
  hasToken: z.boolean(),
  enabled: z.boolean(),
  /** Token 能看到的全部 Zone */
  zones: z.array(cfDnsZoneRefSchema),
  /** 主人勾选启用的 Zone id（子集） */
  enabledZoneIds: z.array(z.string()),
});
export type CfDnsAccount = z.infer<typeof cfDnsAccountSchema>;

export const cfDnsAccountsResponseSchema = z.object({ accounts: z.array(cfDnsAccountSchema) });
export type CfDnsAccountsResponse = z.infer<typeof cfDnsAccountsResponseSchema>;

export const cfDnsAccountCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  token: z.string().trim().min(20).max(200),
});
export type CfDnsAccountCreateRequest = z.infer<typeof cfDnsAccountCreateRequestSchema>;

export const cfDnsAccountUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  enabledZoneIds: z.array(z.string().min(1)).optional(),
});
export type CfDnsAccountUpdateRequest = z.infer<typeof cfDnsAccountUpdateRequestSchema>;

/** 添加节点时可选的 Zone（跨凭据汇总，只含已启用的）。 */
export const cfDnsZoneOptionSchema = cfDnsZoneRefSchema.extend({
  accountId: z.string(),
  accountName: z.string(),
});
export type CfDnsZoneOption = z.infer<typeof cfDnsZoneOptionSchema>;

export const cfDnsZoneListResponseSchema = z.object({ zones: z.array(cfDnsZoneOptionSchema) });
export type CfDnsZoneListResponse = z.infer<typeof cfDnsZoneListResponseSchema>;

/** 已启用 Zone 下的解析记录（只读；用于添加节点时选择已有记录）。 */
export const cfDnsZoneRecordSchema = z.object({
  id: z.string(),
  type: z.enum(['A', 'AAAA', 'CNAME']),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  comment: z.string().nullable(),
  /** comment 命中面板标记 → 面板托管；仅用于展示，不据此决定写操作 */
  managed: z.boolean(),
});
export type CfDnsZoneRecord = z.infer<typeof cfDnsZoneRecordSchema>;

export const cfDnsZoneRecordsResponseSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string(),
  records: z.array(cfDnsZoneRecordSchema),
});
export type CfDnsZoneRecordsResponse = z.infer<typeof cfDnsZoneRecordsResponseSchema>;

export const cfDnsAccountResponseSchema = z.object({
  account: cfDnsAccountSchema,
  /** 本次拉取到的全部 Zone（添加/刷新时返回，便于勾选） */
  zones: z.array(cfDnsZoneRefSchema).optional(),
});
export type CfDnsAccountResponse = z.infer<typeof cfDnsAccountResponseSchema>;

/** 测试连接：校验 Token 有效性 + Zone 可读；DNS Edit 权限在首次写记录时验证。 */
export const cfDnsTestResponseSchema = z.object({
  ok: z.literal(true),
  tokenStatus: z.string(),
  zone: z.object({ id: z.string(), name: z.string(), status: z.string() }),
});
export type CfDnsTestResponse = z.infer<typeof cfDnsTestResponseSchema>;

/** 未传 zoneId/subdomain = 旧单 Zone 路径（<节点名>.<Zone>）；传了则按所选 Zone 建记录。 */
export const cfDnsRecordCreateRequestSchema = z.object({
  nodeId: z.string().min(1).max(64),
  zoneId: z.string().min(1).max(64).optional(),
  subdomain: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, '只能是一个子域名标签')
    .optional(),
});
export type CfDnsRecordCreateRequest = z.infer<typeof cfDnsRecordCreateRequestSchema>;

/** 代建结果；created=false 表示记录已存在（幂等重入）。 */
export const cfDnsRecordResponseSchema = z.object({
  created: z.boolean(),
  record: z.object({
    id: z.string(),
    type: z.enum(['A', 'AAAA']),
    name: z.string(),
    content: z.string(),
  }),
  /** 已写入节点的域名（= record.name） */
  domain: z.string().optional(),
});
export type CfDnsRecordResponse = z.infer<typeof cfDnsRecordResponseSchema>;

export const cfDnsRecordDeleteResponseSchema = z.object({
  deleted: z.boolean(),
  /** 删除失败不阻断节点删除，错误清单回显给面板告警。 */
  errors: z.array(z.string()),
});
export type CfDnsRecordDeleteResponse = z.infer<typeof cfDnsRecordDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// 全局域名管理：单条解析记录增改删（设置页「域名」）
// ---------------------------------------------------------------------------

export const cfDnsRecordUpdateRequestSchema = z
  .object({
    type: z.enum(['A', 'AAAA', 'CNAME']).optional(),
    /** 完整记录名（如 node.example.com），必须是所选 Zone 的子域 */
    name: z.string().trim().min(1).max(253).optional(),
    content: z.string().trim().min(1).max(253).optional(),
    proxied: z.boolean().optional(),
    ttl: z.number().int().min(1).max(86400).optional(),
  })
  .refine(
    (value) =>
      value.type !== undefined ||
      value.name !== undefined ||
      value.content !== undefined ||
      value.proxied !== undefined ||
      value.ttl !== undefined,
    { message: '至少提供一个要修改的字段' },
  );
export type CfDnsRecordUpdateRequest = z.infer<typeof cfDnsRecordUpdateRequestSchema>;

export const cfDnsRecordItemResponseSchema = z.object({
  record: cfDnsZoneRecordSchema,
});
export type CfDnsRecordItemResponse = z.infer<typeof cfDnsRecordItemResponseSchema>;

/** 全局域名管理：在指定 Zone 下新建一条解析记录（不绑定节点）。 */
export const cfDnsRecordCreateForZoneRequestSchema = z.object({
  type: z.enum(['A', 'AAAA', 'CNAME']),
  /** 完整记录名（如 app.example.com），必须是所选 Zone 本身或其子域 */
  name: z.string().trim().min(1).max(253),
  content: z.string().trim().min(1).max(253),
  proxied: z.boolean().optional(),
  ttl: z.number().int().min(1).max(86400).optional(),
});
export type CfDnsRecordCreateForZoneRequest = z.infer<
  typeof cfDnsRecordCreateForZoneRequestSchema
>;
