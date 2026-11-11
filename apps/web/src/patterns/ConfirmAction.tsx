import type { ReactNode } from 'react';
import { ConfirmDialog } from '../ui';
import { actionMeta, type ActionRef } from '../registry/actions';

export interface ConfirmActionProps {
  open: boolean;
  action: ActionRef;
  title: string;
  body: string;
  confirmLabel: string;
  /** L3 需要输入的对象名 */
  targetName?: string;
  nameLabel?: string;
  /** 确认框内的额外选项（例如危险操作的附加开关） */
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * 按动作注册表的级别自动选择 L2/L3 确认框；页面不自行决定危险级别（ui-spec §5.4）。
 */
export function ConfirmAction({
  open,
  action,
  title,
  body,
  confirmLabel,
  targetName,
  nameLabel,
  children,
  onCancel,
  onConfirm,
}: ConfirmActionProps) {
  const meta = actionMeta(action);
  const level = meta.level === 'L3' ? 'L3' : 'L2';
  const confirmTone = meta.kind === 'delete' ? 'danger' : 'primary';
  return (
    <ConfirmDialog
      open={open}
      level={level}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      confirmTone={confirmTone}
      confirmName={level === 'L3' ? targetName : undefined}
      nameLabel={nameLabel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {children}
    </ConfirmDialog>
  );
}
