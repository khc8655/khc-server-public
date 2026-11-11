import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { BackupImportResponse } from '@khc/contracts';
import { ApiError } from '../../data/client';
import { hubAppsQueryOptions, hubQueryOptions } from '../../data/queries';
import {
  backupErrorText,
  fetchNodeBackup,
  importNodeBackup,
  parseBackupFile,
  pickBackupFile,
  type ParsedBackup,
} from '../../data/backup';
import { action, actionLabel } from '../../registry/actions';
import { paths } from '../../registry/routes';
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  Drawer,
  EmptyState,
  InlineError,
  KeyValue,
  PageHeader,
  Row,
  Segmented,
  Stack,
  Table,
  downloadTextFile,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime, formatBytes } from '../../i18n/format';
import { ModeCard } from './ModeCard';
import { AgentCard } from './AgentCard';
import { AccessCard } from './AccessCard';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';

type Segment = 'agent' | 'mode' | 'backup';

/** 导入抽屉内三步 + 结果：选择文件 → 预览 → 确认 → 结果（page-specs §2.6） */
type ImportPhase = 'pick' | 'preview' | 'confirm' | 'done';

interface ImportErrorState {
  message: string;
  details: string | null;
}

function importError(error: unknown): ImportErrorState {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      details:
        error.fields && Object.keys(error.fields).length > 0
          ? JSON.stringify(error.fields, null, 2)
          : null,
    };
  }
  return { message: backupErrorText(error), details: null };
}

/**
 * 节点设置页（ui-redesign T4）：Segmented 四分区
 * Agent 与接入 / 节点模式 / 备份与恢复 / 危险区；导入与删除节点收进唯一抽屉 / L3 确认。
 */
export default function HubSettingsPage() {
  const { hubId } = useParams({ from: '/hubs/$hubId/settings' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const hubQuery = useQuery(hubQueryOptions(hubId));
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const hubName = hubQuery.data?.name ?? hubId;
  const { channels } = useHubChannelsContext();
  const offline = channels.presence === 'offline';

  const existingApps = new Set((appsQuery.data?.apps ?? []).map((item) => item.app));

  const [segment, setSegment] = useState<Segment>('agent');

  /* ------------------------------------------------------------- 导出 */
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExportFile, setLastExportFile] = useState<string | null>(null);

  /* ------------------------------------------------- 导入（抽屉内三步） */
  const [importOpen, setImportOpen] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('pick');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedBackup | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [lastImported, setLastImported] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importErrorState, setImportErrorState] = useState<ImportErrorState | null>(null);
  const [importResult, setImportResult] = useState<BackupImportResponse | null>(null);

  const overwriteCount = preview
    ? preview.apps.filter((item) => existingApps.has(item.app)).length
    : 0;

  const exportBackup = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { backup, filename } = await fetchNodeBackup(hubId);
      downloadTextFile(JSON.stringify(backup, null, 2), filename);
      setLastExportFile(filename);
    } catch (error) {
      setExportError(backupErrorText(error));
    } finally {
      setExporting(false);
    }
  };

  const closeImport = () => {
    setImportOpen(false);
    setPreview(null);
    setDuplicate(false);
    setFileError(null);
    setImportErrorState(null);
    setImportResult(null);
    setPhase('pick');
  };

  const selectFile = async () => {
    setFileError(null);
    let file: File | null;
    try {
      file = await pickBackupFile();
    } catch (error) {
      setFileError(backupErrorText(error));
      return;
    }
    if (!file) return;
    setFileLoading(true);
    try {
      const parsed = await parseBackupFile(file);
      setPreview(parsed);
      setDuplicate(lastImported === parsed.signature);
      setImportResult(null);
      setImportErrorState(null);
      setPhase('preview');
    } catch (error) {
      setPreview(null);
      setDuplicate(false);
      setFileError(backupErrorText(error));
    } finally {
      setFileLoading(false);
    }
  };

  const importBackup = async () => {
    if (!preview) return;
    setImporting(true);
    setImportErrorState(null);
    try {
      const result = await importNodeBackup(hubId, preview.payload);
      setImportResult(result);
      setLastImported(preview.signature);
      setPreview(null);
      setDuplicate(false);
      setPhase('done');
      await queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] });
      toast.show({ message: zh.backup.resultHint });
    } catch (error) {
      setImportErrorState(importError(error));
    } finally {
      setImporting(false);
    }
  };

  const previewColumns: ColumnDef<ParsedBackup['apps'][number]>[] = [
    {
      key: 'app',
      type: 'name',
      header: zh.backup.colApp,
      value: (item) => item.app,
    },
    {
      key: 'schemaVersion',
      type: 'text',
      header: zh.backup.colSchemaVersion,
      value: (item) => String(item.schemaVersion),
    },
    {
      key: 'existing',
      type: 'status',
      header: zh.backup.colExisting,
      status: (item) =>
        existingApps.has(item.app)
          ? { tone: 'warn', label: zh.backup.existing }
          : { tone: 'neutral', label: zh.backup.newApp },
    },
  ];

  const resultColumns: ColumnDef<BackupImportResponse['apps'][number]>[] = [
    {
      key: 'app',
      type: 'name',
      header: zh.backup.colApp,
      value: (item) => item.app,
    },
    {
      key: 'rev',
      type: 'text',
      header: zh.backup.colRev,
      value: (item) => String(item.rev),
    },
    {
      key: 'schemaVersion',
      type: 'text',
      header: zh.backup.colSchemaVersion,
      value: (item) => String(item.schemaVersion),
    },
  ];

  const segmentOptions = [
    { value: 'agent', label: zh.nodeSettings.segmentAgent },
    { value: 'mode', label: zh.nodeSettings.segmentMode },
    { value: 'backup', label: zh.nodeSettings.segmentBackup },
  ];

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.hubSettings}
        scope={hubName}
        summary={zh.nodeSettings.summary}
      />

      <Segmented
        value={segment}
        options={segmentOptions}
        onChange={(value) => setSegment(value as Segment)}
        ariaLabel={zh.nodeSettings.segmentLabel}
      />

      {segment === 'agent' ? (
        <>
          {hubQuery.data ? <AccessCard hub={hubQuery.data} /> : null}
          <AgentCard hubId={hubId} hubName={hubName} lastSeenAt={hubQuery.data?.lastSeenAt ?? null} offline={offline} />
        </>
      ) : null}

      {segment === 'mode' ? (
        <ModeCard hubId={hubId} hubName={hubName} offline={offline} />
      ) : null}

      {segment === 'backup' ? (
        <>
          <Banner tone="info" title={zh.backup.noticeTitle} description={zh.backup.notice} />

          <Card title={zh.backup.exportTitle}>
            <Stack gap={3}>
              <Banner tone="neutral" title={zh.backup.exportDesc} />
              <Row gap={2}>
                <Button
                  label={exporting ? zh.backup.exporting : actionLabel(action('backup.export'))}
                  icon="download"
                  variant="primary"
                  loading={exporting}
                  onClick={() => void exportBackup()}
                />
              </Row>
              {lastExportFile ? (
                <KeyValue
                  items={[
                    {
                      key: zh.backup.exportFilename,
                      value: lastExportFile,
                      mono: true,
                      mode: 'middle',
                    },
                  ]}
                />
              ) : null}
              {exportError ? <InlineError message={exportError} /> : null}
            </Stack>
          </Card>

          <Card title={zh.backup.importTitle}>
            <Stack gap={3}>
              <p className="ui-muted">{zh.backup.importDesc}</p>
              <Row gap={2}>
                <Button
                  label={zh.nodeSettings.importEntry}
                  icon="download"
                  onClick={() => setImportOpen(true)}
                />
              </Row>
            </Stack>
          </Card>
        </>
      ) : null}

      <Drawer
        open={importOpen}
        title={zh.backup.importTitle}
        context={hubName}
        dirty={phase === 'preview' || phase === 'confirm'}
        onClose={closeImport}
        footer={
          phase === 'preview' ? (
            <Row gap={2}>
              <Button label={zh.backup.replaceFile} size="sm" variant="ghost" onClick={() => void selectFile()} />
              <Button
                label={actionLabel(action('backup.import'))}
                icon="download"
                size="sm"
                variant="primary"
                onClick={() => setPhase('confirm')}
              />
            </Row>
          ) : phase === 'confirm' ? (
            <Row gap={2}>
              <Button label={zh.common.cancel} size="sm" variant="ghost" onClick={() => setPhase('preview')} />
              <Button
                label={zh.backup.import}
                icon="download"
                size="sm"
                variant="primary"
                loading={importing}
                disabled={!preview}
                onClick={() => void importBackup()}
              />
            </Row>
          ) : phase === 'done' ? (
            <Row gap={2}>
              <Button label={zh.nodeSettings.done} size="sm" onClick={closeImport} />
            </Row>
          ) : null
        }
      >
        {phase === 'pick' ? (
          <Stack gap={3}>
            <Banner tone="neutral" title={zh.backup.importDesc} description={zh.backup.importNotice} />
            {fileError ? <InlineError message={fileError} /> : null}
            <EmptyState
              icon="download"
              title={zh.backup.previewEmpty}
              description={zh.backup.previewEmptyHint}
              action={
                <Button
                  label={fileLoading ? zh.backup.parsing : zh.backup.chooseFile}
                  icon="plus"
                  loading={fileLoading}
                  onClick={() => void selectFile()}
                />
              }
            />
          </Stack>
        ) : null}

        {phase === 'preview' && preview ? (
          <Stack gap={3}>
            <KeyValue
              items={[
                { key: zh.backup.fileLabel, value: preview.fileName, mono: true, mode: 'middle' },
                { key: zh.backup.fileSize, value: formatBytes(preview.size) },
                { key: zh.backup.previewNode, value: preview.nodeName, mono: true },
                { key: zh.backup.previewExportedAt, value: formatAbsoluteTime(preview.exportedAt) },
              ]}
            />
            {duplicate ? (
              <Banner tone="warn" title={zh.backup.duplicateTitle} description={zh.backup.duplicateDesc} />
            ) : null}
            {overwriteCount > 0 ? (
              <Banner
                tone="warn"
                title={fmt(zh.backup.overwriteTitle, { count: String(overwriteCount) })}
                description={zh.backup.overwriteDesc}
              />
            ) : null}
            <Table
              rows={preview.apps}
              columns={previewColumns}
              rowKey={(item) => item.app}
              objectLabel={zh.backup.previewTitle}
              empty={{ icon: 'box', title: zh.backup.previewEmpty }}
            />
          </Stack>
        ) : null}

        {phase === 'confirm' ? (
          <Stack gap={3}>
            <Banner
              tone="warn"
              title={zh.backup.importConfirmTitle}
              description={
                duplicate
                  ? `${zh.backup.importConfirmBody}${zh.backup.duplicateDesc}`
                  : zh.backup.importConfirmBody
              }
            />
            {overwriteCount > 0 ? (
              <Banner
                tone="warn"
                title={fmt(zh.backup.overwriteTitle, { count: String(overwriteCount) })}
                description={zh.backup.overwriteDesc}
              />
            ) : null}
            {importErrorState ? (
              <Stack gap={2}>
                <InlineError message={importErrorState.message} />
                {importErrorState.details ? (
                  <CodeBlock code={importErrorState.details} label={zh.backup.importFailed} />
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        ) : null}

        {phase === 'done' && importResult ? (
          <Stack gap={3}>
            <Banner tone="info" title={zh.backup.resultHint} />
            <Table
              rows={importResult.apps}
              columns={resultColumns}
              rowKey={(item) => item.app}
              objectLabel={zh.backup.resultTitle}
              empty={{ icon: 'box', title: zh.backup.resultTitle }}
              onRowOpen={(item) => void navigate({ href: paths.hubApp(hubId, item.app) })}
            />
          </Stack>
        ) : null}
      </Drawer>
    </Stack>
  );
}
