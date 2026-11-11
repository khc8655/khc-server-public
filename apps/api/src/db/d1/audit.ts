import type { AuditEntry, AuditRecord, AuditRepo } from '../../domain/repos';
import { nowSec } from '../../lib/ids';

export class D1AuditRepo implements AuditRepo {
  constructor(private readonly db: D1Database) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO audit (at, actor, node_id, app, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        nowSec(),
        entry.actor,
        entry.nodeId ?? null,
        entry.app ?? null,
        entry.action,
        entry.detail ? JSON.stringify(entry.detail) : null,
      )
      .run();
  }

  async list(input: { nodeId?: string | null; limit?: number } = {}): Promise<AuditRecord[]> {
    const nodeId = input.nodeId ?? null;
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
    const result = await this.db
      .prepare(
        'SELECT id, at, actor, node_id, app, action, detail_json FROM audit ' +
          'WHERE (? IS NULL OR node_id = ?) ORDER BY at DESC, id DESC LIMIT ?',
      )
      .bind(nodeId, nodeId, limit)
      .all<{
        id: number;
        at: number;
        actor: string | null;
        node_id: string | null;
        app: string | null;
        action: string | null;
        detail_json: string | null;
      }>();
    return (result.results ?? []).map((row) => {
      let detail: Record<string, unknown> | null = null;
      if (row.detail_json) {
        try {
          const parsed = JSON.parse(row.detail_json) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            detail = parsed as Record<string, unknown>;
          }
        } catch {
          detail = null;
        }
      }
      return {
        id: row.id,
        at: row.at,
        actor: row.actor,
        nodeId: row.node_id,
        app: row.app,
        action: row.action,
        detail,
      };
    });
  }
}
