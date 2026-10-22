import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, skillPayload } from './helpers.mjs';

const makeSkill = (name) =>
  skillPayload({
    name,
    files: [
      {
        path: 'SKILL.md',
        encoding: 'utf8',
        content: `---\nname: ${name}\ndescription: 租户隔离测试\n---\n\n# ${name}\n`,
      },
    ],
  });

test('多租户：发布/市场/详情/审核队列按租户隔离，跨租户不可见', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const { request, tokens } = server;

  const create = async (name, role, tenant) => {
    const result = await request('POST', '/admin/tokens', {
      token: tokens.admin,
      body: { name, role, tenant },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.token;
  };
  const acmePublisher = await create('acme-publisher', 'publisher', 'acme');
  const acmeReviewer = await create('acme-reviewer', 'reviewer', 'acme');

  // 默认租户看不到租户创建前的状态：先发一个默认租户包
  const defaultPublish = await request('POST', '/packages', {
    token: tokens.publisher,
    body: makeSkill('shared-skill'),
  });
  assert.equal(defaultPublish.status, 201);
  const sharedApprove = await request('POST', '/review', {
    token: tokens.reviewer,
    body: { kind: 'skill', name: 'shared-skill', version: '0.1.0', decision: 'approve' },
  });
  assert.equal(sharedApprove.status, 200);
  // acme 包
  const acmePublish = await request('POST', '/packages', {
    token: acmePublisher,
    body: makeSkill('acme-skill'),
  });
  assert.equal(acmePublish.status, 201, JSON.stringify(acmePublish.data));

  const defaultList = await request('GET', '/packages');
  const defaultNames = defaultList.data.items.map((item) => item.name);
  assert.ok(defaultNames.includes('shared-skill'));
  assert.ok(!defaultNames.includes('acme-skill'), '默认租户不应看到 acme 的包');

  const acmeList = await request('GET', '/packages?status=pending', { token: acmeReviewer });
  const acmeNames = acmeList.data.items.map((item) => item.name);
  assert.deepEqual(acmeNames, ['acme-skill']);
  assert.equal(acmeList.data.items[0].tenant, 'acme');
  assert.ok(!acmeNames.includes('shared-skill'));

  // 详情跨租户 404
  assert.equal((await request('GET', '/packages/skill/acme-skill')).status, 404);
  assert.equal((await request('GET', '/packages/skill/acme-skill', { token: acmePublisher })).status, 200);

  // 审核队列隔离
  const defaultQueue = await request('GET', '/review/queue', { token: tokens.reviewer });
  assert.equal(defaultQueue.data.total, 0);
  const acmeQueue = await request('GET', '/review/queue', { token: acmeReviewer });
  assert.equal(acmeQueue.data.total, 1);
  assert.equal(acmeQueue.data.items[0].name, 'acme-skill');

  // 审核后仍隔离
  const approved = await request('POST', '/review', {
    token: acmeReviewer,
    body: { kind: 'skill', name: 'acme-skill', version: '0.1.0', decision: 'approve', note: 'ok' },
  });
  assert.equal(approved.status, 200);
  const defaultAfter = await request('GET', '/packages');
  assert.ok(!defaultAfter.data.items.some((item) => item.name === 'acme-skill'));
  // 跨租户审核被拒绝
  const crossReview = await request('POST', '/review', {
    token: tokens.reviewer,
    body: { kind: 'skill', name: 'acme-skill', version: '0.1.0', decision: 'approve' },
  });
  assert.equal(crossReview.status, 404);
  // 跨租户同名冲突
  const conflict = await request('POST', '/packages', { token: tokens.publisher, body: makeSkill('acme-skill') });
  assert.equal(conflict.status, 409);
});

test('多租户：统计与安装目标按请求租户归属', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const { request, tokens } = server;
  const created = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'beta-publisher', role: 'publisher', tenant: 'beta' },
  });
  const beta = created.data.token;
  await request('POST', '/packages', { token: beta, body: makeSkill('beta-skill') });
  const betaStats = await request('GET', '/stats', { token: beta });
  assert.equal(betaStats.data.packages, 1);
  assert.equal(betaStats.data.versions, 1);
  const defaultStats = await request('GET', '/stats', { token: tokens.publisher });
  assert.equal(defaultStats.data.packages, 0);
});

test('多租户：非法 tenant 名创建令牌被拒绝', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const { request, tokens } = server;
  const bad = await request('POST', '/admin/tokens', {
    token: tokens.admin,
    body: { name: 'bad-tenant', role: 'publisher', tenant: 'Bad Tenant!' },
  });
  assert.equal(bad.status, 400);
});
