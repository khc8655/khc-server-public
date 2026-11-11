import { Hono } from 'hono';
import {
  agentEnvelopeSchema,
  bindCertificateRequestSchema,
  certificateBindResponseSchema,
  certificateListResponseSchema,
  certificateMaterialResponseSchema,
  certificateResponseSchema,
  createCertificateRequestSchema,
  updateCertificateRequestSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
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
      notAfter: body.notAfter ?? null,
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

  // 续期成功后用新材料替换同一条记录（名称/来源节点/ACME 参数不变）
  router.put('/certs/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateCertificateRequestSchema);
    assertPem(body.certPem, body.keyPem);
    const certificate = await deps.certs.update(id, {
      certPem: body.certPem,
      keyPem: body.keyPem,
      ...(body.notAfter === undefined ? {} : { notAfter: body.notAfter }),
      ...(body.domains === undefined ? {} : { domains: body.domains }),
      ...(body.issuer === undefined ? {} : { issuer: body.issuer }),
    });
    if (!certificate) throw notFound('证书不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'cert.update',
      detail: { id, notAfter: certificate.notAfter, domains: certificate.domains },
    });
    return c.json(certificateResponseSchema.parse({ certificate }));
  });

  // 把证书安装到节点 Agent 的 TLS 目录并热重载（控制通道 HTTPS 直连）
  router.post('/certs/:id/bind', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, bindCertificateRequestSchema);
    const material = await deps.certs.material(id);
    if (!material) throw notFound('证书不存在');

    const node = await requireNode(deps, body.nodeId);
    // 请求体就是明文私钥：明文通道一律拒绝，不调用 Agent。
    assertSecureChannelForRawSecrets(c.env, node);
    const token = await nodeToken(c.env, node);
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
    const bind = certificateBindResponseSchema.parse({
      ok: envelope.ok,
      nodeId: node.id,
      certPath: typeof result.certPath === 'string' ? result.certPath : null,
      keyPath: typeof result.keyPath === 'string' ? result.keyPath : null,
      notAfter: typeof result.notAfter === 'number' ? result.notAfter : null,
      reloaded: result.reloaded === true,
      restartRequired: result.restartRequired === true,
      message: typeof result.message === 'string' ? result.message : null,
    });
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
