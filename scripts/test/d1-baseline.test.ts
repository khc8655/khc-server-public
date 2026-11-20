import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_MIGRATIONS,
  buildBaselineSql,
  parseCliArgs,
  parseWranglerJson,
  verifyBaselineSchema,
} from '../d1-baseline.mjs';
import { applyMigrations, tableNames } from '../../apps/api/test/helpers/sqlite-d1';

const ALL_TABLES = [
  'nodes',
  'app_configs',
  'revisions',
  'audit',
  'certificates',
  'settings',
  'rate_limit',
  'ssh_keys',
  'tunnels',
  'app_manifests',
];

const ALL_COLUMNS = {
  nodes: ['id', 'live_endpoint', 'rev_epoch', 'domain', 'access_mode', 'tunnel_id', 'allow_insecure'],
  app_configs: ['node_id', 'app', 'last_apply_error', 'summary_json'],
  certificates: ['id', 'acme_provider', 'acme_credential_key', 'acme_ca', 'acme_key_type'],
};

describe('d1-baseline', () => {
  it('BASELINE_MIGRATIONS 与 0001–0013 迁移文件一致', () => {
    const onDisk = readdirSync('migrations')
      .filter((name) => /^00(0[1-9]|1[0-3])_.*\.sql$/.test(name))
      .sort();
    expect(BASELINE_MIGRATIONS).toEqual(onDisk);
  });

  it('0001–0013 表和列齐备时校验通过', () => {
    const result = verifyBaselineSchema({ tables: ALL_TABLES, columnsByTable: ALL_COLUMNS });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('缺少任意表或列时精确定位缺失项（fail-closed）', () => {
    const noManifest = verifyBaselineSchema({
      tables: ALL_TABLES.filter((t) => t !== 'app_manifests'),
      columnsByTable: ALL_COLUMNS,
    });
    expect(noManifest.ok).toBe(false);
    expect(noManifest.missing).toContainEqual({
      migration: '0013_app_manifests.sql',
      kind: 'table',
      table: 'app_manifests',
    });

    const noSummary = verifyBaselineSchema({
      tables: ALL_TABLES,
      columnsByTable: {
        ...ALL_COLUMNS,
        app_configs: ALL_COLUMNS.app_configs.filter((c) => c !== 'summary_json'),
      },
    });
    expect(noSummary.ok).toBe(false);
    expect(noSummary.missing).toContainEqual({
      migration: '0012_app_configs_summary.sql',
      kind: 'column',
      table: 'app_configs',
      column: 'summary_json',
    });

    const noAcme = verifyBaselineSchema({
      tables: ALL_TABLES,
      columnsByTable: {
        ...ALL_COLUMNS,
        certificates: ALL_COLUMNS.certificates.filter((c) => c !== 'acme_key_type'),
      },
    });
    expect(noAcme.ok).toBe(false);
    expect(noAcme.missing).toContainEqual({
      migration: '0011_cert_acme_meta.sql',
      kind: 'column',
      table: 'certificates',
      column: 'acme_key_type',
    });
  });

  it('buildBaselineSql 在已跑过 0001–0013 的 SQLite 库上幂等且兼容 d1_migrations', () => {
    const db = new DatabaseSync(':memory:');
    for (const file of BASELINE_MIGRATIONS) {
      db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    }
    expect(tableNames(db as never)).not.toContain('d1_migrations');

    const sql = buildBaselineSql();
    db.exec(sql);
    // 重复执行也必须安全
    db.exec(sql);

    const rows = db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(BASELINE_MIGRATIONS);

    const postBaseline = readdirSync('migrations')
      .filter((name) => /^\d+_.*\.sql$/.test(name) && !BASELINE_MIGRATIONS.includes(name))
      .sort();
    const { applied, skipped } = applyMigrations(db as never);
    expect(applied).toEqual(postBaseline);
    expect(skipped).toEqual(BASELINE_MIGRATIONS);

    const second = applyMigrations(db as never);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('parseCliArgs 与 parseWranglerJson 处理参数与前置非 JSON 行', () => {
    expect(parseCliArgs(['--config', 'wrangler.ci.toml', '--remote', '--db=DB'])).toEqual({
      config: 'wrangler.ci.toml',
      db: 'DB',
      remote: true,
      persistTo: null,
    });
    expect(parseCliArgs(['--persist-to', '/tmp/d1'])).toEqual({
      config: 'wrangler.toml',
      db: 'DB',
      remote: false,
      persistTo: '/tmp/d1',
    });
    expect(
      parseWranglerJson('⛅️ wrangler 4.0\n[{"results":[{"name":"nodes"}],"success":true}]'),
    ).toEqual([{ name: 'nodes' }]);
  });
});
