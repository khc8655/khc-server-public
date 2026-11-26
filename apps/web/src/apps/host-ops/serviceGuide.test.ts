import { describe, expect, it } from 'vitest';
import { HOST_GUIDE, lookupProcessGuide, lookupSlimServiceGuide } from './serviceGuide';

describe('serviceGuide', () => {
  it('覆盖全部 12 项保守白名单服务且至少 40 条常见条目', () => {
    expect(Object.keys(HOST_GUIDE).length).toBeGreaterThanOrEqual(40);
    for (const unit of [
      'ModemManager.service',
      'udisks2.service',
      'packagekit.service',
      'fwupd.service',
      'apport.service',
      'whoopsie.service',
      'motd-news.timer',
      'accounts-daemon.service',
      'avahi-daemon.service',
      'cups.service',
      'bluetooth.service',
      'snapd.service',
    ]) {
      const entry = lookupSlimServiceGuide(unit);
      expect(entry, unit).toBeTruthy();
      expect(entry?.slimUnit, unit).toBeTruthy();
    }
  });

  it('按进程名、脚本路径与系统单元名精准命中且不误匹配无关进程', () => {
    const modem = lookupProcessGuide({ name: 'ModemManager', cmdline: '/usr/sbin/ModemManager' });
    expect(modem?.shortLabel).toBe('拨号与蜂窝猫管理');
    expect(modem?.slimUnit).toBe('ModemManager.service');

    const khc = lookupProcessGuide({
      name: 'python3',
      cmdline: '/usr/bin/python3 /opt/khc-agent/main.py',
    });
    expect(khc?.shortLabel).toBe('面板节点 Agent 守护');
    expect(khc?.slimUnit).toBeUndefined();

    const unknown = lookupProcessGuide({ name: 'my-custom-worker', cmdline: './my-custom-worker' });
    expect(unknown).toBeNull();
  });
});
