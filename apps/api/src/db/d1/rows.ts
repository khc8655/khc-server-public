import type { AppApplyError, NodeAccessMode } from '@khc/contracts';
import type { AppConfigRecord, RevisionRecord, StoredNode } from '../../domain/repos';

export interface NodeRow {
  id: string;
  name: string;
  endpoint: string;
  tunnel_endpoint: string | null;
  live_endpoint: string | null;
  domain: string | null;
  access_mode: string | null;
  tunnel_id: string | null;
  allow_insecure: number | null;
  preferred_route: string;
  token_enc: string;
  rev_epoch: string;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 存量行没有 access_mode：按 tunnel 引用与 endpoint 协议推导，读路径永不为空。 */
function deriveAccessMode(row: NodeRow): NodeAccessMode {
  if (row.access_mode === 'domain' || row.access_mode === 'tunnel' || row.access_mode === 'ip') {
    return row.access_mode;
  }
  if (row.tunnel_id || row.preferred_route === 'tunnel') return 'tunnel';
  return /^https:\/\//i.test(row.endpoint) ? 'domain' : 'ip';
}

export function mapStoredNode(row: NodeRow): StoredNode {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    tunnelEndpoint: row.tunnel_endpoint,
    liveEndpoint: row.live_endpoint,
    domain: row.domain ?? null,
    accessMode: deriveAccessMode(row),
    tunnelId: row.tunnel_id ?? null,
    allowInsecure: row.allow_insecure === 1,
    preferredRoute: row.preferred_route === 'tunnel' ? 'tunnel' : 'direct',
    tokenEnc: row.token_enc,
    revEpoch: row.rev_epoch,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AppConfigRow {
  node_id: string;
  app: string;
  schema_version: number;
  config_json: string;
  secrets_enc: string | null;
  rev: number;
  applied_rev: number | null;
  last_apply_error: string | null;
  updated_at: number;
}

/** D6：last_apply_error 存 JSON（兼容历史明文/坏数据，解析失败当无错误）。 */
export function parseAppApplyError(raw: string | null | undefined): AppApplyError | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : '';
      const message = typeof record.message === 'string' ? record.message : '';
      const at = typeof record.at === 'number' && Number.isInteger(record.at) ? record.at : undefined;
      if (code && message) {
        return { code: code.slice(0, 64), message: message.slice(0, 500), ...(at !== undefined ? { at } : {}) };
      }
    }
  } catch {
    // ignore malformed legacy value
  }
  return null;
}

export function mapAppConfig(row: AppConfigRow): AppConfigRecord {
  return {
    nodeId: row.node_id,
    app: row.app,
    schemaVersion: row.schema_version,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    secretsEnc: row.secrets_enc,
    rev: row.rev,
    appliedRev: row.applied_rev,
    lastApplyError: parseAppApplyError(row.last_apply_error),
    updatedAt: row.updated_at,
  };
}

export interface RevisionRow {
  node_id: string;
  app: string;
  rev: number;
  config_json: string;
  note: string | null;
  created_at: number;
}

export function mapRevision(row: RevisionRow): RevisionRecord {
  return {
    nodeId: row.node_id,
    app: row.app,
    rev: row.rev,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    note: row.note,
    createdAt: row.created_at,
  };
}
