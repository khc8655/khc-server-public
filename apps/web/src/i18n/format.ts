/** 时间、数字与端口显示：界面只通过这里格式化（ui-spec §5.8）。 */
import { fmt } from './zh';

/** 相对时间：<60 秒“42 秒前”，<24 小时“3 分钟前 / 2 小时前”，更早 MM-DD HH:mm，跨年 YYYY-MM-DD HH:mm。 */
export function formatRelativeTime(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds <= 0) return '—';
  const ms = unixSeconds * 1000;
  const diff = Math.max(0, now - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return fmt('{n} 秒前', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return fmt('{n} 分钟前', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fmt('{n} 小时前', { n: hours });
  return formatStamp(ms, now);
}

/** 绝对时间：MM-DD HH:mm；跨年则 YYYY-MM-DD HH:mm。 */
export function formatStamp(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
  }
  return `${month}-${day} ${hour}:${minute}`;
}

export function formatAbsoluteTime(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds <= 0) return '—';
  return formatStamp(unixSeconds * 1000, now);
}

/** 时间戳（秒）→ HH:MM:SS，用于日志与任务。 */
export function formatClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 端口显示：51820/udp。 */
export function formatPort(port: number, protocol: string): string {
  return `${port}/${protocol}`;
}

/** 数值统一千分位。 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 指纹/公钥首尾各 4 位，中间省略。 */
export function shortFingerprint(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 秒级运行时长。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return fmt('{n} 秒', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return fmt('{n} 分钟', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fmt('{n} 小时', { n: hours });
  return fmt('{n} 天', { n: Math.floor(hours / 24) });
}


/** 距到期天数（负数为已过期天数）；null 表示未设置。 */
export function daysUntil(unixSeconds: number | null | undefined, now = Date.now()): number | null {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds <= 0) return null;
  return Math.ceil((unixSeconds * 1000 - now) / (24 * 3600 * 1000));
}

/** 到期显示：\u003c14 天提示、\u003c3 天危险（ui-spec §5.8）。 */
export function formatExpiry(unixSeconds: number | null | undefined, now = Date.now()): string {
  const days = daysUntil(unixSeconds, now);
  if (days === null) return '—';
  if (days < 0) return fmt('已过期 {n} 天', { n: Math.abs(days) });
  if (days === 0) return '今天到期';
  return fmt('{n} 天后', { n: days });
}

/** 字节 → GiB/MiB（运维状态用）。 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Math.max(0, value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

/** 0–100 百分比。 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}%`;
}
