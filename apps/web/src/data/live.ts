import { useEffect, useRef, useState } from 'react';
import { liveTicketResponseSchema } from '@khc/contracts';
import { apiRequest } from './client';

export type LiveStatus = 'disabled' | 'connecting' | 'live' | 'fallback';

export interface LiveSnapshot {
  state: Record<string, unknown>;
  receivedAt: number;
}

export interface LiveObservation {
  status: LiveStatus;
  snapshot: LiveSnapshot | null;
  error: string | null;
  /** 手动重连（静默断链的自动重连失败后使用；不做周期重试）。 */
  reconnect: () => void;
}

/** SSE 静默超过该时长视为断链：Agent 每 10s 至少推一帧（keepalive 25s）。 */
export const LIVE_STALE_MS = 60_000;

/** 已连接但长时间没有新帧 = 链路已断（例如中间设备回收空闲连接）。 */
export function isLiveStreamStale(
  lastFrameAt: number | null,
  now: number,
  staleMs: number = LIVE_STALE_MS,
): boolean {
  return lastFrameAt !== null && now - lastFrameAt > staleMs;
}

/** 把节点观测入口 + livePath + 一次性 ticket 规范化为 SSE URL。 */
export function buildLiveSseUrl(endpoint: string, livePath: string, ticket: string): string {
  const url = new URL(endpoint);
  url.pathname = livePath;
  url.search = `ticket=${encodeURIComponent(ticket)}`;
  url.hash = '';
  return url.toString();
}

export async function fetchLiveTicket(
  hubId: string,
  origin: string,
): Promise<{ ticket: string; livePath: string; expiresAt: number }> {
  const body = await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}/live-ticket`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'live', origin }),
  });
  return liveTicketResponseSchema.parse(body);
}

/**
 * 页面可见时保持一条只读观测 SSE 连接；隐藏即断开，恢复后重新取票。
 * 静默断链（60s 无新帧）会自动用新票重连一次；重连失败进入「未连接」，
 * 由用户点击「重新连接」（避免在浏览器无法直连时不断消耗 Worker 票据）。
 * 票据一次性：EventSource 断开后不自动重连（旧票必失效）。
 */
export function useLiveHub(hubId: string, liveEndpoint: string | null | undefined): LiveObservation {
  const [status, setStatus] = useState<LiveStatus>('disabled');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);
  const statusRef = useRef<LiveStatus>('disabled');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!liveEndpoint) {
      setStatus('disabled');
      return;
    }
    let disposed = false;
    let source: EventSource | null = null;
    let lastFrameAt = Date.now();

    const closeSource = () => {
      if (source) {
        source.close();
        source = null;
      }
    };

    const connect = async () => {
      if (disposed || document.hidden) return;
      closeSource();
      setStatus('connecting');
      setError(null);
      try {
        const ticket = await fetchLiveTicket(hubId, window.location.origin);
        if (disposed) return;
        const es = new EventSource(buildLiveSseUrl(liveEndpoint, ticket.livePath, ticket.ticket));
        source = es;
        es.addEventListener('hello', () => {
          if (!disposed) {
            lastFrameAt = Date.now();
            setStatus('live');
          }
        });
        es.addEventListener('state', (event) => {
          if (disposed) return;
          lastFrameAt = Date.now();
          try {
            const message = JSON.parse((event as MessageEvent<string>).data) as {
              state?: Record<string, unknown>;
            };
            if (message.state) {
              setStatus('live');
              setError(null);
              setSnapshot({ state: message.state, receivedAt: Date.now() });
            }
          } catch {
            // 忽略无法解析的事件，等待下一条状态
          }
        });
        // Agent 端自定义错误事件（带 JSON data）；原生网络错误没有 data。
        // 两种情况都收敛为：关闭连接 → 未连接，等待用户手动重连。
        es.addEventListener('error', (event) => {
          if (disposed) return;
          const data = (event as MessageEvent<string>).data;
          if (typeof data === 'string') {
            try {
              setError((JSON.parse(data) as { code?: string }).code ?? 'error');
            } catch {
              setError('error');
            }
          }
          closeSource();
          setStatus('fallback');
        });
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('fallback');
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        closeSource();
        setStatus('fallback');
      } else {
        void connect();
      }
    };

    void connect();
    document.addEventListener('visibilitychange', onVisibility);
    // D-07：SSE 可能被中间设备静默回收（不触发 error），表现为「已连接但不再更新」。
    // 静默超过 LIVE_STALE_MS 时用新票重连；重连失败会停在 fallback，等用户手动重连。
    const watchdog = window.setInterval(() => {
      if (disposed || document.hidden || statusRef.current !== 'live') return;
      if (!isLiveStreamStale(lastFrameAt, Date.now())) return;
      closeSource();
      setStatus('connecting');
      setError(null);
      void connect();
    }, 15_000);
    return () => {
      disposed = true;
      closeSource();
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hubId, liveEndpoint, reconnectTick]);

  return {
    status,
    snapshot,
    error,
    reconnect: () => setReconnectTick((value) => value + 1),
  };
}
