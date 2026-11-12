import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { hubQueryOptions } from '../data/queries';
import { matchHubPath, sectionTitleKey, type HubSection } from '../registry/routes';
import { Banner, Card, EmptyState, PageHeader, Stack } from '../ui';
import { zh, fmt } from '../i18n/zh';
import type { IconName } from '../ui/icons';

const sectionIcon: Record<HubSection, IconName> = {
  services: 'activity',
  wireguard: 'users',
  ops: 'activity',
  sites: 'globe',
  settings: 'settings',
};

/** 节点层占位页：只提供外壳、作用域与空状态，功能在后续变更单接入。 */
export function HubSectionPlaceholder({ section }: { section: HubSection }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const match = matchHubPath(pathname);
  const hubId = match?.hubId ?? '';
  const hubQuery = useQuery(hubQueryOptions(hubId));
  const title = zh.nav[sectionTitleKey[section]];

  return (
    <Stack gap={4}>
      <PageHeader
        title={title}
        scope={hubQuery.data?.name ?? hubId}
        summary={zh.hub.summary}
      />
      <Banner tone="info" title={zh.placeholder.hint} />
      <Card>
        <EmptyState
          icon={sectionIcon[section]}
          title={title}
          description={fmt(zh.placeholder.body, { page: title })}
        />
      </Card>
    </Stack>
  );
}
