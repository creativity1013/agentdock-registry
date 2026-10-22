import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './helpers.mjs';

/** 可配置 claims 的最小 OIDC provider（discovery + token + userinfo） */
async function startMockOidc(claims) {
  const state = { claims };
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
      for await (const _chunk of req) { /* 丢弃请求体 */ }
      return json(200, { access_token: 'access-token-1', token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') return json(200, state.claims);
    return json(404, { message: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    setClaims(next) { state.claims = next; },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function ssoLogin(server) {
  const login = await fetch(`${server.url}/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  const state = location.searchParams.get('state');
  const callback = await fetch(`${server.url}/auth/oidc/callback?state=${state}&code=code-1`, { redirect: 'manual' });
  return callback;
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith('agentdock_session='));
  return session ? session.split(';')[0] : '';
}

test('SSO 组映射：groups → 角色（取最高权限），登录同步租户', async (t) => {
  const mock = await startMockOidc({
    sub: 'sso-group-1',
    email: 'boss@acme.dev',
    name: 'boss',
    tenant: 'acme',
    groups: ['agents-devs', 'agents-admins'],
  });
  t.after(() => mock.close());
  const server = await startTestServer({
    oidc: {
      issuer: mock.url,
      clientId: 'agentdock',
      clientSecret: 's3cret',
      defaultRole: 'viewer',
      groupRoleMap: { 'agents-devs': 'publisher', 'agents-admins': 'admin' },
    },
  });
  t.after(() => server.close());

  const callback = await ssoLogin(server);
  assert.equal(callback.status, 302);
  const me = await fetch(`${server.url}/api/v1/me`, { headers: { Cookie: sessionCookie(callback) } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.name, 'boss');
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.tenant, 'acme');

  // 再次登录（组变化）时角色随 IdP 同步
  mock.setClaims({
    sub: 'sso-group-1',
    email: 'boss@acme.dev',
    name: 'boss',
    tenant: 'acme',
    groups: ['agents-devs'],
  });
  const second = await ssoLogin(server);
  const me2 = await fetch(`${server.url}/api/v1/me`, { headers: { Cookie: sessionCookie(second) } });
  assert.equal((await me2.json()).user.role, 'publisher');
});

test('SSO MFA：开启后要求 IdP 在 amr 声明多因素，否则拒绝登录', async (t) => {
  const mock = await startMockOidc({
    sub: 'sso-mfa-1',
    email: 'mfa@acme.dev',
    name: 'mfa-user',
    amr: ['pwd'],
  });
  t.after(() => mock.close());
  const server = await startTestServer({
    oidc: { issuer: mock.url, clientId: 'agentdock', clientSecret: 's3cret', mfaRequired: true },
  });
  t.after(() => server.close());

  const rejected = await ssoLogin(server);
  assert.equal(rejected.status, 403);
  const error = await rejected.json();
  assert.equal(error.error.code, 'OIDC_MFA_REQUIRED');

  mock.setClaims({ sub: 'sso-mfa-1', email: 'mfa@acme.dev', name: 'mfa-user', amr: ['pwd', 'totp'] });
  const accepted = await ssoLogin(server);
  assert.equal(accepted.status, 302);
  const me = await fetch(`${server.url}/api/v1/me`, { headers: { Cookie: sessionCookie(accepted) } });
  assert.equal(me.status, 200);
});
