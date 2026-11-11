import type { HostOpsProcess } from '../../data/hostOps';

/**
 * 系统进程判定（2026-11-03 依据 node-test-3 与 node-test-2 的实机 /proc 观察定稿）。
 * 只放 Web 页面层：不改协议、不动 Agent。
 *
 * 1) PID 1（init/systemd）与内核线程：ppid === 2（kthreadd 的子进程）或自身 pid === 2；实机上全部内核线程
 *    （kworker/ksoftirqd/irq/rcu/migration/jbd2 等）都落在这条规则里，无需穷举名字。
 * 2) 系统守护进程：命令首段的 basename 命中实机观察到的清单；
 * 3) 系统包/发行版路径：snapd、oracle-cloud-agent、unattended-upgrades；
 * 4) khc Agent 自身与 host-ops 辅助脚本（它们属于控制面，不是用户业务）。
 *
 * 不按用户名判断：caddy、khc-agent 也会以 root 运行，按用户会误伤业务进程。
 */
const SYSTEM_BASENAMES = new Set([
  // systemd 家族（arm-1 / x86-2 均出现）
  'systemd',
  'systemd-journald',
  'systemd-logind',
  'systemd-networkd',
  'systemd-resolved',
  'systemd-timesyncd',
  'systemd-udevd',
  // 其余系统守护进程（两机观察到的并集）
  'dbus-daemon',
  'rpcbind',
  'iscsid',
  'polkitd',
  'udisksd',
  'ModemManager',
  'agetty',
  'fwupd',
  'snapd',
  'sshd',
  'cron',
  'rsyslogd',
  'sd-pam',
  'psimon',
  // 云镜像常见（node-prod-1 实机 2026-11-08 观察）
  'multipathd',
  'amazon-ssm-agent',
  'chronyd',
  'networkd-dispatcher',
  'irqbalance',
  'acpid',
  'qemu-ga',
  'google_guest_agent',
  'walinuxagent',
  'aliyun-service',
  'cloud-init',
]);

const SYSTEM_PATH_PREFIXES = [
  '/snap/snapd/',
  '/snap/oracle-cloud-agent/',
  '/snap/amazon-ssm-agent/',
  '/usr/share/unattended-upgrades/',
  '/opt/khc-agent/',
  '/var/lib/khc-agent/host-ops/',
];

/** 首段命令：去掉尾部冒号（sshd:）、括号（(sd-pam)）、前缀 @（@dbus-daemon）。 */
function basenameOfToken(token: string): string {
  const stripped = token.replace(/^@/, '').replace(/^\((.+)\)$/, '$1').replace(/:$/, '');
  const slash = stripped.lastIndexOf('/');
  return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}

function basenameOf(cmdline: string): string {
  return basenameOfToken(cmdline.trim().split(/\s+/, 1)[0] ?? '');
}

export function isSystemProcess(process: HostOpsProcess): boolean {
  if (process.pid === 1 || process.pid === 2 || process.ppid === 2) return true;
  const cmdline = process.cmdline.trim();
  if (!cmdline) return false;
  // Agent 对空 cmdline 会回退到 comm，内核线程形如 [kworker/0:1]。
  if (cmdline.startsWith('[') && cmdline.endsWith(']')) return true;
  if (SYSTEM_BASENAMES.has(basenameOf(cmdline))) return true;
  // 解释器进程：`python3 /usr/bin/networkd-dispatcher` 的脚本名也要参与判定。
  if (cmdline.split(/\s+/).some((token) => SYSTEM_BASENAMES.has(basenameOfToken(token)))) return true;
  return SYSTEM_PATH_PREFIXES.some((prefix) => cmdline.includes(prefix));
}

/** 业务视图：只保留非系统进程；「显示全部」直接用原列表。 */
export function businessProcesses(processes: HostOpsProcess[]): HostOpsProcess[] {
  return processes.filter((process) => !isSystemProcess(process));
}

/** 当前列表里的系统进程数（= 业务视图下的真实隐藏数）。 */
export function countSystemProcesses(processes: HostOpsProcess[]): number {
  return processes.filter(isSystemProcess).length;
}
