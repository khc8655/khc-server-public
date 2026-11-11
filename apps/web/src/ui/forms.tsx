import { useId, type ReactNode } from 'react';
import type { IconName } from './icons';
import { Icon } from './primitives';
import { zh } from '../i18n/zh';

/* ---------------------------------------------------------------- Field */

export interface FieldProps {
  id: string;
  label: string;
  optional?: boolean;
  required?: boolean;
  help?: string;
  error?: string;
  variant?: 'stack' | 'row';
  children: ReactNode;
}

/** 字段容器：Label → 控件 → 帮助或错误（错误优先，ui-spec §4.16）。 */
export function Field({
  id,
  label,
  optional = false,
  required = false,
  help,
  error,
  variant = 'stack',
  children,
}: FieldProps) {
  if (variant === 'row') {
    return (
      <div className="ui-field-row">
        <div className="ui-field-row-text">
          <span className="ui-field-label">{label}</span>
          {help ? <span className="ui-field-help">{help}</span> : null}
          {error ? (
            <span className="ui-field-error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <div className="ui-field-row-control">{children}</div>
      </div>
    );
  }
  return (
    <div className="ui-field">
      <label className={`ui-field-label${required ? ' is-required' : ''}`} htmlFor={id}>
        {label}
        {optional ? <span className="ui-field-optional">{zh.common.optional}</span> : null}
      </label>
      {children}
      {error ? (
        <span className="ui-field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : help ? (
        <span className="ui-field-help" id={`${id}-help`}>
          {help}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ TextInput */

export interface TextInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | 'email' | 'url';
  mono?: boolean;
  suffix?: string;
  suffixIcon?: IconName;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  invalid?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'url';
  name?: string;
  ariaLabel?: string;
  onBlur?: () => void;
}

export function TextInput({
  id,
  value,
  onChange,
  type = 'text',
  mono = false,
  suffix,
  suffixIcon,
  placeholder,
  readOnly = false,
  disabled = false,
  disabledReason,
  invalid = false,
  autoComplete,
  inputMode,
  name,
  ariaLabel,
  onBlur,
}: TextInputProps) {
  return (
    <div
      className={[
        'ui-input-wrap',
        mono ? 'is-mono' : '',
        invalid ? 'is-invalid' : '',
        readOnly ? 'is-readonly' : '',
        disabled ? 'is-disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={disabled && disabledReason ? disabledReason : undefined}
    >
      <input
        id={id}
        name={name}
        className="ui-input"
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {suffix ? <span className="ui-input-suffix">{suffix}</span> : null}
      {suffixIcon ? (
        <span className="ui-input-suffix">
          <Icon name={suffixIcon} size={14} />
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- NumberInput */

export interface NumberInputProps {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  invalid?: boolean;
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  placeholder,
  disabled = false,
  disabledReason,
  invalid = false,
}: NumberInputProps) {
  return (
    <div
      className={[
        'ui-input-wrap',
        invalid ? 'is-invalid' : '',
        disabled ? 'is-disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={disabled && disabledReason ? disabledReason : undefined}
    >
      <input
        id={id}
        className="ui-input ui-input-number"
        type="number"
        value={value === null ? '' : String(value)}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        onBlur={() => {
          if (value === null) return;
          if (min !== undefined && value < min) onChange(min);
          if (max !== undefined && value > max) onChange(max);
        }}
      />
      {suffix ? <span className="ui-input-suffix">{suffix}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------ PortInput */

export interface PortInputProps {
  id: string;
  value: number | null;
  protocol: 'tcp' | 'udp';
  onChange: (value: number | null) => void;
  onProtocolChange: (protocol: 'tcp' | 'udp') => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

export function PortInput({
  id,
  value,
  protocol,
  onChange,
  onProtocolChange,
  placeholder,
  invalid = false,
  disabled = false,
}: PortInputProps) {
  return (
    <div className={`ui-input-wrap${invalid ? ' is-invalid' : ''}`}>
      <input
        id={id}
        className="ui-input ui-input-number"
        type="number"
        min={1}
        max={65535}
        value={value === null ? '' : String(value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
      />
      <select
        className="ui-input-protocol"
        aria-label="协议"
        value={protocol}
        disabled={disabled}
        onChange={(event) => onProtocolChange(event.target.value === 'udp' ? 'udp' : 'tcp')}
      >
        <option value="tcp">tcp</option>
        <option value="udp">udp</option>
      </select>
    </div>
  );
}

/* --------------------------------------------------------------- Select */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  id: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}

export function Select({
  id,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  invalid = false,
  ariaLabel,
}: SelectProps) {
  return (
    <div className={`ui-input-wrap ui-select-wrap${invalid ? ' is-invalid' : ''}`}>
      <select
        id={id}
        className="ui-input ui-select"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="ui-select-caret" aria-hidden="true">
        <Icon name="arrow" size={14} />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ Segmented */

export interface SegmentedOption {
  value: string;
  label: string;
}

export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`ui-seg-item${option.value === value ? ' is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Toggle */

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  disabledReason,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`ui-toggle${checked ? ' is-on' : ''}`}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-knob" aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------- Checkbox */

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="ui-checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {checked ? <Icon name="check" size={14} /> : null}
      </span>
      <span className="ui-checkbox-text">
        <span className="ui-checkbox-label">{label}</span>
        {description ? <span className="ui-checkbox-desc">{description}</span> : null}
      </span>
    </label>
  );
}

/* -------------------------------------------------------------- Textarea */

export interface TextareaProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}

export function Textarea({
  id,
  value,
  onChange,
  rows = 6,
  mono = false,
  placeholder,
  invalid = false,
  disabled = false,
  readOnly = false,
}: TextareaProps) {
  return (
    <textarea
      id={id}
      className={`ui-textarea${mono ? ' is-mono' : ''}${invalid ? ' is-invalid' : ''}`}
      rows={rows}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/* ----------------------------------------------------------- SearchInput */

export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
}) {
  return (
    <div className="ui-search">
      <input
        className="ui-search-input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onChange('');
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------ FilterChip */

export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ui-filter${active ? ' is-on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
      {active ? <Icon name="x" size={14} /> : null}
    </button>
  );
}
