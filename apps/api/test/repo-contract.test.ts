import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AppConfigRepo,
  AuditRepo,
  CertificateRepo,
  NodeRepo,
  SettingsRepo,
} from '../src/domain/repos';
import {
  MemoryAppConfigRepo,
  MemoryAuditRepo,
  MemoryCertificateRepo,
  MemoryNodeRepo,
  MemorySettingsRepo,
} from './helpers/memory';
import {
  applyMigrations,
  openRawDatabase,
  toD1,
  type RawDatabase,
} from './helpers/sqlite-d1';
import { D1AppConfigRepo } from '../src/db/d1/apps';
import { D1AuditRepo } from '../src/db/d1/audit';
import { D1CertificateRepo } from '../src/db/d1/certs';
import { D1NodeRepo } from '../src/db/d1/nodes';
import { D1SettingsRepo } from '../src/db/d1/settings';

const ENC_KEY = 'test-master-key-0123456789';

interface Repos {
  nodes: NodeRepo;
  apps: AppConfigRepo;
  audit: AuditRepo;
  certs: CertificateRepo;
  settings: SettingsRepo;
}

function memoryRepos(): Repos {
  return {
    nodes: new MemoryNodeRepo(),
    apps: new MemoryAppConfigRepo(),
    audit: new MemoryAuditRepo(),
    certs: new MemoryCertificateRepo(),
    settings: new MemorySettingsRepo(),
  };
}

/**
 * D1 实现：真实本地 sqlite（node:sqlite）+ 全量迁移，不打生产、不需要网络。
 * 仓储测试用不着 D1 环境的其他绑定，encKey 与面板同源（test MASTER_ENC_KEY）。
 */
function d1Repos(): Repos {
  const raw = openRawDatabase();
  applyMigrations(raw);
  const db = toD1(raw);
  return {
    nodes: new D1NodeRepo(db),
    apps: new D1AppConfigRepo(db, ENC_KEY),
    audit: new D1AuditRepo(db),
    certs: new D1CertificateRepo(db, ENC_KEY),
    settings: new D1SettingsRepo(db, ENC_KEY),
  };
}

/** 契约双跑：同一套用例跑 Memory 与 db/d1 两套实现 */
function contractSuite(label: string, make: () => Repos): void {
  describe(`仓储契约（${label}）`, () => {
    let repos: Repos;
    beforeEach(() => {
      repos = make();
    });

    it('nodes：增删改查 + 按创建顺序排列', async () => {
      const first = await repos.nodes.create({
        name: '甲',
        endpoint: 'https://a.example.com:8443',
        tokenEnc: 'enc-a',
      });
      const second = await repos.nodes.create({
        name: '乙',
        endpoint: 'https://b.example.com:8880',
        tunnelEndpoint: 'https://t.example.com',
        tokenEnc: 'enc-b',
      });
      expect(first.preferredRoute).toBe('direct');
      expect(first.lastSeenAt).toBeNull();
      // D-2/T2.2：创建即生成 rev epoch（16 字节随机 hex，节点间互异）
      expect(first.revEpoch).toMatch(/^[0-9a-f]{32}$/);
      expect(second.revEpoch).toMatch(/^[0-9a-f]{32}$/);
      expect(second.revEpoch).not.toBe(first.revEpoch);

      const got = await repos.nodes.get(first.id);
      expect(got?.name).toBe('甲');
      expect(got?.tokenEnc).toBe('enc-a');
      expect(got?.revEpoch).toBe(first.revEpoch);

      const list = await repos.nodes.list();
      expect(list.map((item) => item.id)).toEqual([first.id, second.id]);

      const updated = await repos.nodes.update(first.id, {
        name: '甲改',
        preferredRoute: 'tunnel',
        lastSeenAt: 123,
      });
      expect(updated?.name).toBe('甲改');
      expect(updated?.preferredRoute).toBe('tunnel');
      expect(updated?.lastSeenAt).toBe(123);
      // 未更新的字段保持（rev epoch 不受其他字段更新影响）
      expect(updated?.endpoint).toBe('https://a.example.com:8443');
      expect(updated?.revEpoch).toBe(first.revEpoch);

      expect(await repos.nodes.update('nd_missing', { name: 'x' })).toBeNull();
      expect(await repos.nodes.remove('nd_missing')).toBe(false);
      expect(await repos.nodes.remove(second.id)).toBe(true);
      expect(await repos.nodes.get(second.id)).toBeNull();
    });

    it('apps：rev 递增、revisions 倒序、appliedRev 跨 put 保留、lastApplyError 可写可清', async () => {
      const node = await repos.nodes.create({
        name: 'n',
        endpoint: 'https://n.example.com',
        tokenEnc: 'e',
      });
      const first = await repos.apps.put(node.id, 'wireguard', {
        config: { peers: ['a'] },
        schemaVersion: 1,
        note: '初版',
        actor: 'admin',
      });
      expect(first.rev).toBe(1);
      const second = await repos.apps.put(node.id, 'wireguard', {
        config: { peers: ['a', 'b'] },
        schemaVersion: 1,
        actor: 'admin',
      });
      expect(second.rev).toBe(2);
      // 同一 (node, app) 只有一条配置（PK upsert，不产生重复）
      expect((await repos.apps.listByNode(node.id)).filter((r) => r.app === 'wireguard')).toHaveLength(1);

      const revisions = await repos.apps.listRevisions(node.id, 'wireguard');
      expect(revisions.map((r) => r.rev)).toEqual([2, 1]);
      expect((await repos.apps.getRevision(node.id, 'wireguard', 1))?.config).toEqual({
        peers: ['a'],
      });
      expect((await repos.apps.getRevision(node.id, 'wireguard', 99))?.rev ?? null).toBeNull();

      await repos.apps.setAppliedRev(node.id, 'wireguard', 2);
      expect((await repos.apps.get(node.id, 'wireguard'))?.appliedRev).toBe(2);
      // 保存新配置不清空 appliedRev（同步进度以 appliedRev 表达）
      await repos.apps.put(node.id, 'wireguard', {
        config: { peers: ['a', 'b', 'c'] },
        schemaVersion: 1,
        actor: 'admin',
      });
      expect((await repos.apps.get(node.id, 'wireguard'))?.appliedRev).toBe(2);

      // lastApplyError：写入、读回、清空
      await repos.apps.setLastApplyError(node.id, 'wireguard', {
        code: 'apply_failed',
        message: '端口被占用',
        at: 111,
      });
      const errored = await repos.apps.get(node.id, 'wireguard');
      expect(errored?.lastApplyError).toMatchObject({
        code: 'apply_failed',
        message: '端口被占用',
      });
      await repos.apps.setLastApplyError(node.id, 'wireguard', null);
      expect((await repos.apps.get(node.id, 'wireguard'))?.lastApplyError).toBeNull();

      // 多应用排序 + 节点隔离
      await repos.apps.put(node.id, 'caddy-site', {
        config: { site: 'x' },
        schemaVersion: 1,
        actor: 'admin',
      });
      const other = await repos.nodes.create({
        name: 'm',
        endpoint: 'https://m.example.com',
        tokenEnc: 'e',
      });
      await repos.apps.put(other.id, 'caddy-site', {
        config: { site: 'y' },
        schemaVersion: 1,
        actor: 'admin',
      });
      const mine = await repos.apps.listByNode(node.id);
      expect(mine.map((r) => r.app)).toEqual(['caddy-site', 'wireguard']);
      expect(mine.every((r) => r.nodeId === node.id)).toBe(true);

      // listForSummary：分页读全量（GET /nodes 摘要派生），内容与 listByNode 一致
      const all = await repos.apps.listForSummary();
      expect(all).toHaveLength(3);
      expect(all.filter((r) => r.nodeId === node.id).map((r) => r.app)).toEqual([
        'caddy-site',
        'wireguard',
      ]);
      expect(all.find((r) => r.nodeId === other.id)?.config).toEqual({ site: 'y' });

      // listSummaries：优先读明文摘要；有行即非 null（0 条也保留 0）
      const summaries = await repos.apps.listSummaries();
      expect(summaries).toHaveLength(3);
      expect(summaries.find((r) => r.nodeId === node.id && r.app === 'wireguard')?.summary).toEqual({
        mode: 'wg',
        peers: 3,
      });
      expect(summaries.find((r) => r.nodeId === node.id && r.app === 'caddy-site')?.summary).toEqual({
        sites: { total: 0, disabled: 0 },
      });
      const mineSummaries = await repos.apps.listSummaries(node.id);
      expect(mineSummaries.map((r) => r.app)).toEqual(['caddy-site', 'wireguard']);
      expect(mineSummaries.every((r) => r.nodeId === node.id)).toBe(true);
    });

    it('audit：limit 截断、nodeId 过滤、新→旧排序', async () => {
      for (const action of ['one', 'two', 'three', 'four']) {
        await repos.audit.log({
          actor: 'admin',
          nodeId: 'nd_a',
          action,
          detail: { action },
        });
      }
      await repos.audit.log({ actor: 'admin', nodeId: 'nd_b', action: 'other' });

      const top3 = await repos.audit.list({ nodeId: 'nd_a', limit: 3 });
      expect(top3.map((r) => r.action)).toEqual(['four', 'three', 'two']);
      expect(top3.every((r) => r.nodeId === 'nd_a')).toBe(true);

      const all5 = await repos.audit.list({ limit: 5 });
      expect(all5.map((r) => r.action)).toEqual(['other', 'four', 'three', 'two', 'one']);
      // limit 非法值收敛到边界（0 → 1，>20 → 20）
      const clamped = await repos.audit.list({ limit: 0 });
      expect(clamped).toHaveLength(1);
    });

    it('certs：创建/列表/详情/物料解密/删除', async () => {
      const cert = await repos.certs.create({
        name: '站点证书',
        domains: ['a.example.com'],
        issuer: "Let's Encrypt",
        notAfter: 9999999999,
        certPem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN PRIVATE KEY-----\ndef\n-----END PRIVATE KEY-----',
        sourceNodeId: null,
      });
      expect((await repos.certs.list()).map((c) => c.id)).toEqual([cert.id]);
      const got = await repos.certs.get(cert.id);
      expect(got?.domains).toEqual(['a.example.com']);
      expect(typeof got?.certPemEnc).toBe('string');
      // material 解密回原始 PEM
      const material = await repos.certs.material(cert.id);
      expect(material?.certPem).toContain('BEGIN CERTIFICATE');
      expect(material?.keyPem).toContain('BEGIN PRIVATE KEY');

      expect(await repos.certs.remove('cert_missing')).toBe(false);
      expect(await repos.certs.remove(cert.id)).toBe(true);
      expect(await repos.certs.get(cert.id)).toBeNull();
    });

    it('settings：put/get 往返、覆盖、list、删除', async () => {
      await repos.settings.put('cfDnsToken', { token: 'abc' });
      expect(await repos.settings.getValue('cfDnsToken')).toEqual({ token: 'abc' });
      expect(await repos.settings.getValue('missing')).toBeNull();

      await repos.settings.put('cfDnsToken', { token: 'def' });
      expect(await repos.settings.getValue('cfDnsToken')).toEqual({ token: 'def' });
      expect((await repos.settings.list()).map((s) => s.key)).toEqual(['cfDnsToken']);

      expect(await repos.settings.remove('missing')).toBe(false);
      expect(await repos.settings.remove('cfDnsToken')).toBe(true);
      expect(await repos.settings.getValue('cfDnsToken')).toBeNull();
    });
  });
}

contractSuite('Memory', memoryRepos);
contractSuite('D1/sqlite', d1Repos);

describe('D1 专属：事务、唯一约束与密文落库（真实 sqlite）', () => {
  let raw: RawDatabase;
  beforeEach(() => {
    raw = openRawDatabase();
    applyMigrations(raw);
  });

  it('batch 事务：任一语句失败整批回滚', async () => {
    const db = toD1(raw);
    const ok = db
      .prepare('INSERT INTO nodes (id, name, endpoint, preferred_route, token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('nd_1', 'n', 'https://x', 'direct', 'enc', 1, 1);
    const dup = db
      .prepare('INSERT INTO nodes (id, name, endpoint, preferred_route, token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('nd_1', 'n', 'https://x', 'direct', 'enc', 1, 1);
    // 必须 await：不 await 时断言要到测试结束才被自动收敛，回滚还没落地就去查 COUNT，
    // 既会产生竞态，也会在下一个 vitest major 直接失败。
    await expect(db.batch([ok, dup])).rejects.toThrow();
    // 第一条不能落库
    const count = raw.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('nodes.remove 级联清理 revisions/app_configs/nodes（batch 三删）', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    await apps.put(node.id, 'wireguard', {
      config: { peers: [1] },
      schemaVersion: 1,
      actor: 'admin',
    });
    expect(await nodes.remove(node.id)).toBe(true);
    for (const table of ['nodes', 'app_configs', 'revisions']) {
      const count = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(count.n).toBe(0);
    }
  });

  it('app_configs.config_json 以 AES-GCM 密文落库，读回明文一致', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    const secret = { privateKey: 'super-secret-key-material' };
    await apps.put(node.id, 'wireguard', {
      config: secret,
      schemaVersion: 1,
      actor: 'admin',
    });
    const stored = raw
      .prepare('SELECT config_json FROM app_configs WHERE node_id = ?')
      .get(node.id) as { config_json: string };
    // A-11：新行直接带 crypto 层 enc:v2:<keyId>: 前缀（apps.ts 不再套 enc:v1:）
    expect(stored.config_json.startsWith('enc:v2:')).toBe(true);
    expect(stored.config_json).not.toContain('super-secret-key-material');
    expect((await apps.get(node.id, 'wireguard'))?.config).toEqual(secret);
  });

  it('兼容历史 enc:v1: 包装密文行（A-11 轮换路径）', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    const config = { legacy: true };
    await apps.put(node.id, 'wireguard', { config, schemaVersion: 1, actor: 'admin' });
    // 手工把行改写成 A-11 之前的 enc:v1:<裸 crypto 密文> 格式
    const row = raw
      .prepare('SELECT config_json FROM app_configs WHERE node_id = ?')
      .get(node.id) as { config_json: string };
    const stripped = row.config_json.replace(/^enc:v2:[^:]+:/, '');
    raw
      .prepare('UPDATE app_configs SET config_json = ? WHERE node_id = ?')
      .run(`enc:v1:${stripped}`, node.id);
    expect((await apps.get(node.id, 'wireguard'))?.config).toEqual(config);
  });

  it('未配置 MASTER_ENC_KEY 时读写配置 fail-closed', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    await expect(
      apps.put(node.id, 'wireguard', { config: {}, schemaVersion: 1, actor: 'admin' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('certificates：PEM 以密文落库，material 解密回原文', async () => {
    const db = toD1(raw);
    const certs = new D1CertificateRepo(db, ENC_KEY);
    await certs.create({
      name: 'c',
      domains: ['a.example.com'],
      issuer: 'test',
      notAfter: null,
      certPem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\ndef\n-----END PRIVATE KEY-----',
      sourceNodeId: null,
    });
    const stored = raw
      .prepare('SELECT cert_pem_enc, key_pem_enc FROM certificates')
      .get() as { cert_pem_enc: string; key_pem_enc: string };
    // A-11：密文 = enc:v2:<keyId>:base64url(iv).base64url(cipher)，非明文
    expect(stored.cert_pem_enc).toMatch(/^enc:v2:[^:]+:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(stored.cert_pem_enc).not.toContain('BEGIN CERTIFICATE');
    expect(stored.key_pem_enc).not.toContain('BEGIN PRIVATE KEY');
    const all = await certs.list();
    const material = await certs.material(all[0]?.id ?? '');
    expect(material?.certPem).toContain('BEGIN CERTIFICATE');
    expect(material?.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('nodes.update 只更新补丁列（B-2）：不覆盖并发写者刚落库的其他列', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });

    // 模拟并发写者（如另一请求改 endpoint）直接落库——旧的全字段读改写会用
    // repo.get() 读到的旧 endpoint 覆盖回去，本轮询 lastSeenAt 的写会丢列。
    raw
      .prepare('UPDATE nodes SET endpoint = ? WHERE id = ?')
      .run('https://concurrent.example.com', node.id);

    const updated = await nodes.update(node.id, { lastSeenAt: 123 });
    expect(updated?.lastSeenAt).toBe(123);
    expect(updated?.endpoint).toBe('https://concurrent.example.com');

    // 逐列 patch：其余列保持
    const renamed = await nodes.update(node.id, { name: '改名' });
    expect(renamed?.name).toBe('改名');
    expect(renamed?.lastSeenAt).toBe(123);
    // 不存在的节点返回 null
    expect(await nodes.update('nd_missing', { name: 'x' })).toBeNull();
  });

  it('apps.put 并发不撞 rev（B-3）：rev 单语句原子分配，配置 rev 不回退', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    await apps.put(node.id, 'wireguard', { config: { v: 0 }, schemaVersion: 1, actor: 'admin' });

    // 两个并发 put：加密切割出真实的读改写窗口（旧实现在此撞同一 rev）
    const [a, b] = await Promise.all([
      apps.put(node.id, 'wireguard', { config: { v: 1 }, schemaVersion: 1, actor: 'admin' }),
      apps.put(node.id, 'wireguard', { config: { v: 2 }, schemaVersion: 1, actor: 'admin' }),
    ]);
    // 新语义：被 WHERE 挡下的一次保存回读"当前生效记录"，可能与胜出者同 rev；
    // 约束是返回值不越过库内 rev，且不会返回"自己的 rev + 别人的配置"。
    expect(Math.max(a.rev, b.rev)).toBe(3);
    expect(Math.min(a.rev, b.rev)).toBeGreaterThanOrEqual(2);

    // revisions 无重复 rev；app_configs.rev 指向最大 rev
    const revs = raw
      .prepare('SELECT rev FROM revisions WHERE node_id = ? ORDER BY rev')
      .all(node.id) as Array<{ rev: number }>;
    expect(revs.map((r) => r.rev)).toEqual([1, 2, 3]);
    const pointer = raw
      .prepare('SELECT rev FROM app_configs WHERE node_id = ? AND app = ?')
      .get(node.id, 'wireguard') as { rev: number };
    expect(pointer.rev).toBe(3);

    // 核心回归：app_configs 的 config 必须与它声明的 rev 是同一份版本，
    // 否则面板显示 rev=3 却把 rev=2 的旧配置下发给 Agent。
    const stored = await apps.get(node.id, 'wireguard');
    const rev3 = await apps.getRevision(node.id, 'wireguard', 3);
    expect(stored?.rev).toBe(3);
    expect(stored?.config).toEqual(rev3?.config);
  });

  it('apps.put 遇到库内更大 rev：不覆盖新配置，回读返回当前生效记录', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    await apps.put(node.id, 'wireguard', {
      config: { v: 'newest' },
      schemaVersion: 1,
      actor: 'admin',
    });

    // 模拟另一并发分支已把生效 rev 推高（revisions 仍停留在小 rev），
    // 本次 put 分配到的 rev 较小；旧实现的无条件覆盖会写回 v:'stale'。
    raw
      .prepare('UPDATE app_configs SET rev = 99 WHERE node_id = ? AND app = ?')
      .run(node.id, 'wireguard');
    const result = await apps.put(node.id, 'wireguard', {
      config: { v: 'stale' },
      schemaVersion: 1,
      actor: 'admin',
    });
    expect(result.rev).toBe(99);
    expect(result.config).toEqual({ v: 'newest' });

    const stored = await apps.get(node.id, 'wireguard');
    expect(stored?.rev).toBe(99);
    expect(stored?.config).toEqual({ v: 'newest' });
  });

  it('app_configs.summary_json：只落模式与计数；NULL 行回退解密派生', async () => {
    const db = toD1(raw);
    const nodes = new D1NodeRepo(db);
    const apps = new D1AppConfigRepo(db, ENC_KEY);
    const node = await nodes.create({ name: 'n', endpoint: 'https://x', tokenEnc: 'e' });
    await apps.put(node.id, 'caddy-site', {
      config: {
        sites: [
          {
            name: 'site-a',
            tls: { mode: 'manual', cert: { $cert: 'cert_x' } },
            basicauth: { user: 'u', passwordHash: '$2a$hash' },
          },
        ],
      },
      schemaVersion: 1,
      actor: 'admin',
    });

    const row = raw
      .prepare('SELECT summary_json FROM app_configs WHERE node_id = ? AND app = ?')
      .get(node.id, 'caddy-site') as { summary_json: string };
    expect(row.summary_json).toBeTruthy();
    expect(JSON.parse(row.summary_json)).toEqual({ sites: { total: 1, disabled: 0 } });
    // 硬约束：摘要列不得出现证书/密码/哈希类内容
    expect(row.summary_json).not.toMatch(/cert_x|passwordHash|\$2a\$|BEGIN|site-a/);

    // 旧版本 Worker 写入的行（NULL）→ 读取路径回退解密派生，结果与写入时一致
    raw.prepare('UPDATE app_configs SET summary_json = NULL WHERE node_id = ?').run(node.id);
    const fallback = await apps.listSummaries(node.id);
    expect(fallback.map((r) => r.summary)).toEqual([{ sites: { total: 1, disabled: 0 } }]);
  });
});
