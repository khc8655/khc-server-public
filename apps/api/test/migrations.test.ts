import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  applyMigrations,
  columnNames,
  listMigrationFiles,
  openRawDatabase,
  schemaDump,
  tableNames,
  type RawDatabase,
} from './helpers/sqlite-d1';

function freshDb(): RawDatabase {
  const raw = openRawDatabase();
  applyMigrations(raw);
  return raw;
}

describe('migrations: 顺序与幂等（批次 F）', () => {
  it('0001→0012 按序执行成功，关键表与列齐备', () => {
    const files = listMigrationFiles();
    expect(files).toEqual([
      '0001_init.sql',
      '0002_c3.sql',
      '0003_live_endpoint.sql',
      '0004_last_apply_error.sql',
      '0005_clear_runtime_state.sql',
      '0006_rate_limit.sql',
      '0007_rev_epoch.sql',
      '0008_node_domain.sql',
      '0009_ssh_keys.sql',
      '0010_node_access.sql',
      '0011_cert_acme_meta.sql',
      '0012_app_configs_summary.sql',
    ]);
    const raw = openRawDatabase();
    const { applied, skipped } = applyMigrations(raw);
    expect(applied).toEqual(files);
    expect(skipped).toEqual([]);

    for (const table of [
      'nodes',
      'app_configs',
      'revisions',
      'audit',
      'certificates',
      'settings',
      'rate_limit',
      'ssh_keys',
      'tunnels',
    ]) {
      expect(tableNames(raw)).toContain(table);
    }
    // 0003/0004 的 ALTER 生效
    expect(columnNames(raw, 'nodes')).toContain('live_endpoint');
    expect(columnNames(raw, 'app_configs')).toContain('last_apply_error');
    // 0007：rev epoch 列存在
    expect(columnNames(raw, 'nodes')).toContain('rev_epoch');
    // 0008：面板代建 DNS 的域名列存在
    expect(columnNames(raw, 'nodes')).toContain('domain');
    // 0009：公钥库指纹唯一（同钥匙不可重复入库）
    expect(columnNames(raw, 'ssh_keys')).toContain('fingerprint');
    // 0010：接入方式 / 隧道引用 / 明文开关
    expect(columnNames(raw, 'nodes')).toContain('access_mode');
    expect(columnNames(raw, 'nodes')).toContain('tunnel_id');
    expect(columnNames(raw, 'nodes')).toContain('allow_insecure');
    expect(columnNames(raw, 'tunnels')).toEqual(
      expect.arrayContaining(['id', 'name', 'hostname', 'origin_port', 'token_enc']),
    );
    // 0011：证书库记录 ACME 签发参数（续期用）
    expect(columnNames(raw, 'certificates')).toEqual(
      expect.arrayContaining([
        'acme_provider',
        'acme_credential_key',
        'acme_ca',
        'acme_key_type',
      ]),
    );
    // 0012：应用配置明文摘要列（只存模式与计数，GET /nodes 零解密）
    expect(columnNames(raw, 'app_configs')).toContain('summary_json');
    // 0005 清空历史运行快照
    const lastState = raw
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE last_state_json IS NOT NULL')
      .get() as { n: number };
    expect(lastState.n).toBe(0);
  });

  it('D-2/T2.2：0007 为存量节点回填随机 rev_epoch（现网数据兼容）', () => {
    const dir = mkdtempSync(`${tmpdir()}/khc-mig-epoch-`);
    try {
      // 先只跑到 0006，模拟 0007 之前的现网库
      for (const file of listMigrationFiles()) {
        if (file === '0007_rev_epoch.sql') continue;
        copyFileSync(`migrations/${file}`, `${dir}/${file}`);
      }
      const raw = openRawDatabase();
      applyMigrations(raw, dir);
      const legacyInsert = raw.prepare(
        `INSERT INTO nodes (id, name, endpoint, tunnel_endpoint, live_endpoint, preferred_route,
         token_enc, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'direct', ?, NULL, 1, 1)`,
      );
      legacyInsert.run('nd_legacy1', 'a', 'https://a.example.com', 'enc-a');
      legacyInsert.run('nd_legacy2', 'b', 'https://b.example.com', 'enc-b');

      // 应用 0007：存量节点回填 16 字节随机 hex（每行独立）
      copyFileSync('migrations/0007_rev_epoch.sql', `${dir}/0007_rev_epoch.sql`);
      const { applied } = applyMigrations(raw, dir);
      expect(applied).toEqual(['0007_rev_epoch.sql']);
      const rows = raw
        .prepare('SELECT id, rev_epoch FROM nodes ORDER BY id')
        .all() as Array<{ id: string; rev_epoch: string }>;
      expect(rows[0]?.rev_epoch).toMatch(/^[0-9a-f]{32}$/);
      expect(rows[1]?.rev_epoch).toMatch(/^[0-9a-f]{32}$/);
      expect(rows[0]?.rev_epoch).not.toBe(rows[1]?.rev_epoch);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重复执行：已应用迁移全部跳过，不报错且 schema 不变（幂等）', () => {
    const raw = freshDb();
    const before = schemaDump(raw);
    const { applied, skipped } = applyMigrations(raw);
    expect(applied).toEqual([]);
    expect(skipped).toEqual(listMigrationFiles());
    expect(schemaDump(raw)).toBe(before);
  });

  it('迁移中途失败：该条整体回滚且不记录，修复后重跑能续上', () => {
    const dir = mkdtempSync(`${tmpdir()}/khc-mig-`);
    try {
      writeFileSync(`${dir}/0001_ok.sql`, 'CREATE TABLE t_ok (a TEXT);');
      // 两条语句：第一条建表成功，第二条违反唯一约束 → 整体必须回滚
      writeFileSync(
        `${dir}/0002_bad.sql`,
        'CREATE TABLE t_bad (a TEXT UNIQUE); INSERT INTO t_bad VALUES (\'x\'); INSERT INTO t_bad VALUES (\'x\');',
      );
      const raw = openRawDatabase();
      expect(() => applyMigrations(raw, dir)).toThrowError(/0002_bad\.sql 执行失败/);
      // 0001 已提交保留；0002 整体回滚（t_bad 存在但为空——重点是失败的那条没记录）
      const names = raw
        .prepare('SELECT name FROM d1_migrations ORDER BY name')
        .all() as Array<{ name: string }>;
      expect(names.map((row) => row.name)).toEqual(['0001_ok.sql']);
      // 修复坏文件后重跑：只有 0002 重新应用
      writeFileSync(`${dir}/0002_bad.sql`, 'CREATE TABLE t_bad2 (b TEXT);');
      const { applied, skipped } = applyMigrations(raw, dir);
      expect(applied).toEqual(['0002_bad.sql']);
      expect(skipped).toEqual(['0001_ok.sql']);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('两个全新库各自跑完全量迁移，最终 schema 完全一致（确定性）', () => {
    const a = freshDb();
    const b = freshDb();
    expect(schemaDump(a)).toBe(schemaDump(b));
    a.close();
    b.close();
  });
});
