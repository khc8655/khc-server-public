import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest, validationFailed } from './errors';

/** 解析并校验 JSON 请求体；失败统一抛 AppError（含字段级错误） */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join('.') || '_';
      fields[key] = issue.message;
    }
    throw validationFailed(fields);
  }
  return parsed.data;
}

/** 解析并校验路径/查询参数 */
export function parseParams<S extends z.ZodTypeAny>(value: unknown, schema: S): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.map(String).join('.') || '_'] = issue.message;
    }
    throw validationFailed(fields);
  }
  return parsed.data;
}
