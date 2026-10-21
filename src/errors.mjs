/**
 * 统一错误类型：HTTP 层根据 status 直接映射，CLI 根据 code 判断。
 */
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '缺少或无效的访问令牌') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = '当前角色没有执行该操作的权限') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message, details) => new AppError(422, 'UNPROCESSABLE', message, details);
export const tooLarge = (message = '请求体过大') => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
