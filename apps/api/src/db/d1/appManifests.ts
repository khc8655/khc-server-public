import {
  appManifestAnyDefinitionSchema,
  type AppManifest,
} from '@khc/contracts';
import type { AppManifestPatch, AppManifestRepo, NewAppManifest } from '../../domain/repos';
import { nowSec } from '../../lib/ids';

interface AppManifestRow {
  id: string;
  manifest_json: string;
  version: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, manifest_json, version, enabled, created_at, updated_at';

function formatFirstZodIssue(error: { issues: Array<{ path: Array<string | number | symbol>; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return '应用清单格式不合法';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function mapAppManifest(row: AppManifestRow): AppManifest {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.manifest_json);
  } catch (err) {
    return {
      id: row.id,
      invalid: true,
      error: `manifest_json: ${err instanceof Error ? err.message : 'JSON 解析失败'}`,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  const checked = appManifestAnyDefinitionSchema.safeParse(parsedJson);
  if (!checked.success) {
    return {
      id: row.id,
      invalid: true,
      error: formatFirstZodIssue(checked.error),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return {
    id: row.id,
    manifest: checked.data,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1AppManifestRepo implements AppManifestRepo {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<AppManifest[]> {
    const result = await this.db
      .prepare(`SELECT ${COLUMNS} FROM app_manifests ORDER BY created_at DESC`)
      .all<AppManifestRow>();
    return (result.results ?? []).map(mapAppManifest);
  }

  async get(id: string): Promise<AppManifest | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM app_manifests WHERE id = ?`)
      .bind(id)
      .first<AppManifestRow>();
    return row ? mapAppManifest(row) : null;
  }

  async create(input: NewAppManifest): Promise<AppManifest> {
    const now = nowSec();
    await this.db
      .prepare(
        `INSERT INTO app_manifests (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        JSON.stringify(input.manifest),
        input.manifest.version,
        input.enabled ? 1 : 0,
        now,
        now,
      )
      .run();
    return {
      id: input.id,
      manifest: input.manifest,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: AppManifestPatch): Promise<AppManifest | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const enabled = patch.enabled ?? existing.enabled;
    await this.db
      .prepare(
        'UPDATE app_manifests SET manifest_json = ?, version = ?, enabled = ?, updated_at = ? WHERE id = ?',
      )
      .bind(
        JSON.stringify(patch.manifest),
        patch.manifest.version,
        enabled ? 1 : 0,
        nowSec(),
        id,
      )
      .run();
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM app_manifests WHERE id = ?').bind(id).run();
    return Boolean(result.meta.changes);
  }
}
