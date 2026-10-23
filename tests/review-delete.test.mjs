import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';

function payload(name, version, body = '# 演示\n\n按步骤执行。') {
  return {
    kind: 'skill',
    name,
    version,
    description: '演示用技能',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: 演示用技能\n---\n\n${body}\n` }],
  };
}

const pub = (server, body) => server.request('POST', '/packages', { token: server.tokens.publisher, body });

test('review/delete：单个删除、批量删除、已发布拒删、publisher 403、审计留痕', async () => {
  const server = await startTestServer();
  try {
    await pub(server, payload('del-a', '0.1.0'));
    await pub(server, payload('del-b', '0.1.0'));
    await pub(server, payload('del-c', '0.1.0'));
    // 一个已发布版本用于负例
    await pub(server, payload('del-keep', '0.1.0'));
    await server.request('POST', '/review', { token: server.tokens.reviewer, body: { kind: 'skill', name: 'del-keep', version: '0.1.0', decision: 'approve' } });

    // publisher 无权
    const denied = await server.request('POST', '/review/delete', {
      token: server.tokens.publisher,
      body: { entries: [{ kind: 'skill', name: 'del-a', version: '0.1.0' }] },
    });
    assert.equal(denied.status, 403);

    // 单个删除
    const one = await server.request('POST', '/review/delete', {
      token: server.tokens.reviewer,
      body: { entries: [{ kind: 'skill', name: 'del-a', version: '0.1.0' }] },
    });
    assert.equal(one.status, 200);
    assert.equal(one.data.ok, true);
    assert.equal(one.data.deleted, 1);
    // 版本从详情中消失（包壳 versions 清空；直接取该版本 404）
    const gone = await server.request('GET', '/packages/skill/del-a', { token: server.tokens.reviewer });
    assert.deepEqual(gone.data.versions, []);
    const versionGone = await server.request('GET', '/packages/skill/del-a/versions/0.1.0', { token: server.tokens.reviewer });
    assert.equal(versionGone.status, 404);
    // 磁盘文件一并清除
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const versionDir = join(server.app.config.files.packages, 'skill', 'del-a', '0.1.0');
    assert.equal(existsSync(versionDir), false);

    // 已发布版本拒删
    const published = await server.request('POST', '/review/delete', {
      token: server.tokens.reviewer,
      body: { entries: [{ kind: 'skill', name: 'del-keep', version: '0.1.0' }] },
    });
    assert.equal(published.status, 200);
    assert.equal(published.data.ok, false);
    assert.equal(published.data.deleted, 0);
    assert.match(published.data.failed[0].error, /仅待审核版本/);

    // 批量删除：一个成功 + 一个不存在（部分失败不影响其余）
    const batch = await server.request('POST', '/review/delete', {
      token: server.tokens.reviewer,
      body: { entries: [
        { kind: 'skill', name: 'del-b', version: '0.1.0' },
        { kind: 'skill', name: 'del-c', version: '0.1.0' },
        { kind: 'skill', name: 'del-b', version: '9.9.9' },
      ] },
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.data.ok, false);
    assert.equal(batch.data.deleted, 2);
    assert.equal(batch.data.failed.length, 1);

    // 队列清空
    const queue = await server.request('GET', '/review/queue', { token: server.tokens.reviewer });
    assert.equal(queue.data.total, 0);

    // 审计留痕：3 条 review.delete
    const audit = await server.request('GET', '/audit?action=review.delete', { token: server.tokens.admin });
    assert.equal(audit.data.items.length, 3);
    assert.ok(audit.data.items.some((item) => item.meta?.batch === true));
  } finally {
    await server.close();
  }
});
