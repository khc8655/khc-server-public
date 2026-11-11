import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 用 node:sqlite 模拟 D1Database，让 db/d1 仓储实现可以离线跑契约测试。
 * 只实现本项目实际用到的 API 面：prepare().bind().first/all/run、
 * prepare().all()（无绑定参数）、batch()（隐式事务，失败整体回滚）。
 */

interface RawStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}

export interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

export function openRawDatabase(): RawDatabase {
  return new DatabaseSync(':memory:') as unknown as RawDatabase;
}

interface BoundStatement {
  __sql: string;
  __params: unknown[];
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true }>;
}

function boundApi(stmt: RawStatement, sql: string, params: unknown[]): BoundStatement {
  return {
    __sql: sql,
    __params: params,
    first: async <T>(): Promise<T | null> => (stmt.get(...params) ?? null) as T | null,
    all: async <T>(): Promise<{ results: T[] }> => ({
      results: stmt.all(...params) as T[],
    }),
    run: async () => {
      stmt.run(...params);
      return { success: true as const };
    },
  };
}

export function toD1(raw: RawDatabase): D1Database {
  const d1 = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        ...boundApi(stmt, sql, []),
        bind: (...params: unknown[]) => boundApi(stmt, sql, params),
      };
    },
    batch: async (statements: BoundStatement[]): Promise<unknown[]> => {
      // D1 batch 是隐式事务：任一语句失败，整批回滚
      raw.exec('BEGIN');
      try {
        for (const statement of statements) {
          raw.prepare(statement.__sql).run(...statement.__params);
        }
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
  return d1 as unknown as D1Database;
}

// @ts-expect-error import.meta.url 需要 Node/bundler 运行时；API 的 workers 类型不含它
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url));

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort();
}

/**
 * 迁移驱动（对齐 wrangler d1 migrations 语义）：
 * 用记录表记住已应用文件，重复执行时跳过——保证"重复执行不报错"的幂等。
 * 单个迁移在事务内执行，失败回滚并带文件名报错。
 */
export function applyMigrations(
  raw: RawDatabase,
  dir: string = MIGRATIONS_DIR,
): { applied: string[]; skipped: string[] } {
  raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  )`);
  const appliedNames = new Set(
    (raw.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  const files = readdirSync(dir)
    .filter((name: string) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (appliedNames.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    raw.exec('BEGIN');
    try {
      raw.exec(sql);
      raw
        .prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
      raw.exec('COMMIT');
    } catch (error) {
      raw.exec('ROLLBACK');
      throw new Error(
        `迁移 ${file} 执行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    applied.push(file);
  }
  return { applied, skipped };
}

/** sqlite_master 内容（排序后），用于幂等/确定性比较 */
export function schemaDump(raw: RawDatabase): string {
  const rows = raw
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  return JSON.stringify(
    rows.map((row) => ({ type: row.type, name: row.name, sql: row.sql })),
  );
}

export function tableNames(raw: RawDatabase): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

export function columnNames(raw: RawDatabase, table: string): string[] {
  return (
    raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}
