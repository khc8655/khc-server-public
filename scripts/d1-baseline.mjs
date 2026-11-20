#!/usr/bin/env node
/**
 * D1 基线初始化脚本（方案：CI 自动化 D1 迁移）。
 *
 * 在 `wrangler d1 migrations apply` 之前运行：
 * - 若 `d1_migrations` 已存在 → no-op（直接退出 0）；
 * - 若为空库（无任何用户表）→ no-op（交由 `migrations apply` 从 0001 起全量应用）；
 * - 若为未启用 `d1_migrations` 的存量库 → 逐条校验 0001–0013 结构特征：
 *   - 任一项缺失 → fail-closed 打印缺失项并退出 1（绝不写入 `d1_migrations`）；
 *   - 全部满足 → 创建 `d1_migrations`（对齐 wrangler schema）并登记 0001–0013。
 *
 * 用法：
 *   node scripts/d1-baseline.mjs [--config wrangler.toml] [--db DB] [--local|--remote] [--persist-to dir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASELINE_MIGRATIONS = [
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
  '0013_app_manifests.sql',
];

export const BASELINE_CHECKS = [
  { migration: '0001_init.sql', tables: ['nodes', 'app_configs', 'revisions', 'audit'], columns: {} },
  { migration: '0002_c3.sql', tables: ['certificates', 'settings'], columns: {} },
  { migration: '0003_live_endpoint.sql', tables: [], columns: { nodes: ['live_endpoint'] } },
  { migration: '0004_last_apply_error.sql', tables: [], columns: { app_configs: ['last_apply_error'] } },
  // 0005 只清空 nodes.last_state_json 历史数据，无结构变更
  { migration: '0005_clear_runtime_state.sql', tables: [], columns: {} },
  { migration: '0006_rate_limit.sql', tables: ['rate_limit'], columns: {} },
  { migration: '0007_rev_epoch.sql', tables: [], columns: { nodes: ['rev_epoch'] } },
  { migration: '0008_node_domain.sql', tables: [], columns: { nodes: ['domain'] } },
  { migration: '0009_ssh_keys.sql', tables: ['ssh_keys'], columns: {} },
  {
    migration: '0010_node_access.sql',
    tables: ['tunnels'],
    columns: { nodes: ['access_mode', 'tunnel_id', 'allow_insecure'] },
  },
  {
    migration: '0011_cert_acme_meta.sql',
    tables: [],
    columns: { certificates: ['acme_provider', 'acme_credential_key', 'acme_ca', 'acme_key_type'] },
  },
  { migration: '0012_app_configs_summary.sql', tables: [], columns: { app_configs: ['summary_json'] } },
  { migration: '0013_app_manifests.sql', tables: ['app_manifests'], columns: {} },
];

/**
 * 校验存量库是否完整具备 0001–0013 的全部表与列。
 * @param {{ tables: Iterable<string>; columnsByTable: Record<string, Iterable<string>> }} input
 */
export function verifyBaselineSchema(input) {
  const tableSet = new Set(input.tables);
  const columnSets = Object.fromEntries(
    Object.entries(input.columnsByTable).map(([table, cols]) => [table, new Set(cols)]),
  );
  const missing = [];

  for (const check of BASELINE_CHECKS) {
    for (const table of check.tables) {
      if (!tableSet.has(table)) {
        missing.push({ migration: check.migration, kind: 'table', table });
      }
    }
    for (const [table, cols] of Object.entries(check.columns)) {
      const present = columnSets[table] ?? new Set();
      for (const column of cols) {
        if (!present.has(column)) {
          missing.push({ migration: check.migration, kind: 'column', table, column });
        }
      }
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * 生成与 `wrangler d1 migrations apply` 完全同构的建表与基线登记 SQL。
 */
export function buildBaselineSql(migrations = BASELINE_MIGRATIONS) {
  const values = migrations
    .map((name) => {
      if (!/^[A-Za-z0-9_.-]+\.sql$/.test(name)) {
        throw new Error(`非法迁移文件名: ${name}`);
      }
      return `('${name}')`;
    })
    .join(',\n  ');

  return [
    'CREATE TABLE IF NOT EXISTS "d1_migrations"(',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  name TEXT UNIQUE,',
    '  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL',
    ');',
    'INSERT OR IGNORE INTO "d1_migrations" (name) VALUES',
    `  ${values};`,
    '',
  ].join('\n');
}

/**
 * 解析 `wrangler d1 execute --json` 标准输出（兼容前置非 JSON 日志行）。
 */
export function parseWranglerJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('wrangler 返回空输出');
  const start = trimmed.indexOf('[');
  const raw = start > 0 ? trimmed.slice(start) : trimmed;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`非预期 wrangler JSON 结构: ${trimmed.slice(0, 200)}`);
  }
  return parsed[0]?.results ?? [];
}

export function parseCliArgs(argv) {
  const opts = {
    config: 'wrangler.toml',
    db: 'DB',
    remote: false,
    persistTo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      opts.config = argv[++i] ?? '';
      if (!opts.config) throw new Error('--config 缺少值');
    } else if (arg.startsWith('--config=')) {
      opts.config = arg.slice('--config='.length);
    } else if (arg === '--db') {
      opts.db = argv[++i] ?? '';
      if (!opts.db) throw new Error('--db 缺少值');
    } else if (arg.startsWith('--db=')) {
      opts.db = arg.slice('--db='.length);
    } else if (arg === '--remote') {
      opts.remote = true;
    } else if (arg === '--local') {
      opts.remote = false;
    } else if (arg === '--persist-to') {
      opts.persistTo = argv[++i] ?? '';
      if (!opts.persistTo) throw new Error('--persist-to 缺少值');
    } else if (arg.startsWith('--persist-to=')) {
      opts.persistTo = arg.slice('--persist-to='.length);
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

function runWrangler(args) {
  const localBin = path.join(ROOT, 'node_modules/.bin/wrangler');
  const cmd = fs.existsSync(localBin) ? localBin : 'npx';
  const fullArgs = fs.existsSync(localBin) ? args : ['--no-install', 'wrangler', ...args];
  const res = spawnSync(cmd, fullArgs, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    const detail = [res.stderr, res.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`wrangler 执行失败（exit ${res.status ?? 'null'}）：${detail || '无输出'}`);
  }
  return res.stdout ?? '';
}

function baseD1Args(opts) {
  const args = ['d1', 'execute', opts.db, '--config', opts.config];
  if (opts.remote) {
    args.push('--remote');
  } else {
    args.push('--local');
    if (opts.persistTo) args.push('--persist-to', opts.persistTo);
  }
  return args;
}

function queryD1(opts, sql) {
  const out = runWrangler([...baseD1Args(opts), '--command', sql, '--json']);
  return parseWranglerJson(out);
}

function execD1File(opts, sqlFile) {
  runWrangler([...baseD1Args(opts), `--file=${sqlFile}`]);
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(
      '用法: node scripts/d1-baseline.mjs [--config wrangler.toml] [--db DB] [--local|--remote] [--persist-to dir]',
    );
    return 0;
  }

  const tables = queryD1(
    opts,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).map((row) => String(row.name));

  if (tables.includes('d1_migrations')) {
    console.log('OK: d1_migrations 已存在，跳过基线初始化');
    return 0;
  }

  if (tables.length === 0) {
    console.log('OK: 空数据库（无存量表），跳过基线初始化；后续由 wrangler d1 migrations apply 从 0001 执行');
    return 0;
  }

  const columnsByTable = {};
  for (const table of ['nodes', 'app_configs', 'certificates']) {
    if (!tables.includes(table)) {
      columnsByTable[table] = [];
      continue;
    }
    const cols = queryD1(opts, `PRAGMA table_info(${table})`).map((row) => String(row.name));
    columnsByTable[table] = cols;
  }

  const check = verifyBaselineSchema({ tables, columnsByTable });
  if (!check.ok) {
    console.error('ERROR: 检测到存量库但缺少以下 0001–0013 基线结构，已拒绝写入 d1_migrations：');
    for (const item of check.missing) {
      const target = item.kind === 'table' ? `表 ${item.table}` : `列 ${item.table}.${item.column}`;
      console.error(`  - ${item.migration}: 缺少 ${target}`);
    }
    console.error('请先人工核对并补齐缺失迁移后再重跑。');
    return 1;
  }

  const sqlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khc-d1-baseline-'));
  const sqlFile = path.join(sqlDir, 'baseline.sql');
  try {
    fs.writeFileSync(sqlFile, buildBaselineSql(), 'utf8');
    execD1File(opts, sqlFile);
  } finally {
    fs.rmSync(sqlDir, { recursive: true, force: true });
  }

  console.log(`OK: 存量库已校验通过 0001–0013 结构，已创建 d1_migrations 并登记 ${BASELINE_MIGRATIONS.length} 条记录`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
