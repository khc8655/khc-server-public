import { describe, expect, it } from 'vitest';
import type { HostOpsProcess } from '../../data/hostOps';
import { businessProcesses, countSystemProcesses, isSystemProcess } from './processFilter';

/**
 * 过滤清单来自 node-test-3 / node-test-2 的实机 /proc 观察（2026-11-03），
 * 不照抄通用名单；用例即观察到的真实命令形态。
 */

function process(
  pid: number,
  ppid: number | null,
  cmdline: string,
  user = 'root',
): HostOpsProcess {
  return { pid, ppid, name: cmdline, user, startTime: null, cpu: null, mem: null, cmdline };
}

describe('isSystemProcess', () => {
  it('内核线程：ppid 为 kthreadd（2）或自身 pid 2', () => {
    expect(isSystemProcess(process(2, 0, 'kthreadd'))).toBe(true);
    expect(isSystemProcess(process(125, 2, 'kworker/0:1'))).toBe(true);
    expect(isSystemProcess(process(40, 2, 'ksoftirqd/0'))).toBe(true);
    expect(isSystemProcess(process(48, 2, 'irq/50-aerdrv'))).toBe(true);
    expect(isSystemProcess(process(300, 2, '[jbd2/sda1-8]'))).toBe(true);
  });

  it('系统守护进程按命令首段判定（含 sshd:/@dbus-daemon/(sd-pam) 形态）', () => {
    expect(isSystemProcess(process(1, 0, '/usr/lib/systemd/systemd --system --deserialize=45'))).toBe(true);
    expect(isSystemProcess(process(1, 0, '/sbin/init'))).toBe(true);
    expect(isSystemProcess(process(11, 1, '/usr/lib/systemd/systemd-journald'))).toBe(true);
    expect(isSystemProcess(process(700, 1, '@dbus-daemon --system --address=systemd:'))).toBe(true);
    expect(isSystemProcess(process(900, 1, 'sshd: ubuntu [priv]'))).toBe(true);
    expect(isSystemProcess(process(950, 900, '(sd-pam)'))).toBe(true);
    expect(isSystemProcess(process(1200, 1, '/usr/sbin/cron -f -P 15'))).toBe(true);
    expect(isSystemProcess(process(1250, 1, '/usr/sbin/agetty -o -p -- \\u --noclear tty1 linux'))).toBe(true);
  });

  it('系统包与发行版脚本按完整命令路径判定', () => {
    expect(
      isSystemProcess(
        process(760, 1, '/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal'),
      ),
    ).toBe(true);
    expect(
      isSystemProcess(process(980, 1, '/snap/oracle-cloud-agent/current/bin/agent --logfile /var/log/oracle-cloud-agent.log')),
    ).toBe(true);
    expect(isSystemProcess(process(990, 1, '/snap/snapd/current/usr/lib/snapd/snapd'))).toBe(true);
  });

  it('云镜像自带守护进程按名称判定（node-prod-1 实机观察）', () => {
    expect(isSystemProcess(process(183, 1, '/sbin/multipathd -d -s'))).toBe(true);
    expect(isSystemProcess(process(997, 1, '/snap/amazon-ssm-agent/13349/amazon-ssm-agent'))).toBe(true);
    expect(isSystemProcess(process(789, 1, '/usr/sbin/chronyd -F 1'))).toBe(true);
    expect(
      isSystemProcess(process(640, 1, '/usr/bin/python3 /usr/bin/networkd-dispatcher --run-startup-triggers')),
    ).toBe(true);
    expect(isSystemProcess(process(623, 1, '/usr/sbin/irqbalance --foreground'))).toBe(true);
  });

  it('khc Agent 自身与 host-ops 辅助脚本属于控制面，按路径判定', () => {
    expect(isSystemProcess(process(1010, 1, '/usr/bin/python3 /opt/khc-agent/khc_agent.py run'))).toBe(true);
    expect(
      isSystemProcess(
        process(128448, 1, '/usr/bin/python3 /var/lib/khc-agent/host-ops/khc-host snapshot'),
      ),
    ).toBe(true);
  });

  it('业务进程保留：caddy、用户自己的服务', () => {
    expect(isSystemProcess(process(880, 1, '/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile'))).toBe(false);
    expect(
      isSystemProcess(process(1100, 1000, '/home/user/caddy/mcp-server/.venv/bin/python3 -m mcp_server')),
    ).toBe(false);
    expect(isSystemProcess(process(1300, 1, '/usr/bin/dockerd -H fd://'))).toBe(false);
  });
});

describe('businessProcesses / countSystemProcesses', () => {
  const all = [
    process(1, 0, '/usr/lib/systemd/systemd --system'),
    process(2, 0, 'kthreadd'),
    process(125, 2, 'kworker/0:1'),
    process(880, 1, '/usr/bin/caddy run --config /etc/caddy/Caddyfile'),
    process(1010, 1, '/usr/bin/python3 /opt/khc-agent/khc_agent.py run'),
  ];

  it('默认业务视图只保留业务进程，隐藏数是真实计数', () => {
    expect(countSystemProcesses(all)).toBe(4);
    expect(businessProcesses(all).map((item) => item.pid)).toEqual([880]);
    // 隐藏数 = 总数 - 业务数，切换后不会凭空变化
    expect(all.length - businessProcesses(all).length).toBe(4);
  });

  it('没有系统进程时隐藏数为 0', () => {
    expect(countSystemProcesses([all[3]!])).toBe(0);
  });
});
