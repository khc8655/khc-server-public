/**
 * 应用侧诊断来源：全局证书库（D1）→ 适配器问题形状。
 *
 * 证书是控制面数据（D1 `certificates`），Agent 看不到，所以由 Worker 把“哪个
 * 证书快到期了”翻译成与适配器 `status().problems` 相同的通用结构，再交给
 * `lib/diagnostics/evaluate.ts` 统一渲染。核心诊断不引用应用名。
 */
import type { AdapterProblem, AgentState, Certificate } from '@khc/contracts';

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

const ACME_INSTALL_HINT =
  '节点未安装 acme.sh。只有使用证书库 ACME 签发/续期时才需要；安装命令：' +
  'curl https://get.acme.sh | sh -s email=<你的邮箱>（需 root 与出站 443）。';

/**
 * acme.sh 缺失的告警口径：本节点存在 ACME 证书时保持 error（续期会失败）；
 * 没有 ACME 证书时降为 info 提示，不参与「诊断未通过」计数，避免误报。
 */
export function adjustAcmeProblems(state: AgentState | null, hasAcmeCertificate: boolean): AgentState | null {
  if (!state || hasAcmeCertificate) return state;
  return {
    ...state,
    adapters: state.adapters.map((adapter) => {
      const status = adapter.status;
      if (adapter.name !== 'certificates' || !status || !Array.isArray(status.problems)) return adapter;
      return {
        ...adapter,
        status: {
          ...status,
          problems: status.problems.map((item) => {
            const problem = item as AdapterProblem | null;
            if (!problem || problem.code !== 'acme_failed') return item;
            if (problem.evidence?.reason !== 'env_missing') return item;
            return {
              ...problem,
              severity: 'info' as const,
              title: 'ACME 环境未安装（可选）',
              hint: ACME_INSTALL_HINT,
            };
          }),
        },
      };
    }),
  };
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
