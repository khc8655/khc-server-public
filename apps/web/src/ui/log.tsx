import { useEffect, useRef, useState } from 'react';
import { Icon } from './primitives';
import { Button } from './primitives';
import { fmt, zh } from '../i18n/zh';

export type LogLevel = 'info' | 'warn' | 'error' | 'ok';

export interface LogLine {
  id?: string;
  time?: string;
  level?: LogLevel;
  text: string;
}

export interface LogViewerProps {
  lines: LogLine[];
  title?: string;
  autoscroll?: boolean;
}

const MAX_LINES = 5000;

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 日志查看器（ui-spec §4.26）：等宽 12px、自动滚底、上滚暂停、最多 5000 行。 */
export function LogViewer({ lines, title, autoscroll = true }: LogViewerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const trimmed = lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
  const hidden = expanded ? 0 : Math.max(0, trimmed.length - 200);
  const visible = hidden > 0 ? trimmed.slice(hidden) : trimmed;

  useEffect(() => {
    if (!autoscroll || paused) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [visible.length, autoscroll, paused]);

  const fullText = trimmed
    .map((line) => `${line.time ? `${line.time} ` : ''}${line.level ? `${line.level.toUpperCase()} ` : ''}${line.text}`)
    .join('\n');

  return (
    <div className="ui-log-wrap">
      <div className="ui-log-head">
        {title ? <span className="ui-log-title">{title}</span> : null}
        <span className="ui-log-actions">
          <Button
            label={zh.common.copy}
            icon="copy"
            variant="ghost"
            size="sm"
            onClick={() => navigator.clipboard.writeText(fullText).then(undefined, () => undefined)}
          />
          <Button
            label={zh.common.download}
            icon="download"
            variant="ghost"
            size="sm"
            onClick={() => downloadText(fullText, 'console.log')}
          />
        </span>
      </div>
      <div
        className="ui-log"
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget;
          const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
          setPaused(!atBottom);
        }}
      >
        {hidden > 0 ? (
          <button type="button" className="ui-log-earlier" onClick={() => setExpanded(true)}>
            {fmt(zh.log.earlier, { n: hidden })}
          </button>
        ) : null}
        {visible.map((line, index) => (
          <div className="ui-log-line" key={line.id ?? `${index}-${line.text.slice(0, 12)}`}>
            {line.time ? <span className="ui-log-ts">{line.time}</span> : null}
            <span className={`ui-log-text ui-log-${line.level ?? 'info'}`}>{line.text}</span>
          </div>
        ))}
        {visible.length === 0 ? <div className="ui-log-empty">—</div> : null}
      </div>
      {paused ? (
        <button
          type="button"
          className="ui-log-latest"
          onClick={() => {
            setPaused(false);
            const box = boxRef.current;
            if (box) box.scrollTop = box.scrollHeight;
          }}
        >
          <Icon name="arrow" size={14} />
          {zh.log.latest}
        </button>
      ) : null}
    </div>
  );
}
