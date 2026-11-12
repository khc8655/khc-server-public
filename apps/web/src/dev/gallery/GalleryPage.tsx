import { useState, type ReactNode } from 'react';
import {
  Badge,
  Banner,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  CommandPalette,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FilterChip,
  Grid,
  InlineError,
  KeyValue,
  Link,
  LogViewer,
  MenuButton,
  NumberInput,
  PageHeader,
  PortInput,
  Row,
  ScopeChip,
  SearchInput,
  SecretField,
  Segmented,
  Select,
  Sidebar,
  Skeleton,
  Spinner,
  Stack,
  Stat,
  StatusDot,
  Stepper,
  Steps,
  SyncStatus,
  Table,
  Tabs,
  Tag,
  Textarea,
  TextInput,
  Toast,
  Toggle,
  Topbar,
  Truncate,
  type ColumnDef,
  type LogLine,
  type SidebarHub,
  type SidebarNavItem,
  type StepperItem,
  type StepItem,
} from '../../ui';
import { action } from '../../registry/actions';
import { zh } from '../../i18n/zh';
import { useTheme } from '../../app/theme';

interface SampleRow {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'unknown';
  endpoint: string;
  domain: string;
  count: number;
  lastSeen: number;
}

const SAMPLE_ROWS: SampleRow[] = [
  {
    id: 'tyo-1',
    name: 'office-router-backup-hongkong-01',
    status: 'online',
    endpoint: 'https://203.0.113.10:8880',
    domain: 'very-long-subdomain-for-frontend.console.example.dev',
    count: 12,
    lastSeen: Math.floor(Date.now() / 1000) - 42,
  },
  {
    id: 'fra-1',
    name: 'fra-1',
    status: 'offline',
    endpoint: 'https://198.51.100.24:8880',
    domain: 'fra-1.example.dev',
    count: 3,
    lastSeen: Math.floor(Date.now() / 1000) - 7200,
  },
  {
    id: 'hk-1',
    name: 'hk-1',
    status: 'unknown',
    endpoint: 'https://hk-1.example.dev',
    domain: 'hk-1.example.dev',
    count: 0,
    lastSeen: Math.floor(Date.now() / 1000) - 86400 * 40,
  },
];

const SAMPLE_LOGS: LogLine[] = [
  { time: '21:58:01', level: 'info', text: '开始应用配置 rev 42' },
  { time: '21:58:02', level: 'info', text: '写入 /etc/sing-box/config.json' },
  { time: '21:58:02', level: 'warn', text: '端口 51820/udp 已被占用，改用 51821/udp' },
  { time: '21:58:03', level: 'ok', text: '服务已重启，健康检查通过' },
  { time: '21:58:04', level: 'error', text: '示例错误：节点回执超时' },
];

const SAMPLE_STEPS: StepItem[] = [
  { label: '写入配置', state: 'done', duration: '0.2 秒' },
  { label: '校验配置', state: 'done', duration: '0.1 秒' },
  { label: '重启服务', state: 'running' },
  { label: '健康检查', state: 'todo' },
  { label: '上报状态', state: 'failed', duration: '超时' },
];

const SAMPLE_STEPPER: StepperItem[] = [
  { label: '基本信息', state: 'done' },
  { label: '安装 Agent', state: 'current' },
  { label: '初始化网络', state: 'todo' },
  { label: '完成', state: 'todo' },
];

const HUB_NAV: SidebarNavItem[] = [
  { key: 'hubOverview', label: zh.nav.hubOverview, href: '#', icon: 'home', active: true },
  { key: 'wireguard', label: zh.nav.wireguard, href: '#', icon: 'users', count: 12, active: false },
  { key: 'sites', label: zh.nav.sites, href: '#', icon: 'globe', active: false },
  { key: 'forwards', label: zh.nav.forwards, href: '#', icon: 'arrow', active: false },
  { key: 'certs', label: zh.nav.certs, href: '#', icon: 'lock', active: false },
  { key: 'apps', label: zh.nav.apps, href: '#', icon: 'box', count: 2, active: false },
];

const GLOBAL_NAV: SidebarNavItem[] = [
  { key: 'overview', label: zh.nav.overview, href: '#', icon: 'home', active: true },
  { key: 'hubs', label: zh.nav.hubs, href: '#', icon: 'server', active: false },
  { key: 'settings', label: zh.nav.settings, href: '#', icon: 'settings', active: false },
];

const SAMPLE_HUBS: SidebarHub[] = [
  { id: 'tyo-1', name: 'tyo-1', status: 'online' },
  { id: 'fra-1', name: 'fra-1', status: 'offline' },
  { id: 'hk-1', name: 'hk-1', status: 'unknown' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-section">
      <h2 className="gallery-section-title">{title}</h2>
      {children}
    </section>
  );
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gallery-frame">
      <p className="gallery-label">{label}</p>
      {children}
    </div>
  );
}

export default function GalleryPage() {
  const theme = useTheme();
  const [tab, setTab] = useState('config');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmL2, setConfirmL2] = useState(false);
  const [confirmL3, setConfirmL3] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [name, setName] = useState('office-router');
  const [port, setPort] = useState<number | null>(51820);
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('udp');
  const [count, setCount] = useState<number | null>(3);
  const [select, setSelect] = useState('auto');
  const [segment, setSegment] = useState('phone');
  const [toggle, setToggle] = useState(true);
  const [checked, setChecked] = useState(true);
  const [json, setJson] = useState('{\n  "listen": "0.0.0.0",\n  "port": 51820\n}');
  const [search, setSearch] = useState('');
  const [filterOn, setFilterOn] = useState(true);

  const columns: ColumnDef<SampleRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.hubs.colName,
      value: (row) => row.name,
      dot: (row) => (row.status === 'online' ? 'ok' : 'neutral'),
    },
    {
      key: 'status',
      type: 'status',
      header: zh.hubs.colStatus,
      status: (row) => ({
        tone: row.status === 'online' ? 'ok' : 'neutral',
        label: zh.status[row.status],
      }),
    },
    { key: 'endpoint', type: 'mono', header: zh.fields.endpoint, value: (row) => row.endpoint },
    { key: 'domain', type: 'mono', header: zh.nav.sites, value: (row) => row.domain },
    { key: 'count', type: 'number', header: zh.nav.wireguard, value: (row) => row.count },
    { key: 'lastSeen', type: 'time', header: zh.hubs.colLastSeen, value: (row) => row.lastSeen },
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <div className="gallery">
      <div className="gallery-toolbar">
        <div className="gallery-heading">
          <h1 className="gallery-title">{zh.gallery.title}</h1>
          <p className="gallery-sub">{zh.gallery.subtitle}</p>
        </div>
        <Segmented
          value={theme.mode}
          ariaLabel={zh.gallery.theme}
          options={[
            { value: 'light', label: zh.common.themeLight },
            { value: 'dark', label: zh.common.themeDark },
            { value: 'system', label: zh.common.themeSystem },
          ]}
          onChange={(value) => theme.setMode(value as 'light' | 'dark' | 'system')}
        />
        <Link to="/" label={zh.errors.backHome} />
      </div>

      <Section title={zh.gallery.sections.type}>
        <div className="gallery-grid">
          <Frame label="文字层级">
            <Stack gap={2}>
              <span className="gallery-title">20 / 600 页面标题</span>
              <span className="gallery-sub">13 / 400 说明文字</span>
              <span className="t2">14 / 400 正文与表格单元格</span>
              <span className="t3 xs">12 / 400 元信息与表头</span>
              <span className="mono">10.8.0.12:51820/udp</span>
            </Stack>
          </Frame>
          <Frame label="颜色令牌">
            <div className="gallery-grid">
              {[
                ['bg', 'bg'],
                ['surface', 'surface'],
                ['surface-2', 'surface2'],
                ['border', 'border'],
                ['text', 'text'],
                ['accent', 'accent'],
                ['ok', 'ok'],
                ['warn', 'warn'],
                ['danger', 'danger'],
              ].map(([label, cls]) => (
                <span className="gallery-swatch" key={cls}>
                  <span className={`gallery-chip gallery-chip-${cls}`} />
                  {label}
                </span>
              ))}
            </div>
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.buttons}>
        <div className="gallery-grid">
          <Frame label="变体">
            <Row gap={2} wrap>
              <Button label={zh.actions['hub.create']} variant="primary" icon="plus" onClick={() => undefined} />
              <Button label={zh.common.save} onClick={() => undefined} />
              <Button label={zh.common.copy} variant="ghost" onClick={() => undefined} />
              <Button label={zh.common.delete} variant="danger" onClick={() => undefined} />
              <Button label={zh.common.delete} variant="danger-text" onClick={() => undefined} />
              <Button label={zh.common.more} variant="ghost" icon="more" iconOnly onClick={() => undefined} />
            </Row>
          </Frame>
          <Frame label="尺寸与状态">
            <Row gap={2} wrap>
              <Button label={zh.common.save} size="sm" onClick={() => undefined} />
              <Button label={zh.common.save} size="md" onClick={() => undefined} />
              <Button label={zh.common.loading} loading onClick={() => undefined} />
              <Button label={zh.common.save} disabled disabledReason={zh.common.noChanges} onClick={() => undefined} />
              <Button label={zh.common.retry} icon="refresh" onClick={() => undefined} />
              <Button label={zh.common.next} icon="arrow" variant="primary" onClick={() => undefined} />
            </Row>
          </Frame>
          <Frame label="动作注册表">
            <Stack gap={2}>
              {(['hub.create', 'hub.delete', 'app.apply', 'app.uninstall', 'app.rollback'] as const).map((id) => (
                <Row gap={2} key={id}>
                  <Button label={zh.actions[id]} size="sm" onClick={() => undefined} />
                  <span className="t3 xs">{id}</span>
                </Row>
              ))}
            </Stack>
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.status}>
        <div className="gallery-grid">
          <Frame label="Badge">
            <Row gap={2} wrap>
              <Badge tone="ok" label={zh.status.online} dot />
              <Badge tone="warn" label={zh.status.queued} dot />
              <Badge tone="danger" label={zh.status.failed} dot />
              <Badge tone="info" label={zh.status.pending} dot />
              <Badge tone="neutral" label={zh.status.offline} dot />
              <Tag label="WireGuard" />
              <Tag label="原创" />
            </Row>
          </Frame>
          <Frame label="StatusDot">
            <Row gap={3} wrap>
              {(['ok', 'warn', 'danger', 'info', 'neutral'] as const).map((tone) => (
                <Row gap={1} key={tone}>
                  <StatusDot tone={tone} />
                  <span className="t3 xs">{tone}</span>
                </Row>
              ))}
              <Row gap={1}>
                <StatusDot tone="info" pulse />
                <span className="t3 xs">pulse</span>
              </Row>
            </Row>
          </Frame>
          <Frame label="SyncStatus">
            <Stack gap={2}>
              <SyncStatus state="synced" />
              <SyncStatus state="pending" rev={42} />
              <SyncStatus state="queued" offlineHint={zh.hub.offlineBanner} />
              <SyncStatus state="failed" onRetry={() => undefined} />
            </Stack>
          </Frame>
          <Frame label="ScopeChip 与 Truncate">
            <Stack gap={2}>
              <ScopeChip name="tyo-1" />
              <span className="gallery-sub">
                <Truncate text={zh.gallery.longName} />
              </span>
              <span className="gallery-sub">
                <Truncate text={zh.gallery.longDomain} mode="middle" />
              </span>
              <span className="mono">10.8.0.12</span>
            </Stack>
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.surfaces}>
        <div className="gallery-grid">
          <Frame label="Stat">
            <Grid cols={2} gap={3}>
              <Stat label={zh.overview.statHubs} value="3" unit="个" icon="server" hint="全部在线" />
              <Stat label={zh.overview.statApps} value="12" unit="个" icon="box" hint="2 个待下发" />
            </Grid>
          </Frame>
          <Frame label="Card / KeyValue">
            <Card
              title={zh.hub.infoTitle}
              action={<Link to="/" label={zh.overview.viewAll} />}
            >
              <KeyValue
                items={[
                  { key: zh.fields.endpoint, value: 'https://203.0.113.10:8880', mono: true, copyValue: 'https://203.0.113.10:8880' },
                  { key: zh.fields.preferredRoute, value: zh.hubs.routeDirect },
                  { key: zh.fields.lastSeen, value: '42 秒前' },
                ]}
              />
            </Card>
          </Frame>
          <Frame label="PageHeader">
            <PageHeader
              title="tyo-1"
              scope="tyo-1"
              summary={zh.hub.summary}
              sync={{ state: 'pending', rev: 42 }}
              primaryAction={action('app.apply')}
              secondaryActions={[action('app.plan')]}
              moreActions={[action('app.install'), action('app.uninstall')]}
              onAction={() => undefined}
            />
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.table}>
        <Stack gap={4}>
          <Table
            rows={SAMPLE_ROWS}
            columns={columns}
            rowKey={(row) => row.id}
            objectLabel={zh.nav.hubs}
            search={{ value: search, onChange: setSearch, placeholder: zh.hubs.searchPlaceholder }}
            filters={[
              {
                key: 'online',
                label: zh.status.online,
                active: filterOn,
                onClick: () => setFilterOn((prev) => !prev),
              },
            ]}
            rowActions={() => [action('hub.open'), action('hub.delete')]}
            onRowAction={() => undefined}
            onRowOpen={() => undefined}
            empty={{ icon: 'server', title: zh.hubs.emptyTitle, description: zh.hubs.emptyHint }}
          />
          <Grid cols={2} gap={4}>
            <Card>
              <EmptyState
                icon="server"
                title={zh.hubs.emptyTitle}
                description={zh.hubs.emptyHint}
                action={<Button label={zh.actions['hub.create']} variant="primary" icon="plus" onClick={() => undefined} />}
              />
            </Card>
            <Card>
              <Stack gap={2}>
                <Skeleton height={10} width="60%" />
                <Skeleton height={10} />
                <Skeleton height={10} width="80%" />
                <Row gap={2}>
                  <Spinner />
                  <span className="t3 xs">{zh.common.loading}</span>
                </Row>
              </Stack>
            </Card>
          </Grid>
        </Stack>
      </Section>

      <Section title={zh.gallery.sections.tabs}>
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: 'config', label: zh.apps.tabsConfig },
            { key: 'changes', label: zh.apps.tabsChanges, count: 2 },
            { key: 'task', label: zh.apps.tabsTask, count: 1 },
            { key: 'history', label: zh.apps.tabsHistory, count: 12 },
          ]}
        />
      </Section>

      <Section title={zh.gallery.sections.forms}>
        <div className="gallery-grid">
          <Frame label="TextInput">
            <Stack gap={3}>
              <Field id="g-name" label={zh.fields.name} help={zh.help.hubName}>
                <TextInput id="g-name" value={name} onChange={setName} />
              </Field>
              <Field id="g-mono" label={zh.fields.endpoint}>
                <TextInput id="g-mono" value="https://203.0.113.10:8880" mono onChange={() => undefined} />
              </Field>
              <Field id="g-invalid" label={zh.fields.name} error={zh.form.invalid}>
                <TextInput id="g-invalid" value="bad name" invalid onChange={() => undefined} />
              </Field>
              <Field id="g-ro" label={zh.fields.version}>
                <TextInput id="g-ro" value="1.8.2" readOnly onChange={() => undefined} />
              </Field>
              <Field id="g-disabled" label={zh.fields.name}>
                <TextInput
                  id="g-disabled"
                  value="disabled"
                  disabled
                  disabledReason={zh.common.noChanges}
                  onChange={() => undefined}
                />
              </Field>
            </Stack>
          </Frame>
          <Frame label="数值与端口">
            <Stack gap={3}>
              <Field id="g-number" label={zh.fields.ports}>
                <NumberInput id="g-number" value={count} min={1} max={10} onChange={setCount} suffix="个" />
              </Field>
              <Field id="g-port" label={zh.fields.ports}>
                <PortInput
                  id="g-port"
                  value={port}
                  protocol={protocol}
                  onChange={setPort}
                  onProtocolChange={setProtocol}
                />
              </Field>
              <Field id="g-select" label={zh.fields.route}>
                <Select
                  id="g-select"
                  value={select}
                  options={[
                    { value: 'auto', label: zh.common.auto },
                    { value: 'direct', label: zh.hubs.routeDirect },
                    { value: 'tunnel', label: zh.hubs.routeTunnel },
                  ]}
                  onChange={setSelect}
                />
              </Field>
              <Field id="g-seg" label={zh.nav.wireguard}>
                <Segmented
                  value={segment}
                  ariaLabel={zh.nav.wireguard}
                  options={[
                    { value: 'phone', label: '手机' },
                    { value: 'pc', label: '电脑' },
                    { value: 'site', label: '站点' },
                  ]}
                  onChange={setSegment}
                />
              </Field>
            </Stack>
          </Frame>
          <Frame label="开关与多选">
            <Stack gap={3}>
              <Field id="g-toggle" label={zh.fields.status} variant="row" help={zh.hub.offlineBanner}>
                <Toggle checked={toggle} onChange={setToggle} label={zh.fields.status} />
              </Field>
              <Checkbox
                checked={checked}
                onChange={setChecked}
                label={zh.common.yes}
                description={zh.common.no}
              />
              <Field id="g-textarea" label={zh.fields.note}>
                <Textarea id="g-textarea" value={json} rows={4} mono onChange={setJson} />
              </Field>
              <Row gap={2}>
                <SearchInput value={search} onChange={setSearch} placeholder={zh.hubs.searchPlaceholder} />
                <FilterChip label={zh.status.online} active={filterOn} onClick={() => setFilterOn((prev) => !prev)} />
              </Row>
              <InlineError message={zh.apps.jsonInvalid} />
            </Stack>
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.secrets}>
        <div className="gallery-grid">
          <Frame label="SecretField stored">
            <SecretField
              kind="stored"
              id="g-secret"
              label={zh.fields.note}
              maskedValue="••••3f9a"
              onReplace={() => undefined}
            />
          </Frame>
          <Frame label="SecretField once">
            <SecretField kind="once" text="wg-config-example-content" onDownload={() => undefined} />
          </Frame>
          <Frame label="SecretField agent">
            <SecretField kind="agent" nodeName="hk-1" publicKey="Zq3x…Lm8A" />
          </Frame>
          <Frame label="CodeBlock">
            <CodeBlock code={'listen: 0.0.0.0\nport: 51820\nprotocol: udp'} label="/etc/sing-box/config.json" />
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.overlays}>
        <div className="gallery-grid">
          <Frame label="浮层触发">
            <Row gap={2} wrap>
              <Button label={zh.actions['hub.create']} onClick={() => setDrawerOpen(true)} />
              <Button label={zh.common.more} onClick={() => setDialogOpen(true)} />
              <Button label={zh.apps.rollbackConfirm} onClick={() => setConfirmL2(true)} />
              <Button label={zh.common.delete} variant="danger-text" onClick={() => setConfirmL3(true)} />
              <Button label={zh.common.search} onClick={() => setPaletteOpen(true)} />
            </Row>
          </Frame>
          <Frame label="Menu">
            <MenuButton
              label={zh.common.more}
              iconOnly={false}
              items={[
                { id: 'open', label: zh.nav.overview, icon: 'home' },
                { id: 'refresh', label: zh.common.refresh, icon: 'refresh' },
                { id: 'delete', label: zh.common.delete, danger: true, disabled: true, disabledReason: zh.common.noChanges },
              ]}
              onSelect={() => undefined}
            />
          </Frame>
          <Frame label="Toast">
            <Toast message={zh.toast.configSaved} actionLabel={zh.common.retry} onAction={() => undefined} />
          </Frame>
        </div>
      </Section>

      <Section title={zh.gallery.sections.feedback}>
        <Stack gap={3}>
          <Banner tone="info" title={zh.placeholder.hint} />
          <Banner tone="warn" title={zh.apps.dirty} description={zh.apps.saveNote} />
          <Banner
            tone="danger"
            title={zh.hubs.loadError}
            description={zh.errors.loadHint}
            action={<Button label={zh.common.retry} size="sm" onClick={() => undefined} />}
          />
          <Banner tone="neutral" title={zh.hub.offlineBanner} />
          <Grid cols={2} gap={4}>
            <Card>
              <EmptyState
                icon="check"
                title={zh.overview.attentionEmpty}
                description={zh.overview.attentionEmptyHint}
              />
            </Card>
            <Card>
              <Stack gap={2}>
                <InlineError message={zh.hubs.missingFields} />
                <Skeleton height={10} />
                <Skeleton height={10} width="70%" />
              </Stack>
            </Card>
          </Grid>
        </Stack>
      </Section>

      <Section title={zh.gallery.sections.data}>
        <Grid cols={2} gap={4}>
          <LogViewer lines={SAMPLE_LOGS} title={zh.gallery.sections.data} />
          <Stack gap={4}>
            <Steps items={SAMPLE_STEPS} />
            <Stepper items={SAMPLE_STEPPER} />
          </Stack>
        </Grid>
      </Section>

      <Section title={zh.gallery.sections.shell}>
        <Stack gap={4}>
          <div className="gallery-shell">
            <Sidebar
              variant="hub"
              brand={zh.app.name}
              nav={HUB_NAV}
              secondaryNav={[
                { key: 'settings', label: zh.nav.hubSettings, href: '#', icon: 'settings', active: false },
              ]}
              hubs={SAMPLE_HUBS}
              activeHub={SAMPLE_HUBS[0] ?? null}
              hubsHref="#"
              allHubsLabel={zh.nav.allHubs.replace('{count}', '3')}
              backLabel={zh.nav.backToHubs}
              groupLabel={zh.nav.groupHubs}
              footerLabel={zh.app.controlPlaneConnected}
              footerTone="ok"
              onSelectHub={() => undefined}
              mobileOpen={false}
              onCloseMobile={() => undefined}
            />
            <div className="ui-main">
              <Topbar
                crumbs={[
                  { label: zh.nav.hubs, href: '#' },
                  { label: 'tyo-1', href: '#' },
                  { label: zh.nav.wireguard },
                ]}
                onOpenPalette={() => setPaletteOpen(true)}
                theme={theme.mode}
                onThemeChange={theme.setMode}
                userName="admin"
                onLogout={() => undefined}
                onOpenMenu={() => undefined}
                taskEntry={
                  <span className="ui-task-pill">
                    <StatusDot tone="info" pulse />
                    1 个任务运行中
                  </span>
                }
              />
              <div className="ui-content">
                <Breadcrumb
                  items={[
                    { label: zh.nav.hubs, href: '#' },
                    { label: 'tyo-1', href: '#' },
                    { label: zh.nav.wireguard },
                  ]}
                />
              </div>
            </div>
          </div>
          <div className="gallery-shell">
            <Sidebar
              variant="global"
              brand={zh.app.name}
              nav={GLOBAL_NAV}
              hubs={SAMPLE_HUBS}
              activeHub={null}
              hubsHref="#"
              allHubsLabel={zh.nav.allHubs.replace('{count}', '3')}
              backLabel={zh.nav.backToHubs}
              groupLabel={zh.nav.groupHubs}
              footerLabel={zh.app.controlPlaneOffline}
              footerTone="neutral"
              onSelectHub={() => undefined}
              mobileOpen={false}
              onCloseMobile={() => undefined}
            />
            <div className="ui-main">
              <Topbar
                crumbs={[{ label: zh.nav.overview }]}
                onOpenPalette={() => setPaletteOpen(true)}
                theme={theme.mode}
                onThemeChange={theme.setMode}
                userName="admin"
                onLogout={() => undefined}
                onOpenMenu={() => undefined}
              />
            </div>
          </div>
        </Stack>
      </Section>

      <Section title={zh.gallery.sections.layout}>
        <Grid cols={2} gap={4}>
          <Card title="Stack / Row">
            <Stack gap={2}>
              <Row gap={2}>
                <Badge tone="ok" label={zh.status.online} dot />
                <Tag label="tag" />
                <Link to="/" label={zh.nav.overview} />
              </Row>
              <Row gap={2} wrap>
                <Button label={zh.common.save} size="sm" onClick={() => undefined} />
                <Button label={zh.common.cancel} size="sm" onClick={() => undefined} />
              </Row>
            </Stack>
          </Card>
          <Card title="Breadcrumb">
            <Breadcrumb
              items={[
                { label: zh.nav.hubs, href: '#' },
                { label: 'tyo-1', href: '#' },
                { label: zh.nav.apps, href: '#' },
                { label: 'node-exporter' },
              ]}
            />
          </Card>
        </Grid>
      </Section>

      <Drawer
        open={drawerOpen}
        title={zh.hubs.createTitle}
        context={zh.hubs.createContext}
        dirty
        onClose={() => setDrawerOpen(false)}
        footer={
          <Row gap={2}>
            <Button label={zh.common.cancel} onClick={() => setDrawerOpen(false)} />
            <Button label={zh.hubs.add} variant="primary" onClick={() => setDrawerOpen(false)} />
          </Row>
        }
      >
        <Stack gap={4}>
          <Field id="drawer-name" label={zh.fields.name} help={zh.help.hubName}>
            <TextInput id="drawer-name" value={name} onChange={setName} />
          </Field>
          <Field id="drawer-endpoint" label={zh.fields.endpoint} help={zh.help.hubEndpoint}>
            <TextInput id="drawer-endpoint" value="https://203.0.113.10:8880" mono onChange={() => undefined} />
          </Field>
          <Banner tone="info" title={zh.hubs.createNote} />
        </Stack>
      </Drawer>

      <Dialog
        open={dialogOpen}
        title={zh.hub.infoTitle}
        onClose={() => setDialogOpen(false)}
        footer={<Button label={zh.common.close} onClick={() => setDialogOpen(false)} />}
      >
        <p className="gallery-sub">{zh.placeholder.hint}</p>
      </Dialog>

      <ConfirmDialog
        open={confirmL2}
        level="L2"
        title={zh.apps.rollbackTitle.replace('{rev}', '41')}
        body={zh.apps.rollbackBody}
        confirmLabel={zh.apps.rollbackConfirm}
        confirmTone="primary"
        onCancel={() => setConfirmL2(false)}
        onConfirm={async () => setConfirmL2(false)}
      />

      <ConfirmDialog
        open={confirmL3}
        level="L3"
        title={zh.apps.uninstallTitle.replace('{app}', 'node-exporter')}
        body={zh.apps.uninstallBody}
        confirmLabel={zh.apps.uninstallConfirm}
        confirmName="node-exporter"
        nameLabel={zh.apps.uninstallNameLabel.replace('{app}', 'node-exporter')}
        onCancel={() => setConfirmL3(false)}
        onConfirm={async () => setConfirmL3(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={() => setPaletteOpen(false)}
        groups={[
          {
            title: zh.nav.hubs,
            items: SAMPLE_HUBS.map((hub) => ({ id: hub.id, label: hub.name, scope: zh.nav.hubs, icon: 'server' as const })),
          },
          {
            title: zh.nav.overview,
            items: [
              { id: 'overview', label: zh.nav.overview, icon: 'home' as const },
              { id: 'hubs', label: zh.nav.hubs, icon: 'server' as const },
              { id: 'settings', label: zh.nav.settings, icon: 'settings' as const },
            ],
          },
        ]}
      />
    </div>
  );
}
