import { Hono } from 'hono';
import {
  cfDnsAccountCreateRequestSchema,
  cfDnsAccountResponseSchema,
  cfDnsAccountUpdateRequestSchema,
  cfDnsAccountsResponseSchema,
  cfDnsConfigRequestSchema,
  cfDnsRecordCreateForZoneRequestSchema,
  cfDnsRecordCreateRequestSchema,
  cfDnsRecordDeleteResponseSchema,
  cfDnsRecordItemResponseSchema,
  cfDnsRecordResponseSchema,
  cfDnsRecordUpdateRequestSchema,
  cfDnsStatusResponseSchema,
  cfDnsTestResponseSchema,
  cfDnsZoneListResponseSchema,
  cfDnsZoneRecordsResponseSchema,
  okResponseSchema,
  type CfDnsAccount,
  type CfDnsZoneOption,
  type CfDnsZoneRef,
} from '@khc/contracts';
import type { AppBindings, AppDeps, Env } from '../types';
import { AppError, badRequest, misconfigured, notFound } from '../lib/errors';
import { encryptSecret, decryptSecret } from '../lib/crypto';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { requireNode } from './helpers';
import { newId } from '../lib/ids';
import {
  KHC_RECORD_COMMENT,
  createRecord,
  defaultCfFetch,
  deleteRecord,
  findZone,
  listDnsRecords,
  listZones,
  updateRecord,
  verifyToken,
  type CfFetch,
} from '../lib/cf-dns';

/**
 * Cloudflare DNS 集成：
 * - 单 Zone 旧配置存 settings（key=cf_dns），保留兼容；
 * - 多账号配置存 settings（key=cf_dns_accounts）：每条 = 名称 + 加密 Token + 该 Token 可见的 Zone 列表，
 *   主人勾选启用哪些 Zone；子域名选择与安装命令靠这份配置。
 * - 加节点后代建 A/AAAA 记录（comment 标记面板托管），域名写回 nodes.domain；
 * - 删节点时联动删除（错误清单回显，不阻断节点删除本身）。
 */

const CF_DNS_KEY = 'cf_dns';
const CF_DNS_ACCOUNTS_KEY = 'cf_dns_accounts';
const nodeKey = (nodeId: string) => `cf_dns_node_${nodeId}`;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i;

/** 落库形态：token 只存密文（encToken），读路径永不回显明文。 */
interface CfDnsStored {
  encToken: string;
  zoneName: string;
  enabled: boolean;
  zoneId: string | null;
}

interface CfDnsConfig extends Omit<CfDnsStored, 'encToken'> {
  token: string;
}

interface StoredAccount {
  id: string;
  name: string;
  accountName?: string | null;
  encToken: string;
  enabled: boolean;
  zones: CfDnsZoneRef[];
  enabledZoneIds: string[];
}

interface StoredAccounts {
  accounts: StoredAccount[];
}

interface AccountRuntime {
  id: string;
  name: string;
  accountName: string | null;
  token: string;
  enabled: boolean;
  zones: CfDnsZoneRef[];
  enabledZoneIds: string[];
}

interface ManagedRecord {
  id: string;
  type: 'A' | 'AAAA';
  name: string;
  content: string;
  accountId?: string;
  zoneId?: string;
}

interface ManagedRecords {
  records: ManagedRecord[];
}

async function loadConfig(deps: AppDeps, env: Env): Promise<CfDnsConfig | null> {
  const stored = (await deps.settings.getValue(CF_DNS_KEY)) as CfDnsStored | null;
  if (!stored || typeof stored.encToken !== 'string' || typeof stored.zoneName !== 'string') {
    return null;
  }
  if (!env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
  const token = await decryptSecret(env.MASTER_ENC_KEY, stored.encToken, {
    previousKey: env.MASTER_ENC_KEY_PREVIOUS,
  });
  if (!token) return null;
  return {
    token,
    zoneName: stored.zoneName,
    enabled: !!stored.enabled,
    zoneId: stored.zoneId ?? null,
  };
}

/** 读多账号配置；没有则把旧单 Zone 配置投影成一条只读账号（删除/编辑时会迁移）。 */
async function loadAccounts(deps: AppDeps, env: Env): Promise<AccountRuntime[]> {
  if (!env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
  const file = (await deps.settings.getValue(CF_DNS_ACCOUNTS_KEY)) as StoredAccounts | null;
  if (file && Array.isArray(file.accounts) && file.accounts.length > 0) {
    const result: AccountRuntime[] = [];
    for (const account of file.accounts) {
      if (!account || typeof account.encToken !== 'string') continue;
      const token = await decryptSecret(env.MASTER_ENC_KEY, account.encToken, {
        previousKey: env.MASTER_ENC_KEY_PREVIOUS,
      });
      if (!token) continue;
      result.push({
        id: account.id,
        name: account.name,
        accountName: account.accountName ?? null,
        token,
        enabled: !!account.enabled,
        zones: Array.isArray(account.zones) ? account.zones : [],
        enabledZoneIds: Array.isArray(account.enabledZoneIds)
          ? account.enabledZoneIds
          : (account.zones ?? []).map((zone) => zone.id),
      });
    }
    return result;
  }
  const legacy = await loadConfig(deps, env);
  if (!legacy) return [];
  const zones: CfDnsZoneRef[] = legacy.zoneName
    ? [{ id: legacy.zoneId ?? '', name: legacy.zoneName }]
    : [];
  return [
    {
      id: 'legacy',
      name: '默认（旧单 Zone）',
      accountName: null,
      token: legacy.token,
      enabled: legacy.enabled,
      zones,
      enabledZoneIds: zones.map((zone) => zone.id),
    },
  ];
}

async function persistAccounts(deps: AppDeps, env: Env, accounts: AccountRuntime[]): Promise<void> {
  if (!env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
  const stored: StoredAccount[] = [];
  for (const account of accounts) {
    stored.push({
      id: account.id,
      name: account.name,
      accountName: account.accountName,
      // 明文 Token 只在内存里流转；落库前逐条加密
      encToken: await encryptSecret(env.MASTER_ENC_KEY, account.token, {
        keyId: env.MASTER_ENC_KEY_ID,
      }),
      enabled: account.enabled,
      zones: account.zones,
      enabledZoneIds: account.enabledZoneIds,
    });
  }
  await deps.settings.put(CF_DNS_ACCOUNTS_KEY, { accounts: stored });
}

function sanitize(account: AccountRuntime): CfDnsAccount {
  return {
    id: account.id,
    name: account.name,
    accountName: account.accountName,
    hasToken: !!account.token,
    enabled: account.enabled,
    zones: account.zones,
    enabledZoneIds: account.enabledZoneIds,
  };
}

async function loadManaged(deps: AppDeps, nodeId: string): Promise<ManagedRecords | null> {
  const value = (await deps.settings.getValue(nodeKey(nodeId))) as ManagedRecords | null;
  return value && Array.isArray(value.records) ? value : null;
}

function fetcher(deps: AppDeps): CfFetch {
  return deps.cfFetch ?? defaultCfFetch;
}

/** endpoint（https://host:port）→ { host, recordType, content }；仅支持 IP 形式。 */
function ipFromEndpoint(endpoint: string): { type: 'A' | 'AAAA'; content: string } {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw badRequest('节点 endpoint 不是合法 URL', { endpoint: '格式错误' });
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (IPV4_RE.test(host)) return { type: 'A', content: host };
  if (IPV6_RE.test(host) && host.includes(':')) return { type: 'AAAA', content: host };
  throw badRequest(
    '节点 endpoint 是域名，无法推断记录值；请使用 IP 形式的 endpoint 或在 Cloudflare 手工建记录',
    { endpoint: '需要 IP' },
  );
}

/**
 * 未显式选择 Zone 时的默认解析（多凭据模型）：
 * - 恰好一个「已启用账号 + 已启用 Zone」→ 自动使用；
 * - 0 个 → 未启用；
 * - 多个 → 必须显式选择，避免把记录建到错误 Zone。
 * 旧单 Zone 配置由 loadAccounts 投影为 id='legacy' 的账号参与同一套判断。
 */
async function resolveDefaultZoneSelection(
  deps: AppDeps,
  env: Env,
): Promise<
  | { ok: true; account: AccountRuntime; zone: CfDnsZoneRef }
  | { ok: false; reason: 'disabled' | 'ambiguous'; zoneNames: string[] }
> {
  const accounts = await loadAccounts(deps, env);
  const candidates: { account: AccountRuntime; zone: CfDnsZoneRef }[] = [];
  for (const account of accounts) {
    if (!account.enabled) continue;
    for (const zone of account.zones) {
      if (zone.id && !account.enabledZoneIds.includes(zone.id)) continue;
      candidates.push({ account, zone });
    }
  }
  if (candidates.length === 0) return { ok: false, reason: 'disabled', zoneNames: [] };
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      zoneNames: candidates.map((item) => item.zone.name),
    };
  }
  const only = candidates[0]!;
  let zone = only.zone;
  if (!zone.id) {
    const resolved = await findZone(fetcher(deps), only.account.token, zone.name);
    zone = { id: resolved.id, name: zone.name };
  }
  return { ok: true, account: only.account, zone };
}

/** 把「所选 Zone + 子域名」解析到具体账号/Zone；旧单 Zone 配置也能命中。 */
async function resolveZoneSelection(
  deps: AppDeps,
  env: Env,
  zoneId: string,
): Promise<{ account: AccountRuntime; zone: CfDnsZoneRef } | null> {
  const accounts = await loadAccounts(deps, env);
  const fetcher_ = fetcher(deps);
  for (const account of accounts) {
    if (!account.enabled) continue;
    for (const zone of account.zones) {
      // 旧单 Zone 配置没有缓存 id，勾选状态按「空 id」表达
      if (zone.id && !account.enabledZoneIds.includes(zone.id)) continue;
      if (zone.id === zoneId) return { account, zone };
      if (!zone.id) {
        // 旧配置只有 Zone 名：解析一次拿 id
        try {
          const resolved = await findZone(fetcher_, account.token, zone.name);
          if (resolved.id === zoneId) return { account, zone: { id: zoneId, name: zone.name } };
        } catch {
          // 解析失败则继续尝试下一条账号
        }
      }
    }
  }
  return null;
}

export function cfDnsRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/cf-dns', requireAuth);
  router.use('/cf-dns/*', requireAuth);

  // 状态：永不回显 Token，只报告是否已配置（保留旧单 Zone 口径）。
  router.get('/cf-dns', async (c) => {
    const config = await loadConfig(deps, c.env);
    const hasToken = !!config?.token;
    const zoneName = config?.zoneName ?? null;
    return c.json(
      cfDnsStatusResponseSchema.parse({
        enabled: !!config?.enabled,
        configured: hasToken && !!zoneName,
        hasToken,
        zoneName,
      }),
    );
  });

  // 旧单 Zone 保存入口（保留兼容；新界面走 /cf-dns/accounts）。
  router.put('/cf-dns', async (c) => {
    if (!c.env.MASTER_ENC_KEY) throw misconfigured('MASTER_ENC_KEY 未配置');
    const body = await parseJsonBody(c, cfDnsConfigRequestSchema);
    const existing = (await deps.settings.getValue(CF_DNS_KEY)) as CfDnsStored | null;
    if (body.enabled && (!body.zoneName || (!body.token && !existing?.encToken))) {
      throw badRequest('启用前需提供 Zone 名与 API Token', {
        zoneName: body.zoneName ? '' : '必填',
        token: body.token || existing?.encToken ? '' : '必填',
      });
    }
    const stored: CfDnsStored = {
      encToken:
        body.token !== undefined
          ? await encryptSecret(c.env.MASTER_ENC_KEY, body.token, {
              keyId: c.env.MASTER_ENC_KEY_ID,
            })
          : existing?.encToken ?? '',
      zoneName: body.zoneName ?? existing?.zoneName ?? '',
      enabled: body.enabled,
      zoneId: body.zoneName && body.zoneName === existing?.zoneName ? existing?.zoneId ?? null : null,
    };
    await deps.settings.put(CF_DNS_KEY, stored);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.put',
      detail: { enabled: stored.enabled, zoneName: stored.zoneName, tokenProvided: !!body.token },
    });
    return c.json(
      cfDnsStatusResponseSchema.parse({
        enabled: stored.enabled,
        configured: !!stored.encToken && !!stored.zoneName,
        hasToken: !!stored.encToken,
        zoneName: stored.zoneName || null,
      }),
    );
  });

  // 旧单 Zone 测试连接（保留兼容）。
  router.post('/cf-dns/test', async (c) => {
    const config = await loadConfig(deps, c.env);
    if (!config?.token || !config.zoneName) {
      throw new AppError(409, 'cf_dns_not_configured', '请先保存 Cloudflare Token 与 Zone 名');
    }
    const fetcher_ = fetcher(deps);
    const tokenStatus = await verifyToken(fetcher_, config.token);
    const zone = await findZone(fetcher_, config.token, config.zoneName);
    if (config.zoneId !== zone.id) {
      const stored = (await deps.settings.getValue(CF_DNS_KEY)) as CfDnsStored | null;
      await deps.settings.put(CF_DNS_KEY, {
        encToken: stored?.encToken ?? '',
        zoneName: config.zoneName,
        enabled: config.enabled,
        zoneId: zone.id,
      });
    }
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.test',
      detail: { zoneName: zone.name },
    });
    return c.json(cfDnsTestResponseSchema.parse({ ok: true, tokenStatus, zone }));
  });

  // 多凭据：列表（Token 只回 hasToken 语义，绝不回显）
  router.get('/cf-dns/accounts', async (c) => {
    const accounts = await loadAccounts(deps, c.env);
    return c.json(cfDnsAccountsResponseSchema.parse({ accounts: accounts.map(sanitize) }));
  });

  // 多凭据：新增（验证 Token 并拉取全部 Zone；默认全部勾选）
  router.post('/cf-dns/accounts', async (c) => {
    const body = await parseJsonBody(c, cfDnsAccountCreateRequestSchema);
    const fetcher_ = fetcher(deps);
    let listed;
    try {
      listed = await listZones(fetcher_, body.token);
    } catch (error) {
      throw new AppError(400, 'cf_dns_token_invalid', error instanceof Error ? error.message : 'Token 校验失败');
    }
    if (listed.length === 0) {
      throw new AppError(400, 'cf_dns_no_zones', '该 Token 下没有可用 Zone（需要 Zone:Read 权限）');
    }
    const zones: CfDnsZoneRef[] = listed.map((zone) => ({ id: zone.id, name: zone.name }));
    const accounts = await loadAccounts(deps, c.env);
    const account: AccountRuntime = {
      id: newId('cf'),
      name: body.name,
      accountName: listed.find((zone) => zone.accountName)?.accountName ?? null,
      token: body.token,
      enabled: true,
      zones,
      enabledZoneIds: zones.map((zone) => zone.id),
    };
    // 若仍是旧单 Zone 配置，迁移成多凭据文件（旧账号原文保留为新列表的第一条）
    const next = accounts.length ? [...accounts, account] : [account];
    await persistAccounts(deps, c.env, next);
    if (accounts.some((item) => item.id === 'legacy')) {
      await deps.settings.remove(CF_DNS_KEY);
    }
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.account.create',
      detail: { accountId: account.id, name: account.name, zones: zones.length },
    });
    return c.json(
      cfDnsAccountResponseSchema.parse({
        account: sanitize(account),
        zones: account.zones,
      }),
      201,
    );
  });

  // 多凭据：改名称 / 启停 / 勾选 Zone
  router.put('/cf-dns/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, cfDnsAccountUpdateRequestSchema);
    const accounts = await loadAccounts(deps, c.env);
    const account = accounts.find((item) => item.id === id);
    if (!account) throw notFound('凭据不存在');
    if (body.name !== undefined) account.name = body.name;
    if (body.enabled !== undefined) account.enabled = body.enabled;
    if (body.enabledZoneIds !== undefined) {
      const known = new Set(account.zones.map((zone) => zone.id));
      const invalid = body.enabledZoneIds.filter((zoneId) => !known.has(zoneId));
      if (invalid.length) throw badRequest('包含不属于该凭据的 Zone', { zones: invalid.join(',') });
      account.enabledZoneIds = body.enabledZoneIds;
    }
    await persistAccounts(deps, c.env, accounts);
    if (account.id === 'legacy') {
      // 迁移完成后删除旧单 Zone 配置，避免双份真相
      await deps.settings.remove(CF_DNS_KEY);
    }
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.account.update',
      detail: { accountId: id, enabled: account.enabled, zones: account.enabledZoneIds.length },
    });
    return c.json(cfDnsAccountResponseSchema.parse({ account: sanitize(account) }));
  });

  // 多凭据：删除（不动 Cloudflare 侧记录；节点托管记录删节点时仍会尝试清理）
  router.delete('/cf-dns/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const accounts = await loadAccounts(deps, c.env);
    const account = accounts.find((item) => item.id === id);
    if (!account) throw notFound('凭据不存在');
    const remaining = accounts.filter((item) => item.id !== id);
    if (remaining.length === 0) {
      await deps.settings.remove(CF_DNS_ACCOUNTS_KEY);
    } else {
      await persistAccounts(deps, c.env, remaining);
    }
    // 旧单 Zone 账号被删时一并清掉旧键，防止列表里又冒出来
    if (id === 'legacy') await deps.settings.remove(CF_DNS_KEY);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.account.delete',
      detail: { accountId: id },
    });
    return c.json(cfDnsAccountsResponseSchema.parse({ accounts: remaining.map(sanitize) }));
  });

  // 多凭据：重新拉取 Zone 列表（合并已勾选项）
  router.post('/cf-dns/accounts/:id/refresh', async (c) => {
    const id = c.req.param('id');
    if (id === 'legacy') throw badRequest('旧单 Zone 配置不支持刷新；请重新添加凭据');
    const accounts = await loadAccounts(deps, c.env);
    const account = accounts.find((item) => item.id === id);
    if (!account) throw notFound('凭据不存在');
    const listed = await listZones(fetcher(deps), account.token);
    const zones = listed.map((zone) => ({ id: zone.id, name: zone.name }));
    const known = new Set(zones.map((zone) => zone.id));
    account.accountName = listed.find((zone) => zone.accountName)?.accountName ?? account.accountName;
    account.zones = zones;
    account.enabledZoneIds = account.enabledZoneIds.filter((zoneId) => known.has(zoneId));
    await persistAccounts(deps, c.env, accounts);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.account.refresh',
      detail: { accountId: id, zones: zones.length },
    });
    return c.json(cfDnsAccountResponseSchema.parse({ account: sanitize(account), zones }));
  });

  // 加节点时可选 Zone（跨凭据汇总，只含启用账号里已勾选的 Zone）
  router.get('/cf-dns/zones', async (c) => {
    const accounts = await loadAccounts(deps, c.env);
    const fetcher_ = fetcher(deps);
    const zones: CfDnsZoneOption[] = [];
    let migrated = false;
    for (const account of accounts) {
      if (!account.enabled) continue;
      for (const zone of account.zones) {
        // 旧单 Zone 配置没有缓存 id，勾选状态按「空 id」表达
        if (zone.id && !account.enabledZoneIds.includes(zone.id)) continue;
        let id = zone.id;
        if (!id) {
          // 旧单 Zone 配置没有缓存 id：解析一次（失败则跳过，不影响手工路径）
          try {
            id = (await findZone(fetcher_, account.token, zone.name)).id;
            // 解析成功即回写，后续编辑/建记录不再每次调 Cloudflare
            zone.id = id;
            account.enabledZoneIds = account.enabledZoneIds
              .filter((zoneId) => zoneId)
              .concat(id);
            migrated = true;
          } catch {
            continue;
          }
        }
        zones.push({ id, name: zone.name, accountId: account.id, accountName: account.name });
      }
    }
    if (migrated) await persistAccounts(deps, c.env, accounts);
    return c.json(cfDnsZoneListResponseSchema.parse({ zones }));
  });

  // 读取已启用 Zone 的现有解析记录（只读；添加节点时选择已有记录）。
  router.get('/cf-dns/records', async (c) => {
    const zoneId = c.req.query('zoneId')?.trim();
    if (!zoneId) throw badRequest('缺少 zoneId');
    const selection = await resolveZoneSelection(deps, c.env, zoneId);
    if (!selection) {
      throw new AppError(409, 'cf_dns_zone_unavailable', '所选 Zone 未启用或凭据已变更；请重新选择');
    }
    const records = await listDnsRecords(fetcher(deps), selection.account.token, zoneId);
    const typeRank: Record<string, number> = { A: 0, AAAA: 1, CNAME: 2 };
    records.sort(
      (a, b) =>
        (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9) ||
        a.name.localeCompare(b.name) ||
        a.content.localeCompare(b.content),
    );
    return c.json(
      cfDnsZoneRecordsResponseSchema.parse({
        zoneId,
        zoneName: selection.zone.name,
        records: records.map((record) => ({
          ...record,
          managed: record.comment === KHC_RECORD_COMMENT,
        })),
      }),
    );
  });

  // 全局域名管理：单条记录改 / 删（设置页「域名」，不依赖节点）。
  router.patch('/cf-dns/records/:zoneId/:recordId', async (c) => {
    const zoneId = c.req.param('zoneId');
    const recordId = c.req.param('recordId');
    const body = await parseJsonBody(c, cfDnsRecordUpdateRequestSchema);
    const selection = await resolveZoneSelection(deps, c.env, zoneId);
    if (!selection) {
      throw new AppError(409, 'cf_dns_zone_unavailable', '所选 Zone 未启用或凭据已变更；请重新选择');
    }
    if (body.name) {
      const zoneName = selection.zone.name;
      if (body.name !== zoneName && !body.name.endsWith(`.${zoneName}`)) {
        throw badRequest('记录名必须是所选 Zone 的子域', { name: `需以 .${zoneName} 结尾` });
      }
    }
    const record = await updateRecord(fetcher(deps), selection.account.token, {
      zoneId,
      recordId,
      ...body,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.record.update',
      detail: { zoneId, recordId, name: record.name },
    });
    return c.json(
      cfDnsRecordItemResponseSchema.parse({
        record: { ...record, managed: record.comment === KHC_RECORD_COMMENT },
      }),
    );
  });

  router.delete('/cf-dns/records/:zoneId/:recordId', async (c) => {
    const zoneId = c.req.param('zoneId');
    const recordId = c.req.param('recordId');
    const selection = await resolveZoneSelection(deps, c.env, zoneId);
    if (!selection) {
      throw new AppError(409, 'cf_dns_zone_unavailable', '所选 Zone 未启用或凭据已变更；请重新选择');
    }
    await deleteRecord(fetcher(deps), selection.account.token, zoneId, recordId);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.record.delete',
      detail: { zoneId, recordId },
    });
    return c.json(okResponseSchema.parse({ ok: true }));
  });

  // 全局域名管理：在指定 Zone 下新增一条记录（不绑定节点）。
  router.post('/cf-dns/records/:zoneId', async (c) => {
    const zoneId = c.req.param('zoneId');
    const body = await parseJsonBody(c, cfDnsRecordCreateForZoneRequestSchema);
    const selection = await resolveZoneSelection(deps, c.env, zoneId);
    if (!selection) {
      throw new AppError(409, 'cf_dns_zone_unavailable', '所选 Zone 未启用或凭据已变更；请重新选择');
    }
    const zoneName = selection.zone.name;
    if (body.name !== zoneName && !body.name.endsWith(`.${zoneName}`)) {
      throw badRequest('记录名必须是所选 Zone 的子域', { name: `需以 .${zoneName} 结尾` });
    }
    const record = await createRecord(fetcher(deps), selection.account.token, {
      zoneId,
      type: body.type,
      name: body.name,
      content: body.content,
      proxied: body.proxied,
      ttl: body.ttl,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cfDns.record.create',
      detail: { zoneId, type: record.type, name: record.name },
    });
    return c.json(
      cfDnsRecordItemResponseSchema.parse({
        record: {
          ...record,
          proxied: body.proxied ?? false,
          comment: null,
          managed: false,
        },
      }),
      201,
    );
  });

  // 代建记录：面板调用；DNS 失败不影响节点本身（独立端点）。
  router.post('/cf-dns/records', async (c) => {
    const body = await parseJsonBody(c, cfDnsRecordCreateRequestSchema);
    const node = await requireNode(deps, body.nodeId);
    const existingManaged = await loadManaged(deps, node.id);
    const first = existingManaged?.records[0];
    if (first) {
      // 幂等重入：面板已托管该节点的记录，直接返回，不重复创建。
      if (!node.domain) await deps.nodes.update(node.id, { domain: first.name });
      return c.json(
        cfDnsRecordResponseSchema.parse({
          created: false,
          record: { id: first.id, type: first.type, name: first.name, content: first.content },
          domain: first.name,
        }),
      );
    }
    const { type, content } = ipFromEndpoint(node.endpoint);
    const fetcher_ = fetcher(deps);

    let token: string;
    let zoneId: string;
    let zoneName: string;
    let accountId: string | undefined;

    if (body.zoneId) {
      const selection = await resolveZoneSelection(deps, c.env, body.zoneId);
      if (!selection) {
        throw new AppError(409, 'cf_dns_zone_unavailable', '所选 Zone 未启用或凭据已变更；请重新选择');
      }
      token = selection.account.token;
      zoneId = selection.zone.id;
      zoneName = selection.zone.name;
      accountId = selection.account.id;
    } else {
      // 多凭据模型：未显式选择 Zone 时，只有唯一启用 Zone 才自动代建；
      // 多个 Zone 必须让前端带上选择，不能默默挑一个。
      const selection = await resolveDefaultZoneSelection(deps, c.env);
      if (!selection.ok) {
        if (selection.reason === 'ambiguous') {
          throw new AppError(
            409,
            'cf_dns_zone_required',
            `检测到多个已启用的 Zone（${selection.zoneNames.join('、')}）；请选择具体 Zone 与子域后重试`,
          );
        }
        throw new AppError(
          409,
          'cf_dns_disabled',
          'Cloudflare DNS 集成未启用；可在设置页配置，或在 Cloudflare 手工建记录',
        );
      }
      token = selection.account.token;
      zoneId = selection.zone.id;
      zoneName = selection.zone.name;
      accountId = selection.account.id;
      // 旧单 Zone 配置没有缓存 id：解析成功后回写，避免每次代建都重新查 Zone。
      if (selection.account.id === 'legacy') {
        const stored = (await deps.settings.getValue(CF_DNS_KEY)) as CfDnsStored | null;
        if (stored && !stored.zoneId) {
          await deps.settings.put(CF_DNS_KEY, { ...stored, zoneId });
        }
      }
    }

    const name = body.subdomain ? `${body.subdomain}.${zoneName}` : `${node.name}.${zoneName}`;
    const record = await createRecord(fetcher_, token, {
      zoneId,
      type,
      name,
      content,
      comment: KHC_RECORD_COMMENT,
    });
    // 写托管清单 + 节点域名；失败 → 回滚刚建的记录，不留面板不知道的 CF 记录。
    try {
      await deps.settings.put(nodeKey(node.id), {
        records: [{ ...record, accountId, zoneId }],
      });
      await deps.nodes.update(node.id, { domain: record.name });
    } catch (error) {
      await deleteRecord(fetcher_, token, zoneId, record.id).catch(() => {});
      throw new AppError(500, 'internal_error', `记录已创建但登记失败，已回滚：${String(error)}`);
    }
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'cfDns.record.create',
      detail: { type, name: record.name, content, accountId },
    });
    return c.json(
      cfDnsRecordResponseSchema.parse({
        created: true,
        record: { id: record.id, type: record.type, name: record.name, content: record.content },
        domain: record.name,
      }),
      201,
    );
  });

  // 联动删除：错误清单回显，不抛错（不阻断节点删除）。
  router.delete('/cf-dns/records/:nodeId', async (c) => {
    const nodeId = c.req.param('nodeId');
    const errors: string[] = [];
    let deleted = false;
    const managed = await loadManaged(deps, nodeId);
    if (!managed) {
      // 从未代建（或已删）：幂等成功。
      return c.json(cfDnsRecordDeleteResponseSchema.parse({ deleted: true, errors }));
    }
    const accounts = await loadAccounts(deps, c.env);
    const fetcher_ = fetcher(deps);
    const remaining: ManagedRecord[] = [];
    for (const record of managed.records) {
      let token: string | null = null;
      let zoneId = record.zoneId ?? '';
      if (record.accountId) {
        const account = accounts.find((item) => item.id === record.accountId);
        token = account?.token ?? null;
        if (!zoneId && account) {
          const zone = account.zones.find((item) => record.name.endsWith(`.${item.name}`));
          zoneId = zone?.id ?? '';
        }
      }
      if (!token) {
        // 历史托管记录没有 accountId：退回旧单 Zone 配置
        const config = await loadConfig(deps, c.env);
        if (!config?.token) {
          errors.push(`${record.name}：面板已无对应 Cloudflare 凭据，请手工删除`);
          remaining.push(record);
          continue;
        }
        token = config.token;
        if (!zoneId) {
          try {
            zoneId = (await findZone(fetcher_, token, config.zoneName)).id;
          } catch (error) {
            errors.push(`${record.name}：${error instanceof Error ? error.message : 'Zone 解析失败'}`);
            remaining.push(record);
            continue;
          }
        }
      }
      try {
        await deleteRecord(fetcher_, token, zoneId, record.id);
        deleted = true;
      } catch (error) {
        errors.push(`${record.name}：${error instanceof Error ? error.message : '删除失败'}`);
        remaining.push(record);
      }
    }
    if (remaining.length === 0) {
      await deps.settings.remove(nodeKey(nodeId));
    } else {
      await deps.settings.put(nodeKey(nodeId), { records: remaining });
    }
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId,
      action: 'cfDns.record.delete',
      detail: { deleted, failed: remaining.length },
    });
    return c.json(cfDnsRecordDeleteResponseSchema.parse({ deleted, errors }));
  });

  return router;
}
