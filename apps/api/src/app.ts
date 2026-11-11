import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  API_VERSION,
  SERVICE_NAME,
  healthResponseSchema,
  versionResponseSchema,
} from '@khc/contracts';
import type { AppBindings, AppDeps } from './types';
import { AppError } from './lib/errors';
import { requireAuth } from './middleware/auth';
import { authRoutes } from './routes/auth';
import { nodeRoutes } from './routes/nodes';
import { appRoutes } from './routes/apps';
import { certificateRoutes } from './routes/certs';
import { settingsRoutes } from './routes/settings';
import { liveRoutes } from './routes/live';
import { snapshotRoutes } from './routes/snapshot';
import { diagnosticsRoutes } from './routes/diagnostics';
import { modeRoutes } from './routes/mode';
import { backupRoutes } from './routes/backup';
import { agentLifecycleRoutes } from './routes/agent_lifecycle';
import { cfDnsRoutes } from './routes/cfDns';
import { sshKeyRoutes } from './routes/sshKeys';
import { tunnelRoutes } from './routes/tunnels';
import { readBuildInfo } from './lib/build-info';
// 版本号唯一来源是仓库根 package.json（ADR-0013），这里不再硬编码。
import { APP_VERSION } from './version';

export { APP_VERSION, PANEL_RELEASE_DATE } from './version';

/** A-2：需要做跨站/媒体类型校验的写方法 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 写请求是否为零长度 body。
 * 浏览器对无 body 的 POST/DELETE 仍会给出非空空流（raw.body !== null），
 * 只看 raw.body 是否为空会把 logout/probe/删除公钥这类请求误判为 415；
 * content-length 缺失（chunked）时读一次副本判断。
 */
async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.body === null) return true;
  const length = request.headers.get('content-length');
  if (length !== null) return length.trim() === '0';
  try {
    return (await request.clone().text()).length === 0;
  } catch {
    return false;
  }
}

/**
 * A-3：/api/v1/* 默认鉴权的放行白名单（无需会话即可访问）。
 * - login/logout：登录入口必须公开；logout 幂等清 cookie、零数据暴露，
 *   会话过期后也要能登出，故放行。
 * - health/version：探活与版本信息，不含敏感数据。
 * - /agent/releases 不放行：无外部机器消费者（install-command 由登录后的
 *   面板生成、CI 校验走静态资产路径 /agent/*.tar.gz），公开只会泄漏
 *   部署版本面信息。
 */
const PUBLIC_API_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/health',
  '/api/v1/version',
]);

/** 面板对外入口白名单：LIVE_ORIGINS 逗号分隔（如 https://panel.example.com）；未配置时为空。 */
function allowedOriginSet(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim();
    if (!value) continue;
    try {
      set.add(new URL(value).origin.toLowerCase());
    } catch {
      // 非法配置忽略
    }
  }
  return set;
}

export function createApp(deps: AppDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // ---- 无鉴权探活 ----
  app.get('/api/v1/health', (c) =>
    c.json(
      healthResponseSchema.parse({
        ok: true,
        service: SERVICE_NAME,
        version: APP_VERSION,
        env: c.env.ENVIRONMENT ?? 'development',
        time: Math.floor(Date.now() / 1000),
        ...readBuildInfo(c.env),
      }),
    ),
  );

  app.get('/api/v1/version', (c) =>
    c.json(
      versionResponseSchema.parse({
        name: SERVICE_NAME,
        version: APP_VERSION,
        apiVersion: API_VERSION,
        ...readBuildInfo(c.env),
      }),
    ),
  );

  // ---- A-3：/api/v1/* 默认鉴权（白名单外一律 401）----
  // 各路由内部既有的 requireAuth 保留（纵深防御）；新增路由天然受保护。
  app.use('/api/v1/*', async (c, next) => {
    // 注入 settings 仓库：会话版本校验与 TOTP 读写复用同一仓库（登录白名单路径也需可用）
    c.set('settings', deps.settings);
    if (PUBLIC_API_PATHS.has(c.req.path)) return next();
    return requireAuth(c, next);
  });

  // ---- A-2：写请求防 CSRF + 强制 JSON（鉴权之后，未登录先报 401）----
  // 浏览器跨站发起的写请求（CSRF 载体）一律拒绝；Origin/Sec-Fetch-Site 都
  // 缺省视为非浏览器客户端（curl 等），放行（身份仍需 cookie 会话）。
  // 带 body 的写请求必须 application/json——表单/文本类型是 HTML form
  // CSRF 的天然载体（附录 A-4：POST /nodes 带 text/plain 仍 201 → 现在 415）。
  // 无 body 的写请求（如 logout）不校验 content-type。
  app.use('/api/v1/*', async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let allowed = false;
      try {
        const parsed = new URL(origin);
        allowed =
          parsed.host === new URL(c.req.url).host ||
          allowedOriginSet(c.env.LIVE_ORIGINS).has(parsed.origin.toLowerCase());
      } catch {
        allowed = false;
      }
      if (!allowed) {
        throw new AppError(403, 'cross_origin_blocked', '跨站写请求已被拒绝');
      }
    } else {
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        throw new AppError(403, 'cross_origin_blocked', '跨站写请求已被拒绝');
      }
    }
    // 有请求体才校验媒体类型（content-length 在部分运行时/网关不可靠，以 raw.body 为准）
    // 浏览器的无 body POST/DELETE 仍会给出非空空流，此时零长度不应判 415。
    if (!(await hasEmptyBody(c.req.raw))) {
      const contentType = (c.req.header('content-type') ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        throw new AppError(415, 'unsupported_media_type', '写请求必须使用 application/json');
      }
    }
    return next();
  });

  // ---- 业务路由 ----
  app.route('/api/v1', authRoutes());
  app.route('/api/v1', nodeRoutes(deps));
  app.route('/api/v1', appRoutes(deps));
  app.route('/api/v1', certificateRoutes(deps));
  app.route('/api/v1', settingsRoutes(deps));
  app.route('/api/v1', sshKeyRoutes(deps));
  app.route('/api/v1', tunnelRoutes(deps));
  app.route('/api/v1', liveRoutes(deps));
  app.route('/api/v1', snapshotRoutes(deps));
  app.route('/api/v1', cfDnsRoutes(deps));
  app.route('/api/v1', backupRoutes(deps));
  app.route('/api/v1', diagnosticsRoutes(deps));
  app.route('/api/v1', modeRoutes(deps));
  app.route('/api/v1', agentLifecycleRoutes(deps));

  // ---- 未实现的 API 统一 404（避免落到 SPA fallback）----
  app.all('/api/*', (c) =>
    c.json({ error: { code: 'not_found', message: 'Not Found' } }, 404),
  );

  // ---- 其余路径交给静态资源 ----
  // A-1：静态响应统一补安全头——
  //   frame-ancestors 'none'：面板只允许顶层窗口直接打开，禁止被任意站点 iframe
  //     嵌入（避免点击劫持/凭据钓鱼；面板无需被嵌入的场景）。
  //   nosniff：阻止 MIME 嗅探，hash 资源的 content-type 由构建产物决定，不可被
  //     当作可执行内容执行。
  //   HSTS：workers.dev 与自定义域名均为 HTTPS，强制浏览器后续不走 HTTP。
  // HTML 不能走 CDN 长缓存：否则发版后旧 HTML 仍引用已删除的 hash 资源，页面会白屏。
  app.get('*', async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const contentType = response.headers.get('content-type') ?? '';
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (contentType.includes('text/html')) {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Pragma', 'no-cache');
    }
    return new Response(response.body, { status: response.status, headers });
  });

  // ---- 统一错误处理（零凭据回显）----
  app.onError((err, c) => {
    if (err instanceof AppError) {
      const body = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
      };
      return c.json(body, err.status as ContentfulStatusCode);
    }
    console.error('[khc-server] unhandled error:', err);
    return c.json(
      { error: { code: 'internal_error', message: '服务器内部错误' } },
      500,
    );
  });

  return app;
}
