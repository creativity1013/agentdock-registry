import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './helpers.mjs';

/** 最小 OIDC provider：discovery + token + userinfo（固定 alice/acme/publisher） */
async function startMockOidc() {
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
      for await (const _ of req) void _;
      return json(200, { access_token: 'access-token-1', token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') {
      return json(200, { sub: 'sso-sub-1', email: 'alice@acme.dev', name: 'alice', tenant: 'acme', role: 'publisher' });
    }
    return json(404, { message: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function ssoLogin(server) {
  const login = await fetch(`${server.url}/auth/oidc/login`, { redirect: 'manual' });
  const location = new URL(login.headers.get('location'));
  const state = location.searchParams.get('state');
  const callback = await fetch(`${server.url}/auth/oidc/callback?state=${state}&code=abc123`, {
    redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  const cookies = callback.headers.getSetCookie
    ? callback.headers.getSetCookie()
    : (callback.headers.get('set-cookie') || '').split(',');
  const session = cookies.find((item) => item.trim().startsWith('agentdock_session='));
  assert.ok(session, '应下发会话 Cookie');
  return session.split(';')[0].trim();
}

async function meWithCookie(server, cookie) {
  const response = await fetch(`${server.url}/api/v1/me`, { headers: { cookie } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('会话吊销：禁用用户立即踢下线，启用后旧会话仍失效、重新登录可用', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const server = await startTestServer({
    oidc: { issuer: mock.url, clientId: 'agentdock', clientSecret: 's3cret' },
  });
  t.after(() => server.close());

  const cookie = await ssoLogin(server);
  let me = await meWithCookie(server, cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, 'alice');

  const users = await server.request('GET', '/admin/users', { token: server.tokens.admin });
  const alice = users.data.items.find((user) => user.name === 'alice');
  assert.ok(alice, 'SSO 用户应出现在用户列表');

  await server.request('PATCH', `/admin/users/${alice.id}`, {
    token: server.tokens.admin,
    body: { disabled: true },
  });
  me = await meWithCookie(server, cookie);
  assert.equal(me.status, 401, '被禁用用户的会话应立即失效');

  await server.request('PATCH', `/admin/users/${alice.id}`, {
    token: server.tokens.admin,
    body: { disabled: false },
  });
  me = await meWithCookie(server, cookie);
  assert.equal(me.status, 401, '重新启用不应复活旧会话（sessionEpoch 已推进）');

  const fresh = await ssoLogin(server);
  me = await meWithCookie(server, fresh);
  assert.equal(me.status, 200, '重新登录应拿到新会话');
});

test('会话吊销：按用户 revoke 与全员 revoke-all 均使旧 Cookie 失效，令牌不受影响', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const server = await startTestServer({
    oidc: { issuer: mock.url, clientId: 'agentdock', clientSecret: 's3cret' },
  });
  t.after(() => server.close());

  const first = await ssoLogin(server);
  assert.equal((await meWithCookie(server, first)).status, 200);

  const users = await server.request('GET', '/admin/users', { token: server.tokens.admin });
  const alice = users.data.items.find((user) => user.name === 'alice');
  await server.request('POST', `/admin/users/${alice.id}/revoke-sessions`, {
    token: server.tokens.admin,
  });
  assert.equal((await meWithCookie(server, first)).status, 401, '按用户吊销后旧 Cookie 失效');

  const second = await ssoLogin(server);
  assert.equal((await meWithCookie(server, second)).status, 200);

  const revoked = await server.request('POST', '/admin/sessions/revoke-all', {
    token: server.tokens.admin,
  });
  assert.equal(revoked.data.globalEpoch, 1);
  assert.equal((await meWithCookie(server, second)).status, 401, '全员吊销后旧 Cookie 失效');

  const third = await ssoLogin(server);
  assert.equal((await meWithCookie(server, third)).status, 200, '全员吊销后重新登录仍可用');

  // Bearer 令牌不依赖会话世代，禁用的用户才失效
  const adminMe = await server.request('GET', '/me', { token: server.tokens.admin });
  assert.equal(adminMe.status, 200);
});

test('会话吊销：被禁用用户的 Bearer 令牌立即失效', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await server.request('POST', '/admin/tokens', {
    token: server.tokens.admin,
    body: { name: 'temp-publisher', role: 'publisher' },
  });
  const token = created.data.token;
  assert.equal((await server.request('GET', '/me', { token })).status, 200);

  await server.request('PATCH', `/admin/users/${created.data.user.id}`, {
    token: server.tokens.admin,
    body: { disabled: true },
  });
  assert.equal((await server.request('GET', '/me', { token })).status, 401);

  const enable = await server.request('PATCH', `/admin/users/${created.data.user.id}`, {
    token: server.tokens.admin,
    body: { disabled: false },
  });
  assert.equal(enable.status, 200);
  // 启用后令牌恢复（令牌是长期凭据，禁用期间拒绝）
  assert.equal((await server.request('GET', '/me', { token })).status, 200);
});
