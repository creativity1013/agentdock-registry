import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, skillPayload } from './helpers.mjs';

test('审计按租户过滤：admin 可指定租户，reviewer 只能看本租户', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  // acme 租户发布者
  const acmeToken = await server.request('POST', '/admin/tokens', {
    token: server.tokens.admin,
    body: { name: 'acme-pub', role: 'publisher', tenant: 'acme' },
  });
  const payload = skillPayload();
  payload.name = 'tenant-audit-skill';
  payload.files[0].content = payload.files[0].content.replace('name: demo-skill', 'name: tenant-audit-skill');
  const published = await server.request('POST', '/packages', {
    token: acmeToken.data.token,
    body: payload,
  });
  assert.equal(published.status, 201);

  // default 租户也发布一条，便于对比
  const defaultPayload = skillPayload();
  defaultPayload.name = 'default-audit-skill';
  defaultPayload.files[0].content = defaultPayload.files[0].content.replace('name: demo-skill', 'name: default-audit-skill');
  assert.equal((await server.request('POST', '/packages', { token: server.tokens.publisher, body: defaultPayload })).status, 201);

  // admin 过滤 acme：只看到 acme 条目的租户字段
  const acmeAudit = await server.request('GET', '/audit?tenant=acme&limit=200', { token: server.tokens.admin });
  assert.equal(acmeAudit.status, 200);
  assert.equal(acmeAudit.data.tenant, 'acme');
  assert.ok(acmeAudit.data.items.length >= 1);
  for (const item of acmeAudit.data.items) {
    assert.equal(item.meta?.tenant || 'default', 'acme');
  }
  assert.ok(acmeAudit.data.items.some((item) => item.action === 'package.publish' && item.target.includes('tenant-audit-skill')));

  // admin 看全部
  const allAudit = await server.request('GET', '/audit?limit=200', { token: server.tokens.admin });
  assert.ok(allAudit.data.total > acmeAudit.data.total);
  assert.ok(allAudit.data.items.some((item) => (item.meta?.tenant || 'default') === 'default'));

  // reviewer（default 租户）不能通过参数越权
  const reviewerAudit = await server.request('GET', '/audit?tenant=acme', { token: server.tokens.reviewer });
  assert.equal(reviewerAudit.data.tenant, 'default');
  for (const item of reviewerAudit.data.items) {
    assert.equal(item.meta?.tenant || 'default', 'default');
  }

  // 导出同样按租户过滤
  const exportResponse = await fetch(`${server.url}/api/v1/audit/export?format=jsonl&tenant=acme`, {
    headers: { Authorization: `Bearer ${server.tokens.admin}` },
  });
  assert.equal(exportResponse.status, 200);
  const lines = (await exportResponse.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.length >= 1);
  for (const entry of lines) assert.equal(entry.meta?.tenant || 'default', 'acme');
});
