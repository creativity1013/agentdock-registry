import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './helpers.mjs';

/** 最小 OIDC provider：discovery + token + userinfo */
async function startMockOidc() {
  const seen = { token: null, userinfo: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: `http://${req.headers.host}`,
        authorization_endpoint: `http://${req.headers.host}/authorize`,
        token_endpoint: `http://${req.headers.host}/token`,
        userinfo_endpoint: `http://${req.headers.host}/userinfo`,
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      seen.token = Object.fromEntries(new URLSearchParams(raw));
      return json(200, { access_token: 'access-token-1', token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') {
      seen.userinfo = req.headers.authorization;
      return json(200, {
        sub: 'sso-sub-1',
        email: 'alice@acme.dev',
        name: 'alice',
        tenant: 'acme',
        role: 'publisher',
      });
    }
    return json(404, { message: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('SSO：OIDC 授权码 + PKCE 登录，自动建号并写入会话 Cookie', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const server = await startTestServer({
    oidc: { issuer: mock.url, clientId: 'agentdock', clientSecret: 's3cret', defaultRole: 'viewer' },
  });
  t.after(() => server.close());

  const config = await fetch(`${server.url}/auth/config`).then((response) => response.json());
  assert.equal(config.enabled, true);
  assert.equal(config.issuer, mock.url);

  const login = await fetch(`${server.url}/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  assert.equal(location.origin + location.pathname, `${mock.url}/authorize`);
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('client_id'), 'agentdock');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge').length >= 40);
  const state = location.searchParams.get('state');
  const redirectUri = location.searchParams.get('redirect_uri');
  assert.ok(state);
  assert.ok(redirectUri.endsWith('/auth/oidc/callback'));

  const callback = await fetch(`${server.url}/auth/oidc/callback?state=${state}&code=abc123`, {
    redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  const cookie = (callback.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^agentdock_session=/);
  assert.ok(mock.seen.token.code_verifier, '应携带 PKCE code_verifier');
  assert.equal(mock.seen.token.code, 'abc123');
  assert.equal(mock.seen.token.grant_type, 'authorization_code');
  assert.equal(mock.seen.userinfo, 'Bearer access-token-1');

  const me = await fetch(`${server.url}/api/v1/me`, { headers: { cookie } });
  const meData = await me.json();
  assert.equal(meData.user.name, 'alice');
  assert.equal(meData.user.role, 'publisher');
  assert.equal(meData.user.tenant, 'acme');

  // 用会话 Cookie 访问租户内市场
  const list = await fetch(`${server.url}/api/v1/packages`, { headers: { cookie } });
  assert.equal(list.status, 200);

  // 无效 state 回调被拒绝
  const bad = await fetch(`${server.url}/auth/oidc/callback?state=nope&code=abc`, { redirect: 'manual' });
  assert.equal(bad.status, 400);

  // 未登录访问 /api/v1/me 仍 401
  assert.equal((await fetch(`${server.url}/api/v1/me`)).status, 401);
});

test('SSO：未配置 OIDC 时登录端点返回 404，/auth/config 显示关闭', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const config = await fetch(`${server.url}/auth/config`).then((response) => response.json());
  assert.equal(config.enabled, false);
  const login = await fetch(`${server.url}/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 404);
});
