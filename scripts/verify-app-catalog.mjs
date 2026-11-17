#!/usr/bin/env node
/**
 * 应用目录（recipe catalog）一致性校验：`verify.sh` 里「app catalog drift」步骤的真实检查。
 *
 * 背景：`agent/recipes/catalog.json` 是随 Agent 包发布的 recipe 清单，节点按它渲染/安装
 * 脚本式应用。清单和磁盘上的 `agent/recipes/<id>/` 一旦漂移，就会出现「清单里有的 recipe
 * 找不到脚本」或「新增了 recipe 目录却忘了登记」，而 Agent 运行时才报错。这个检查把这类
 * 漂移挡在提交前。
 *
 * 检查项：
 *   1. 复用 Agent 的权威加载器 `khc.recipes.load_catalog()` 做格式 / 参数 schema / 脚本存在性校验
 *      （规则只有一份，不为校验再写一遍）。
 *   2. catalog 里列出的每个 recipe 在 `agent/recipes/<id>/` 下都有目录。
 *   3. `agent/recipes/` 下每个子目录都在 catalog 里登记（防止漏登记）。
 *
 * 用法：`node scripts/verify-app-catalog.mjs`，有问题 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(ROOT, 'agent');
const RECIPES_DIR = path.join(AGENT_DIR, 'recipes');
const CATALOG_FILE = path.join(RECIPES_DIR, 'catalog.json');

const problems = [];
const bad = (msg) => problems.push(msg);

// 1) 权威加载器校验（agent/khc/recipes.py 是唯一实现）
const py = spawnSync('python3', ['-c', 'from khc.recipes import load_catalog; load_catalog()'], {
  cwd: AGENT_DIR,
  encoding: 'utf8',
});
if (py.error) {
  bad(`无法执行 python3 校验 recipe 清单：${py.error.message}`);
} else if (py.status !== 0) {
  const detail = (py.stderr || py.stdout || '').trim();
  bad(`khc.recipes.load_catalog 校验失败：${detail || `退出码 ${py.status}`}`);
}

// 2/3) catalog 登记项 ↔ 磁盘目录
let catalogIds = [];
try {
  const payload = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const entries = Array.isArray(payload?.recipes) ? payload.recipes : [];
  catalogIds = entries.map((entry) => (typeof entry?.id === 'string' ? entry.id : '?'));
} catch (error) {
  bad(`无法读取 catalog.json：${error.message}`);
}

let diskDirs = [];
try {
  diskDirs = fs
    .readdirSync(RECIPES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
} catch (error) {
  bad(`无法读取 agent/recipes 目录：${error.message}`);
}

for (const id of catalogIds) {
  if (!diskDirs.includes(id)) {
    bad(`catalog.json 登记了 ${id}，但 agent/recipes/${id}/ 目录不存在`);
  }
}
for (const dir of diskDirs) {
  if (!catalogIds.includes(dir)) {
    bad(`agent/recipes/${dir}/ 未在 catalog.json 登记（清单与磁盘漂移）`);
  }
}

if (problems.length > 0) {
  console.error('FAIL: 应用目录一致性检查未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`OK: 应用目录一致（${catalogIds.length} 个 recipe：${catalogIds.join(', ')}）`);