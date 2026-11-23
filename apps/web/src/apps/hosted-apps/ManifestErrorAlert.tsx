/** 应用清单操作结构化错误展示（安装向导与已装应用抽屉共用）。 */
import { manifestErrorView } from '../../data/manifestApps';
import { paths } from '../../registry/routes';
import { Badge, Banner, Link, LogViewer, Row, Stack } from '../../ui';

export function ManifestErrorAlert({
  error,
  hubId,
  manifestId,
}: {
  error: unknown;
  hubId: string;
  manifestId?: string;
  onNavigate?: () => void;
}) {
  const view = manifestErrorView(error);

  const actionLink =
    view.actionKind === 'upgrade-agent' ? (
      <Link to={paths.hubSection(hubId, 'settings')} label="去升级 Agent" />
    ) : view.actionKind === 'config-secrets' ? (
      <Link
        to={`${paths.settings}?tab=manifests${manifestId ? `&manifest=${encodeURIComponent(manifestId)}` : ''}`}
        label="去配置凭据"
      />
    ) : view.actionKind === 'switch-channel' ? (
      <Link to={paths.hubSection(hubId, 'settings')} label="改为域名或 Tunnel 接入" />
    ) : undefined;

  return (
    <Stack gap={2}>
      <Banner
        tone="danger"
        title={view.title}
        description={view.detail}
        action={actionLink}
      />
      {view.checks && view.checks.length > 0 ? (
        <Stack gap={1}>
          {view.checks.map((item) => (
            <Row key={`${item.name}-${item.message}`} gap={2} align="center">
              <Badge tone={item.ok ? 'ok' : 'danger'} label={item.ok ? '通过' : '未通过'} />
              <span className="ui-text-caption">{item.message}</span>
            </Row>
          ))}
        </Stack>
      ) : null}
      {view.logs ? (
        <LogViewer
          lines={view.logs.split('\n').map((text) => ({ text }))}
          title="单元日志"
          autoscroll={false}
        />
      ) : null}
    </Stack>
  );
}
