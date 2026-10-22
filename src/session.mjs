import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, randomToken, readJson } from './util.mjs';
import { CSRF_COOKIE } from './security.mjs';

/**
 * 轻量会话：HMAC-SHA256 签名的 Cookie（无状态，服务端只存签名密钥）。
 * 只用于 SSO 登录后的人机会话；程序化访问仍用 Bearer 令牌。
 */

export const SESSION_COOKIE = 'agentdock_session';
export const SESSION_TTL_SECONDS = 8 * 3600;

export function createSessionManager(config) {
  const file = config.files.sessionSecret;
  const stateFile = config.files.sessions;
  ensureDir(path.dirname(file));
  let secret = readJson(file, null)?.secret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(
      file,
      JSON.stringify({ secret, createdAt: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  let state = readJson(stateFile, null);
  if (!state || !Number.isInteger(state.globalEpoch)) state = { globalEpoch: 0, updatedAt: new Date().toISOString() };
  const persistState = () => fs.writeFileSync(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });

  const mac = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function sign(userId, { ttlSeconds = SESSION_TTL_SECONDS, now = Date.now(), userEpoch = 0 } = {}) {
    const payload = Buffer.from(
      JSON.stringify({
        uid: userId,
        uepoch: userEpoch,
        gepoch: state.globalEpoch,
        exp: Math.floor(now / 1000) + ttlSeconds,
      }),
      'utf8',
    ).toString('base64url');
    return `${payload}.${mac(payload)}`;
  }

  function verify(token, { now = Date.now() } = {}) {
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = mac(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.uid || !Number.isFinite(data.exp)) return null;
      if (data.exp * 1000 < now) return null;
      return { uid: data.uid, userEpoch: data.uepoch ?? 0, globalEpoch: data.gepoch ?? 0 };
    } catch {
      return null;
    }
  }

  function cookieFrom(req) {
    const header = req.headers?.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return '';
  }

  /** 登录成功时同时下发会话 Cookie 与 CSRF 双提交 Cookie（非 HttpOnly，供前端读取） */
  function cookieHeader(userId, { ttlSeconds = SESSION_TTL_SECONDS, secure = false, userEpoch = 0 } = {}) {
    const session = [
      `${SESSION_COOKIE}=${encodeURIComponent(sign(userId, { ttlSeconds, userEpoch }))}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${ttlSeconds}`,
    ];
    const csrf = [
      `${CSRF_COOKIE}=${encodeURIComponent(randomToken(18))}`,
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${ttlSeconds}`,
    ];
    if (secure) {
      session.push('Secure');
      csrf.push('Secure');
    }
    return [session.join('; '), csrf.join('; ')];
  }

  function clearCookie() {
    return [
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`,
    ];
  }

  function revokeAll() {
    state.globalEpoch += 1;
    persistState();
    return state.globalEpoch;
  }

  const currentGlobalEpoch = () => state.globalEpoch;

  return {
    file,
    stateFile,
    sign,
    revokeAll,
    currentGlobalEpoch,
    verify,
    cookieFrom,
    cookieHeader,
    clearCookie,
    ttlSeconds: SESSION_TTL_SECONDS,
  };
}
