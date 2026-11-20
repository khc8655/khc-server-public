/**
 * 服务状态的统一口径（2026-11-20）。
 *
 * 真机走查发现：aws-hui-us 上 `fwupd` / `fwupd-refresh` / `apt-daily-upgrade` 三个
 * 发行版自带单元处于 failed，状态带直接摆出红色「3 个失败」，服务段三行也全红。
 * 这些单元的启动逻辑由发行版负责，面板既修不了也不该催 —— 长期红灯的结果是
 * 用户学会无视整块告警，真正的 khc-* 失败反而被淹没。
 *
 * 所以口径统一为一条规则：**红色只留给面板受管的单元**。
 * 系统单元失败仍然如实显示（透明），但换成中性/黄色，且不计入「待处理」。
 * 受管名单只有 `data/managedUnits.ts` 一份，这里不重复写单元名。
 */
import { isManagedUnit, splitFailedUnits } from '../../data/managedUnits';
import { fmt, zh } from '../../i18n/zh';

export type ServiceTone = 'ok' | 'warn' | 'danger' | 'neutral';

/** 服务行色调：受管失败 → danger；系统自带单元失败 → warn；其余按运行状态。 */
export function serviceRowTone(unit: string, active: string): ServiceTone {
  if (active === 'active') return 'ok';
  if (active !== 'failed') return 'neutral';
  return isManagedUnit(unit) ? 'danger' : 'warn';
}

/**
 * 状态带「服务」瓦片的文案与色调。
 *
 * `null` 表示**读不到**失败单元（旧 Agent 且 `/state` 也没有）：显示「未知」而不是
 * 「正常」—— 把「不知道」说成「没问题」是另一种谎报。
 */
export function servicesTile(failedUnits: readonly string[] | null): {
  value: string;
  tone: ServiceTone;
} {
  if (failedUnits === null) return { value: zh.common.unknown, tone: 'neutral' };
  const { managed, system } = splitFailedUnits(failedUnits);
  if (managed.length > 0) {
    return { value: fmt(zh.hostOps.servicesFailed, { count: String(managed.length) }), tone: 'danger' };
  }
  if (system.length > 0) {
    return {
      value: fmt(zh.hostOps.servicesSystemFailed, { count: String(system.length) }),
      tone: 'neutral',
    };
  }
  return { value: zh.hostOps.servicesOk, tone: 'neutral' };
}
