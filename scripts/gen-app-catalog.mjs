#!/usr/bin/env node
/**
 * 由 agent/recipes/catalog.json 生成面板用的 apps/web/src/apps/catalog.generated.json。
 *
 * 用法：
 *   node scripts/gen-app-catalog.mjs           # 写入
 *   node scripts/gen-app-catalog.mjs --check   # 只检查漂移（verify.sh 使用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'agent/recipes/catalog.json');
const target = resolve(root, 'apps/web/src/apps/catalog.generated.json');
const check = process.argv.includes('--check');

const payload = JSON.parse(readFileSync(source, 'utf8'));
if (!payload || !Array.isArray(payload.recipes)) {
  console.error('catalog.json 缺少 recipes 数组');
  process.exit(1);
}

const ids = new Set();
const recipes = payload.recipes.map((recipe) => {
  const id = String(recipe.id ?? '');
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
    console.error(`recipe id 非法: ${id}`);
    process.exit(1);
  }
  if (ids.has(id)) {
    console.error(`recipe id 重复: ${id}`);
    process.exit(1);
  }
  ids.add(id);
  return {
    id,
    name: String(recipe.name ?? id),
    version: String(recipe.version ?? ''),
    description: String(recipe.description ?? ''),
    requiresRoot: Boolean(recipe.requiresRoot ?? true),
    params: Array.isArray(recipe.params) ? recipe.params : [],
    access: Array.isArray(recipe.access) ? recipe.access : [],
  };
});

const output = {
  version: 1,
  generatedFrom: 'agent/recipes/catalog.json',
  recipes,
};
const text = `${JSON.stringify(output, null, 2)}\n`;

if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('缺少 apps/web/src/apps/catalog.generated.json，请运行 node scripts/gen-app-catalog.mjs');
    process.exit(1);
  }
  if (current !== text) {
    console.error('catalog.generated.json 与 agent/recipes/catalog.json 不一致，请重新生成');
    process.exit(1);
  }
  console.log('app catalog OK');
} else {
  writeFileSync(target, text, 'utf8');
  console.log(`wrote ${target}`);
}
