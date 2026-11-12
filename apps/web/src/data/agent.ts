/** C5 Agent 生命周期：命令生成（Worker 只生成，不执行）+ 远程升级下发。 */
import {
  agentCommandRequestSchema,
  agentCommandResponseSchema,
  agentUninstallCommandRequestSchema,
  agentUpgradeRequestSchema,
  agentUpgradeResponseSchema,
  type AgentCommandMode,
  type AgentCommandResponse,
  type AgentCommandType,
  type AgentInstallOptions,
  type AgentUpgradeResponse,
} from '@khc/contracts';
import { apiRequest } from './client';

export type AgentCommandKind = AgentCommandType;
export type AgentRunMode = AgentCommandMode;

export interface AgentCommandInput {
  mode?: AgentRunMode;
  /** 安装/升级必填；卸载可省略（Worker 用已签名的最新发布包）。 */
  packageUrl?: string;
  sha256?: string;
  purge?: boolean;
  /** P0-1：安装命令可选组件（仅 kind==='install' 生效；默认不带） */
  installOptions?: AgentInstallOptions;
}

export type AgentCommandResult = AgentCommandResponse;

export interface AgentRelease {
  version: string;
  url: string;
  sha256: string;
}

/** 读取生产 Worker 已签名的 Agent 发布清单（#32）。 */
export async function fetchAgentReleases(): Promise<AgentRelease[]> {
  const body = await apiRequest<unknown>('/api/v1/agent/releases');
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = Array.isArray(record.releases) ? record.releases : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const release = item as Record<string, unknown>;
    const version = typeof release.version === 'string' ? release.version : '';
    const url = typeof release.url === 'string' ? release.url : '';
    const sha256 = typeof release.sha256 === 'string' ? release.sha256 : '';
    if (!version || !url || !/^[0-9a-f]{64}$/i.test(sha256)) return [];
    return [{ version, url, sha256 }];
  });
}

export class AgentCommandError extends Error {
  constructor(
    message: string,
    readonly field: 'packageUrl' | 'sha256' | 'mode' | 'request' | 'response' = 'request',
  ) {
    super(message);
    this.name = 'AgentCommandError';
  }
}

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RE = /\s/;

/** packageUrl 必须 https、无空白/控制字符、≤2048；sha256 必须 64 hex。 */
export function validatePackageUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return '请填写安装包地址';
  if (text.length > 2048) return '安装包地址不能超过 2048 个字符';
  if (WHITESPACE_RE.test(text) || CONTROL_RE.test(text)) {
    return '安装包地址不能包含空白或控制字符';
  }
  if (/['`]/.test(text)) return '安装包地址不能包含引号或反引号';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '安装包地址不是合法 URL';
  }
  if (url.protocol !== 'https:') return '安装包地址必须是 https';
  return null;
}

export function validateSha256(value: string): string | null {
  const text = value.trim();
  if (!text) return '请填写 sha256';
  if (!SHA256_RE.test(text)) return 'sha256 必须是 64 位十六进制';
  return null;
}

export function validateRunMode(value: string): value is AgentRunMode {
  return value === 'system' || value === 'user';
}

function endpoint(kind: AgentCommandKind): string {
  if (kind === 'install') return 'install-command';
  if (kind === 'upgrade') return 'upgrade-command';
  return 'uninstall-command';
}

export async function generateAgentCommand(
  hubId: string,
  kind: AgentCommandKind,
  input: AgentCommandInput,
): Promise<AgentCommandResult> {
  const mode = input.mode;
  if (!validateRunMode(mode ?? '')) {
    throw new AgentCommandError('运行模式只能是 system 或 user', 'mode');
  }
  const packageUrl = (input.packageUrl ?? '').trim();
  const sha256 = (input.sha256 ?? '').trim();
  let payload;
  if (kind === 'uninstall') {
    // 卸载不再要求用户填写包地址/sha256；旧调用方仍可显式传入。
    payload = agentUninstallCommandRequestSchema.parse({
      mode,
      ...(packageUrl ? { packageUrl } : {}),
      ...(sha256 ? { sha256 } : {}),
      purge: Boolean(input.purge),
    });
  } else {
    const urlError = validatePackageUrl(packageUrl);
    if (urlError) throw new AgentCommandError(urlError, 'packageUrl');
    const shaError = validateSha256(sha256);
    if (shaError) throw new AgentCommandError(shaError, 'sha256');
    payload =
      kind === 'upgrade'
        ? agentCommandRequestSchema.parse({ mode, packageUrl, sha256 })
        : agentCommandRequestSchema.parse({
            mode,
            packageUrl,
            sha256,
            installOptions: input.installOptions ?? undefined,
          });
  }

  const body = await apiRequest<unknown>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/agent/${endpoint(kind)}`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  const parsed = agentCommandResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentCommandError('服务端未返回合法命令', 'response');
  }
  return parsed.data;
}

/**
 * 回滚目标（ADR-0019）：清单约定 releases[0]=最新、releases[1]=上一版。
 *
 * 只有「节点当前版本 == 最新版本」且「存在上一版」时才允许回滚——否则
 * 拿 releases[1] 去操作一个更旧的节点，实质是升级而不是回滚，文案会骗人。
 */
export function rollbackTarget(
  releases: AgentRelease[] | null | undefined,
  currentVersion: string | null | undefined,
): AgentRelease | null {
  const latest = releases?.[0];
  const previous = releases?.[1];
  if (!latest || !previous || !currentVersion) return null;
  if (currentVersion !== latest.version) return null;
  if (previous.version === latest.version) return null;
  return previous;
}

/** E3：下发远程升级（Agent 拉取式，自重启）；包地址与 sha256 来自发布清单。 */
export async function upgradeAgentRemote(
  hubId: string,
  input: { packageUrl: string; sha256: string },
): Promise<AgentUpgradeResponse> {
  const payload = agentUpgradeRequestSchema.parse({
    packageUrl: input.packageUrl.trim(),
    sha256: input.sha256.trim(),
  });
  const body = await apiRequest<unknown>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/agent/upgrade`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  const parsed = agentUpgradeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentCommandError('服务端未接受升级请求', 'response');
  }
  return parsed.data;
}
