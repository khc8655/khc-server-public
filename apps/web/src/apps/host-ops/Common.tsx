import { useState } from 'react';
import { Banner, Button, CodeBlock, Stack } from '../../ui';
import { zh } from '../../i18n/zh';
import type { HostOpsError } from '../../data/hostOps';

export function hostOpsErrorTitle(error: HostOpsError | null): string {
  if (!error) return zh.hostOps.errors.E_UNKNOWN;
  const dictionary = zh.hostOps.errors as Record<string, string>;
  return dictionary[error.code] ?? zh.hostOps.errors.E_UNKNOWN;
}

/**
 * 错误提示：主文案只显示中文映射；原始错误码 / 适配器原文放在可展开详情里。
 */
export function HostOpsErrorBanner({
  error,
  onRetry,
}: {
  error: HostOpsError;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const details = [
    `code: ${error.code}`,
    error.message ? `message: ${error.message}` : '',
    error.details ? error.details : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return (
    <Stack gap={2}>
      <Banner
        tone="danger"
        title={hostOpsErrorTitle(error)}
        action={
          <Button
            label={open ? zh.hostOps.detailsHide : zh.hostOps.detailsShow}
            size="sm"
            onClick={() => setOpen((value) => !value)}
          />
        }
      />
      {open ? <CodeBlock code={details} label={zh.hostOps.detailsShow} /> : null}
      {onRetry ? (
        <Button label={zh.common.retry} size="sm" onClick={onRetry} />
      ) : null}
    </Stack>
  );
}
