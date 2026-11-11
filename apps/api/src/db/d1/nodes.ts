import type { NewNode, NodePatch, NodeRepo, StoredNode } from '../../domain/repos';
import { newEpoch, newId, nowSec } from '../../lib/ids';
import { mapStoredNode, type NodeRow } from './rows';

const COLUMNS =
  'id, name, endpoint, tunnel_endpoint, live_endpoint, domain, access_mode, tunnel_id, allow_insecure, preferred_route, token_enc, rev_epoch, last_seen_at, created_at, updated_at';

export class D1NodeRepo implements NodeRepo {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<StoredNode[]> {
    const result = await this.db
      .prepare(`SELECT ${COLUMNS} FROM nodes ORDER BY created_at ASC`)
      .all<NodeRow>();
    return (result.results ?? []).map(mapStoredNode);
  }

  async get(id: string): Promise<StoredNode | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM nodes WHERE id = ?`)
      .bind(id)
      .first<NodeRow>();
    return row ? mapStoredNode(row) : null;
  }

  async create(input: NewNode): Promise<StoredNode> {
    const now = nowSec();
    const accessMode =
      input.accessMode ??
      (input.tunnelId ? 'tunnel' : /^https:\/\//i.test(input.endpoint) ? 'domain' : 'ip');
    const node: StoredNode = {
      id: newId('nd'),
      name: input.name,
      endpoint: input.endpoint,
      tunnelEndpoint: input.tunnelEndpoint ?? null,
      liveEndpoint: input.liveEndpoint ?? null,
      domain: input.domain ?? null,
      accessMode,
      tunnelId: input.tunnelId ?? null,
      allowInsecure: input.allowInsecure ?? accessMode === 'ip',
      preferredRoute: input.preferredRoute ?? (accessMode === 'tunnel' ? 'tunnel' : 'direct'),
      tokenEnc: input.tokenEnc,
      // D-2/T2.2：创建即生成纪元；节点重建/恢复=新节点行=新纪元，
      // Agent 据此识别旧纪元并重置 rev 基线（迁移 0007 为存量节点回填）。
      revEpoch: newEpoch(),
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO nodes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        node.id,
        node.name,
        node.endpoint,
        node.tunnelEndpoint,
        node.liveEndpoint,
        node.domain,
        node.accessMode,
        node.tunnelId,
        node.allowInsecure ? 1 : 0,
        node.preferredRoute,
        node.tokenEnc,
        node.revEpoch,
        node.lastSeenAt,
        node.createdAt,
        node.updatedAt,
      )
      .run();
    return node;
  }

  async update(id: string, patch: NodePatch): Promise<StoredNode | null> {
    // B-2：只 UPDATE 补丁里出现的列——旧的全字段读改写会把并发写者刚落库的其他列
    // （如 /state 轮询写的 last_seen_at）用读到的旧值覆盖回去。
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.endpoint !== undefined) set('endpoint', patch.endpoint);
    if (patch.tunnelEndpoint !== undefined) set('tunnel_endpoint', patch.tunnelEndpoint);
    if (patch.liveEndpoint !== undefined) set('live_endpoint', patch.liveEndpoint);
    if (patch.domain !== undefined) set('domain', patch.domain);
    if (patch.accessMode !== undefined) set('access_mode', patch.accessMode);
    if (patch.tunnelId !== undefined) set('tunnel_id', patch.tunnelId);
    if (patch.allowInsecure !== undefined) set('allow_insecure', patch.allowInsecure ? 1 : 0);
    if (patch.preferredRoute !== undefined) set('preferred_route', patch.preferredRoute);
    if (patch.tokenEnc !== undefined) set('token_enc', patch.tokenEnc);
    if (patch.lastSeenAt !== undefined) set('last_seen_at', patch.lastSeenAt);
    if (sets.length === 0) return this.get(id);
    set('updated_at', nowSec());
    await this.db
      .prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run();
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.batch([
      this.db.prepare('DELETE FROM revisions WHERE node_id = ?').bind(id),
      this.db.prepare('DELETE FROM app_configs WHERE node_id = ?').bind(id),
      this.db.prepare('DELETE FROM nodes WHERE id = ?').bind(id),
    ]);
    return true;
  }
}
