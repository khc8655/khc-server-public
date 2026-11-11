/** 生成带前缀的资源 ID，如 nd_xxxxxxxxxxxxxxxx */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}

/** D-2/T2.2：节点 rev epoch（16 字节随机 hex）。创建节点时生成；节点重建/恢复时换新值。 */
export function newEpoch(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** 当前 Unix 秒 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
