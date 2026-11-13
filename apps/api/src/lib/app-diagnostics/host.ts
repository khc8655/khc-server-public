/**
 * 应用侧诊断来源：主机运维指标（/state.ops）→ 适配器问题形状。
 *
 * 与 certificates.ts 一样，Worker 把节点自身看不到的判定（阈值、受管单元过滤）
 * 翻译成通用 problems，交给 lib/diagnostics/evaluate.ts 统一渲染；核心目录不认识应用名。
 * 全部只读、没有一键修复，hint 给出手工处理方法并指向「主机运维」页。
 * 所有阈值集中在本文件，调整阈值只改 Worker、不必发 Agent 版本。
 */
import type { AdapterProblem, AgentOps } from '@khc/contracts';

// ---------------------------------------------------------------------------
// 阈值（唯一维护处）
// ---------------------------------------------------------------------------

const DISK_WARN_PERCENT = 85;
const DISK_ERROR_PERCENT = 95;
const MEM_AVAILABLE_WARN_PERCENT = 10;
const MEM_AVAILABLE_NO_SWAP_PERCENT = 5;
const SWAP_USED_WARN_PERCENT = 50;
const OOM_WINDOW_SEC = 24 * 60 * 60;
const MEMORY_PRESSURE_AVG60_WARN = 20;
const MAX_FAILED_UNITS_IN_EVIDENCE = 5;

const HOST_OPS_PAGE = '节点「主机运维」页（/hubs/<节点>/ops）';

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 受管单元由对应适配器（caddy-site / wireguard / khc-agent）自行上报，这里不重复报。 */
function isManagedUnit(name: string): boolean {
  return (
    name === 'caddy' ||
    name.startsWith('caddy.') ||
    name.startsWith('khc-') ||
    name.startsWith('wg-quick@')
  );
}

/**
 * 从 /state.ops 派生主机问题。ops 缺失或旧 Agent 不上报可选字段时，对应检查跳过。
 * now 为控制面 Unix 秒。
 */
export function hostProblems(ops: AgentOps | null | undefined, now: number): AdapterProblem[] {
  if (!ops) return [];
  const problems: AdapterProblem[] = [];

  // disk_full：所有磁盘的空间与 inode 使用率取最严重的一条，避免刷屏。
  let worstDisk: { name: string; path: string; metric: string; percent: number } | null = null;
  for (const disk of ops.disks ?? []) {
    const name = typeof disk.name === 'string' ? disk.name : 'disk';
    const path = typeof disk.path === 'string' ? disk.path : '';
    for (const [metric, raw] of [
      ['space', disk.percent],
      ['inodes', disk.inodesPercent],
    ] as const) {
      const percent = numberOrNull(raw);
      if (percent === null || (worstDisk !== null && percent <= worstDisk.percent)) continue;
      worstDisk = { name, path, metric, percent };
    }
  }
  if (worstDisk && worstDisk.percent >= DISK_WARN_PERCENT) {
    const severity: AdapterProblem['severity'] =
      worstDisk.percent >= DISK_ERROR_PERCENT ? 'error' : 'warn';
    const label = worstDisk.metric === 'inodes' ? 'inode' : '空间';
    problems.push({
      code: 'disk_full',
      severity,
      title: '磁盘空间或 inode 将满',
      hint:
        `${clip(worstDisk.name, 64)}（${clip(worstDisk.path || '/', 64)}）的${label}使用率已达 ${worstDisk.percent}%。` +
        '请登录节点用 df -h、df -i 与 du -sh 定位，清理日志、缓存或无用文件，必要时扩容；' +
        `告警阈值 ${DISK_WARN_PERCENT}%，严重阈值 ${DISK_ERROR_PERCENT}%。可在${HOST_OPS_PAGE}查看磁盘分段。`,
      evidence: {
        disk: clip(worstDisk.name),
        path: clip(worstDisk.path || '/'),
        metric: worstDisk.metric,
        percent: worstDisk.percent,
      },
    });
  }

  // memory_low：有 swap 时要求「可用内存 <10% 且 swap 已用 >50%」；无 swap 时只看 <5%。
  const mem = ops.mem;
  const total = numberOrNull(mem?.total);
  const available = numberOrNull(mem?.available);
  const usedPercent = numberOrNull(mem?.percent);
  let availablePercent: number | null = null;
  if (total !== null && total > 0 && available !== null) {
    availablePercent = Math.max(0, Math.min(100, (available / total) * 100));
  } else if (usedPercent !== null) {
    availablePercent = Math.max(0, Math.min(100, 100 - usedPercent));
  }
  const swap = ops.swap;
  const swapTotal = numberOrNull(swap?.total);
  const swapPercent = numberOrNull(swap?.percent);
  const hasSwap = swapTotal !== null && swapTotal > 0 && swapPercent !== null;
  if (availablePercent !== null) {
    const low = hasSwap
      ? availablePercent < MEM_AVAILABLE_WARN_PERCENT && (swapPercent ?? 0) > SWAP_USED_WARN_PERCENT
      : availablePercent < MEM_AVAILABLE_NO_SWAP_PERCENT;
    if (low) {
      problems.push({
        code: 'memory_low',
        severity: 'warn',
        title: '可用内存不足',
        hint:
          `可用内存约 ${Math.round(availablePercent * 10) / 10}%` +
          (hasSwap ? `，swap 已用 ${swapPercent}%` : '，节点没有可用 swap') +
          '。请登录节点用 free -m、top 找出高占用进程，重启或限制该进程，必要时增加内存或 swap；' +
          `可在${HOST_OPS_PAGE}查看内存与进程分段。`,
        evidence: {
          availablePercent: Math.round(availablePercent * 10) / 10,
          swapPercent: hasSwap ? swapPercent : null,
          hasSwap,
        },
      });
    }
  }

  // units_failed：过滤受管单元，evidence 只列前 5 个名字。
  const failedUnits = ops.services?.failedUnits;
  if (Array.isArray(failedUnits)) {
    const units = failedUnits.filter(
      (name) => typeof name === 'string' && name.length > 0 && !isManagedUnit(name),
    );
    if (units.length > 0) {
      problems.push({
        code: 'units_failed',
        severity: 'warn',
        title: '系统单元运行失败',
        hint:
          `可在${HOST_OPS_PAGE}查看服务分段与日志：${units.length} 个 systemd 单元处于 failed` +
          `（${clip(units.slice(0, MAX_FAILED_UNITS_IN_EVIDENCE).join('、'), 80)}）。` +
          '请登录节点用 systemctl status <单元>、journalctl -u <单元> 排查，' +
          '修复后执行 systemctl restart <单元>；受管单元由对应应用诊断展示。',
        evidence: {
          count: units.length,
          units: clip(units.slice(0, MAX_FAILED_UNITS_IN_EVIDENCE).join(', ')),
        },
      });
    }
  }

  // reboot_required：内核/库更新后的重启标记。
  if (ops.rebootRequired === true) {
    problems.push({
      code: 'reboot_required',
      severity: 'info',
      title: '系统需要重启',
      hint:
        '节点存在 /var/run/reboot-required 标记，通常是内核或系统库更新未生效。' +
        '请在维护窗口手工执行 sudo reboot，重启后到' +
        HOST_OPS_PAGE +
        '确认服务已恢复。',
      evidence: { rebootRequired: true },
    });
  }

  // oom_killed：最近一次 oom_kill 计数增长在 24 小时窗口内。
  const oom = ops.oom;
  const lastIncreaseAt = numberOrNull(oom?.lastIncreaseAt);
  if (lastIncreaseAt !== null && lastIncreaseAt > 0) {
    const age = now - lastIncreaseAt;
    if (age >= 0 && age <= OOM_WINDOW_SEC) {
      problems.push({
        code: 'oom_killed',
        severity: 'warn',
        title: '24 小时内发生过 OOM 杀进程',
        hint:
          `内核累计 OOM 杀进程 ${numberOrNull(oom?.total) ?? 0} 次，最近一次增长在 24 小时内。` +
          '请登录节点用 dmesg -T、journalctl -k 定位被杀进程，降低其内存占用或增加内存/swap；' +
          `可在${HOST_OPS_PAGE}查看内存与进程分段。`,
        evidence: { total: numberOrNull(oom?.total) ?? 0, lastIncreaseAt },
      });
    }
  }

  // fs_readonly：根挂载被内核置为只读，配置写入会全部失败。
  if (ops.rootReadonly === true) {
    problems.push({
      code: 'fs_readonly',
      severity: 'error',
      title: '根文件系统被置为只读',
      hint:
        '根挂载被内核改为只读，通常由磁盘或文件系统错误触发。' +
        '请登录节点用 dmesg -T、mount 检查，备份数据后执行 fsck 并重启；恢复前不要应用配置。' +
        `可在${HOST_OPS_PAGE}查看系统状态。`,
      evidence: { rootReadonly: true },
    });
  }

  // memory_pressure：PSI 的 some avg60 超过阈值（可选字段，缺 PSI 支持时跳过）。
  const avg60 = numberOrNull(ops.memoryPressure);
  if (avg60 !== null && avg60 > MEMORY_PRESSURE_AVG60_WARN) {
    problems.push({
      code: 'memory_pressure',
      severity: 'warn',
      title: '内存压力持续偏高',
      hint:
        `PSI 内存 some avg60=${avg60}，超过 ${MEMORY_PRESSURE_AVG60_WARN}，进程持续因内存回收被阻塞。` +
        '请登录节点用 top、free -m 找出高占用进程，减少内存占用或扩容；' +
        `可在${HOST_OPS_PAGE}查看内存与进程分段。`,
      evidence: { avg60 },
    });
  }

  return problems;
}
