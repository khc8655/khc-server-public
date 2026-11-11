import type { Setting } from '@khc/contracts';
import type { SettingRecord, SettingsRepo } from '../../domain/repos';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { misconfigured } from '../../lib/errors';
import { nowSec } from '../../lib/ids';

interface SettingRow {
  key: string;
  value_enc: string;
  updated_at: number;
}

export class D1SettingsRepo implements SettingsRepo {
  constructor(
    private readonly db: D1Database,
    private readonly encKey?: string,
    private readonly enc?: { keyId?: string; previousKey?: string },
  ) {}

  private key(): string {
    if (!this.encKey) throw misconfigured('MASTER_ENC_KEY 未配置，无法读写设置');
    return this.encKey;
  }

  async list(): Promise<Setting[]> {
    const result = await this.db
      .prepare('SELECT key, value_enc, updated_at FROM settings ORDER BY key ASC')
      .all<SettingRow>();
    return (result.results ?? []).map((row) => ({ key: row.key, updatedAt: row.updated_at }));
  }

  async getValue(key: string): Promise<unknown | null> {
    const row = await this.db
      .prepare('SELECT key, value_enc, updated_at FROM settings WHERE key = ?')
      .bind(key)
      .first<SettingRow>();
    if (!row) return null;
    return JSON.parse(
      await decryptSecret(this.key(), row.value_enc, { previousKey: this.enc?.previousKey }),
    ) as unknown;
  }

  async put(key: string, value: unknown): Promise<Setting> {
    const now = nowSec();
    const encrypted = await encryptSecret(this.key(), JSON.stringify(value), {
      keyId: this.enc?.keyId,
    });
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      )
      .bind(key, encrypted, now)
      .run();
    return { key, updatedAt: now };
  }

  async remove(key: string): Promise<boolean> {
    const existing = await this.db
      .prepare('SELECT key FROM settings WHERE key = ?')
      .bind(key)
      .first<{ key: string }>();
    if (!existing) return false;
    await this.db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    return true;
  }
}
