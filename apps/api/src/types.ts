import type { AuthUser } from '@khc/contracts';
import type { AgentClient } from './lib/node-client';
import type {
  AppConfigRepo,
  AuditRepo,
  CertificateRepo,
  NodeRepo,
  SettingsRepo,
  SshKeyRepo,
  TunnelRepo,
} from './domain/repos';

export interface Env {
  /** D1 数据库 */
  DB: D1Database;
  /** 限流（可选；未绑定时退化为进程内） */
  KV?: KVNamespace;
  /** 静态资源（apps/web/dist） */
  ASSETS: Fetcher;
  /**
   * L3 构建标识（ADR-0013）：Cloudflare 官方 version metadata binding。
   * 提供 id / tag / timestamp；本地 dev 与单测可能缺省。
   */
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
  ENVIRONMENT?: string;
  /** 管理员口令哈希（pbkdf2$...）；生产必填 */
  ADMIN_PW_HASH?: string;
  /** 仅开发环境使用的明文口令（生产不读取） */
  ADMIN_PASSWORD?: string;
  /** 会话签名密钥（≥32 字节）；生产必填，缺失即 fail-closed */
  SESSION_SECRET?: string;
  /** 敏感字段 AES-GCM 密钥（token 加密）；生产必填 */
  MASTER_ENC_KEY?: string;
  /** A-11：当前密钥 id（写入 enc:v2:<keyId>: 前缀；缺省 k1；轮换时递增 k2…） */
  MASTER_ENC_KEY_ID?: string;
  /** A-11：轮换窗口内的旧密钥（只读：当前钥解不开时回退；全部行重加密后移除） */
  MASTER_ENC_KEY_PREVIOUS?: string;
  /** 可选：Agent 发布包固定前缀；设置后只接受该前缀下的 URL（#32 低成本约束） */
  AGENT_RELEASE_BASE?: string;
  /** #32：Ed25519 公钥（base64 raw）与签名清单；设置清单后只接受清单内 URL/sha */
  AGENT_RELEASE_PUBKEY?: string;
  AGENT_RELEASE_MANIFEST?: string;
  /** '1'/'true' 时强制要求清单；production 默认强制 */
  AGENT_RELEASE_REQUIRE_MANIFEST?: string;
  /** 面板对外入口白名单（逗号分隔的 origin，如 https://panel.example.com）；
   *  未配置时只允许与请求同 host 的 Origin（既有行为）。 */
  LIVE_ORIGINS?: string;
}

/** 显式依赖注入：路由只依赖仓库接口，单测可用内存实现 */
export interface AppDeps {
  nodes: NodeRepo;
  apps: AppConfigRepo;
  audit: AuditRepo;
  certs: CertificateRepo;
  settings: SettingsRepo;
  sshKeys: SshKeyRepo;
  tunnels: TunnelRepo;
  agent: AgentClient;
  /** CF DNS 集成的可注入 fetch（测试 mock；生产缺省用全局 fetch，不触达真实 CF API） */
  cfFetch?: import('./lib/cf-dns').CfFetch;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    /** 由 createApp 注入，供会话版本校验与 TOTP 读写复用同一个 settings 仓库 */
    settings: SettingsRepo;
  };
};
