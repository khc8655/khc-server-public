import { Hono } from 'hono';
import {
  agentEnvelopeSchema,
  bindCertificateRequestSchema,
  certificateBindResponseSchema,
  certificateListResponseSchema,
  certificateMaterialResponseSchema,
  certificateResponseSchema,
  certificateSyncResponseSchema,
  certificateUsagesResponseSchema,
  createCertificateRequestSchema,
  issueCfDnsCertificateRequestSchema,
  patchCertificateRequestSchema,
  updateCertificateRequestSchema,
  type Certificate,
  type CertificateBindResponse,
  type CertificateSyncTargetResult,
  type CertificateUsageItem,
} from '@khc/contracts';
import type { AppBindings, AppDeps, Env } from '../types';
import type { CertificateMaterial, StoredNode } from '../domain/repos';
import { issueAcmeDns01, parseLeafCertNotAfter } from '../lib/acme-dns01';
import { resolveSecretRefs } from '../lib/secret-refs';
import { loadCfAccounts, type CfAccountRuntime } from './cfDns';
import { newIdempotencyKey } from '../lib/crypto';
import { AppError, badRequest, notFound } from '../lib/errors';
import { assertSecureChannelForRawSecrets } from '../lib/secure-channel';
import { HubUnreachableError } from '../lib/node-client';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { nodeToken, requireNode } from './helpers';
import { throwAgentError } from './nodes';

/** 安装证书是同步写动作（写入 Agent TLS 目录 + SIGHUP），给足热重载时间 */
const BIND_TIMEOUT_MS = 15_000;

function assertPem(certPem: string, keyPem: string): void {
  if (!certPem.includes('BEGIN CERTIFICATE')) {
    throw badRequest('证书 PEM 格式不正确', { certPem: '缺少 BEGIN CERTIFICATE' });
  }
  if (!/BEGIN (RSA |EC )?PRIVATE KEY/.test(keyPem)) {
    throw badRequest('私钥 PEM 格式不正确', { keyPem: '缺少 BEGIN PRIVATE KEY' });
  }
}

async function resolveCfAccount(deps: AppDeps, env: Env, accountId: string): Promise<CfAccountRuntime> {
  const accounts = await loadCfAccounts(deps, env);
  const found = accounts.find((item) => item.id === accountId);
  if (!found || !found.enabled) {
    throw badRequest('所选 Cloudflare 账号不存在或已停用');
  }
  const enabledSet = new Set(found.enabledZoneIds);
  const enabledZones = found.zones.filter((zone) => enabledSet.has(zone.id));
  return {
    ...found,
    zones: enabledZones.length > 0 ? enabledZones : found.zones,
  };
}

function configReferencesCert(config: Record<string, unknown>, certId: string): boolean {
  const serialized = JSON.stringify(config);
  return serialized.includes(`"$cert":"${certId}"`);
}

async function findCertUsages(deps: AppDeps, cert: Certificate): Promise<CertificateUsageItem[]> {
  const [nodes, appRows] = await Promise.all([deps.nodes.list(), deps.apps.listForSummary()]);
  const nodeMap = new Map<string, StoredNode>(nodes.map((node) => [node.id, node]));
  const appsByNode = new Map<string, Set<string>>();

  for (const row of appRows) {
    if (!configReferencesCert(row.config, cert.id)) continue;
    const set = appsByNode.get(row.nodeId) ?? new Set<string>();
    set.add(row.app);
    appsByNode.set(row.nodeId, set);
  }

  const targetNodeIds = new Set<string>(appsByNode.keys());
  if (cert.sourceNodeId && nodeMap.has(cert.sourceNodeId)) {
    targetNodeIds.add(cert.sourceNodeId);
  }
  for (const node of nodes) {
    if (node.tlsCertId === cert.id) targetNodeIds.add(node.id);
  }

  const usages: CertificateUsageItem[] = [];
  for (const nodeId of targetNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    usages.push({
      nodeId: node.id,
      nodeName: node.name,
      apps: [...(appsByNode.get(nodeId) ?? [])].sort(),
      isSourceNode: cert.sourceNodeId === node.id,
      isNodeTls: node.tlsCertId === cert.id,
    });
  }
  return usages.sort((a, b) => a.nodeName.localeCompare(b.nodeName));
}

async function bindCertificateToNode(
  deps: AppDeps,
  env: Env,
  node: StoredNode,
  material: CertificateMaterial,
): Promise<CertificateBindResponse> {
  assertSecureChannelForRawSecrets(env, node);
  const token = await nodeToken(env, node);
  const idempotencyKey = newIdempotencyKey();

  let response;
  try {
    response = await deps.agent.call(
      node,
      token,
      'POST',
      '/apps/certificates/install_tls',
      {
        config: {},
        expectRev: 0,
        ...(node.revEpoch ? { epoch: node.revEpoch } : {}),
        params: { certPem: material.certPem, keyPem: material.keyPem },
        idempotencyKey,
      },
      { timeoutMs: BIND_TIMEOUT_MS, idempotencyKey },
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new HubUnreachableError('无法把证书安装到节点（控制通道不可达）', {});
  }
  if (response.status >= 400) throwAgentError(response.status, response.body);

  const envelope = agentEnvelopeSchema.parse(response.body);
  const result = (envelope.result ?? {}) as Record<string, unknown>;
  return certificateBindResponseSchema.parse({
    ok: envelope.ok,
    nodeId: node.id,
    certPath: typeof result.certPath === 'string' ? result.certPath : null,
    keyPath: typeof result.keyPath === 'string' ? result.keyPath : null,
    notAfter: typeof result.notAfter === 'number' ? result.notAfter : null,
    reloaded: result.reloaded === true,
    restartRequired: result.restartRequired === true,
    message: typeof result.message === 'string' ? result.message : null,
  });
}

async function syncCertificateToNodes(
  deps: AppDeps,
  env: Env,
  cert: Certificate,
): Promise<CertificateSyncTargetResult[]> {
  const usages = await findCertUsages(deps, cert);
  if (usages.length === 0) return [];
  const material = await deps.certs.material(cert.id);
  if (!material) return [];
  const nodes = await deps.nodes.list();
  const nodeMap = new Map<string, StoredNode>(nodes.map((node) => [node.id, node]));

  const results: CertificateSyncTargetResult[] = [];
  for (const usage of usages) {
    const node = nodeMap.get(usage.nodeId);
    if (!node) {
      results.push({
        nodeId: usage.nodeId,
        nodeName: usage.nodeName,
        status: 'error',
        appliedApps: [],
        tlsBound: false,
        error: '节点不存在',
      });
      continue;
    }

    const appliedApps: string[] = [];
    let tlsBound = false;
    try {
      assertSecureChannelForRawSecrets(env, node);
      const token = await nodeToken(env, node);

      for (const app of usage.apps) {
        const record = await deps.apps.get(node.id, app);
        if (!record) continue;
        const resolvedConfig = (await resolveSecretRefs(deps, record.config)) as Record<
          string,
          unknown
        >;
        const idempotencyKey = newIdempotencyKey();
        let response;
        try {
          response = await deps.agent.call(
            node,
            token,
            'POST',
            `/apps/${encodeURIComponent(app)}/apply`,
            {
              config: resolvedConfig,
              expectRev: record.rev,
              ...(node.revEpoch ? { epoch: node.revEpoch } : {}),
              params: {},
              idempotencyKey,
            },
            { timeoutMs: BIND_TIMEOUT_MS, idempotencyKey },
          );
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new HubUnreachableError('节点控制通道不可达', {});
        }
        if (response.status >= 400) throwAgentError(response.status, response.body);
        const envelope = agentEnvelopeSchema.parse(response.body);
        if (!envelope.ok) {
          throw new Error(envelope.error?.message ?? `应用 ${app} 生效失败`);
        }
        await deps.apps.setAppliedRev(node.id, app, envelope.appliedRev ?? record.rev);
        appliedApps.push(app);
      }

      if (usage.isNodeTls || usage.isSourceNode) {
        const bind = await bindCertificateToNode(deps, env, node, material);
        if (!bind.ok) {
          throw new Error(bind.message ?? '安装节点 TLS 证书失败');
        }
        tlsBound = true;
      }

      results.push({
        nodeId: node.id,
        nodeName: node.name,
        status: 'synced',
        appliedApps,
        tlsBound,
        error: null,
      });
    } catch (error) {
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        status: error instanceof HubUnreachableError ? 'offline' : 'error',
        appliedApps,
        tlsBound,
        error: error instanceof Error ? error.message : '同步失败',
      });
    }
  }
  return results;
}

export function certificateRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/certs', requireAuth);
  router.use('/certs/*', requireAuth);

  router.get('/certs', async (c) => {
    return c.json(certificateListResponseSchema.parse({ certificates: await deps.certs.list() }));
  });

  router.post('/certs', async (c) => {
    const body = await parseJsonBody(c, createCertificateRequestSchema);
    assertPem(body.certPem, body.keyPem);
    const certificate = await deps.certs.create({
      name: body.name,
      domains: body.domains,
      issuer: body.issuer,
      notAfter: body.notAfter ?? parseLeafCertNotAfter(body.certPem),
      certPem: body.certPem,
      keyPem: body.keyPem,
      sourceNodeId: body.sourceNodeId ?? null,
      acme: body.acme
        ? {
            provider: body.acme.provider,
            credentialKey: body.acme.credentialKey,
            ca: body.acme.ca ?? null,
            keyType: body.acme.keyType ?? null,
          }
        : null,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.create',
      detail: { id: certificate.id, issuer: certificate.issuer, domains: certificate.domains },
    });
    return c.json(certificateResponseSchema.parse({ certificate }), 201);
  });

  // 控制面直连 Cloudflare DNS-01 签发全球证书（支持单域名与 *. 通配符，无需节点 acme.sh）
  router.post('/certs/issue-dns01', async (c) => {
    const body = await parseJsonBody(c, issueCfDnsCertificateRequestSchema);
    const account = await resolveCfAccount(deps, c.env, body.accountId);
    const material = await issueAcmeDns01({
      domains: body.domains,
      cfToken: account.token,
      zones: account.zones,
      ca: body.ca,
      acmeFetch: deps.acmeFetch,
      cfFetch: deps.cfFetch,
      sleep: deps.acmeSleep,
    });
    const certificate = await deps.certs.create({
      name: body.name,
      domains: material.domains,
      issuer: 'acme',
      notAfter: material.notAfter,
      certPem: material.certPem,
      keyPem: material.keyPem,
      sourceNodeId: null,
      autoSync: true,
      acme: {
        provider: 'cf-dns01',
        credentialKey: account.id,
        ca: body.ca,
        keyType: 'ec',
      },
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.issue_dns01',
      detail: { id: certificate.id, accountId: account.id, domains: certificate.domains, ca: body.ca },
    });
    return c.json(certificateResponseSchema.parse({ certificate }), 201);
  });

  // 控制面直接续期 CF DNS-01 证书（替换材料并更新到期时间）
  router.post('/certs/:id/renew', async (c) => {
    const id = c.req.param('id');
    const existing = await deps.certs.get(id);
    if (!existing) throw notFound('证书不存在');
    if (existing.acmeProvider !== 'cf-dns01' || !existing.acmeCredentialKey) {
      throw badRequest('仅控制面 Cloudflare DNS-01 签发的证书支持通过此接口续期');
    }
    const account = await resolveCfAccount(deps, c.env, existing.acmeCredentialKey);
    const ca =
      existing.acmeCa === 'letsencrypt_staging' ? 'letsencrypt_staging' : 'letsencrypt';
    const material = await issueAcmeDns01({
      domains: existing.domains,
      cfToken: account.token,
      zones: account.zones,
      ca,
      acmeFetch: deps.acmeFetch,
      cfFetch: deps.cfFetch,
      sleep: deps.acmeSleep,
    });
    const certificate = await deps.certs.update(id, {
      certPem: material.certPem,
      keyPem: material.keyPem,
      notAfter: material.notAfter,
      domains: material.domains,
      issuer: 'acme',
    });
    if (!certificate) throw notFound('证书不存在');
    const syncResults = certificate.autoSync
      ? await syncCertificateToNodes(deps, c.env, certificate)
      : undefined;
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.renew',
      detail: {
        id,
        domains: certificate.domains,
        notAfter: certificate.notAfter,
        ...(syncResults ? { syncedCount: syncResults.filter((r) => r.status === 'synced').length } : {}),
      },
    });
    return c.json(
      certificateResponseSchema.parse({
        certificate,
        ...(syncResults ? { syncResults } : {}),
      }),
    );
  });

  router.get('/certs/:id/usages', async (c) => {
    const id = c.req.param('id');
    const existing = await deps.certs.get(id);
    if (!existing) throw notFound('证书不存在');
    const usages = await findCertUsages(deps, existing);
    return c.json(certificateUsagesResponseSchema.parse({ usages }));
  });

  router.patch('/certs/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, patchCertificateRequestSchema);
    const certificate = await deps.certs.setAutoSync(id, body.autoSync);
    if (!certificate) throw notFound('证书不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.update_auto_sync',
      detail: { id, autoSync: certificate.autoSync },
    });
    return c.json(certificateResponseSchema.parse({ certificate }));
  });

  router.post('/certs/:id/sync', async (c) => {
    const id = c.req.param('id');
    const existing = await deps.certs.get(id);
    if (!existing) throw notFound('证书不存在');
    const results = await syncCertificateToNodes(deps, c.env, existing);
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.sync',
      detail: {
        id,
        total: results.length,
        synced: results.filter((item) => item.status === 'synced').length,
      },
    });
    return c.json(certificateSyncResponseSchema.parse({ results }));
  });

  // 续期成功后用新材料替换同一条记录（名称/来源节点/ACME 参数不变）
  router.put('/certs/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateCertificateRequestSchema);
    assertPem(body.certPem, body.keyPem);
    const resolvedNotAfter = body.notAfter ?? parseLeafCertNotAfter(body.certPem);
    const certificate = await deps.certs.update(id, {
      certPem: body.certPem,
      keyPem: body.keyPem,
      ...(resolvedNotAfter === null ? {} : { notAfter: resolvedNotAfter }),
      ...(body.domains === undefined ? {} : { domains: body.domains }),
      ...(body.issuer === undefined ? {} : { issuer: body.issuer }),
    });
    if (!certificate) throw notFound('证书不存在');
    const syncResults = certificate.autoSync
      ? await syncCertificateToNodes(deps, c.env, certificate)
      : undefined;
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.update',
      detail: { id, notAfter: certificate.notAfter, domains: certificate.domains },
    });
    return c.json(
      certificateResponseSchema.parse({
        certificate,
        ...(syncResults ? { syncResults } : {}),
      }),
    );
  });

  // 把证书安装到节点 Agent 的 TLS 目录并热重载（控制通道 HTTPS 直连）
  router.post('/certs/:id/bind', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, bindCertificateRequestSchema);
    const material = await deps.certs.material(id);
    if (!material) throw notFound('证书不存在');

    const node = await requireNode(deps, body.nodeId);
    const bind = await bindCertificateToNode(deps, c.env, node, material);
    await deps.audit.log({
      actor: c.get('user').name,
      nodeId: node.id,
      action: 'cert.bind',
      detail: { id, reloaded: bind.reloaded, restartRequired: bind.restartRequired },
    });
    return c.json(bind);
  });

  router.delete('/certs/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await deps.certs.get(id);
    if (!existing) throw notFound('证书不存在');
    const usages = await findCertUsages(deps, existing);
    const activeUsages = usages.filter((item) => item.isNodeTls || item.apps.length > 0);
    if (activeUsages.length > 0) {
      throw new AppError(
        409,
        'cert_in_use',
        '该证书仍被节点或站点引用，请先解绑后再删除',
        undefined,
        { usages: activeUsages },
      );
    }
    const removed = await deps.certs.remove(id);
    if (!removed) throw notFound('证书不存在');
    await deps.audit.log({ actor: c.get('user').name, action: 'cert.delete', detail: { id } });
    return c.json({ ok: true });
  });

  // 管理员导出 PEM/KEY（用于迁移/备份）；写审计，绝不记录内容
  router.get('/certs/:id/material', async (c) => {
    const id = c.req.param('id');
    const material = await deps.certs.material(id);
    if (!material) throw notFound('证书不存在');
    await deps.audit.log({ actor: c.get('user').name, action: 'cert.material', detail: { id } });
    return c.json(certificateMaterialResponseSchema.parse(material));
  });

  return router;
}
