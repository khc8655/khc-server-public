import type { SshKey } from '@khc/contracts';
import type { NewSshKey, SshKeyRepo } from '../../domain/repos';
import { newId, nowSec } from '../../lib/ids';

interface SshKeyRow {
  id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  comment: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, name, public_key, fingerprint, comment, created_at, updated_at';

function mapSshKey(row: SshKeyRow): SshKey {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1SshKeyRepo implements SshKeyRepo {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<SshKey[]> {
    const result = await this.db
      .prepare(`SELECT ${COLUMNS} FROM ssh_keys ORDER BY created_at DESC`)
      .all<SshKeyRow>();
    return (result.results ?? []).map(mapSshKey);
  }

  async get(id: string): Promise<SshKey | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM ssh_keys WHERE id = ?`)
      .bind(id)
      .first<SshKeyRow>();
    return row ? mapSshKey(row) : null;
  }

  async findByFingerprint(fingerprint: string): Promise<SshKey | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM ssh_keys WHERE fingerprint = ?`)
      .bind(fingerprint)
      .first<SshKeyRow>();
    return row ? mapSshKey(row) : null;
  }

  async create(input: NewSshKey): Promise<SshKey> {
    const now = nowSec();
    const key: SshKey = {
      id: newId('sshkey'),
      name: input.name,
      publicKey: input.publicKey,
      fingerprint: input.fingerprint,
      comment: input.comment,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(`INSERT INTO ssh_keys (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        key.id,
        key.name,
        key.publicKey,
        key.fingerprint,
        key.comment,
        key.createdAt,
        key.updatedAt,
      )
      .run();
    return key;
  }

  async rename(id: string, name: string): Promise<SshKey | null> {
    const now = nowSec();
    const result = await this.db
      .prepare('UPDATE ssh_keys SET name = ?, updated_at = ? WHERE id = ?')
      .bind(name, now, id)
      .run();
    if (!result.meta.changes) return null;
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM ssh_keys WHERE id = ?').bind(id).run();
    return Boolean(result.meta.changes);
  }
}
