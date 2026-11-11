import { Hono } from 'hono';
import {
  backupExportSchema,
  backupImportRequestSchema,
  backupImportResponseSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { DEFAULT_ENC_KEY_ID } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { requireNode } from './helpers';


const APP_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_APPS = 50;

/**
 * 只按字段名剥离已知密钥；备份默认不携带任何私钥/预共享密钥/口令哈希。
 * basicauth.passwordHash 是 bcrypt（不可逆）但可离线爆破，同样默认剥离；
 * 导入时由 restoreSecrets 按稳定标识保留目标节点旧值。
 */
const SECRET_KEYS = new Set([
  'privatekey',
  'presharedkey',
  'private_key',
  'preshared_key',
  'psk',
  'passwordhash',
  'password_hash',
]);
const STRIPPED_KEYS = [...SECRET_KEYS].sort();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripSecrets(item);
  }
  return out;
}

/** 稳定对象标识：publicKey 优先，其次 id；name 只作最后兜底。 */
function stableIdentity(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ['publicKey', 'id', 'name'] as const) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) return `${key}:${raw}`;
  }
  return null;
}

/**
 * 导入时保留目标节点已有的私钥/PSK；新配置里被剥离的字段不覆盖旧值。
 *
 * 关键：只按稳定标识匹配，**绝不按下标兜底**。公钥变了就是另一把钥匙，
 * 不能把旧 privateKey 拼到新 publicKey 上。
 */
function restoreSecrets(existing: unknown, incoming: unknown, inherit = false): unknown {
  if (Array.isArray(incoming)) {
    const old = Array.isArray(existing) ? existing : [];
    return incoming.map((item) => {
      const key = stableIdentity(item);
      const match = key ? old.find((candidate) => stableIdentity(candidate) === key) : undefined;
      // 数组元素必须自带稳定标识才算同一对象，绝不按下标继承。
      return restoreSecrets(match, item, false);
    });
  }
  if (!isRecord(incoming)) return incoming;
  const old = isRecord(existing) ? existing : {};
  const out: Record<string, unknown> = {};
  const incomingIdentity = stableIdentity(incoming);
  const oldIdentity = stableIdentity(old);
  const sameObject =
    incomingIdentity === null || oldIdentity === null ? false : incomingIdentity === oldIdentity;
  // inherit：父对象已按稳定标识匹配（如站点的 basicauth 子对象），
  // 允许恢复父对象内部被剥离的口令哈希等；子对象自身不再要求有标识。
  const allowRestore = sameObject || inherit;
  for (const [key, item] of Object.entries(incoming)) {
    out[key] = restoreSecrets(old[key], item, allowRestore);
  }
  if (allowRestore) {
    for (const [key, item] of Object.entries(old)) {
      if (!(key in out) && SECRET_KEYS.has(key.toLowerCase())) out[key] = item;
    }
  }
  return out;
}

/**
 * C4 备份/恢复：只导出节点公开信息 + 各应用配置（不导出节点 token、
 * 证书 PEM/DNS 凭据）。恢复只写 app_configs，不自动 apply；由操作者逐项 plan/apply。
 */
export function backupRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/nodes/*', requireAuth);

  router.get('/nodes/:id/export', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const records = await deps.apps.listByNode(node.id);
    const apps = records
      .filter((record) => APP_RE.test(record.app))
      .map((record) => ({
        app: record.app,
        schemaVersion: record.schemaVersion,
        config: stripSecrets(record.config) as Record<string, unknown>,
      }));
    return c.json(
      backupExportSchema.parse({
        format: 'khc-backup/v1',
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        manifest: {
          stripped: STRIPPED_KEYS,
          encKeyId: c.env.MASTER_ENC_KEY_ID ?? DEFAULT_ENC_KEY_ID,
        },
        node: {
          id: node.id,
          name: node.name,
          endpoint: node.endpoint,
          tunnelEndpoint: node.tunnelEndpoint,
          liveEndpoint: node.liveEndpoint,
          preferredRoute: node.preferredRoute,
        },
        apps,
      }),
    );
  });

  router.post('/nodes/:id/import', async (c) => {
    const node = await requireNode(deps, c.req.param('id'));
    const body = await parseJsonBody(c, backupImportRequestSchema);
    if (body.apps.length > MAX_APPS) {
      throw badRequest(`备份应用数超过上限 ${MAX_APPS}`);
    }
    const seen = new Set<string>();
    const imported: Array<{ app: string; rev: number; schemaVersion: number }> = [];
    for (const item of body.apps) {
      if (seen.has(item.app)) throw badRequest(`备份中应用重复：${item.app}`);
      seen.add(item.app);
      if (!APP_RE.test(item.app)) throw badRequest(`应用名非法：${item.app}`);
      const existing = await deps.apps.get(node.id, item.app);
      const safeConfig = stripSecrets(item.config) as Record<string, unknown>;
      const merged = restoreSecrets(existing?.config, safeConfig) as Record<string, unknown>;
      const record = await deps.apps.put(node.id, item.app, {
        config: merged,
        schemaVersion: item.schemaVersion,
        note: `import ${new Date(body.exportedAt * 1000).toISOString()}`,
        actor: c.get('user').name,
      });
      imported.push({ app: record.app, rev: record.rev, schemaVersion: record.schemaVersion });
    }
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'node.import',
      detail: { apps: imported.map((item) => item.app) },
    });
    return c.json(
      backupImportResponseSchema.parse({ ok: true, nodeId: node.id, apps: imported }),
    );
  });

  return router;
}
