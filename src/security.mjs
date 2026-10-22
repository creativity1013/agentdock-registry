import { safeEqual } from './util.mjs';

/**
 * 浏览器 Cookie 会话的 CSRF 防护（双提交 Cookie + Origin 检查）。
 * Bearer 令牌请求（CLI / API 客户端）不经过 CSRF 校验。
 */

export const CSRF_COOKIE = 'agentdock_csrf';

/** 从 Cookie 头里读取指定 cookie 值 */
export function cookieValue(header, name) {
  const raw = typeof header === 'string' ? header : '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return '';
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {object} input
 * @param {string} input.method
 * @param {'bearer'|'session'|null} input.authVia
 * @param {object} input.headers
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkCsrf({ method, authVia, headers }) {
  if (!STATE_CHANGING.has(String(method || '').toUpperCase())) return { ok: true };
  if (authVia !== 'session') return { ok: true };
  const origin = headers?.origin;
  const host = headers?.host || '';
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: 'Origin 头非法' };
    }
    if (!host || originHost !== host) return { ok: false, reason: 'Origin 与 Host 不一致' };
  }
  const header = headers?.['x-agentdock-csrf'];
  const cookie = cookieValue(headers?.cookie, CSRF_COOKIE);
  if (!header || !cookie) return { ok: false, reason: '缺少 CSRF 令牌' };
  if (!safeEqual(String(header), String(cookie))) return { ok: false, reason: 'CSRF 令牌不匹配' };
  return { ok: true };
}
