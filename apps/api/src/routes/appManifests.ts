import { Hono } from 'hono';
import {
  appManifestListResponseSchema,
  appManifestResponseSchema,
  appManifestSecretsResponseSchema,
  appSecretKey,
  appSecretValueSchema,
  createAppManifestRequestSchema,
  listTemplateVars,
  toManifestV2,
  updateAppManifestRequestSchema,
  type AppManifestAnyDefinition,
  type AppManifestDefinitionV2,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from '../types';
import { AppError, conflict, notFound } from '../lib/errors';
import { assertManifestSha256 } from '../lib/app-manifests';
import { ensureBuiltinAppManifests } from '../lib/builtin-manifests';
import { parseJsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/auth';

function collectLeafStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectLeafStrings(item, out);
  }
}

async function checkManifestSecretHostWarnings(
  deps: Pick<AppDeps, 'settings'>,
  manifestId: string,
  v2: AppManifestDefinitionV2,
): Promise<string[]> {
  if (!v2.secrets?.length || !v2.hooks) return [];
  const hostRefs = new Map<string, Set<string>>();
  for (const stage of ['preInstall', 'preUpgrade', 'preUninstall'] as const) {
    const hook = v2.hooks[stage];
    if (!hook) continue;
    let host: string;
    try {
      host = new URL(hook.url).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      continue;
    }
    const texts: string[] = [...Object.values(hook.headers ?? {})];
    if (hook.body !== undefined) collectLeafStrings(hook.body, texts);
    for (const text of texts) {
      let vars: string[];
      try {
        vars = listTemplateVars(text);
      } catch {
        continue;
      }
      for (const v of vars) {
        if (!v.startsWith('secret.')) continue;
        const name = v.slice('secret.'.length);
        let set = hostRefs.get(name);
        if (!set) {
          set = new Set<string>();
          hostRefs.set(name, set);
        }
        set.add(host);
      }
    }
  }

  const warnings: string[] = [];
  for (const sec of v2.secrets) {
    const neededHosts = hostRefs.get(sec.name);
    if (!neededHosts || neededHosts.size === 0) continue;
    const raw = await deps.settings.getValue(appSecretKey(manifestId, sec.name));
    const parsed = appSecretValueSchema.safeParse(raw);
    if (!parsed.success) continue;
    const allowed = new Set(parsed.data.allowHosts.map((h) => h.toLowerCase().replace(/\.$/, '')));
    const missing = Array.from(neededHosts).filter((h) => !allowed.has(h)).sort();
    if (missing.length > 0) {
      warnings.push(
        `凭据 ${sec.name} 的 allowHosts 未覆盖 hook 主机 ${missing.join(', ')}（保存成功，但安装时会阻断）`,
      );
    }
  }
  return warnings;
}

type ParamRefStage = 'preUpgrade' | 'preUninstall';

/** 收集 preUpgrade / preUninstall 的 url / headers / body 里引用的 `{{params.<key>}}`（按阶段去重）。 */
function collectHookParamRefs(v2: AppManifestDefinitionV2): Array<{ stage: ParamRefStage; keys: string[] }> {
  if (!v2.hooks) return [];
  const out: Array<{ stage: ParamRefStage; keys: string[] }> = [];
  for (const stage of ['preUpgrade', 'preUninstall'] as const) {
    const hook = v2.hooks[stage];
    if (!hook) continue;
    const texts: string[] = [hook.url, ...Object.values(hook.headers ?? {})];
    if (hook.body !== undefined) collectLeafStrings(hook.body, texts);
    const keys = new Set<string>();
    for (const text of texts) {
      let vars: string[];
      try {
        vars = listTemplateVars(text);
      } catch {
        continue;
      }
      for (const v of vars) {
        if (v.startsWith('params.')) keys.add(v.slice('params.'.length).split('.')[0]!);
      }
    }
    if (keys.size > 0) out.push({ stage, keys: Array.from(keys).sort() });
  }
  return out;
}

/**
 * preUpgrade / preUninstall 在 Worker 渲染，拿不到节点上的安装值：引用无默认值（含 derive）的参数
 * 会让升级 / 卸载在 Worker 就失败，因此保存时直接拒绝。preInstall 不受限。
 */
function assertHookParamRefsHaveDefaults(v2: AppManifestDefinitionV2): void {
  for (const { stage, keys } of collectHookParamRefs(v2)) {
    for (const key of keys) {
      const param = v2.params.find((item) => item.key === key);
      if (param && param.default === undefined) {
        const message = `${stage} 引用了无默认值的参数 ${key}：升级 / 卸载时控制面步骤拿不到安装值，请为该参数设置默认值，或改为在 preInstall 里使用`;
        throw new AppError(400, 'manifest_invalid', message, {
          [`manifest.hooks.${stage}`]: message,
        });
      }
    }
  }
}

/** preUpgrade / preUninstall 引用有默认值的 {{params.*}} 时：Worker 只拿得到清单默认值与本次填写的值。 */
function checkManifestParamRefWarnings(v2: AppManifestDefinitionV2): string[] {
  return collectHookParamRefs(v2).map(
    ({ stage, keys }) =>
      `${stage} 引用了 ${keys.map((k) => `{{params.${k}}}`).join('、')}：升级 / 卸载时控制面步骤只能拿到清单默认值和本次填写的值，拿不到安装时填的值`,
  );
}

function shaAuditFields(manifest: AppManifestAnyDefinition) {
  const sha = manifest.sha256 as { install: string; uninstall: string; upgrade?: string };
  return {
    schema: 'schema' in manifest && manifest.schema === 2 ? 2 : 1,
    installSha256: sha.install,
    uninstallSha256: sha.uninstall,
    ...(sha.upgrade ? { upgradeSha256: sha.upgrade } : {}),
  };
}

/**
 * 全局应用清单（R1 / V2）。
 *
 * - 接受 v1 或 v2 定义；写入前校验全部脚本正文与 sha256 一致。
 * - D1 中存在坏记录时，`GET /app-manifests` 逐条标注 `invalid: true`，不阻塞整表返回。
 * - 暴露 `GET /app-manifests/:id/secrets` 供面板检查凭据配置状态（绝不返回 value）。
 */
export function appManifestRoutes(deps: AppDeps): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  router.use('/app-manifests', requireAuth);
  router.use('/app-manifests/*', requireAuth);

  router.get('/app-manifests', async (c) => {
    // 内置应用开箱可见：缺就补一行，已有记录不动。
    await ensureBuiltinAppManifests(deps);
    return c.json(
      appManifestListResponseSchema.parse({
        appManifests: await deps.appManifests.list(),
      }),
    );
  });

  router.get('/app-manifests/:id/secrets', async (c) => {
    const id = c.req.param('id');
    const record = await deps.appManifests.get(id);
    if (!record) throw notFound('应用不存在');
    if (record.invalid || !record.manifest) {
      throw new AppError(400, 'manifest_invalid', record.error ?? '应用清单格式不合法');
    }
    const v2 = toManifestV2(record.manifest);
    const decls = v2.secrets ?? [];
    if (decls.length === 0) {
      return c.json(appManifestSecretsResponseSchema.parse({ secrets: [] }));
    }
    const settingsList = await deps.settings.list();
    const updatedMap = new Map(settingsList.map((item) => [item.key, item.updatedAt]));
    const secrets = await Promise.all(
      decls.map(async (sec) => {
        const key = appSecretKey(id, sec.name);
        const raw = await deps.settings.getValue(key);
        const parsed = appSecretValueSchema.safeParse(raw);
        return {
          name: sec.name,
          label: sec.label,
          ...(sec.hint ? { hint: sec.hint } : {}),
          configured: parsed.success,
          allowHosts: parsed.success ? parsed.data.allowHosts : [],
          updatedAt: parsed.success ? (updatedMap.get(key) ?? null) : null,
        };
      }),
    );
    return c.json(appManifestSecretsResponseSchema.parse({ secrets }));
  });

  router.post('/app-manifests', async (c) => {
    const body = await parseJsonBody(c, createAppManifestRequestSchema);
    await assertManifestSha256(body.manifest);
    if (await deps.appManifests.get(body.id)) {
      throw conflict(`应用 ${body.id} 已存在`);
    }
    const v2Def = toManifestV2(body.manifest);
    assertHookParamRefsHaveDefaults(v2Def);
    const warnings = [
      ...(await checkManifestSecretHostWarnings(deps, body.id, v2Def)),
      ...checkManifestParamRefWarnings(v2Def),
    ];
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
        version: body.manifest.version,
        ...shaAuditFields(body.manifest),
      },
    });
    return c.json(
      appManifestResponseSchema.parse({
        appManifest,
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
      201,
    );
  });

  router.put('/app-manifests/:id', async (c) => {
    const id = c.req.param('id');
    const previous = await deps.appManifests.get(id);
    if (!previous) throw notFound('应用不存在');
    const body = await parseJsonBody(c, updateAppManifestRequestSchema);
    await assertManifestSha256(body.manifest);
    const v2Def = toManifestV2(body.manifest);
    assertHookParamRefsHaveDefaults(v2Def);
    const warnings = [
      ...(await checkManifestSecretHostWarnings(deps, id, v2Def)),
      ...checkManifestParamRefWarnings(v2Def),
    ];
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
        version: body.manifest.version,
        oldInstallSha256: previous.manifest?.sha256.install ?? null,
        newInstallSha256: body.manifest.sha256.install,
        ...shaAuditFields(body.manifest),
      },
    });
    return c.json(
      appManifestResponseSchema.parse({
        appManifest,
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    );
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
