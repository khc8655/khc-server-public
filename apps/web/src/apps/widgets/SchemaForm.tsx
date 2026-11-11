import { useState } from 'react';
import {
  Button,
  Field,
  NumberInput,
  PortInput,
  Row,
  SecretField,
  Segmented,
  Select,
  Stack,
  TextInput,
  Textarea,
  Toggle,
} from '../../ui';
import { zh } from '../../i18n/zh';

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  widget?: string;
  'x-secret'?: boolean | string;
}

interface SchemaFormProps {
  schema: JsonSchema | null;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function PortField({
  id,
  label,
  help,
  required = false,
  value,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  required?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp');
  return (
    <Field id={id} label={label} help={help} required={required}>
      <PortInput
        id={id}
        value={asNumber(value)}
        protocol={protocol}
        onProtocolChange={setProtocol}
        onChange={onChange}
      />
    </Field>
  );
}

function JsonField({
  id,
  label,
  help,
  required = false,
  value,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  required?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Field id={id} label={label} help={help} required={required} error={error ?? undefined}>
      <Textarea
        id={id}
        value={text}
        mono
        invalid={Boolean(error)}
        onChange={(next) => {
          setText(next);
          try {
            onChange(JSON.parse(next));
            setError(null);
          } catch {
            setError(zh.apps.jsonInvalid);
          }
        }}
      />
    </Field>
  );
}

function FieldControl({
  fieldKey,
  schema,
  required = false,
  value,
  onChange,
}: {
  fieldKey: string;
  schema: JsonSchema;
  required?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `field-${fieldKey}`;
  const label = schema.title ?? fieldKey;
  const help = schema.description;

  if (schema['x-secret']) {
    const kind = typeof schema['x-secret'] === 'string' ? schema['x-secret'] : 'stored';
    if (kind === 'agent') {
      return (
        <Field id={id} label={label} help={help} required={required}>
          <SecretField
            kind="agent"
            nodeName={typeof value === 'string' && value ? value : '节点'}
            publicKey={asString(value)}
          />
        </Field>
      );
    }
    return (
      <Field id={id} label={label} help={help} required={required}>
        <SecretField
          kind="stored"
          id={id}
          label={label}
          maskedValue={value ? '••••' : null}
          editing
          value={asString(value)}
          onChange={(next) => onChange(next)}
          onCancelEdit={() => undefined}
        />
      </Field>
    );
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    const options = schema.enum.map((option) => ({ value: String(option), label: String(option) }));
    const short = options.length >= 2 && options.length <= 4 && options.every((option) => option.label.length <= 8);
    return (
      <Field id={id} label={label} help={help} required={required}>
        {short ? (
          <Segmented
            value={asString(value)}
            options={options}
            ariaLabel={label}
            onChange={(next) => onChange(next)}
          />
        ) : (
          <Select
            id={id}
            value={asString(value)}
            options={options}
            placeholder={zh.form.choose}
            onChange={(next) => onChange(next)}
            ariaLabel={label}
          />
        )}
      </Field>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <Field id={id} label={label} help={help} required={required} variant="row">
        <Toggle
          checked={Boolean(value)}
          label={label}
          onChange={(next) => onChange(next)}
        />
      </Field>
    );
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.widget === 'port') {
      return <PortField id={id} label={label} help={help} required={required} value={value} onChange={onChange} />;
    }
    return (
      <Field id={id} label={label} help={help} required={required}>
        <NumberInput
          id={id}
          value={asNumber(value)}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(next) => onChange(next)}
        />
      </Field>
    );
  }

  if (schema.type === 'array' || schema.type === 'object') {
    return <JsonField id={id} label={label} help={help} required={required} value={value} onChange={onChange} />;
  }

  if (schema.widget === 'uuid' || schema.widget === 'randomString') {
    return (
      <Field id={id} label={label} help={help} required={required}>
        <Row gap={2}>
          <TextInput id={id} value={asString(value)} mono onChange={(next) => onChange(next)} />
          <Button
            label={zh.common.generate}
            size="sm"
            onClick={() => onChange(crypto.randomUUID())}
          />
        </Row>
      </Field>
    );
  }

  const mono = Boolean(
    schema.format && ['hostname', 'ipv4', 'cidr', 'uri', 'uuid'].includes(schema.format),
  );

  return (
    <Field id={id} label={label} help={help} required={required}>
      <TextInput id={id} value={asString(value)} mono={mono} onChange={(next) => onChange(next)} />
    </Field>
  );
}

/**
 * Schema 表单（ui-spec §4.25 / §4.25a）：控件由数据类型决定，页面与插件不能自选控件。
 */
function JsonFallback({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack gap={4}>
      <Field
        id="app-config-json"
        label={zh.apps.configTitle}
        help={zh.apps.jsonHint}
        error={error ?? undefined}
      >
        <Textarea
          id="app-config-json"
          value={text}
          mono
          rows={10}
          invalid={Boolean(error)}
          onChange={(next) => {
            setText(next);
            try {
              const parsed: unknown = JSON.parse(next);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                onChange(parsed as Record<string, unknown>);
                setError(null);
              } else {
                setError(zh.apps.jsonInvalid);
              }
            } catch {
              setError(zh.apps.jsonInvalid);
            }
          }}
        />
      </Field>
    </Stack>
  );
}

export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  if (!schema?.properties) {
    return <JsonFallback value={value} onChange={onChange} />;
  }

  return (
    <Stack gap={4}>
      {Object.entries(schema.properties).map(([key, field]) => (
        <FieldControl
          key={key}
          fieldKey={key}
          schema={field}
          required={schema.required?.includes(key) ?? false}
          value={value[key] ?? field.default}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </Stack>
  );
}
