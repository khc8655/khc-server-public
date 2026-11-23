import {
  appSecretKey,
  appSecretValueSchema,
  listTemplateVars,
  renderTemplate,
  TemplateRenderError,
  type AppManifestHookStepV2,
} from '@khc/contracts';
import type { AppDeps } from '../types';
import { AppError } from './errors';
import { timed } from './timing';

const MAX_HOOK_RESPONSE_BYTES = 64 * 1024;
const MAX_EXTRACT_BYTES = 4096;
const HOOK_TIMEOUT_MS = 10_000;

export type HookScalar = string | number | boolean;

export interface ExecuteHookInput {
  deps: Pick<AppDeps, 'settings' | 'audit' | 'hookFetch'>;
  node: { id: string; name: string };
  actor: string;
  manifestId: string;
  instance: string;
  stage: 'preInstall' | 'preUpgrade' | 'preUninstall';
  hook: AppManifestHookStepV2;
  params: Record<string, unknown>;
  facts?: Record<string, unknown>;
}

export interface ExecuteHookResult {
  hookOutputs: Record<string, HookScalar>;
  hookFacts: Record<string, HookScalar>;
}

/** 按 RFC 6901 非根 JSON Pointer 提取节点；缺失或越界返回 undefined。 */
export function extractJsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined;
  const segments = pointer.slice(1).split('/');
  let cur: unknown = doc;
  for (const rawSeg of segments) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d*)$/.test(seg)) return undefined;
      const idx = Number(seg);
      if (idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      const record = cur as Record<string, unknown>;
      if (!Object.hasOwn(record, seg)) return undefined;
      cur = record[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function collectBodyLeafStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBodyLeafStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectBodyLeafStrings(item, out);
  }
}

function renderJsonBody(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return renderTemplate(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderJsonBody(item, vars));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderJsonBody(v, vars);
    }
    return out;
  }
  return value;
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

function mapTemplateError(err: unknown): never {
  if (err instanceof TemplateRenderError) {
    throw new AppError(
      400,
      err.code,
      err.message,
      undefined,
      err.variable ? { variable: err.variable } : undefined,
    );
  }
  throw err;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error('response_too_large');
    }
    return new TextDecoder().decode(buf);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response_too_large');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * 执行应用清单控制面步骤（§4）：
 * 仅 https://、redirect: 'manual' 拒绝 3xx、10s 超时、64KB 响应上限、不重试、不回显凭据/头/体。
 */
export async function executeManifestHook(input: ExecuteHookInput): Promise<ExecuteHookResult> {
  const { deps, node, actor, manifestId, instance, stage, hook, params, facts = {} } = input;

  // 1. 收集全部模板变量，先查出引用的 secret.* 并核对目标主机 allowHosts（命中越界时绝不发请求）
  const texts: string[] = [hook.url];
  for (const headerVal of Object.values(hook.headers ?? {})) {
    texts.push(headerVal);
  }
  if (hook.body !== undefined) {
    collectBodyLeafStrings(hook.body, texts);
  }

  const secretNames = new Set<string>();
  try {
    for (const text of texts) {
      for (const name of listTemplateVars(text)) {
        if (name.startsWith('secret.')) {
          secretNames.add(name.slice('secret.'.length));
        }
      }
    }
  } catch (err) {
    mapTemplateError(err);
  }

  // 先用不含 secret 的上下文渲染 URL 并验证主机，url 已被 schema 禁止引用 secret.*
  const baseVars: Record<string, unknown> = {
    node: { id: node.id, name: node.name },
    instance,
    params,
    facts,
  };
  let renderedUrl: string;
  try {
    renderedUrl = renderTemplate(hook.url, baseVars);
  } catch (err) {
    mapTemplateError(err);
  }

  let targetHost: string;
  try {
    const parsedUrl = new URL(renderedUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('only https allowed');
    }
    targetHost = normalizeHost(parsedUrl.hostname);
  } catch {
    throw new AppError(400, 'manifest_invalid', '控制面步骤 URL 必须是合法的 https 地址');
  }

  const secretValues: Record<string, string> = {};
  for (const name of secretNames) {
    const key = appSecretKey(manifestId, name);
    const rawSetting = await deps.settings.getValue(key);
    const parsedSecret = appSecretValueSchema.safeParse(rawSetting);
    if (!parsedSecret.success) {
      throw new AppError(
        400,
        'secret_not_configured',
        `缺少或格式无效的应用凭据：${name}`,
        undefined,
        { name },
      );
    }
    const allowHosts = parsedSecret.data.allowHosts.map(normalizeHost);
    if (!allowHosts.includes(targetHost)) {
      throw new AppError(
        403,
        'secret_host_not_allowed',
        `应用凭据 ${name} 未授权发送给主机 ${targetHost}`,
        undefined,
        { name, host: targetHost },
      );
    }
    secretValues[name] = parsedSecret.data.value;
  }

  const fullVars: Record<string, unknown> = {
    ...baseVars,
    secret: secretValues,
  };

  const headers: Record<string, string> = {};
  let serializedBody: string | undefined;
  try {
    for (const [headerName, headerTpl] of Object.entries(hook.headers ?? {})) {
      headers[headerName] = renderTemplate(headerTpl, fullVars);
    }
    if (hook.body !== undefined) {
      serializedBody = JSON.stringify(renderJsonBody(hook.body, fullVars));
      const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
      if (!hasContentType) {
        headers['content-type'] = 'application/json';
      }
    }
  } catch (err) {
    mapTemplateError(err);
  }

  const fetchImpl = deps.hookFetch ?? fetch;
  const startedAt = Date.now();
  let status = 0;
  let outcome = 'hook_failed';
  let response: Response;

  try {
    try {
      response = await timed('ext', () =>
        fetchImpl(renderedUrl, {
          method: hook.method,
          headers,
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
        }),
      );
    } catch {
      outcome = 'hook_failed';
      throw new AppError(502, 'hook_failed', `控制面步骤 ${stage} 请求失败`, undefined, {
        stage,
        status: 0,
        error: 'request_failed_or_timeout',
      });
    }

    status = response.status;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      outcome = 'hook_failed';
      throw new AppError(502, 'hook_failed', `控制面步骤 ${stage} 拒绝跟随重定向`, undefined, {
        stage,
        status: response.status,
        error: 'redirect_not_allowed',
      });
    }

    let rawText: string;
    try {
      rawText = await readBoundedText(response, MAX_HOOK_RESPONSE_BYTES);
    } catch {
      outcome = 'hook_failed';
      throw new AppError(502, 'hook_failed', `控制面步骤 ${stage} 响应超过 64KB 上限`, undefined, {
        stage,
        status: response.status,
        error: 'response_too_large',
      });
    }

    const statusOk = hook.expectStatus
      ? hook.expectStatus.includes(response.status)
      : response.status >= 200 && response.status <= 299;

    if (!statusOk) {
      outcome = 'hook_failed';
      let remoteError: string | undefined;
      try {
        const errJson = JSON.parse(rawText) as { error?: unknown };
        if (errJson && typeof errJson === 'object' && typeof errJson.error === 'string' && errJson.error) {
          remoteError = errJson.error.slice(0, 200);
        }
      } catch {
        // 忽略非 JSON 错误体，绝不回显原始响应
      }
      throw new AppError(
        502,
        'hook_failed',
        `控制面步骤 ${stage} 返回状态 ${response.status}`,
        undefined,
        {
          stage,
          status: response.status,
          ...(remoteError ? { error: remoteError } : {}),
        },
      );
    }

    const hookOutputs: Record<string, HookScalar> = {};
    const hookFacts: Record<string, HookScalar> = {};
    const extractEntries = Object.entries(hook.extract ?? {});
    if (extractEntries.length > 0) {
      let doc: unknown;
      try {
        doc = JSON.parse(rawText);
      } catch {
        outcome = 'hook_extract_failed';
        throw new AppError(502, 'hook_extract_failed', '控制面步骤响应不是合法 JSON', undefined, {
          key: extractEntries[0]?.[0] ?? 'body',
        });
      }
      const encoder = new TextEncoder();
      const publicSet = new Set(hook.public ?? []);
      for (const [key, pointer] of extractEntries) {
        const val = extractJsonPointer(doc, pointer);
        const isScalar =
          typeof val === 'string' ||
          (typeof val === 'number' && Number.isFinite(val)) ||
          typeof val === 'boolean';
        if (!isScalar || encoder.encode(String(val)).byteLength > MAX_EXTRACT_BYTES) {
          outcome = 'hook_extract_failed';
          throw new AppError(502, 'hook_extract_failed', `控制面步骤提取字段 ${key} 失败`, undefined, {
            key,
          });
        }
        hookOutputs[key] = val;
        if (publicSet.has(key)) {
          hookFacts[key] = val;
        }
      }
    }

    outcome = 'ok';
    return { hookOutputs, hookFacts };
  } finally {
    const durationMs = Math.max(0, Date.now() - startedAt);
    await deps.audit.log({
      actor,
      nodeId: node.id,
      action: 'app.hook',
      detail: {
        manifestId,
        instance,
        stage,
        host: targetHost,
        status,
        durationMs,
        outcome,
      },
    });
  }
}
