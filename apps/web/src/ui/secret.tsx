import { useEffect, useState, type ReactNode } from 'react';

import { Button, Icon, Truncate } from './primitives';
import { zh } from '../i18n/zh';

/* ------------------------------------------------------------- SecretField */

export interface SecretStoredProps {
  kind: 'stored';
  id: string;
  label: string;
  /** 已设置时的掩码，如 ••••3f9a；未设置时为 null */
  maskedValue: string | null;
  editing?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  onReplace?: () => void;
  onCancelEdit?: () => void;
}

export interface SecretOnceProps {
  kind: 'once';
  text: string;
  onDownload?: () => void;
  qrSlot?: ReactNode;
}

export interface SecretAgentProps {
  kind: 'agent';
  nodeName: string;
  publicKey: string;
  onCopy?: (value: string) => void;
}

export type SecretFieldProps = SecretStoredProps | SecretOnceProps | SecretAgentProps;

/** 机密字段三种形态（ui-spec §4.19）：永不在界面回显明文（只显示一次的内容除外）。 */
export function SecretField(props: SecretFieldProps) {
  if (props.kind === 'stored') {
    if (props.editing) {
      return (
        <div className="ui-secret-wrap">
          <input
            id={props.id}
            className="ui-input"
            type="password"
            value={props.value ?? ''}
            autoComplete="new-password"
            aria-label={props.label}
            onChange={(event) => props.onChange?.(event.target.value)}
          />
          <div className="ui-secret-actions">
            <Button
              label={zh.secret.cancelReplace}
              variant="ghost"
              size="sm"
              onClick={() => props.onCancelEdit?.()}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="ui-secret">
        <Icon name="key" size={14} />
        <span className="ui-secret-value">
          {props.maskedValue
            ? `${zh.secret.storedSet} · ${props.maskedValue}`
            : zh.secret.storedSet}
        </span>
        <span className="ui-secret-actions">
          <Button
            label={zh.secret.replace}
            variant="ghost"
            size="sm"
            onClick={() => props.onReplace?.()}
          />
        </span>
      </div>
    );
  }

  if (props.kind === 'once') {
    return (
      <div className="ui-secret-once">
        <div className="ui-secret-warning">
          <Icon name="alert" size={14} />
          {zh.secret.onceWarning}
        </div>
        <div className="ui-secret-code mono">
          <Truncate text={props.text} mode="none" />
        </div>
        <div className="ui-secret-once-actions">
          <CopyButton value={props.text} label={zh.secret.copy} />
          {props.qrSlot ? <span className="ui-secret-qr">{props.qrSlot}</span> : null}
          {props.onDownload ? (
            <Button label={zh.secret.download} icon="download" size="sm" onClick={props.onDownload} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="ui-secret ui-secret-agent">
      <Icon name="shield" size={14} />
      <span className="ui-secret-value">{zh.secret.agentNote.replace('{node}', props.nodeName)}</span>
      <span className="ui-secret-actions">
        <span className="ui-secret-public mono">{zh.secret.publicKey} {props.publicKey}</span>
        <CopyButton value={props.publicKey} label={zh.secret.copy} />
      </span>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      label={copied ? zh.secret.copied : label}
      icon={copied ? 'check' : 'copy'}
      size="sm"
      variant="default"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    />
  );
}

/** 触发浏览器下载纯文本（.conf 等）。 */
export function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------- CodeBlock */

export function CodeBlock({
  code,
  label,
  copyLabel = zh.secret.codeCopy,
}: {
  code: string;
  label?: string;
  copyLabel?: string;
}) {
  return (
    <div className="ui-code-wrap">
      <div className="ui-code-head">
        {label ? <span className="ui-code-label">{label}</span> : null}
        <CopyButton value={code} label={copyLabel} />
      </div>
      <pre className="ui-code mono">{code}</pre>
    </div>
  );
}
