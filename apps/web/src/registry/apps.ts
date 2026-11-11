/**
 * 内置模块不是“应用发布”里的普通应用：它们各自有专属页面。
 * 应用发布页只展示可独立安装/发布的应用。
 */
export const BUILTIN_APP_NAMES = [
  'wireguard',
  'caddy-site',
  'port-forward',
  'certificates',
  'host-ops',
] as const;

export function isBuiltinApp(app: string): boolean {
  return (BUILTIN_APP_NAMES as readonly string[]).includes(app);
}
