import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, skillPayload } from './helpers.mjs';

/** 构造一个指定包名/版本的 skill payload（frontmatter name 必须与包名一致） */
function skill(name, version = '0.1.0', overrides = {}) {
  const payload = skillPayload({ name, version, ...overrides });
  payload.files = payload.files.map((file) =>
    file.path === 'SKILL.md'
      ? { ...file, content: file.content.replace(/^name:.*$/m, `name: ${name}`) }
      : file,
  );
  return payload;
}

test('租户级策略：各租户独立自动审批，互不影响', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const { tokens, request } = server;

  // 创建 acme 租户的 admin / publisher
  const acmeAdmin = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'acme-admin', role: 'admin', tenant: 'acme' },
  });
  assert.equal(acmeAdmin.status, 201);
  const acmePublisher = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'acme-pub', role: 'publisher', tenant: 'acme' },
  });
  const acmeAdminToken = acmeAdmin.data.token;
  const acmePubToken = acmePublisher.data.token;
  assert.equal(acmeAdmin.data.user.tenant, 'acme');

  // 默认租户策略未启用
  const defaultPolicy = await request('GET', '/policy', { token: tokens.admin });
  assert.equal(defaultPolicy.data.policy.autoApprove.enabled, false);
  assert.equal(defaultPolicy.data.source, 'default');

  // acme 启用自动审批
  const put = await request('PUT', '/policy', {
    token: acmeAdminToken,
    body: { policy: { autoApprove: { enabled: true, kinds: ['skill'] } } },
  });
  assert.equal(put.status, 200);
  const acmePolicy = await request('GET', '/policy', { token: acmeAdminToken });
  assert.equal(acmePolicy.data.policy.autoApprove.enabled, true);
  assert.equal(acmePolicy.data.source, 'tenant');
  assert.equal(acmePolicy.data.tenant, 'acme');

  // 默认租户仍然未启用
  const defaultAfter = await request('GET', '/policy', { token: tokens.admin });
  assert.equal(defaultAfter.data.policy.autoApprove.enabled, false);

  // acme 发布 → 自动审批上架；默认租户不可见
  const published = await request('POST', '/packages', { token: acmePubToken, body: skill('acme-skill') });
  assert.equal(published.status, 201);
  assert.equal(published.data.version.status, 'published');
  assert.equal(published.data.autoApproved, true);

  const defaultList = await request('GET', '/packages', { token: tokens.admin });
  assert.ok(!defaultList.data.items.some((item) => item.name === 'acme-skill'));
  const acmeList = await request('GET', '/packages', { token: acmePubToken });
  assert.ok(acmeList.data.items.some((item) => item.name === 'acme-skill'));

  // 默认租户发布同名包 → 冲突
  const conflict = await request('POST', '/packages', { token: tokens.publisher, body: skill('acme-skill') });
  assert.equal(conflict.status, 409);
});

test('租户配额：包数量 / 单包版本数 / 存储上限生效，默认租户不受影响', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const { tokens, request } = server;

  const acmeAdmin = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'acme-admin2', role: 'admin', tenant: 'acme' },
  });
  const acmePublisher = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'acme-pub2', role: 'publisher', tenant: 'acme' },
  });
  const acmeAdminToken = acmeAdmin.data.token;
  const acmePubToken = acmePublisher.data.token;

  // 单包版本上限 1
  await request('PUT', '/policy', {
    token: acmeAdminToken,
    body: { policy: { quota: { maxVersionsPerPackage: 1, maxPackages: 1 } } },
  });
  assert.equal((await request('POST', '/packages', { token: acmePubToken, body: skill('quota-skill', '0.1.0') })).status, 201);
  const tooManyVersions = await request('POST', '/packages', {
    token: acmePubToken,
    body: skill('quota-skill', '0.2.0'),
  });
  assert.equal(tooManyVersions.status, 422);
  assert.equal(tooManyVersions.data.error.details.quota, 'maxVersionsPerPackage');

  // 包数量上限 1：第二个包被拒
  const tooManyPackages = await request('POST', '/packages', {
    token: acmePubToken,
    body: skill('quota-skill-two', '0.1.0'),
  });
  assert.equal(tooManyPackages.status, 422);
  assert.equal(tooManyPackages.data.error.details.quota, 'maxPackages');

  // 存储上限：设为 1 字节 → 拒绝
  await request('PUT', '/policy', {
    token: acmeAdminToken,
    body: { policy: { quota: { maxPackages: 0, maxVersionsPerPackage: 0, maxStorageBytes: 1 } } },
  });
  const storage = await request('POST', '/packages', {
    token: acmePubToken,
    body: skill('quota-skill-three', '0.1.0'),
  });
  assert.equal(storage.status, 422);
  assert.equal(storage.data.error.details.quota, 'maxStorageBytes');

  // 默认租户没有配额限制，可以继续发布
  const normal = await request('POST', '/packages', { token: tokens.publisher, body: skill('normal-skill') });
  assert.equal(normal.status, 201);

  // 非法配额（负数）→ 400
  const invalid = await request('PUT', '/policy', {
    token: acmeAdminToken,
    body: { policy: { quota: { maxPackages: -1 } } },
  });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.error.code);
});
