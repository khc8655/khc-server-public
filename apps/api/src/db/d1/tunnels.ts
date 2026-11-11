import type { NewTunnel, TunnelPatch, TunnelRecord, TunnelRepo } from '../../domain/repos';
import { newId, nowSec } from '../../lib/ids';

interface TunnelRow {
  id: string;
  name: string;
  hostname: string;
  origin_port: number;
  token_enc: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, name, hostname, origin_port, token_enc, created_at, updated_at';

function mapTunnel(row: TunnelRow): TunnelRecord {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    originPort: row.origin_port,
    hasToken: Boolean(row.token_enc),
    tokenEnc: row.token_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1TunnelRepo implements TunnelRepo {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<TunnelRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${COLUMNS} FROM tunnels ORDER BY created_at ASC`)
      .all<TunnelRow>();
    return (result.results ?? []).map(mapTunnel);
  }

  async get(id: string): Promise<TunnelRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM tunnels WHERE id = ?`)
      .bind(id)
      .first<TunnelRow>();
    return row ? mapTunnel(row) : null;
  }

  async create(input: NewTunnel): Promise<TunnelRecord> {
    const now = nowSec();
    const tunnel: TunnelRecord = {
      id: newId('tn'),
      name: input.name,
      hostname: input.hostname,
      originPort: input.originPort,
      hasToken: true,
      tokenEnc: input.tokenEnc,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(`INSERT INTO tunnels (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        tunnel.id,
        tunnel.name,
        tunnel.hostname,
        tunnel.originPort,
        tunnel.tokenEnc,
        tunnel.createdAt,
        tunnel.updatedAt,
      )
      .run();
    return tunnel;
  }

  async update(id: string, patch: TunnelPatch): Promise<TunnelRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.hostname !== undefined) set('hostname', patch.hostname);
    if (patch.originPort !== undefined) set('origin_port', patch.originPort);
    if (patch.tokenEnc !== undefined) set('token_enc', patch.tokenEnc);
    if (sets.length === 0) return this.get(id);
    set('updated_at', nowSec());
    const result = await this.db
      .prepare(`UPDATE tunnels SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run();
    if (!result.meta.changes) return null;
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM tunnels WHERE id = ?').bind(id).run();
    return Boolean(result.meta.changes);
  }
}
