import { Button, Row, SaveBarFrame } from '../ui';
import { zh } from '../i18n/zh';

export interface SaveBarProps {
  note: string;
  dirty: boolean;
  saving?: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

/** T4 底部保存条：左侧后果说明，右侧“放弃修改 / 保存”。 */
export function SaveBar({ note, dirty, saving = false, onDiscard, onSave }: SaveBarProps) {
  return (
    <SaveBarFrame note={note}>
      <Row gap={2}>
        <Button
          label={zh.common.discard}
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          disabledReason={zh.common.noChanges}
          onClick={onDiscard}
        />
        <Button
          label={zh.common.save}
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!dirty}
          disabledReason={zh.common.noChanges}
          onClick={onSave}
        />
      </Row>
    </SaveBarFrame>
  );
}
