import type {
  AppConfigRecord,
  AppConfigRepo,
  AppConfigSummaryRow,
  AppSummaryRow,
  PutAppConfigInput,
  RevisionRecord,
} from '../../domain/repos';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { misconfigured } from '../../lib/errors';
import { nowSec } from '../../lib/ids';
import { summarizeAppConfig, type AppSummaryCounts } from '../../lib/node-summary';
import { mapAppConfig, mapRevision, type AppConfigRow, type RevisionRow } from './rows';

const CONFIG_COLUMNS =
  'node_id, app, schema_version, config_json, secrets_enc, rev, applied_rev, last_apply_error, updated_at';
/** 历史 v1 包装前缀（A-11 前的密文行）；新行直接带 crypto 层 enc:v2:<keyId>: 前缀 */
const ENC_V1_PREFIX = 'enc:v1:';

/**
 * D1 实现：app_configs.config_json / revisions.config_json 在库里以 AES-GCM 密文保存，
 * 读出时解密（兼容历史明文行）。Worker 本身不解析 config，只做搬运。
 */
export class D1AppConfigRepo implements AppConfigRepo {
  constructor(
    private readonly db: D1Database,
    private readonly encKey?: string,
    private readonly enc?: { keyId?: string; previousKey?: string },
  ) {}

  private async encryptConfig(config: Record<string, unknown>): Promise<string> {
    if (!this.encKey) throw misconfigured('MASTER_ENC_KEY 未配置，无法保存应用配置');
    return encryptSecret(this.encKey, JSON.stringify(config), { keyId: this.enc?.keyId });
  }

  private async decryptConfig(raw: string): Promise<Record<string, unknown>> {
    if (!raw.startsWith('enc:')) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    if (!this.encKey) throw misconfigured('MASTER_ENC_KEY 未配置，无法读取应用配置');
    const body = raw.startsWith(ENC_V1_PREFIX) ? raw.slice(ENC_V1_PREFIX.length) : raw;
    return JSON.parse(
      await decryptSecret(this.encKey, body, { previousKey: this.enc?.previousKey }),
    ) as Record<string, unknown>;
  }

  private async decryptRow(row: AppConfigRow): Promise<AppConfigRow> {
    return { ...row, config_json: JSON.stringify(await this.decryptConfig(row.config_json)) };
  }

  private async decryptRevision(row: RevisionRow): Promise<RevisionRow> {
    return { ...row, config_json: JSON.stringify(await this.decryptConfig(row.config_json)) };
  }

  async listByNode(nodeId: string): Promise<AppConfigRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${CONFIG_COLUMNS} FROM app_configs WHERE node_id = ? ORDER BY app ASC`)
      .bind(nodeId)
      .all<AppConfigRow>();
    const rows = await Promise.all((result.results ?? []).map((row) => this.decryptRow(row)));
    return rows.map(mapAppConfig);
  }

  /**
   * 摘要派生专用：分页读全量配置行，规避 D1 单次 1000 行上限的静默截断。
   *
   * 计数只能从 config_json 里算，而它在库里是 AES-GCM 密文（D1 无法对密文做 SQL 聚合，
   * 因此在 0012 增加 summary_json 明文摘要列），所以本方法仍要解密；但只投影
   * node_id/app/config_json 三列、不读 secrets_enc，解密结果只活在本次派生里、不出路由。
   * 自 0.8.1 起仅作 summary_json 为 NULL 时的兜底。
   */
  async listForSummary(): Promise<AppConfigSummaryRow[]> {
    const pageSize = 200;
    const rows: AppConfigSummaryRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await this.db
        .prepare(
          'SELECT node_id, app, config_json FROM app_configs ORDER BY node_id, app LIMIT ? OFFSET ?',
        )
        .bind(pageSize, offset)
        .all<{ node_id: string; app: string; config_json: string }>();
      const page = result.results ?? [];
      const configs = await Promise.all(page.map((row) => this.decryptConfig(row.config_json)));
      page.forEach((row, index) => {
        rows.push({ nodeId: row.node_id, app: row.app, config: configs[index]! });
      });
      if (page.length < pageSize) break;
    }
    return rows;
  }

  /**
   * 摘要读取：优先读 0012 的明文 summary_json（零解密）；只要存在 NULL 行
   * （旧版本 Worker 写入、尚未回填），整批回退到解密派生，保证结果不缺项。
   * 分页读取同样规避 D1 单次 1000 行上限。
   */
  async listSummaries(nodeId?: string): Promise<AppSummaryRow[]> {
    const pageSize = 200;
    const rows: AppSummaryRow[] = [];
    let missing = false;
    for (let offset = 0; ; offset += pageSize) {
      const statement = this.db.prepare(
        nodeId
          ? 'SELECT node_id, app, summary_json FROM app_configs WHERE node_id = ? ORDER BY app LIMIT ? OFFSET ?'
          : 'SELECT node_id, app, summary_json FROM app_configs ORDER BY node_id, app LIMIT ? OFFSET ?',
      );
      const bound = nodeId ? statement.bind(nodeId, pageSize, offset) : statement.bind(pageSize, offset);
      const result = await bound.all<{
        node_id: string;
        app: string;
        summary_json: string | null;
      }>();
      const page = result.results ?? [];
      for (const row of page) {
        if (row.summary_json === null) {
          missing = true;
          continue;
        }
        rows.push({
          nodeId: row.node_id,
          app: row.app,
          summary: JSON.parse(row.summary_json) as AppSummaryCounts,
        });
      }
      if (page.length < pageSize) break;
    }
    if (!missing) return rows;

    const configs = nodeId ? await this.listByNode(nodeId) : await this.listForSummary();
    return configs.map((config) => ({
      nodeId: config.nodeId,
      app: config.app,
      summary: summarizeAppConfig(config.app, config.config),
    }));
  }

  async get(nodeId: string, app: string): Promise<AppConfigRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${CONFIG_COLUMNS} FROM app_configs WHERE node_id = ? AND app = ?`)
      .bind(nodeId, app)
      .first<AppConfigRow>();
    if (!row) return null;
    return mapAppConfig(await this.decryptRow(row));
  }

  async put(nodeId: string, app: string, input: PutAppConfigInput): Promise<AppConfigRecord> {
    const now = nowSec();
    const configJson = await this.encryptConfig(input.config);
    // 明文摘要只含模式与计数，供 GET /nodes 零解密派生；与 config 同一次写入落库。
    const summaryJson = JSON.stringify(summarizeAppConfig(app, input.config));

    // B-3：rev 由 INSERT 语句内的子查询原子分配（SELECT MAX(rev)+1 与写入同一语句，
    // 数据库级串行），RETURNING 拿回实际值——旧的"先读 MAX 再写"在读与写之间有真实
    // 并发窗口（加密切割），两个并发保存会算出同一 rev，后者撞 revisions 主键整批失败。
    const revRow = await this.db
      .prepare(
        `INSERT INTO revisions (node_id, app, rev, config_json, note, created_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM revisions WHERE node_id = ? AND app = ?), ?, ?, ?)
         RETURNING rev`,
      )
      .bind(nodeId, app, nodeId, app, configJson, input.note ?? null, now)
      .first<{ rev: number }>();
    const rev = revRow?.rev;
    if (!rev) throw new Error('rev 分配失败（revisions INSERT 未返回 rev）');

    // app_configs 的 rev 只允许单调前进：并发保存时两条语句之间可能已有更大
    // rev 落库，若无条件覆盖 config_json，就会出现"rev=6 但配置是 rev=5 的旧值"。
    // WHERE + RETURNING 让数据库原子地判定是否写入；未写入则回读真实记录返回，
    // 否则调用方会拿着落后于库里的 expectRev 去 apply，被 Agent 以 409 拒绝。
    const upsert = await this.db
      .prepare(
        `INSERT INTO app_configs (${CONFIG_COLUMNS}, summary_json)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
         ON CONFLICT(node_id, app) DO UPDATE SET
           schema_version = excluded.schema_version,
           config_json = excluded.config_json,
           rev = excluded.rev,
           applied_rev = app_configs.applied_rev,
           last_apply_error = NULL,
           updated_at = excluded.updated_at,
           summary_json = excluded.summary_json
         WHERE excluded.rev > app_configs.rev
         RETURNING rev`,
      )
      .bind(nodeId, app, input.schemaVersion, configJson, rev, now, summaryJson)
      .first<{ rev: number }>();

    if (!upsert?.rev) {
      const current = await this.get(nodeId, app);
      if (!current) throw new Error('app_configs 写入后无法回读');
      return current;
    }

    return {
      nodeId,
      app,
      schemaVersion: input.schemaVersion,
      config: input.config,
      secretsEnc: null,
      rev: upsert.rev,
      appliedRev: null,
      lastApplyError: null,
      updatedAt: now,
    };
  }

  async setAppliedRev(nodeId: string, app: string, rev: number): Promise<void> {
    await this.db
      .prepare('UPDATE app_configs SET applied_rev = ? WHERE node_id = ? AND app = ?')
      .bind(rev, nodeId, app)
      .run();
  }

  async setLastApplyError(
    nodeId: string,
    app: string,
    error: import('@khc/contracts').AppApplyError | null,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE app_configs SET last_apply_error = ? WHERE node_id = ? AND app = ?')
      .bind(error ? JSON.stringify(error) : null, nodeId, app)
      .run();
  }

  async listRevisions(nodeId: string, app: string): Promise<RevisionRecord[]> {
    const result = await this.db
      .prepare(
        'SELECT node_id, app, rev, config_json, note, created_at FROM revisions WHERE node_id = ? AND app = ? ORDER BY rev DESC LIMIT 50',
      )
      .bind(nodeId, app)
      .all<RevisionRow>();
    const rows = await Promise.all((result.results ?? []).map((row) => this.decryptRevision(row)));
    return rows.map(mapRevision);
  }

  async getRevision(nodeId: string, app: string, rev: number): Promise<RevisionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT node_id, app, rev, config_json, note, created_at FROM revisions WHERE node_id = ? AND app = ? AND rev = ?',
      )
      .bind(nodeId, app, rev)
      .first<RevisionRow>();
    if (!row) return null;
    return mapRevision(await this.decryptRevision(row));
  }
}
