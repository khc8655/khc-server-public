#!/usr/bin/env node
/**
 * 生产/测试环境 SSE 直连验收：
 * 登录 -> 取 live ticket -> 浏览器同款 fetch/EventSource 语义连接
 * https://<liveEndpoint>/<livePath>?ticket=... -> 检查 CORS + hello + 至少 2 帧 state。
 *
 * 使用：
 *   KHC_BASE_URL=https://panel.example.com \
 *   KHC_ADMIN_PASSWORD='...' \
 *   KHC_NODE_ID=nd_xxx \
 *   node scripts/live-sse-check.mjs
 */
const base = (process.env.KHC_BASE_URL || '').replace(/\/$/, '');
const password = process.env.KHC_ADMIN_PASSWORD || '';
const nodeId = process.env.KHC_NODE_ID || '';
const timeoutMs = Number(process.env.KHC_TIMEOUT_MS || 15000);

if (!base || !password || !nodeId) {
  console.error('需要 KHC_BASE_URL / KHC_ADMIN_PASSWORD / KHC_NODE_ID');
  process.exit(2);
}

let cookie = '';
function setCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/khc_sess=([^;]+)/);
  if (match) cookie = `khc_sess=${match[1]}`;
}
async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  setCookie(response);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function main() {
  await json('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
  const nodes = await json('/api/v1/nodes');
  const node = (nodes.nodes || []).find((item) => item.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  if (!node.liveEndpoint) throw new Error(`节点 ${node.name} 没有 liveEndpoint`);
  const ticket = await json(`/api/v1/nodes/${encodeURIComponent(nodeId)}/live-ticket`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'live', origin: base }),
  });
  const url = new URL(node.liveEndpoint);
  url.pathname = ticket.livePath;
  url.search = `ticket=${encodeURIComponent(ticket.ticket)}`;
  url.hash = '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'text/event-stream', origin: base },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const acao = response.headers.get('access-control-allow-origin');
  if (!acao || (acao !== '*' && acao !== base)) {
    clearTimeout(timer);
    throw new Error(`CORS 失败: Access-Control-Allow-Origin=${acao ?? '(missing)'} origin=${base}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let hello = false;
  let states = 0;
  let error = null;
  try {
    while (hello ? states < 2 : true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (event === 'hello') hello = true;
        if (event === 'state') states += 1;
        if (event === 'error') error = payload;
        if (hello && states >= 2) break;
      }
      if (error) throw new Error(`服务端错误: ${JSON.stringify(error)}`);
      if (hello && states >= 2) break;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  if (!hello) throw new Error('未收到 hello');
  if (states < 2) throw new Error(`只收到 ${states} 帧 state`);
  console.log(`OK ${node.name} ${url.origin}${url.pathname} CORS=${acao} hello + 2 state frames`);
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
