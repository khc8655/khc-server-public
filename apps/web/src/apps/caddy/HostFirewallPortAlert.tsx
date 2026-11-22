import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  callHostOps,
  callHostOpsTask,
  isHostOpsAbortError,
  normalizeFirewallShow,
  normalizeFirewallToken,
  normalizeVersion,
  type HostOpsFirewallShow,
} from '../../data/hostOps';
import { paths } from '../../registry/routes';
import { Banner, Button, InlineError, Link, Stack, useOptionalToast } from '../../ui';
import { fmt, zh } from '../../i18n/zh';

/** 判断防火墙端口规范字符串（单端口或 start-end，支持逗号分隔）是否命中目标端口。 */
export function portMatchesSpec(spec: string, targetPort: number): boolean {
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const rangeMatch = /^(\d{1,5})-(\d{1,5})$/.exec(part);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (targetPort >= start && targetPort <= end) return true;
      continue;
    }
    if (/^\d{1,5}$/.test(part) && Number(part) === targetPort) return true;
  }
  return false;
}

function isTcpProto(proto: string): boolean {
  const value = proto.trim().toLowerCase();
  return (
    value === '' ||
    value === 'tcp' ||
    value === 'tcp/udp' ||
    value === 'both' ||
    value === 'any' ||
    value === 'all'
  );
}

function isPublicSource(source: string): boolean {
  const value = source.trim().toLowerCase();
  return value === '' || value === '0.0.0.0/0' || value === '::/0' || value === '*' || value === 'any';
}

/** 判定当前主机防火墙是否已对公网放行目标 TCP 端口；空白未托管规则视作未拦截。 */
export function isTcpPortAllowedByFirewall(show: HostOpsFirewallShow, port: number): boolean {
  if (show.rules.length === 0 && show.autoRules.length === 0) return true;
  for (const rule of show.rules) {
    if (rule.action !== 'allow') continue;
    if (!isTcpProto(rule.proto) || !isPublicSource(rule.source)) continue;
    if (portMatchesSpec(rule.port, port)) return true;
  }
  for (const rule of show.autoRules) {
    if (!isTcpProto(rule.proto)) continue;
    if (portMatchesSpec(rule.port, port)) return true;
  }
  return false;
}

/** 构造在现有防火墙规则末尾追加一条公网 TCP 放行的 `fw.apply` 载荷。 */
export function buildAppendTcpAllowPayload(
  show: HostOpsFirewallShow,
  port: number,
  note: string,
) {
  return {
    rules: [
      ...show.rules.map((rule) => ({
        id: rule.id,
        action: rule.action,
        proto: rule.proto,
        port: rule.port.trim(),
        source: rule.source.trim(),
        note: rule.note.trim(),
      })),
      {
        id: `caddy-allow-tcp-${port}`,
        action: 'allow' as const,
        proto: 'tcp',
        port: String(port),
        source: '0.0.0.0/0',
        note: note.trim() || fmt(zh.sites.fwRuleNote, { port: String(port) }),
      },
    ],
    baseRev: show.baseRev,
  };
}

export function HostFirewallPortAlert({
  hubId,
  port,
  enabled,
  appLabel,
}: {
  hubId: string;
  port: number | null;
  enabled: boolean;
  appLabel?: string;
}) {
  const queryClient = useQueryClient();
  const toast = useOptionalToast();
  const [allowing, setAllowing] = useState(false);
  const [allowErrorState, setAllowErrorState] = useState<{ port: number; message: string } | null>(
    null,
  );
  const [justAllowedPort, setJustAllowedPort] = useState<number | null>(null);
  const applyAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      applyAbort.current?.abort();
    },
    [],
  );

  const validPort = port !== null && Number.isInteger(port) && port >= 1 && port <= 65535;
  const queryKey = ['hubs', hubId, 'host-ops', 'fw-show'] as const;

  const fwQuery = useQuery({
    queryKey,
    enabled: Boolean(enabled && hubId && validPort),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const [versionRes, showRes] = await Promise.all([
        callHostOps(hubId, 'self', 'version'),
        callHostOps(hubId, 'self', 'fw.show', {}),
      ]);
      if (!showRes.ok) {
        return { supported: false as const, readOnly: false, show: null };
      }
      const version = versionRes.ok ? normalizeVersion(versionRes.data) : null;
      return {
        supported: true as const,
        readOnly: version?.root === false,
        show: normalizeFirewallShow(showRes.data),
      };
    },
  });

  if (!enabled || !validPort || !fwQuery.data?.supported || !fwQuery.data.show) {
    return null;
  }

  const show = fwQuery.data.show;
  const targetPort = port;
  const allowError = allowErrorState?.port === targetPort ? allowErrorState.message : null;

  if (isTcpPortAllowedByFirewall(show, targetPort)) {
    if (justAllowedPort === targetPort) {
      return (
        <Banner
          tone="ok"
          title={fmt(zh.sites.fwPortAllowedOk, { port: String(targetPort) })}
        />
      );
    }
    return null;
  }

  if (show.pending?.token) {
    return (
      <Banner
        tone="warn"
        title={fmt(zh.sites.fwPendingTitle, { port: String(targetPort) })}
        description={zh.sites.fwPendingDesc}
        action={<Link to={paths.hubSection(hubId, 'ops')} label={zh.sites.fwGoToOps} />}
      />
    );
  }

  if (fwQuery.data.readOnly) {
    return (
      <Banner
        tone="warn"
        title={fmt(zh.sites.fwPortBlockedTitle, { port: String(targetPort) })}
        description={zh.sites.fwReadOnlyDesc}
        action={<Link to={paths.hubSection(hubId, 'ops')} label={zh.sites.fwGoToOps} />}
      />
    );
  }

  const handleAllowPort = async () => {
    setAllowing(true);
    setAllowErrorState(null);
    const controller = new AbortController();
    applyAbort.current = controller;
    try {
      const note = appLabel?.trim()
        ? `${appLabel.trim()} :${targetPort}`
        : fmt(zh.sites.fwRuleNote, { port: String(targetPort) });
      const applyRes = await callHostOpsTask(
        hubId,
        'self',
        'fw.apply',
        buildAppendTcpAllowPayload(show, targetPort, note),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!applyRes.ok) {
        setAllowErrorState({
          port: targetPort,
          message: applyRes.error?.message || zh.sites.fwAllowFailed,
        });
        return;
      }
      const token = normalizeFirewallToken(applyRes.data);
      if (!token) {
        setAllowErrorState({ port: targetPort, message: zh.sites.fwAllowFailed });
        return;
      }
      const confirmRes = await callHostOps(hubId, 'self', 'fw.confirm', { token });
      if (controller.signal.aborted) return;
      if (!confirmRes.ok) {
        setAllowErrorState({
          port: targetPort,
          message: confirmRes.error?.message || zh.sites.fwAllowFailed,
        });
        return;
      }
      setJustAllowedPort(targetPort);
      await queryClient.invalidateQueries({ queryKey });
      toast?.show({
        message: fmt(zh.sites.fwPortAllowedToast, { port: String(targetPort) }),
      });
    } catch (error) {
      if (!isHostOpsAbortError(error)) {
        setAllowErrorState({
          port: targetPort,
          message: error instanceof Error && error.message ? error.message : zh.sites.fwAllowFailed,
        });
      }
    } finally {
      if (applyAbort.current === controller) applyAbort.current = null;
      if (!controller.signal.aborted) setAllowing(false);
    }
  };

  return (
    <Stack gap={2}>
      <Banner
        tone="warn"
        title={fmt(zh.sites.fwPortBlockedTitle, { port: String(targetPort) })}
        description={zh.sites.fwPortBlockedDesc}
        action={
          <Button
            label={fmt(zh.sites.fwAllowPortAction, { port: String(targetPort) })}
            size="sm"
            variant="primary"
            loading={allowing}
            onClick={() => void handleAllowPort()}
          />
        }
      />
      {allowError ? <InlineError message={allowError} /> : null}
    </Stack>
  );
}
