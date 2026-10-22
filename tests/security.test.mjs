import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { checkCsrf, CSRF_COOKIE } from '../src/security.mjs';
import { startTestServer } from './helpers.mjs';

test('限流：滑动窗口内超过上限被拒绝，窗口滑过后恢复', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => clock });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, true);
  const blocked = limiter.hit('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.hit('b').allowed, true, '不同 key 互不影响');
  clock = 1500;
  assert.equal(limiter.hit('a').allowed, true, '窗口滑过后恢复');
  limiter.prune();
  assert.ok(limiter.size <= 1);
});

test('CSRF：仅 Cookie 会话的写操作校验 Origin 与双提交令牌', () => {
  const headers = {
    host: 'dock.example.com',
    cookie: `${CSRF_COOKIE}=token-abc`,
    'x-agentdock-csrf': 'token-abc',
  };
  assert.equal(checkCsrf({ method: 'GET', authVia: 'session', headers }).ok, true);
  assert.equal(checkCsrf({ method: 'POST', authVia: 'bearer', headers }).ok, true);
  assert.deepEqual(checkCsrf({ method: 'POST', authVia: 'session', headers }), { ok: true });
  assert.equal(checkCsrf({ method: 'POST', authVia: 'session', headers: {} }).ok, false);
  assert.equal(
    checkCsrf({ method: 'POST', authVia: 'session', headers: { ...headers, 'x-agentdock-csrf': 'other' } }).ok,
    false,
  );
  assert.equal(
    checkCsrf({ method: 'POST', authVia: 'session', headers: { ...headers, origin: 'https://evil.example' } }).ok,
    false,
  );
  assert.equal(
    checkCsrf({ method: 'POST', authVia: 'session', headers: { ...headers, origin: 'https://dock.example.com' } }).ok,
    true,
  );
});

test('接口限流：超过上限返回 429 与 Retry-After（默认关闭的测试环境显式开启）', async (t) => {
  const server = await startTestServer({
    security: { rateLimit: { enabled: true, windowMs: 60_000, max: 3, loginMax: 5 } },
  });
  t.after(() => server.close());
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const response = await fetch(`${server.url}/api/v1/health`);
    statuses.push(response.status);
    if (i === 3) {
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) >= 1);
      const data = await response.json();
      assert.equal(data.error.code, 'RATE_LIMITED');
    }
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
});
