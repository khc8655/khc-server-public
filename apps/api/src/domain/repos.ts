import type {
  AppApplyError,
  AppConfig,
  Certificate,
  NodeAccessMode,
  PreferredRoute,
  Revision,
  Setting,
  SshKey,
  Tunnel,
} from '@khc/contracts';
import type { AppSummaryCounts } from '../lib/node-summary';

/** 仓库内部使用的节点记录：包含加密 token，绝不直接出网 */
export interface StoredNode {
  id: string;
  name: string;
  endpoint: string;
  tunnelEndpoint: string | null;
  liveEndpoint: string | null;
  /** 面板代建 DNS 选定的域名；未绑定为 null */
  domain: string | null;
  /** 接入方式（存量行由 mapStoredNode 按 endpoint/preferredRoute 推导） */
  accessMode: NodeAccessMode;
  /** 引用的全局隧道 id */
  tunnelId: string | null;
  /** 允许明文 http 入口 */
  allowInsecure: boolean;
  preferredRoute: PreferredRoute;
  tokenEnc: string;
  /** D-2/T2.2：rev epoch（纪元），创建时生成；节点重建/恢复时换新值（公开 API 不回显） */
  revEpoch: string;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewNode {
  name: string;
  endpoint: string;
  tunnelEndpoint?: string | null;
  liveEndpoint?: string | null;
  /** 选用已有解析记录时直接写入；未选则为空 */
  domain?: string | null;
  accessMode?: NodeAccessMode;
  tunnelId?: string | null;
  allowInsecure?: boolean;
  preferredRoute?: PreferredRoute;
  tokenEnc: string;
}

export interface NodePatch {
  name?: string;
  endpoint?: string;
  tunnelEndpoint?: string | null;
  liveEndpoint?: string | null;
  domain?: string | null;
  accessMode?: NodeAccessMode;
  tunnelId?: string | null;
  allowInsecure?: boolean;
  preferredRoute?: PreferredRoute;
  tokenEnc?: string;
  lastSeenAt?: number | null;
}

export interface NodeRepo {
  list(): Promise<StoredNode[]>;
  get(id: string): Promise<StoredNode | null>;
  create(input: NewNode): Promise<StoredNode>;
  update(id: string, patch: NodePatch): Promise<StoredNode | null>;
  remove(id: string): Promise<boolean>;
}

export interface AppConfigRecord extends AppConfig {
  nodeId: string;
  secretsEnc: string | null;
}

/** 摘要派生用的最小投影：只保留 nodeId / app / config，不带 secrets 与 rev 元数据 */
export interface AppConfigSummaryRow {
  nodeId: string;
  app: string;
  config: Record<string, unknown>;
}

/** 摘要读取的最小投影：summary 只含模式与计数，不含 config / secrets */
export interface AppSummaryRow {
  nodeId: string;
  app: string;
  summary: AppSummaryCounts;
}

export interface PutAppConfigInput {
  config: Record<string, unknown>;
  schemaVersion: number;
  note?: string;
  actor: string;
}

export interface RevisionRecord extends Revision {
  nodeId: string;
}

export interface AppConfigRepo {
  listByNode(nodeId: string): Promise<AppConfigRecord[]>;
  /**
   * 全部配置行的最小投影（GET /nodes 摘要派生用）：分页读取，避免 D1 单次
   * 1000 行上限导致静默截断；只解密摘要需要的 config_json，不读取 secrets_enc。
   * 仅作 summary_json 为 NULL 时的兜底（旧版本 Worker 写入的行）。
   */
  listForSummary(): Promise<AppConfigSummaryRow[]>;
  /**
   * 摘要读取（GET /nodes 与 GET /nodes/:id）：优先读 app_configs.summary_json，
   * 零解密；存在 NULL 行（旧版本 Worker 写入/尚未回填）时整批回退到
   * listForSummary()/listByNode() 解密派生。
   */
  listSummaries(nodeId?: string): Promise<AppSummaryRow[]>;
  get(nodeId: string, app: string): Promise<AppConfigRecord | null>;
  /** 写入新配置：rev = 当前最大 rev + 1，同时落一条 revisions */
  put(nodeId: string, app: string, input: PutAppConfigInput): Promise<AppConfigRecord>;
  setAppliedRev(nodeId: string, app: string, rev: number): Promise<void>;
  /** D6：写入/清除最近一次 apply 失败摘要 */
  setLastApplyError(nodeId: string, app: string, error: AppApplyError | null): Promise<void>;
  listRevisions(nodeId: string, app: string): Promise<RevisionRecord[]>;
  getRevision(nodeId: string, app: string, rev: number): Promise<RevisionRecord | null>;
}

export interface AuditEntry {
  actor: string;
  nodeId?: string | null;
  app?: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

export interface AuditRecord {
  id: number;
  at: number;
  actor: string | null;
  nodeId: string | null;
  app: string | null;
  action: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuditRepo {
  log(entry: AuditEntry): Promise<void>;
  /** 最近操作（只读；用于节点概况最小版）。 */
  list(input?: { nodeId?: string | null; limit?: number }): Promise<AuditRecord[]>;
}


// ---------------------------------------------------------------------------
// C3：证书库 / 全局设置
// ---------------------------------------------------------------------------

export interface CertificateAcmeMeta {
  provider: string;
  credentialKey: string;
  ca: string | null;
  keyType: 'rsa' | 'ec' | null;
}

export interface CertificateRecord extends Certificate {
  certPemEnc: string;
  keyPemEnc: string;
}

export interface NewCertificate {
  name: string;
  domains: string[];
  issuer: string;
  notAfter: number | null;
  certPem: string;
  keyPem: string;
  sourceNodeId: string | null;
  acme?: CertificateAcmeMeta | null;
}

export interface UpdateCertificate {
  certPem: string;
  keyPem: string;
  notAfter?: number | null;
  domains?: string[];
  issuer?: string;
}

export interface CertificateMaterial {
  id: string;
  domains: string[];
  certPem: string;
  keyPem: string;
}

export interface CertificateRepo {
  list(): Promise<Certificate[]>;
  get(id: string): Promise<CertificateRecord | null>;
  create(input: NewCertificate): Promise<Certificate>;
  /** 续期成功后替换材料（名称/来源节点/ACME 元数据保持不变）。 */
  update(id: string, input: UpdateCertificate): Promise<Certificate | null>;
  /** 解密后的 PEM/KEY；供 Worker 解析 $cert 引用与管理员导出 */
  material(id: string): Promise<CertificateMaterial | null>;
  remove(id: string): Promise<boolean>;
}

export interface SettingRecord extends Setting {
  valueEnc: string;
}

export interface SettingsRepo {
  list(): Promise<Setting[]>;
  /** 解密后的 JSON 值；不存在返回 null */
  getValue(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<Setting>;
  remove(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// P4：全局 SSH 公钥库（只存公钥）
// ---------------------------------------------------------------------------

export interface NewSshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
  comment: string | null;
}

export interface SshKeyRepo {
  list(): Promise<SshKey[]>;
  get(id: string): Promise<SshKey | null>;
  findByFingerprint(fingerprint: string): Promise<SshKey | null>;
  create(input: NewSshKey): Promise<SshKey>;
  rename(id: string, name: string): Promise<SshKey | null>;
  remove(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// PR1：全局隧道配置（只存配置，不做 Cloudflare Tunnel CRUD）
// ---------------------------------------------------------------------------

export interface TunnelRecord extends Tunnel {
  tokenEnc: string;
}

export interface NewTunnel {
  name: string;
  hostname: string;
  originPort: number;
  tokenEnc: string;
}

export interface TunnelPatch {
  name?: string;
  hostname?: string;
  originPort?: number;
  tokenEnc?: string;
}

export interface TunnelRepo {
  list(): Promise<TunnelRecord[]>;
  get(id: string): Promise<TunnelRecord | null>;
  create(input: NewTunnel): Promise<TunnelRecord>;
  update(id: string, patch: TunnelPatch): Promise<TunnelRecord | null>;
  remove(id: string): Promise<boolean>;
}
