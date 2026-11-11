export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new AppError(400, 'bad_request', message, fields);

export const validationFailed = (fields: Record<string, string>) =>
  new AppError(400, 'validation_failed', '参数校验失败', fields);

export const unauthorized = (message = '请先登录') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = '无权访问') => new AppError(403, 'forbidden', message);

export const notFound = (message = '资源不存在') =>
  new AppError(404, 'not_found', message);

export const conflict = (message: string) => new AppError(409, 'conflict', message);

export const misconfigured = (message: string) =>
  new AppError(503, 'server_misconfigured', message);
