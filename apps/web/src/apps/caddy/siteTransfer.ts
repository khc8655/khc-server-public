/** Caddy 站点 JSON 导出/导入（纯前端；导入只保存配置，不自动 apply）。 */
import { normalizeCaddySite, type CaddyConfig, type CaddySite } from '../../data/sites';

export const SITE_EXPORT_FORMAT = 'khc-caddy-sites/v1';
export const MAX_SITE_IMPORT_BYTES = 2 * 1024 * 1024;

const DOMAIN_RE = /^[A-Za-z0-9*_.-]+(\.[A-Za-z0-9*_.-]+)*$/;
const NAME_RE = /^[A-Za-z0-9_.@*-]{1,64}$/;
const UPSTREAM_RE = /^(https?:\/\/[^\s]+|[A-Za-z0-9_.:[\]-]+:\d{1,5})$/;
const PATH_RE = /^\/[^\s]*$/;

export type SiteImportStatus = 'new' | 'overwrite' | 'conflict';

export interface SiteImportRow {
  site: CaddySite;
  status: SiteImportStatus;
  reason: string | null;
}

export interface SiteImportResult {
  rows: SiteImportRow[];
  errors: string[];
  nextConfig: CaddyConfig;
}

export class SiteImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteImportError';
  }
}

function safePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function siteExportFilename(nodeName: string, nodeId: string, date = new Date()): string {
  const name = safePart(nodeName) || safePart(nodeId) || 'node';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `khc-sites-${name}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

export function serializeSites(sites: CaddySite[]): string {
  return JSON.stringify(
    {
      format: SITE_EXPORT_FORMAT,
      version: 1,
      exportedAt: Math.floor(Date.now() / 1000),
      sites,
    },
    null,
    2,
  );
}

function addressKey(port: number, domain: string): string {
  return `${port}:${domain.toLowerCase()}`;
}

function validateSite(site: CaddySite): string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(site.name)) errors.push('站点名称格式不合法');
  if (site.domains.length === 0) errors.push('缺少域名');
  if (site.domains.some((domain) => !DOMAIN_RE.test(domain))) errors.push('域名格式不合法');
  if (new Set(site.domains.map((domain) => domain.toLowerCase())).size !== site.domains.length) {
    errors.push('域名重复');
  }
  if (
    !Number.isInteger(site.listenPort) ||
    site.listenPort < 1 ||
    site.listenPort > 65535
  ) {
    errors.push('监听端口需要 1–65535');
  }
  if (site.kind === 'proxy') {
    if (site.upstreams.length === 0) errors.push('代理站点缺少上游');
    else if (site.upstreams.some((upstream) => !UPSTREAM_RE.test(upstream))) {
      errors.push('上游格式不合法');
    }
  } else if (site.kind === 'static') {
    if (!site.root.trim()) errors.push('静态站点缺少根目录');
  } else if (site.kind === 'redirect') {
    if (!site.redirectTo.trim()) errors.push('跳转站点缺少目标地址');
    else if (!/^(https?:\/\/|\/)[^\s]*$/.test(site.redirectTo.trim())) {
      errors.push('跳转地址格式不合法');
    }
  }
  for (const route of site.pathRoutes) {
    if (!PATH_RE.test(route.path.trim())) errors.push('路径规则格式不合法');
    if (route.upstreams.length === 0) errors.push('路径规则缺少上游');
    else if (route.upstreams.some((upstream) => !UPSTREAM_RE.test(upstream))) {
      errors.push('路径规则上游格式不合法');
    }
  }
  return errors;
}

function rawFieldErrors(raw: unknown, index: number): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`第 ${index + 1} 个站点不是对象`];
  }
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (record.listenPort !== undefined) {
    const value = record.listenPort;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535
    ) {
      errors.push('监听端口需要 1–65535');
    }
  }
  if (
    record.kind !== undefined &&
    record.kind !== 'proxy' &&
    record.kind !== 'static' &&
    record.kind !== 'redirect'
  ) {
    errors.push('站点类型不合法');
  }
  if (record.domains !== undefined && !Array.isArray(record.domains)) {
    errors.push('域名必须是数组');
  }
  if (record.upstreams !== undefined && !Array.isArray(record.upstreams)) {
    errors.push('上游必须是数组');
  }
  return errors;
}

function parseRoot(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SiteImportError('文件不是合法 JSON');
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed === null || typeof parsed !== 'object') {
    throw new SiteImportError('站点 JSON 必须是数组或包含 sites 的对象');
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== undefined && record.format !== SITE_EXPORT_FORMAT) {
    throw new SiteImportError('不是本面板导出的站点 JSON');
  }
  if (!Array.isArray(record.sites)) {
    throw new SiteImportError('站点 JSON 缺少 sites 数组');
  }
  return record.sites;
}

/** 解析并预览导入：校验每条站点，标记新增/覆盖/冲突，返回合并后的本地配置。 */
export function parseSitesImport(text: string, existingSites: CaddySite[]): SiteImportResult {
  const rawSites = parseRoot(text);
  if (rawSites.length === 0) throw new SiteImportError('没有可导入的站点');
  const errors: string[] = [];
  const rows: SiteImportRow[] = [];
  const existingByName = new Map(existingSites.map((site) => [site.name, site]));
  const occupied = new Map<string, string>();
  for (const site of existingSites) {
    for (const domain of site.domains) {
      occupied.set(addressKey(site.listenPort, domain), site.name);
    }
  }
  const seenNames = new Set<string>();

  rawSites.forEach((raw, index) => {
    const fieldErrors = rawFieldErrors(raw, index);
    if (fieldErrors.length > 0) {
      errors.push(`第 ${index + 1} 个站点：${fieldErrors.join('；')}`);
      return;
    }
    const site = normalizeCaddySite(raw);
    if (!site) {
      errors.push(`第 ${index + 1} 个站点缺少域名`);
      return;
    }
    const siteErrors = validateSite(site);
    if (siteErrors.length > 0) {
      errors.push(`${site.name || `第 ${index + 1} 个站点`}：${siteErrors.join('；')}`);
      return;
    }
    let status: SiteImportStatus = existingByName.has(site.name) ? 'overwrite' : 'new';
    let reason: string | null = null;
    if (seenNames.has(site.name)) {
      status = 'conflict';
      reason = '文件内站点名称重复';
    }
    seenNames.add(site.name);
    for (const domain of site.domains) {
      const key = addressKey(site.listenPort, domain);
      const owner = occupied.get(key);
      if (owner && owner !== site.name) {
        status = 'conflict';
        reason = `与现有站点 ${owner} 的域名和端口冲突`;
        break;
      }
    }
    if (status !== 'conflict') {
      for (const domain of site.domains) {
        occupied.set(addressKey(site.listenPort, domain), site.name);
      }
    }
    rows.push({ site, status, reason });
  });

  const nextSites = [...existingSites];
  for (const row of rows) {
    if (row.status === 'conflict') continue;
    const index = nextSites.findIndex((site) => site.name === row.site.name);
    if (index >= 0) nextSites[index] = row.site;
    else nextSites.push(row.site);
  }
  return { rows, errors, nextConfig: { sites: nextSites } };
}
