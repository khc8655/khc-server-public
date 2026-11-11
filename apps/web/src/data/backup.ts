/** 节点备份/恢复（C4）：备份文件解析、下载与导入 API。 */
import {
  backupExportSchema,
  backupImportResponseSchema,
  type BackupExport,
  type BackupImportResponse,
} from '@khc/contracts';
import { ApiError, apiRequest } from './client';

export const BACKUP_FORMAT = 'khc-backup/v1';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export const MAX_BACKUP_APPS = 50;
export const BACKUP_APP_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface BackupAppPreview {
  app: string;
  schemaVersion: number;
}

export interface ParsedBackup {
  payload: Record<string, unknown>;
  fileName: string;
  size: number;
  signature: string;
  nodeId: string;
  nodeName: string;
  exportedAt: number;
  apps: BackupAppPreview[];
}

export class BackupFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFileError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 程序化打开文件选择器，页面只渲染 Button（不新增 FileInput 组件）。 */
export function pickBackupFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export function backupFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** 文件名安全化 + 日期：khc-backup-<node>-<YYYY-MM-DD>.json（不放路径/控制字符）。 */
export function backupFilename(
  nodeName: string,
  nodeId: string,
  date: Date = new Date(),
): string {
  const safePart = (value: string): string =>
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  const name = safePart(nodeName) || safePart(nodeId) || 'node';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `khc-backup-${name}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

function parseApps(value: unknown): BackupAppPreview[] {
  if (!Array.isArray(value)) {
    throw new BackupFileError('备份文件缺少 apps 数组');
  }
  if (value.length > MAX_BACKUP_APPS) {
    throw new BackupFileError(`备份应用数超过上限（${MAX_BACKUP_APPS}）`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = asRecord(raw);
    const app = asString(item.app);
    if (!app || !BACKUP_APP_RE.test(app)) {
      throw new BackupFileError(`第 ${index + 1} 个应用名不合法`);
    }
    if (seen.has(app)) {
      throw new BackupFileError(`备份中应用重复：${app}`);
    }
    seen.add(app);
    const config = item.config;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new BackupFileError(`应用 ${app} 的配置不是 JSON 对象`);
    }
    const rawVersion = item.schemaVersion;
    const schemaVersion = rawVersion === undefined ? 1 : asNumber(rawVersion);
    if (
      schemaVersion === null ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 1
    ) {
      throw new BackupFileError(`应用 ${app} 的 schemaVersion 不合法`);
    }
    return { app, schemaVersion };
  });
}

/** 本地解析 + 格式/版本/应用列表校验（不信任文件内容）。 */
export function parseBackupText(
  text: string,
  meta: { name: string; size: number; lastModified: number },
): ParsedBackup {
  if (!meta.name.toLowerCase().endsWith('.json')) {
    throw new BackupFileError('请选择 .json 备份文件');
  }
  if (meta.size > MAX_BACKUP_BYTES) {
    throw new BackupFileError('备份文件超过 2 MB 上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupFileError('文件不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupFileError('备份文件格式不正确');
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.format !== BACKUP_FORMAT) {
    throw new BackupFileError(`不是 KHC 备份文件（format 应为 ${BACKUP_FORMAT}）`);
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new BackupFileError(`不支持的备份版本：${String(payload.version)}`);
  }
  const exportedAt = asNumber(payload.exportedAt);
  if (exportedAt === null || !Number.isInteger(exportedAt) || exportedAt < 0) {
    throw new BackupFileError('备份文件缺少合法的 exportedAt');
  }
  const node = asRecord(payload.node);
  const nodeId = asString(node.id);
  const nodeName = asString(node.name);
  if (!nodeId && !nodeName) {
    throw new BackupFileError('备份文件缺少节点信息');
  }
  const apps = parseApps(payload.apps);
  return {
    payload,
    fileName: meta.name,
    size: meta.size,
    signature: `${meta.name}:${meta.size}:${meta.lastModified}`,
    nodeId,
    nodeName: nodeName || nodeId,
    exportedAt,
    apps,
  };
}

export async function parseBackupFile(file: File): Promise<ParsedBackup> {
  if (!file.name.toLowerCase().endsWith('.json')) {
    throw new BackupFileError('请选择 .json 备份文件');
  }
  if (file.size > MAX_BACKUP_BYTES) {
    throw new BackupFileError('备份文件超过 2 MB 上限');
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new BackupFileError('无法读取备份文件');
  }
  return parseBackupText(text, {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  });
}

export async function fetchNodeBackup(
  hubId: string,
): Promise<{ backup: BackupExport; filename: string }> {
  const body = await apiRequest<unknown>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/export`,
  );
  const parsed = backupExportSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('导出响应格式不合法');
  }
  const backup = parsed.data;
  return {
    backup,
    filename: backupFilename(backup.node.name, backup.node.id),
  };
}

export async function importNodeBackup(
  hubId: string,
  payload: Record<string, unknown>,
): Promise<BackupImportResponse> {
  const body = await apiRequest<unknown>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/import`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  const parsed = backupImportResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('导入响应格式不合法');
  }
  return parsed.data;
}

export function backupErrorText(error: unknown): string {
  if (error instanceof BackupFileError) return error.message;
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '操作失败';
}
