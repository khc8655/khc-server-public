/**
 * 设置 → 应用管理 → 导入应用（页面级抽屉，抽屉内不弹 Dialog）。
 *
 * 三种来源：粘贴 JSON / 上传文件 / 从 https URL（浏览器端 fetch，不经 Worker）。
 * 先在前端用契约解析并展示与 D1 当前版本的差异，确认后 POST（新 ID）或 PUT（已存在）。
 * 审计沿用 Worker 现有 appManifest.create / update。
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MANIFEST_V2_MIN_AGENT, requiredAgentFeatures, toManifestV2, type AppManifest } from '@khc/contracts';
import { ApiError } from '../../data/client';
import { createAppManifest, updateAppManifest } from '../../data/appManifests';
import {
  ImportFetchError,
  MAX_IMPORT_BYTES,
  diffManifests,
  fetchImportUrl,
  findExisting,
  importText,
  parseImportText,
  utf8Bytes,
  type DiffItem,
  type FetchLike,
  type ImportIssue,
  type ParseImportResult,
} from './appImport';
import {
  Badge,
  Banner,
  Button,
  Drawer,
  Field,
  InlineError,
  Row,
  Segmented,
  Stack,
  TextInput,
  Textarea,
  useToast,
} from '../../ui';

type Source = 'paste' | 'file' | 'url';
type Stage = 'input' | 'review' | 'done';
type ParsedOk = Extract<ParseImportResult, { ok: true }>;

const SOURCE_OPTIONS = [
  { value: 'paste', label: '粘贴 JSON' },
  { value: 'file', label: '上传文件' },
  { value: 'url', label: '从 URL' },
];

function issuesFromApiError(error: unknown): { message: string; issues: ImportIssue[] } {
  if (error instanceof ApiError) {
    const issues = Object.entries(error.fields ?? {}).map(([path, message]) => ({ path, message }));
    return { message: error.message || '保存失败', issues };
  }
  return { message: error instanceof Error && error.message ? error.message : '保存失败', issues: [] };
}

function IssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <Stack gap={1}>
      {issues.map((issue) => (
        <div key={`${issue.path}:${issue.message}`} className="ui-text-caption">
          <span className="ui-text-mono">{issue.path}</span>：{issue.message}
        </div>
      ))}
    </Stack>
  );
}

function DiffRow({ item, prefix }: { item: DiffItem; prefix: 'diff' | 'summary' }) {
  return (
    <div className="ui-row-between" data-testid={`${prefix}-${item.key}`}>
      <span>{item.label}</span>
      <Row gap={2} align="center" wrap>
        <span className="ui-text-mono">{item.before}</span>
        <span aria-hidden="true">→</span>
        <span className="ui-text-mono">{item.after}</span>
        {item.tone === 'neutral' ? null : (
          <Badge tone={item.tone} label={item.tone === 'danger' ? '高风险' : '变化'} />
        )}
      </Row>
    </div>
  );
}

export function ImportAppDrawer({
  rows,
  onClose,
  fetchImpl,
}: {
  rows: AppManifest[];
  onClose: () => void;
  /** 测试注入；默认用浏览器 fetch */
  fetchImpl?: FetchLike;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [source, setSource] = useState<Source>('paste');
  const [stage, setStage] = useState<Stage>('input');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [idInput, setIdInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [parsed, setParsed] = useState<ParsedOk | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const existing = useMemo(() => (parsed ? findExisting(rows, parsed.id) : null), [parsed, rows]);
  const diff = useMemo(
    () => (parsed ? diffManifests(existing?.manifest, parsed.manifest) : null),
    [parsed, existing],
  );
  const dangerChanges = diff?.changes.filter((item) => item.tone === 'danger') ?? [];
  const minAgent = useMemo(() => {
    // v1 清单在旧 Agent 上照常工作；只有 v2 才要求节点支持 schema 2
    if (!parsed || !('schema' in parsed.manifest) || parsed.manifest.schema !== 2) return null;
    return requiredAgentFeatures(toManifestV2(parsed.manifest)).length > 0 ? MANIFEST_V2_MIN_AGENT : null;
  }, [parsed]);

  const fail = (message: string, list: ImportIssue[] = []) => {
    setError(message);
    setIssues(list);
  };

  const check = (raw: string) => {
    const result = parseImportText(raw, idInput);
    if (!result.ok) {
      fail(result.error, result.issues);
      return;
    }
    setError(null);
    setIssues([]);
    setParsed(result);
    setStage('review');
  };

  const onFile = async (file: File | undefined) => {
    setError(null);
    setIssues([]);
    setText('');
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      fail(importText.tooLarge);
      return;
    }
    try {
      const content = await file.text();
      if (utf8Bytes(content) > MAX_IMPORT_BYTES) {
        fail(importText.tooLarge);
        return;
      }
      setText(content);
    } catch {
      fail('文件读取失败');
    }
  };

  const runCheck = async () => {
    setError(null);
    setIssues([]);
    if (source === 'url') {
      try {
        const body = await fetchImportUrl(url, fetchImpl);
        setText(body);
        check(body);
      } catch (e) {
        fail(e instanceof ImportFetchError ? e.message : '拉取失败');
      }
      return;
    }
    if (!text.trim()) {
      fail(source === 'file' ? '请先选择 .json 文件' : '请粘贴清单 JSON');
      return;
    }
    check(text);
  };

  const confirm = async () => {
    if (!parsed) return;
    setError(null);
    setIssues([]);
    try {
      const res = existing
        ? await updateAppManifest(parsed.id, {
            manifest: parsed.manifest,
            ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
          })
        : await createAppManifest({
            id: parsed.id,
            manifest: parsed.manifest,
            enabled: parsed.enabled ?? true,
          });
      await queryClient.invalidateQueries({ queryKey: ['appManifests'] });
      const list = res.warnings ?? [];
      toast.show({ message: existing ? '应用已更新' : '应用已导入' });
      if (list.length > 0) {
        setWarnings(list);
        setStage('done');
      } else {
        onClose();
      }
    } catch (e) {
      const mapped = issuesFromApiError(e);
      fail(mapped.message, mapped.issues);
    }
  };

  const footer =
    stage === 'input' ? (
      <Row>
        <Button
          label={source === 'url' ? '拉取并检查' : '检查'}
          variant="primary"
          onClick={() => runCheck()}
        />
        <Button label="取消" onClick={onClose} />
      </Row>
    ) : stage === 'review' ? (
      <Row>
        <Button
          label={existing ? '确认更新' : '确认导入'}
          variant={dangerChanges.length > 0 ? 'danger' : 'primary'}
          onClick={() => confirm()}
        />
        <Button
          label="返回修改"
          onClick={() => {
            setStage('input');
            setError(null);
            setIssues([]);
          }}
        />
        <Button label="取消" onClick={onClose} />
      </Row>
    ) : (
      <Row>
        <Button label="完成" variant="primary" onClick={onClose} />
      </Row>
    );

  return (
    <Drawer open title="导入应用" onClose={onClose} footer={footer}>
      <Stack gap={4}>
        {stage === 'input' ? (
          <>
            <Segmented
              value={source}
              ariaLabel="导入来源"
              options={SOURCE_OPTIONS}
              onChange={(value) => {
                setSource(value as Source);
                setError(null);
                setIssues([]);
              }}
            />
            {source === 'paste' ? (
              <Field
                id="import-text"
                label="清单 JSON"
                help="仓库格式 {id, enabled, manifest}，或裸清单（需填写应用 ID）；≤ 512KB"
              >
                <Textarea
                  id="import-text"
                  value={text}
                  rows={14}
                  mono
                  invalid={Boolean(error)}
                  onChange={(value) => {
                    setText(value);
                    setError(null);
                    setIssues([]);
                  }}
                />
              </Field>
            ) : null}
            {source === 'file' ? (
              <Field id="import-file" label="清单文件" help="选择 .json 文件，≤ 512KB">
                <input
                  id="import-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => void onFile(event.target.files?.[0])}
                />
                {fileName ? <span className="ui-text-caption">{fileName}</span> : null}
              </Field>
            ) : null}
            {source === 'url' ? (
              <Field
                id="import-url"
                label="清单地址"
                help="只允许 https://，由浏览器直接读取，不经过面板服务；对方需允许跨域读取（如仓库 raw 地址）"
              >
                <TextInput
                  id="import-url"
                  mono
                  value={url}
                  placeholder="https://raw.githubusercontent.com/…/manifest.json"
                  onChange={(value) => {
                    setUrl(value);
                    setError(null);
                  }}
                />
              </Field>
            ) : null}
            <Field
              id="import-id"
              label="应用 ID"
              optional
              help="仓库格式已含 ID 时可留空；裸清单必须填写。小写 slug，创建后不可修改"
            >
              <TextInput id="import-id" value={idInput} placeholder="my-app" onChange={setIdInput} />
            </Field>
          </>
        ) : null}

        {stage === 'review' && parsed && diff ? (
          <Stack gap={3}>
            <Banner
              tone={existing ? 'warn' : 'info'}
              title={
                existing
                  ? `应用 ${parsed.id} 已存在，确认后将覆盖当前定义`
                  : `将新增应用 ${parsed.id}`
              }
              description={
                existing && !existing.manifest
                  ? '当前记录格式异常，导入后将被替换。'
                  : existing && diff.changes.length === 0
                    ? '与当前版本没有差异。'
                    : undefined
              }
            />
            {dangerChanges.map((item) => (
              <Banner
                key={item.key}
                tone="danger"
                title="运行方式提升为 root"
                description={`${item.before} → ${item.after}：脚本将以 root 身份执行，请确认来源可信。`}
              />
            ))}
            {minAgent ? (
              <span className="ui-text-caption">需要节点 Agent ≥ {minAgent}（低版本节点安装时会返回 409）。</span>
            ) : null}
            {diff.changes.length > 0 ? (
              <Stack gap={2}>
                <span className="ui-text-caption">变化</span>
                {diff.changes.map((item) => (
                  <DiffRow key={item.key} item={item} prefix="diff" />
                ))}
              </Stack>
            ) : null}
            <Stack gap={2}>
              <span className="ui-text-caption">{diff.isNew ? '即将写入' : '概览（当前 → 导入）'}</span>
              {diff.summary.map((item) => (
                <DiffRow key={item.key} item={item} prefix="summary" />
              ))}
            </Stack>
          </Stack>
        ) : null}

        {stage === 'done' ? (
          <Banner tone="warn" title="保存提醒" description={warnings.join('；')} />
        ) : null}

        {error ? <InlineError message={error} /> : null}
        <IssueList issues={issues} />
      </Stack>
    </Drawer>
  );
}
