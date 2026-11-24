import {
  MANIFEST_V2_MIN_AGENT,
  manifestActionParamsSchema,
  requiredAgentFeatures,
  toManifestV2,
  type AgentManifestFeature,
  type AppManifestAnyDefinition,
  type AppManifestDefinitionV2,
} from '@khc/contracts';
import type { NodeRepo, StoredNode } from '../domain/repos';
import type { AppDeps, Env } from '../types';
import { AppError, badRequest, notFound } from './errors';
import { executeManifestHook, type HookScalar } from './manifest-hooks';
import { resolveManifestParams } from './app-manifests';
import { assertSecureChannelForRawSecrets } from './secure-channel';

export type ManifestStage = 'install' | 'upgrade' | 'uninstall';

export interface AppManifestCapabilitiesCache {
  schemas: number[];
  features: string[];
}

const SYNC_MANIFEST_ACTIONS = new Set([
  'manifest_control',
  'manifest_logs',
  'manifest_access',
  'manifest_installed',
]);

const ACTION_STAGE_MAP: Record<string, ManifestStage> = {
  manifest_install: 'install',
  recipe_install: 'install',
  manifest_upgrade: 'upgrade',
  manifest_uninstall: 'uninstall',
  recipe_uninstall: 'uninstall',
};

const HOOK_REPLAY_TTL_MS = 10 * 60 * 1000;

interface CachedHookReplay {
  at: number;
  hookOutputs: Record<string, HookScalar>;
  hookFacts: Record<string, HookScalar>;
  hooksSkipped: boolean;
}

const nodeCapsCache = new WeakMap<NodeRepo, Map<string, AppManifestCapabilitiesCache>>();
const hookReplayCache = new WeakMap<object, Map<string, CachedHookReplay>>();

/** 记录最近一次 `/state` 观测到的节点 Agent manifest 能力声明（isolate 内缓存）。 */
export function recordNodeAppManifestCapabilities(
  nodeRepo: NodeRepo,
  nodeId: string,
  caps: AppManifestCapabilitiesCache | undefined,
): void {
  if (!caps) return;
  let map = nodeCapsCache.get(nodeRepo);
  if (!map) {
    map = new Map();
    nodeCapsCache.set(nodeRepo, map);
  }
  map.set(nodeId, { schemas: [...caps.schemas], features: [...caps.features] });
}

export function getCachedNodeAppManifestCapabilities(
  nodeRepo: NodeRepo,
  nodeId: string,
): AppManifestCapabilitiesCache | undefined {
  return nodeCapsCache.get(nodeRepo)?.get(nodeId);
}

export function isManifestLifecycleAction(app: string, action: string, params: Record<string, unknown>): boolean {
  if (app !== 'app-catalog' || typeof params.manifestId !== 'string') return false;
  return action in ACTION_STAGE_MAP || SYNC_MANIFEST_ACTIONS.has(action);
}

export function neededFeaturesForAction(
  defV2: AppManifestDefinitionV2,
  action: string,
): AgentManifestFeature[] {
  const needed = new Set<AgentManifestFeature>(requiredAgentFeatures(defV2));
  if (action === 'manifest_upgrade') {
    needed.add('upgrade');
  }
  if (action === 'manifest_control' || action === 'manifest_logs') {
    needed.add('units');
  }
  return Array.from(needed).sort();
}

export function throwAgentUpgradeRequired(missing: readonly string[]): never {
  throw new AppError(
    409,
    'agent_upgrade_required',
    `节点 Agent 版本过旧，请至少升级到 ${MANIFEST_V2_MIN_AGENT}`,
    undefined,
    {
      missing: [...missing],
      minAgentVersion: MANIFEST_V2_MIN_AGENT,
    },
  );
}

function assertCapabilitiesSatisfied(
  caps: AppManifestCapabilitiesCache,
  needed: readonly AgentManifestFeature[],
): void {
  const features = new Set(caps.features);
  const missing = needed.filter((item) => !features.has(item));
  if (!caps.schemas.includes(2) || missing.length > 0) {
    throwAgentUpgradeRequired(missing);
  }
}

function mergeParamDefaults(
  defV2: AppManifestDefinitionV2,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const param of defV2.params) {
    if (param.default !== undefined) {
      merged[param.key] = param.default;
    }
  }
  for (const [k, v] of Object.entries(values)) {
    merged[k] = v;
  }
  return merged;
}

function safeToManifestV2(rawManifest: AppManifestAnyDefinition): AppManifestDefinitionV2 {
  try {
    return toManifestV2(rawManifest);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      const issues = (err as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
      const first = issues?.[0];
      const path = Array.isArray(first?.path) ? first.path.map(String).join('.') : '';
      const msg = first?.message ?? '应用清单格式不合法';
      throw new AppError(400, 'manifest_invalid', path ? `${path}: ${msg}` : msg);
    }
    throw new AppError(
      400,
      'manifest_invalid',
      err instanceof Error ? err.message : '应用清单格式不合法',
    );
  }
}

function isUnknownActionResponse(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (status !== 400 || !body || typeof body !== 'object') return false;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return code === 'invalid_action';
}

function replayCacheKey(nodeId: string, app: string, action: string, idempotencyKey: string): string {
  return `${nodeId}:${app}:${action}:${idempotencyKey}`;
}

function getHookReplay(
  agent: object,
  key: string,
  nowMs = Date.now(),
): CachedHookReplay | null {
  const map = hookReplayCache.get(agent);
  if (!map) return null;
  const entry = map.get(key);
  if (!entry) return null;
  if (nowMs - entry.at > HOOK_REPLAY_TTL_MS) {
    map.delete(key);
    return null;
  }
  return entry;
}

function putHookReplay(
  agent: object,
  key: string,
  value: Omit<CachedHookReplay, 'at'>,
  nowMs = Date.now(),
): void {
  let map = hookReplayCache.get(agent);
  if (!map) {
    map = new Map();
    hookReplayCache.set(agent, map);
  }
  map.set(key, { ...value, at: nowMs });
}

export interface PrepareManifestActionInput {
  env: Pick<Env, 'ENVIRONMENT'>;
  deps: AppDeps;
  node: StoredNode;
  token: string;
  actor: string;
  app: string;
  action: string;
  params: Record<string, unknown>;
  idempotencyKey: string;
  getNodeForSyncCheck?: () => Promise<StoredNode>;
  onAgentFailure: (status: number, body: unknown) => never;
}

export interface PreparedManifestAction {
  actionParams: Record<string, unknown>;
  isSyncCapabilityCheckOnly: boolean;
  neededFeatures: AgentManifestFeature[];
  markReplayAccepted?: () => void;
  clearReplayOnUnreachable?: (timedOut: boolean) => void;
}

/**
 * 编排 `app-catalog` + `manifestId` 的生命周期请求（§3）：
 * - v1 清单走 recipe_install/recipe_uninstall 保持原有直转，不做预检与 hooks（保证旧 Agent 可用）
 * - sync 动作（control/logs/installed）不跑预检，读 `/state` 缓存能力
 * - install/upgrade/uninstall 按「取清单 → 预检 + 能力协商 → 控制面步骤 → 保密通道校验 → 转发」执行
 */
export async function prepareManifestLifecycleAction(
  input: PrepareManifestActionInput,
): Promise<PreparedManifestAction> {
  const { env, deps, node, token, actor, app, action, params, idempotencyKey, onAgentFailure } = input;

  if ('manifest' in params) {
    throw badRequest('不接受直接传入 manifest，请改用 manifestId');
  }
  const parsed = manifestActionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw badRequest(`manifestId 动作参数非法：${parsed.error.issues[0]?.message ?? '格式错误'}`);
  }

  const record = await deps.appManifests.get(parsed.data.manifestId);
  if (!record) throw notFound('应用不存在');
  if (record.invalid || !record.manifest) {
    throw new AppError(400, 'manifest_invalid', record.error ?? '应用清单格式不合法');
  }

  const isV1Record = !('schema' in record.manifest) || record.manifest.schema !== 2;
  const isLegacyV1Action = action === 'recipe_install' || action === 'recipe_uninstall';
  if (isV1Record && isLegacyV1Action) {
    if (parsed.data.skipHooks) {
      throw badRequest('v1 应用清单不支持 skipHooks');
    }
    const legacyParams = await resolveManifestParams(deps, params);
    return {
      actionParams: legacyParams,
      isSyncCapabilityCheckOnly: false,
      neededFeatures: [],
    };
  }

  const defV2 = safeToManifestV2(record.manifest);
  const neededFeatures = neededFeaturesForAction(defV2, action);
  const instance = parsed.data.instance ?? parsed.data.manifestId;
  const { manifestId: _dropId, skipHooks: rawSkipHooks, ...restParams } = params;

  // 同步控制 / 日志 / 已安装查询：不预检，优先检查最近 /state 缓存能力
  if (SYNC_MANIFEST_ACTIONS.has(action)) {
    if (rawSkipHooks !== undefined) {
      throw badRequest('该动作不支持 skipHooks');
    }
    if (input.getNodeForSyncCheck) {
      await input.getNodeForSyncCheck();
    }
    const cachedCaps = getCachedNodeAppManifestCapabilities(deps.nodes, node.id);
    if (cachedCaps) {
      assertCapabilitiesSatisfied(cachedCaps, neededFeatures);
    }
    const mergedValues = mergeParamDefaults(defV2, parsed.data.values);
    return {
      actionParams: {
        ...restParams,
        manifest: defV2,
        manifestId: parsed.data.manifestId,
        instance,
        values: mergedValues,
      },
      isSyncCapabilityCheckOnly: true,
      neededFeatures,
    };
  }

  const stage = ACTION_STAGE_MAP[action];
  if (!stage) {
    throw badRequest(`不支持的应用清单动作：${action}`);
  }

  if (stage === 'install' && !record.enabled) {
    throw badRequest('该应用已停用，不能发起安装');
  }
  if (rawSkipHooks === true && stage !== 'uninstall') {
    throw badRequest('只有卸载动作支持 skipHooks');
  }

  // 运行身份参数校验
  const explicitMode = parsed.data.runtimeMode;
  const hasUser = Boolean(parsed.data.runtimeUser);
  const hasPassword = Boolean(parsed.data.runtimePassword);
  if (stage === 'upgrade' && (explicitMode || hasUser || hasPassword)) {
    throw badRequest('升级沿用已安装身份，不接受 runtimeMode/runtimeUser/runtimePassword');
  }
  const effectiveMode = explicitMode ?? (defV2.runtime.mode === 'root' ? 'root' : 'create');
  if (effectiveMode === 'root' && (hasUser || hasPassword)) {
    throw badRequest('以 root 运行时不接受用户名和密码');
  }
  if (effectiveMode === 'create') {
    if (hasPassword && !hasUser) throw badRequest('填写密码时必须同时填写用户名');
    if (parsed.data.runtimeUser === 'root') {
      throw badRequest('不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」');
    }
  }

  // hooks 渲染始终用「清单默认值 + 本次值」（Worker 拿不到节点上的安装值）。
  const mergedValues = mergeParamDefaults(defV2, parsed.data.values);
  // 只有 install 转发「清单默认值 + 本次值」。upgrade / uninstall 转发请求原值（任务参数与预检一致）：
  // 默认值与安装记录值由 Agent 合并（本次值 > 安装记录值 > 清单默认值），
  // Worker 预先塞默认值会被当成「本次值」盖掉安装记录值。
  const forwardValues = stage === 'install' ? mergedValues : parsed.data.values;
  const replayKey = replayCacheKey(node.id, app, action, idempotencyKey);
  const replayed = getHookReplay(deps.agent, replayKey);
  if (replayed) {
    if (Object.keys(replayed.hookOutputs).length > 0) {
      assertSecureChannelForRawSecrets(env, node);
    }
    return {
      actionParams: {
        ...restParams,
        manifest: defV2,
        manifestId: parsed.data.manifestId,
        instance,
        values: forwardValues,
        ...(explicitMode ? { runtimeMode: explicitMode } : {}),
        ...(Object.keys(replayed.hookOutputs).length > 0 ? { hookOutputs: replayed.hookOutputs } : {}),
        ...(Object.keys(replayed.hookFacts).length > 0 ? { hookFacts: replayed.hookFacts } : {}),
        ...(replayed.hooksSkipped ? { hooksSkipped: true } : {}),
      },
      isSyncCapabilityCheckOnly: false,
      neededFeatures,
    };
  }

  // 2. 节点预检（10s 超时；不写 recordApplyFailure）
  const preflightRes = await deps.agent.call(
    node,
    token,
    'POST',
    '/apps/app-catalog/manifest_preflight',
    {
      config: {},
      expectRev: 0,
      params: {
        manifest: defV2,
        manifestId: parsed.data.manifestId,
        instance,
        values: forwardValues,
        stage,
      },
    },
    { timeoutMs: 10_000, bypassCooldown: true },
  );

  if (isUnknownActionResponse(preflightRes.status, preflightRes.body)) {
    throwAgentUpgradeRequired(neededFeatures);
  }
  if (preflightRes.status >= 400) {
    onAgentFailure(preflightRes.status, preflightRes.body);
  }

  const preflightBody = (preflightRes.body ?? {}) as {
    ok?: unknown;
    capabilities?: { schemas?: unknown; features?: unknown };
    checks?: Array<{ name?: unknown; ok?: unknown; message?: unknown }>;
    installed?: { version?: unknown; schema?: unknown; facts?: unknown } | null;
  };

  const caps = preflightBody.capabilities;
  const schemas = Array.isArray(caps?.schemas)
    ? caps.schemas.filter((item): item is number => typeof item === 'number')
    : [];
  const features = Array.isArray(caps?.features)
    ? caps.features.filter((item): item is string => typeof item === 'string')
    : [];
  assertCapabilitiesSatisfied({ schemas, features }, neededFeatures);

  const checks = Array.isArray(preflightBody.checks) ? preflightBody.checks : [];
  const manifestInvalidCheck = checks.find(
    (item) => item?.name === 'manifest' && item.ok === false,
  );
  if (manifestInvalidCheck) {
    console.warn('[manifest-lifecycle] Agent preflight reported manifest_invalid', {
      manifestId: parsed.data.manifestId,
    });
    throw new AppError(
      400,
      'manifest_invalid',
      typeof manifestInvalidCheck.message === 'string'
        ? manifestInvalidCheck.message
        : '节点校验应用清单未通过',
    );
  }

  const installedInfo = preflightBody.installed ?? null;
  if ((stage === 'upgrade' || stage === 'uninstall') && installedInfo === null) {
    throw new AppError(409, 'not_installed', '该实例尚未安装', undefined, {
      manifestId: parsed.data.manifestId,
      instance,
    });
  }

  if (stage === 'install' || stage === 'upgrade') {
    const failed = checks.some((item) => item?.ok === false);
    if (failed) {
      throw new AppError(422, 'preflight_failed', '节点安装预检未通过', undefined, {
        checks,
      });
    }
  }

  // 3. 控制面步骤（hooks）
  let hookOutputs: Record<string, HookScalar> = {};
  let hookFacts: Record<string, HookScalar> = {};
  let hooksSkipped = false;

  // upgrade 只认 preUpgrade，未声明时不回退 preInstall，避免把注册步骤当升级重跑。
  const hookStep =
    stage === 'install'
      ? defV2.hooks?.preInstall
      : stage === 'upgrade'
        ? defV2.hooks?.preUpgrade
        : defV2.hooks?.preUninstall;
  const hookStageName: 'preInstall' | 'preUpgrade' | 'preUninstall' =
    stage === 'install'
      ? 'preInstall'
      : stage === 'upgrade'
        ? 'preUpgrade'
        : 'preUninstall';

  if (rawSkipHooks === true && stage === 'uninstall') {
    hooksSkipped = true;
    await deps.audit.log({
      actor,
      nodeId: node.id,
      app,
      action: 'app.hook.skipped',
      detail: { manifestId: parsed.data.manifestId, instance, stage: 'uninstall' },
    });
  } else if (hookStep) {
    // hook 声明 extract 时产出的凭据将下发给节点：发往第三方前先拦截明文通道，避免已触发外部副作用后再失败。
    if (hookStep.extract && Object.keys(hookStep.extract).length > 0) {
      assertSecureChannelForRawSecrets(env, node);
    }
    const factsRaw = installedInfo?.facts;
    const installedFacts =
      factsRaw && typeof factsRaw === 'object' && !Array.isArray(factsRaw)
        ? (factsRaw as Record<string, unknown>)
        : {};
    const hookResult = await executeManifestHook({
      deps,
      node: { id: node.id, name: node.name },
      actor,
      manifestId: parsed.data.manifestId,
      instance,
      stage: hookStageName,
      hook: hookStep,
      params: mergedValues,
      facts: installedFacts,
    });
    hookOutputs = hookResult.hookOutputs;
    hookFacts = hookResult.hookFacts;
  }

  // 4. 保密通道门禁：hookOutputs 非空时拒绝明文通道（development 豁免）
  if (Object.keys(hookOutputs).length > 0) {
    assertSecureChannelForRawSecrets(env, node);
  }

  return {
    actionParams: {
      ...restParams,
      manifest: defV2,
      manifestId: parsed.data.manifestId,
      instance,
      values: forwardValues,
      ...(explicitMode ? { runtimeMode: explicitMode } : {}),
      ...(Object.keys(hookOutputs).length > 0 ? { hookOutputs } : {}),
      ...(Object.keys(hookFacts).length > 0 ? { hookFacts } : {}),
      ...(hooksSkipped ? { hooksSkipped: true } : {}),
    },
    isSyncCapabilityCheckOnly: false,
    neededFeatures,
    markReplayAccepted: () => {
      putHookReplay(deps.agent, replayKey, { hookOutputs, hookFacts, hooksSkipped });
    },
    clearReplayOnUnreachable: (timedOut: boolean) => {
      // 超时说明请求可能已被 Agent 受理，保留缓存防重复跑 hook；仅明确未触达且非超时才允许清掉。
      if (!timedOut) {
        hookReplayCache.get(deps.agent)?.delete(replayKey);
      }
    },
  };
}
