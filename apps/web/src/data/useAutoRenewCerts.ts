/**
 * 按需证书自动续期 Hook（零 Cron）：
 * 仅在打开首页/节点列表并收到 probe 返回的临期证书列表时触发；
 * 同一会话内按证书 ID 去重，避免重复调用 POST /api/v1/certs/:id/renew。
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExpiringCertSummary } from '@khc/contracts';
import { renewCertificate } from './certs';
import { useToast } from '../ui';
import { fmt, zh } from '../i18n/zh';

const attemptedCertIds = new Set<string>();

export function resetAutoRenewAttemptedForTests(): void {
  attemptedCertIds.clear();
}

export function useAutoRenewCerts(expiringCerts?: readonly ExpiringCertSummary[]): void {
  const queryClient = useQueryClient();
  const toast = useToast();
  const runningRef = useRef(false);

  useEffect(() => {
    if (!expiringCerts || expiringCerts.length === 0 || runningRef.current) return;
    const due = expiringCerts.filter(
      (cert) =>
        cert.daysLeft <= 15 &&
        cert.renewable === true &&
        cert.autoSync === true &&
        !attemptedCertIds.has(cert.id),
    );
    if (due.length === 0) return;

    runningRef.current = true;
    for (const cert of due) {
      attemptedCertIds.add(cert.id);
    }

    let cancelled = false;
    void (async () => {
      try {
        for (const cert of due) {
          if (cancelled) break;
          try {
            const res = await renewCertificate(cert.id);
            const syncedCount = (res.syncResults ?? []).filter(
              (item) => item.status === 'synced',
            ).length;
            toast.show({
              message:
                syncedCount > 0
                  ? fmt(zh.certs.autoRenewSynced, { name: cert.name, count: syncedCount })
                  : fmt(zh.certs.autoRenewSuccess, { name: cert.name }),
            });
          } catch (error) {
            toast.show({
              message: fmt(zh.certs.autoRenewFailed, {
                name: cert.name,
                error: error instanceof Error ? error.message : zh.certs.renewFailed,
              }),
            });
          }
        }
        if (!cancelled) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['certs'] }),
            queryClient.invalidateQueries({ queryKey: ['hubs'] }),
          ]);
        }
      } finally {
        runningRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expiringCerts, queryClient, toast]);
}
