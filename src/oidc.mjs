import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

/**
 * OIDC 登录（Authorization Code + PKCE，零依赖）。
 * 身份取 userinfo 端点（HTTPS 传输信任），不做本地 JWT 验签；
 * 角色/租户从 userinfo 声明映射，未声明时用配置默认值。
 */

const DISCOVERY_TTL_MS = 3600 * 1000;

export function createOidcClient(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const settings = config.oidc || {};
  let cache = null;

  function requireEnabled() {
    if (!settings.enabled) throw new AppError(404, 'OIDC_DISABLED', '未配置 SSO（OIDC）');
  }

  async function discover() {
    requireEnabled();
    if (cache && cache.expiresAt > now()) return cache.value;
    const url = `${String(settings.issuer).replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw new AppError(502, 'OIDC_DISCOVERY_FAILED', `无法访问 OIDC issuer：${url}（${error.message}）`);
    }
    if (!response.ok) throw new AppError(502, 'OIDC_DISCOVERY_FAILED', `OIDC discovery 返回 ${response.status}`);
    const value = await response.json();
    for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
      if (!value[key]) throw new AppError(502, 'OIDC_DISCOVERY_INVALID', `OIDC discovery 缺少 ${key}`);
    }
    cache = { value, expiresAt: now() + DISCOVERY_TTL_MS };
    return value;
  }

  function createPkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  function createState() {
    return crypto.randomBytes(24).toString('base64url');
  }

  function authorizeUrl(endpoints, { state, codeChallenge, redirectUri }) {
    const url = new URL(endpoints.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', settings.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async function exchangeCode(endpoints, { code, codeVerifier, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: settings.clientId,
      code_verifier: codeVerifier,
    });
    if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
    let response;
    try {
      response = await fetchImpl(endpoints.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new AppError(502, 'OIDC_TOKEN_FAILED', `OIDC token 请求失败：${error.message}`);
    }
    if (!response.ok) throw new AppError(401, 'OIDC_TOKEN_REJECTED', `OIDC token 端点返回 ${response.status}`);
    return response.json();
  }

  async function userinfo(endpoints, accessToken) {
    let response;
    try {
      response = await fetchImpl(endpoints.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new AppError(502, 'OIDC_USERINFO_FAILED', `OIDC userinfo 请求失败：${error.message}`);
    }
    if (!response.ok) throw new AppError(401, 'OIDC_USERINFO_REJECTED', `OIDC userinfo 返回 ${response.status}`);
    return response.json();
  }

  /** 把 userinfo 声明映射成 AgentDock 身份 */
  function mapClaims(claims) {
    const tenant = String(claims[settings.tenantClaim] || claims.tenant || 'default').trim() || 'default';
    const rawRole = String(claims[settings.roleClaim] || claims.role || '').trim();
    const role = ['viewer', 'publisher', 'reviewer', 'admin'].includes(rawRole) ? rawRole : settings.defaultRole;
    const email = String(claims.email || '').trim();
    const name = String(claims.name || claims.preferred_username || email || claims.sub || '').trim();
    const subject = String(claims.sub || '').trim();
    if (!subject && !email) throw new AppError(401, 'OIDC_IDENTITY_MISSING', 'OIDC 身份缺少 sub/email');
    return { subject: subject || email, email, name: name || subject, tenant, role };
  }

  function loginUrl({ state, codeChallenge, redirectUri }) {
    return discover().then((endpoints) => authorizeUrl(endpoints, { state, codeChallenge, redirectUri }));
  }

  return { settings, discover, createPkcePair, createState, authorizeUrl, exchangeCode, userinfo, mapClaims, loginUrl };
}
