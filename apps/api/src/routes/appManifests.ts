import { Hono } from 'hono';
import {
  appManifestListResponseSchema,
  appManifestResponseSchema,
  createAppManifestRequestSchema,
  updateAppManifestRequestSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { conflict, notFound } from '../lib/errors';
import { assertManifestSha256 } from '../lib/app-manifests';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';

/**
 * 全局应用清单（R1 架子）。
 *
 * - 脚本正文与元数据属于配置，存 D1；写请求用 .strict() 契约拒绝未知字段。
 * - 写入前校验脚本正文与 sha256 一致，填错哈希当场报错。
 * - 新增/修改/删除全部写审计，并记下新旧 install 脚本哈希，便于追责与比对。
 */
export function appManifestRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/app-manifests', requireAuth);
  router.use('/app-manifests/*', requireAuth);

  router.get('/app-manifests', async (c) =>
    c.json(
      appManifestListResponseSchema.parse({
        appManifests: await deps.appManifests.list(),
      }),
    ),
  );

  router.post('/app-manifests', async (c) => {
    const body = await parseJsonBody(c, createAppManifestRequestSchema);
    await assertManifestSha256(body.manifest);
    if (await deps.appManifests.get(body.id)) {
      throw conflict(`应用 ${body.id} 已存在`);
    }
    const appManifest = await deps.appManifests.create({
      id: body.id,
      manifest: body.manifest,
      enabled: body.enabled,
    });
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'appManifest.create',
      detail: {
        id: appManifest.id,
        version: appManifest.manifest.version,
        installSha256: appManifest.manifest.sha256.install,
      },
    });
    return c.json(appManifestResponseSchema.parse({ appManifest }), 201);
  });

  router.put('/app-manifests/:id', async (c) => {
    const id = c.req.param('id');
    const previous = await deps.appManifests.get(id);
    if (!previous) throw notFound('应用不存在');
    const body = await parseJsonBody(c, updateAppManifestRequestSchema);
    await assertManifestSha256(body.manifest);
    const appManifest = await deps.appManifests.update(id, {
      manifest: body.manifest,
      enabled: body.enabled,
    });
    if (!appManifest) throw notFound('应用不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'appManifest.update',
      detail: {
        id,
        version: appManifest.manifest.version,
        oldInstallSha256: previous.manifest.sha256.install,
        newInstallSha256: appManifest.manifest.sha256.install,
      },
    });
    return c.json(appManifestResponseSchema.parse({ appManifest }));
  });

  router.delete('/app-manifests/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await deps.appManifests.remove(id);
    if (!removed) throw notFound('应用不存在');
    await deps.audit.log({
      actor: c.get('user').name,
      action: 'appManifest.delete',
      detail: { id },
    });
    return c.json({ ok: true });
  });

  return router;
}
