/**
 * 应用清单差异摘要（推送脚本用）：与面板「导入应用」抽屉同一口径——版本、各脚本 sha256、
 * 参数增删改、运行方式（create → root 标高风险）、控制面步骤的阶段与主机、外部来源、凭据声明。
 * 只读原始 JSON，不做 v1 → v2 归一化；格式校验由 Worker 负责。
 */

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 12) : '无');
const runtimeLabel = (m) =>
  m?.runtime?.mode === 'root' ? 'root' : `create（${m?.runtime?.user ?? '安装时填写'}）`;

function hooks(m) {
  const out = {};
  for (const stage of ['preInstall', 'preUpgrade', 'preUninstall']) {
    const step = m?.hooks?.[stage];
    if (!step) continue;
    let host = '—';
    try {
      host = new URL(step.url).host;
    } catch {
      /* 展示用 */
    }
    out[stage] = `${step.method} ${host}`;
  }
  return out;
}

const sourceLine = (s) => `${s.host}（${s.pinned ? '固定' : '动态'}）`;

/** @returns {{isNew: boolean, changes: Array<{key: string, label: string, before: string, after: string, tone: string}>}} */
export function diffManifestJson(previous, next) {
  const changes = [];
  const push = (key, label, before, after, tone = 'info') =>
    changes.push({ key, label, before, after, tone });
  if (!previous) return { isNew: true, changes };

  if (previous.version !== next.version) push('version', '版本', previous.version, next.version);
  const pSchema = previous.schema === 2 ? 2 : 1;
  const nSchema = next.schema === 2 ? 2 : 1;
  if (pSchema !== nSchema) push('schema', '清单格式', `v${pSchema}`, `v${nSchema}`);

  for (const action of ['install', 'uninstall', 'upgrade']) {
    const before = previous.sha256?.[action];
    const after = next.sha256?.[action];
    if (before !== after) push(`sha256.${action}`, `${action} 脚本 sha256`, short(before), short(after), 'warn');
  }

  if (previous.runtime?.mode !== next.runtime?.mode || previous.runtime?.user !== next.runtime?.user) {
    const danger = previous.runtime?.mode !== 'root' && next.runtime?.mode === 'root';
    push('runtime.mode', '运行方式', runtimeLabel(previous), runtimeLabel(next), danger ? 'danger' : 'warn');
  }

  const pParams = new Map((previous.params ?? []).map((p) => [p.key, p]));
  const nParams = new Map((next.params ?? []).map((p) => [p.key, p]));
  for (const [key, spec] of nParams) {
    if (!pParams.has(key)) push(`params.${key}`, `参数 ${key}`, '无', '新增');
    else if (stable(pParams.get(key)) !== stable(spec)) push(`params.${key}`, `参数 ${key}`, '旧定义', '已修改');
  }
  for (const key of pParams.keys()) {
    if (!nParams.has(key)) push(`params.${key}`, `参数 ${key}`, '有', '删除', 'warn');
  }

  const pHooks = hooks(previous);
  const nHooks = hooks(next);
  for (const stage of new Set([...Object.keys(pHooks), ...Object.keys(nHooks)])) {
    if (pHooks[stage] === nHooks[stage] && stable(previous.hooks?.[stage]) === stable(next.hooks?.[stage])) continue;
    push(`hooks.${stage}`, `控制面步骤 ${stage}`, pHooks[stage] ?? '无', nHooks[stage] ?? '无', 'warn');
  }

  const pSources = new Set((previous.sources ?? []).map(sourceLine));
  const nSources = new Set((next.sources ?? []).map(sourceLine));
  for (const line of nSources) if (!pSources.has(line)) push(`sources.${line}`, '外部来源', '无', line, 'warn');
  for (const line of pSources) if (!nSources.has(line)) push(`sources.${line}`, '外部来源', line, '移除');

  const pSecrets = new Set((previous.secrets ?? []).map((s) => s.name));
  const nSecrets = new Set((next.secrets ?? []).map((s) => s.name));
  for (const name of nSecrets) if (!pSecrets.has(name)) push(`secrets.${name}`, '凭据声明', '无', name, 'warn');
  for (const name of pSecrets) if (!nSecrets.has(name)) push(`secrets.${name}`, '凭据声明', name, '移除');

  return { isNew: false, changes };
}

export function formatDiff(diff) {
  if (diff.isNew) return ['新增应用（D1 中不存在该 ID）'];
  if (diff.changes.length === 0) return ['与 D1 当前版本没有差异'];
  return diff.changes.map(
    (c) => `${c.tone === 'danger' ? '[高风险] ' : ''}${c.label}：${c.before} → ${c.after}`,
  );
}
