
import { Icon, Spinner } from './primitives';
import { zh } from '../i18n/zh';

export type StepState = 'done' | 'running' | 'todo' | 'failed';

export interface StepItem {
  label: string;
  state: StepState;
  duration?: string;
}

/** 任务步骤（ui-spec §4.26）：18px 圆形图标 + 13px 文字 + 右侧耗时。 */
export function Steps({ items }: { items: StepItem[] }) {
  return (
    <ol className="ui-steps">
      {items.map((item) => (
        <li className={`ui-step ui-step-${item.state}`} key={item.label}>
          <span className="ui-step-icon" aria-hidden="true">
            {item.state === 'done' ? <Icon name="check" size={14} /> : null}
            {item.state === 'failed' ? <Icon name="x" size={14} /> : null}
            {item.state === 'running' ? <Spinner size={14} /> : null}
          </span>
          <span className="ui-step-label">{item.label}</span>
          {item.duration ? <span className="ui-step-duration">{item.duration}</span> : null}
          <span className="sr-only">{stepStateLabel(item.state)}</span>
        </li>
      ))}
    </ol>
  );
}

function stepStateLabel(state: StepState): string {
  if (state === 'running') return zh.status.running;
  if (state === 'failed') return zh.status.error;
  if (state === 'done') return zh.status.done;
  return zh.status.pendingTask;
}

export type StepperState = 'done' | 'current' | 'todo' | 'failed';

export interface StepperItem {
  label: string;
  state: StepperState;
}

/** 向导步骤条：等分横条，不可点击跳步。 */
export function Stepper({ items }: { items: StepperItem[] }) {
  return (
    <ol className="ui-stepper">
      {items.map((item) => (
        <li className={`ui-stepper-item ui-stepper-${item.state}`} key={item.label}>
          <span className="ui-stepper-bar" aria-hidden="true" />
          <span className="ui-stepper-label">{item.label}</span>
        </li>
      ))}
    </ol>
  );
}
