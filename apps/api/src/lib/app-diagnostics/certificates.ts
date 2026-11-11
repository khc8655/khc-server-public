/**
 * 应用侧诊断来源：全局证书库（D1）→ 适配器问题形状。
 *
 * 证书是控制面数据（D1 `certificates`），Agent 看不到，所以由 Worker 把“哪个
 * 证书快到期了”翻译成与适配器 `status().problems` 相同的通用结构，再交给
 * `lib/diagnostics/evaluate.ts` 统一渲染。核心诊断不引用应用名。
 */
import type { AdapterProblem, Certificate } from '@khc/contracts';

export interface CertRefConfig {
  app: string;
  config?: Record<string, unknown>;
}

const DAY = 86_400;

/** 证书是否与本节点相关：本节点签发，或被某个应用配置的 `$cert` 引用。 */
export function isCertificateRelevant(
  nodeId: string,
  configs: CertRefConfig[],
  cert: Pick<Certificate, 'id' | 'sourceNodeId'>,
): boolean {
  if (cert.sourceNodeId && cert.sourceNodeId === nodeId) return true;
  if (!cert.id) return false;
  return configs.some((config) => {
    if (!config.config) return false;
    const text = JSON.stringify(config.config);
    return text.includes(`"$cert":"${cert.id}"`) || text.includes(`"$cert": "${cert.id}"`);
  });
}

export function selectRelevantCertificates(
  nodeId: string,
  configs: CertRefConfig[],
  certs: Certificate[],
): Certificate[] {
  return certs.filter((cert) => isCertificateRelevant(nodeId, configs, cert));
}

/**
 * 只报最近到期的一张证书（一行一个问题，避免诊断页刷屏）。
 * ≤3 天/已过期为 error，≤14 天 warn，≤30 天 info。
 */
export function certificateProblems(certs: Certificate[], now: number): AdapterProblem[] {
  const dated = certs.filter(
    (cert): cert is Certificate & { notAfter: number } =>
      typeof cert.notAfter === 'number' && Number.isFinite(cert.notAfter),
  );
  if (dated.length === 0) return [];
  const soonest = dated.reduce((min, cert) => (cert.notAfter < min.notAfter ? cert : min));
  const domain = soonest.domains[0] ?? soonest.name ?? '证书';
  const daysLeft = Math.ceil((soonest.notAfter - now) / DAY);
  if (daysLeft > 30) return [];
  const expired = soonest.notAfter <= now;
  const severity = expired || daysLeft <= 3 ? 'error' : daysLeft <= 14 ? 'warn' : 'info';
  return [
    {
      code: 'expiring',
      severity,
      title: expired ? '证书已过期' : `证书 ${daysLeft} 天后到期`,
      hint: expired
        ? `${domain} 的证书已过期，站点 HTTPS 会失败；请重新签发。`
        : `${domain} 的证书将在 ${daysLeft} 天后到期，请尽快续期。`,
      evidence: {
        domain,
        daysLeft,
        issuer: soonest.issuer ?? null,
        notAfter: soonest.notAfter,
      },
    },
  ];
}
