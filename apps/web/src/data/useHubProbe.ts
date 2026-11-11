/**
 * 节点探测（概览页与节点列表页共用）。
 *
 * 设计目标（2026-11-07 主人反馈："打开页面就应该探测，不想再看到『未探测』"）：
 *
 * 1. **挂载即探测**：两个页面都自动探测，不再出现"打开列表页什么都不探测"的分裂行为；
 * 2. **一次请求覆盖全部节点**：走 `POST /nodes/probe` 批量接口，而不是按节点 fan-out；
 * 3. **只有三种用户可见状态**：探测中 / 在线 / 离线。
 *    - 从未探测、租约过期、以及"探测还没返回"一律呈现为「探测中…」，不再是「未探测」；
 *    - 探测请求整体失败（控制面/网络问题）时才落到「未知」，并在页面顶部给错误横幅；
 * 4. **15 秒内复用结果**：概览 ↔ 列表来回切换不会重复打请求；
 * 5. **离线才复核**：探测出不可达节点时按 60s/120s/240s 最多自动再探 3 次，
 *    全部在线或手动刷新即停；不做常驻轮询。
 *
 * 后端 `status: unknown`（从未探测或租约过期）仍保留在数据层——它是事实，
 * 只是不再直接暴露给用户；是否有结论由本次探测决定。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node, NodeProbeApp, NodeProbeResponse } from '@khc/contracts';
import { fmt, zh } from '../i18n/zh';
import { probeHubs } from './hubs';
import { hubsQueryOptions } from './queries';

/** 探测阶段：进行中 / 已拿到结论 / 请求本身失败 */
export type HubProbePhase = 'probing' | 'done' | 'failed';

/** 结果复用窗口：避免概览与列表来回切换时重复探测 */
const PROBE_TTL_MS = 15_000;
const PROBE_CACHE_KEY = ['hub-probe'] as const;

/**
 * 离线节点的有节制自动复核：60s → 120s → 240s，最多 3 次。
 * 节点真失联时只在这几个时间点打请求，不做常驻轮询；恢复或手动刷新即停。
 */
export const PROBE_RETRY_DELAYS_MS = [60_000, 120_000, 240_000] as const;

/** 第 attempt 次自动复核前的等待时长；undefined 表示不再复核。 */
export function nextProbeRetryDelay(attempt: number): number | null {
  return PROBE_RETRY_DELAYS_MS[attempt] ?? null;
}

interface ProbeCache {
  result: NodeProbeResponse;
  at: number;
}

/** 列表行 = 节点 + 本次探测是否有结论 */
export interface HubView extends Node {
  /** true 表示本次探测已给出结论；false 表示仍在探测或探测失败 */
  probed: boolean;
  /** 本次探测拿到的适配器实装/运行状态（/state 投影）；不可达或未上报时缺失 */
  apps?: NodeProbeApp[];
}

export interface HubStatusView {
  tone: 'ok' | 'danger' | 'neutral';
  label: string;
}

/**
 * 离线节点已失联天数：以最后一次成功探测（lastSeenAt）为基准。
 * - 在线 / 未探测 / 从未成功上线过 → null；
 * - 只对"本次探测确认不可达"的节点计算，避免把未知或过期租约当成失联。
 */
export function hubOutageDays(hub: HubView, nowMs = Date.now()): number | null {
  if (!hub.probed || hub.status !== 'offline' || !hub.lastSeenAt) return null;
  return Math.floor(Math.max(0, nowMs - hub.lastSeenAt * 1000) / 86_400_000);
}

/** 失联标记：≥1 天 →「已失联 N 天」；不足 1 天或从未上线 → null（仍显示「离线」）。 */
export function hubOutageLabel(hub: HubView, nowMs = Date.now()): string | null {
  if (!hub.probed || hub.status !== 'offline') return null;
  const days = hubOutageDays(hub, nowMs);
  return days !== null && days >= 1 ? fmt(zh.status.staleDays, { days }) : null;
}

/**
 * 状态徽标口径（唯一来源）：只有 在线 / 离线 / 探测中 / 未知 四种。
 *
 * 关键：**不信任列表里的租约状态**。`/nodes` 的 status 是"最近一次成功探测是否新鲜"，
 * 节点刚被停掉时它仍然是 online（租约窗口内），若据此显示"在线"就是假在线
 * （2026-11-07 实测：Agent 已 stop，列表仍显示"在线 · 43 秒前"）。
 * 因此是否有结论只看**本次探测**：没结论 → 探测中…；探测整体失败 → 未知。
 */
export function hubStatusView(
  hub: HubView,
  phase: HubProbePhase,
  nowMs = Date.now(),
): HubStatusView {
  if (!hub.probed) {
    // 探测已有结论但本轮没有该节点（例如刚创建、列表尚未重新探测）时，
    // 显示「未知」而不是永久「探测中…」；下次 probe 会补上结论。
    return phase === 'failed' || phase === 'done'
      ? { tone: 'neutral', label: zh.status.unknown }
      : { tone: 'neutral', label: zh.status.probing };
  }
  if (hub.status === 'online') return { tone: 'ok', label: zh.status.online };
  const outage = hubOutageLabel(hub, nowMs);
  return { tone: 'danger', label: outage ? `${zh.status.offline} · ${outage}` : zh.status.offline };
}

/** 把探测结论同步进 ['hubs'] 列表与 ['hubs', id] 详情缓存 */
function syncHubCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  result: NodeProbeResponse,
): void {
  const apply = <T extends { status: Node['status']; lastSeenAt: number | null }>(item: T): T => {
    const hit = result.nodes.find((candidate) => candidate.id === (item as { id?: string }).id);
    if (!hit) return item;
    return {
      ...item,
      status: hit.reachable ? 'online' : 'offline',
      lastSeenAt: hit.lastSeenAt ?? (hit.reachable ? result.probedAt : item.lastSeenAt),
    };
  };
  queryClient.setQueryData<Node[] | undefined>(['hubs'], (old) => old?.map(apply));
  for (const item of result.nodes) {
    queryClient.setQueryData<Node | undefined>(['hubs', item.id], (old) =>
      old ? apply(old) : old,
    );
  }
}

export function useHubProbe() {
  const queryClient = useQueryClient();
  const hubsQuery = useQuery(hubsQueryOptions());

  const [result, setResult] = useState<NodeProbeResponse | null>(null);
  const [phase, setPhase] = useState<HubProbePhase>('probing');
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunAt = useRef(0);
  // 供自动复核调用，避免 runProbe ↔ scheduleRetry 的循环依赖
  const runProbeRef = useRef<(force: boolean) => Promise<void>>(async () => {});

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!mounted.current) return;
    clearRetry();
    const delay = nextProbeRetryDelay(retryAttempt.current);
    if (delay === null) return; // 3 次自动复核后停手，等主人手动刷新或重新打开页面
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      retryAttempt.current += 1;
      void runProbeRef.current(true);
    }, delay);
  }, [clearRetry]);

  const runProbe = useCallback(
    async (force: boolean) => {
      if (running.current) return;
      const cached = queryClient.getQueryData<ProbeCache>(PROBE_CACHE_KEY);
      if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) {
        setResult(cached.result);
        setPhase('done');
        setError(null);
        if (cached.result.nodes.some((node) => !node.reachable)) scheduleRetry();
        return;
      }
      running.current = true;
      setPhase('probing');
      setError(null);
      try {
        const fresh = await probeHubs();
        queryClient.setQueryData<ProbeCache>(PROBE_CACHE_KEY, { result: fresh, at: Date.now() });
        setResult(fresh);
        setPhase('done');
        syncHubCaches(queryClient, fresh);
        lastRunAt.current = Date.now();
        if (fresh.nodes.some((node) => !node.reachable)) {
          scheduleRetry();
        } else {
          retryAttempt.current = 0;
          clearRetry();
        }
      } catch (caught) {
        // 探测请求整体失败（控制面/网络问题）不是节点离线，交给顶部错误横幅与手动刷新。
        setError(caught instanceof Error ? caught.message : zh.overview.probeFailedHint);
        setPhase('failed');
      } finally {
        running.current = false;
      }
    },
    [queryClient, scheduleRetry, clearRetry],
  );
  runProbeRef.current = runProbe;

  // 手动/首次探测：重置自动复核计数，避免与用户操作叠加。
  const probe = useCallback(
    async (options?: { force?: boolean }) => {
      clearRetry();
      retryAttempt.current = 0;
      await runProbe(options?.force ?? false);
    },
    [clearRetry, runProbe],
  );

  // mounted 必须先于 probe 注册：StrictMode 重挂载时保证探测结果不会被丢弃。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearRetry();
    };
  }, [clearRetry]);

  // 打开页面即探测一次；不轮询（轮询只在节点详情页的观测层做）。
  useEffect(() => {
    void probe();
  }, [probe]);

  // 长时间停在后台后回到页面：距上次探测超过 60 秒就补一次，避免一直显示旧结论。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRunAt.current < 60_000) return;
      void probe();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [probe]);

  const hubs = useMemo<HubView[]>(() => {
    const list = hubsQuery.data ?? [];
    const byId = new Map((result?.nodes ?? []).map((item) => [item.id, item]));
    return list.map((node) => {
      const hit = byId.get(node.id);
      // 没有本次探测结论时，**丢弃列表里的租约 status**（可能已过期，导致假在线），
      // 统一置为 unknown，由 hubStatusView 呈现"探测中…"。
      if (!hit) return { ...node, status: 'unknown' as const, probed: false };
      return {
        ...node,
        status: hit.reachable ? ('online' as const) : ('offline' as const),
        lastSeenAt: hit.lastSeenAt ?? (hit.reachable ? result!.probedAt : node.lastSeenAt),
        probed: true,
        apps: hit.apps,
      };
    });
  }, [hubsQuery.data, result]);

  const counts = useMemo(() => {
    const online = hubs.filter((hub) => hub.status === 'online').length;
    const offline = hubs.filter((hub) => hub.status === 'offline').length;
    return { online, offline, total: hubs.length };
  }, [hubs]);

  // 列表里出现本轮 probe 没覆盖的节点（最常见：刚创建节点、列表先刷新）时补一次探测，
  // 否则新节点会一直停在「探测中…」直到主人手动点刷新。
  const hasUnprobed = useMemo(() => {
    if (!result || !hubsQuery.data) return false;
    const known = new Set(result.nodes.map((node) => node.id));
    return hubsQuery.data.some((node) => !known.has(node.id));
  }, [hubsQuery.data, result]);

  useEffect(() => {
    if (!hasUnprobed) return;
    void probe({ force: true });
  }, [hasUnprobed, probe]);

  return {
    hubs,
    hubsQuery,
    phase,
    error,
    probe,
    counts,
    probedAt: result?.probedAt ?? null,
  };
}
