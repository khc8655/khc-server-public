/**
 * 升级确认里的「修改参数（可选）」表单：按新版本清单的 params 通用渲染，
 * 每项默认「保持原值」，只把用户实际改动的键交给调用方（值保存在调用方组件状态里，
 * 不进 queryKey / localStorage / toast）。
 */
import { useState } from 'react';
import type { AppManifestDefinitionV2 } from '@khc/contracts';
import { zh } from '../../i18n/zh';
import { Button, Field, Row, Select, Stack, TextInput } from '../../ui';

export type UpgradeValues = Record<string, unknown>;

export interface UpgradeParamsFormProps {
  def: AppManifestDefinitionV2;
  values: UpgradeValues;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown | undefined) => void;
}

const KEEP = '';

export function UpgradeParamsForm({ def, values, errors, onChange }: UpgradeParamsFormProps) {
  const [shown, setShown] = useState<Record<string, boolean>>({});

  if (def.params.length === 0) {
    return <p className="ui-text-caption">该应用没有可修改的参数。</p>;
  }

  return (
    <Stack gap={3}>
      <p className="ui-text-caption">{zh.catalog.upgradeParamsHint}</p>
      {def.params.map((param) => {
        const id = `upgrade-param-${param.key}`;
        const label = param.label ?? param.key;
        const error = errors[param.key];
        const help = param.derive ? zh.catalog.upgradeDeriveHelp : undefined;
        const raw = values[param.key];

        if (param.type === 'boolean') {
          const current = raw === true ? 'true' : raw === false ? 'false' : KEEP;
          return (
            <Field key={param.key} id={id} label={label} help={help} error={error}>
              <Select
                id={id}
                value={current}
                ariaLabel={label}
                options={[
                  { value: KEEP, label: zh.catalog.upgradeKeepOriginal },
                  { value: 'true', label: zh.catalog.upgradeBoolYes },
                  { value: 'false', label: zh.catalog.upgradeBoolNo },
                ]}
                onChange={(value) =>
                  onChange(param.key, value === 'true' ? true : value === 'false' ? false : undefined)
                }
              />
            </Field>
          );
        }

        if (param.type === 'enum' && param.options) {
          return (
            <Field key={param.key} id={id} label={label} help={help} error={error}>
              <Select
                id={id}
                value={typeof raw === 'string' ? raw : KEEP}
                ariaLabel={label}
                options={[
                  { value: KEEP, label: zh.catalog.upgradeKeepOriginal },
                  ...param.options.map((opt) => ({ value: opt.value, label: opt.label })),
                ]}
                onChange={(value) => onChange(param.key, value === KEEP ? undefined : value)}
              />
            </Field>
          );
        }

        const text = raw === undefined || raw === null ? '' : String(raw);
        const isSecret = Boolean(param.secret);
        const reveal = Boolean(shown[param.key]);
        const input = (
          <TextInput
            id={id}
            type={isSecret && !reveal ? 'password' : 'text'}
            mono
            autoComplete={isSecret ? 'new-password' : 'off'}
            placeholder={zh.catalog.upgradeKeepPlaceholder}
            inputMode={param.type === 'integer' ? 'numeric' : undefined}
            value={text}
            invalid={Boolean(error)}
            onChange={(value) => {
              if (value === '') {
                onChange(param.key, undefined);
              } else if (param.type === 'integer' && /^-?\d+$/.test(value.trim())) {
                onChange(param.key, Number(value.trim()));
              } else {
                onChange(param.key, value);
              }
            }}
          />
        );
        return (
          <Field key={param.key} id={id} label={label} help={help} error={error}>
            {isSecret ? (
              <Row gap={2} align="center">
                <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
                <Button
                  label={reveal ? '隐藏' : '显示'}
                  variant="ghost"
                  size="sm"
                  onClick={() => setShown((prev) => ({ ...prev, [param.key]: !prev[param.key] }))}
                />
              </Row>
            ) : (
              input
            )}
          </Field>
        );
      })}
    </Stack>
  );
}
