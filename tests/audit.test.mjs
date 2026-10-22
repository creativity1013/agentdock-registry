import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { startTestServer, skillPayload } from './helpers.mjs';
import { AUDIT_GENESIS_HASH, auditEntryHash, createAuditLog } from '../src/audit.mjs';

function tempConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-audit-'));
  return loadConfig(
    {},
    {
      dataDir: path.join(root, 'data'),
      home: path.join(root, 'home'),
      audit: { maxBytes: 0, keep: 0 },
      ...overrides,
    },
  );
}

function rewriteLines(file, transform) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, `${transform(lines).join('\n')}\n`);
}

test('追加记录形成哈希链，verify 全链自洽', () => {
  const config = tempConfig();
  const log = createAuditLog(config);
  assert.equal(log.verify().ok, true);
  assert.equal(log.verify().entries, 0);

  const first = log.append({ actor: 'admin', role: 'admin', action: 'package.publish', target: 'skill/demo', meta: { v: '0.1.0' }, ip: '127.0.0.1' });
  const second = log.append({ actor: 'alice', role: 'publisher', action: 'package.install', target: 'skill/demo', meta: {}, ip: '' });

  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, AUDIT_GENESIS_HASH);
  assert.equal(first.hash, auditEntryHash(first));
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);

  const result = log.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entries, 2);
  assert.equal(result.legacy, 0);
  assert.equal(result.headHash, second.hash);
  assert.equal(result.brokenAt, null);

  // 重新实例化（内存链头丢失）后链仍可校验，且能接着追加
  const reloaded = createAuditLog(config);
  assert.equal(reloaded.verify().ok, true);
  const third = reloaded.append({ action: 'review.approve', actor: 'bob', role: 'reviewer' });
  assert.equal(third.seq, 3);
  assert.equal(third.prevHash, second.hash);
  assert.equal(reloaded.verify().ok, true);
});

test('篡改或删除记录时 verify 能定位断链位置', () => {
  const config = tempConfig();
  const log = createAuditLog(config);
  log.append({ action: 'a', actor: 'x' });
  log.append({ action: 'b', actor: 'y' });

  rewriteLines(config.files.audit, (lines) => {
    const entry = JSON.parse(lines[0]);
    entry.actor = 'attacker';
    lines[0] = JSON.stringify(entry);
    return lines;
  });

  const result = createAuditLog(config).verify();
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('篡改')), `应有篡改原因：${result.reasons}`);
  assert.ok(result.brokenAt);

  // 删除中间记录同样能发现（prevHash 不衔接）
  const config2 = tempConfig();
  const log2 = createAuditLog(config2);
  log2.append({ action: 'a', actor: 'x' });
  log2.append({ action: 'b', actor: 'y' });
  log2.append({ action: 'c', actor: 'z' });
  rewriteLines(config2.files.audit, (lines) => [lines[0], lines[2]]);
  const result2 = createAuditLog(config2).verify();
  assert.equal(result2.ok, false);
  assert.ok(result2.reasons.some((reason) => reason.includes('prevHash')), `应报告断链：${result2.reasons}`);

  // 损坏行（无法解析）也会被报告
  fs.appendFileSync(config2.files.audit, 'not-json\n');
  const result3 = createAuditLog(config2).verify();
  assert.equal(result3.ok, false);
  assert.ok(result3.reasons.some((reason) => reason.includes('无法解析')));
});

test('旧格式（无链字段）记录被跳过并计数，新链从 genesis 重新起链', () => {
  const config = tempConfig();
  fs.mkdirSync(path.dirname(config.files.audit), { recursive: true });
  fs.writeFileSync(
    config.files.audit,
    `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', actor: 'old', role: 'admin', action: 'legacy.op', target: '', meta: {}, ip: '' })}\n`,
  );
  const log = createAuditLog(config);
  const entry = log.append({ action: 'new.op', actor: 'admin', role: 'admin' });
  assert.equal(entry.seq, 1);
  assert.equal(entry.prevHash, AUDIT_GENESIS_HASH);

  const result = log.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entries, 1);
  assert.equal(result.legacy, 1);

  // legacy 记录仍可被查询
  assert.equal(log.read({ action: 'legacy.op' }).total, 1);
});

test('read 支持 action/actor 精确、target 子串与时间范围过滤', () => {
  const config = tempConfig();
  const log = createAuditLog(config);
  log.append({ actor: 'admin', role: 'admin', action: 'package.publish', target: 'skill/Alpha@0.1.0' });
  log.append({ actor: 'alice', role: 'publisher', action: 'package.publish', target: 'agent/beta@1.0.0' });
  log.append({ actor: 'admin', role: 'admin', action: 'policy.update', target: 'policy.json' });

  assert.equal(log.read({ action: 'package.publish' }).total, 2);
  assert.equal(log.read({ actor: 'admin' }).total, 2);
  assert.equal(log.read({ target: 'alpha' }).total, 1); // 子串 + 忽略大小写
  assert.equal(log.read({ target: 'policy' }).items[0].action, 'policy.update');
  assert.equal(log.read({ from: '2999-01-01T00:00:00.000Z' }).total, 0);
  assert.equal(log.read({ to: '2000-01-01T00:00:00.000Z' }).total, 0);
  assert.equal(log.read({}).total, 3);

  // 最新在前 + offset 分页
  const page = log.read({ limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].seq, 2);
  assert.equal(page.items[1].seq, 1);
});

test('CSV 导出按 RFC 4180 转义，jsonl 保持完整 JSON', () => {
  const config = tempConfig();
  const log = createAuditLog(config);
  log.append({ actor: 'admin', role: 'admin', action: 'plain', target: 't', meta: { k: 'v' } });
  log.append({ actor: 'we"ird,actor', role: 'admin', action: 'tricky', target: 'multi\nline', meta: { note: '逗号, 引号" 换行\n' } });

  const csv = log.exportLines({ format: 'csv' });
  assert.equal(csv.contentType, 'text/csv; charset=utf-8');
  const rows = csv.body.trim().split('\r\n');
  assert.equal(rows[0], 'ts,actor,role,action,target,ip,seq,hash,meta');
  assert.ok(rows[2].includes('"we""ird,actor"'));
  assert.ok(rows[2].includes('"multi\nline"'));
  // 时间正序
  assert.ok(csv.body.includes('plain'));

  const jsonl = log.exportLines({ format: 'jsonl' });
  assert.equal(jsonl.contentType, 'application/x-ndjson; charset=utf-8');
  const parsed = jsonl.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].seq, 1);
  assert.deepEqual(parsed[1].meta, { note: '逗号, 引号" 换行\n' });

  // 导出同样支持过滤
  assert.equal(log.exportLines({ format: 'jsonl', action: 'plain' }).body.trim().split('\n').length, 1);
});

test('轮转后归档锚点续链，verify --all 跨文件校验；删除归档报 gap', () => {
  const config = tempConfig({ audit: { maxBytes: 512, keep: 0 } }); // 0 = 归档不限量
  const log = createAuditLog(config);
  for (let i = 0; i < 12; i += 1) {
    log.append({ actor: 'admin', role: 'admin', action: `op.${i}`, target: `t-${i}` });
  }
  const archives = log.archives();
  assert.ok(archives.length >= 2, `应产生多个归档，实际 ${archives.length}`);
  assert.ok(fs.existsSync(config.files.audit), 'active 文件应存在');

  // 全量校验（归档 + active）跨文件衔接通过
  const all = log.verify({ all: true });
  assert.equal(all.ok, true, `verify --all 应通过：${all.reasons}`);
  assert.equal(all.entries, 12);

  // active-only：首条 prevHash 指向归档链头，不因缺少归档误报
  assert.equal(log.verify().ok, true);

  // 删除中间归档 → --all 报 gap（最老归档被删不可检测：链起点之前没有锚，属预期边界）
  assert.ok(archives.length >= 3, `应有至少 3 个归档，实际 ${archives.length}`);
  fs.unlinkSync(archives[1]);
  const gapped = log.verify({ all: true });
  assert.equal(gapped.ok, false);
  assert.ok(
    gapped.reasons.some((reason) => reason.includes('衔接') || reason.includes('prevHash')),
    `应报告归档缺口：${gapped.reasons}`,
  );
});

test('keep 保留策略清理最老归档（保留集连续，--all 仍通过）', () => {
  const config = tempConfig({ audit: { maxBytes: 512, keep: 2 } });
  const log = createAuditLog(config);
  for (let i = 0; i < 24; i += 1) {
    log.append({ actor: 'admin', role: 'admin', action: `op.${i}` });
  }
  assert.ok(log.archives().length <= 2, `归档应被清理到 ≤2，实际 ${log.archives().length}`);
  // 剪枝只删最老前缀 → 保留的归档互相衔接，--all 通过（起点宽松；手动删中间归档才报 gap）
  assert.equal(log.verify({ all: true }).ok, true);
  assert.equal(log.verify().ok, true);
});

/* ------------------------------ HTTP API ------------------------------ */

test('API：/audit 过滤、/audit/verify 校验失败返回 409、权限 403', async () => {
  const server = await startTestServer();
  try {
    await server.request('POST', '/packages', { token: server.tokens.publisher, body: skillPayload() });

    // reviewer 可查
    const list = await server.request('GET', '/audit?limit=10', { token: server.tokens.reviewer });
    assert.equal(list.status, 200);
    assert.ok(list.data.total >= 1);
    const entry = list.data.items[0];
    assert.ok(entry.seq >= 1, '新记录应带链字段');

    // 过滤参数生效
    const byActor = await server.request('GET', `/audit?actor=${encodeURIComponent(entry.actor)}`, { token: server.tokens.reviewer });
    assert.equal(byActor.status, 200);
    assert.ok(byActor.data.total >= 1);
    const none = await server.request('GET', '/audit?actor=no-such-user', { token: server.tokens.reviewer });
    assert.equal(none.data.total, 0);

    // publisher 无权查看 / 校验 / 导出
    for (const pathname of ['/audit', '/audit/verify', '/audit/export?format=csv']) {
      const denied = await server.request('GET', pathname, { token: server.tokens.publisher });
      assert.equal(denied.status, 403, `${pathname} 应 403`);
    }

    // verify 通过
    const ok = await server.request('GET', '/audit/verify', { token: server.tokens.reviewer });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);

    // 篡改 audit.log → verify 409
    rewriteLines(server.config.files.audit, (lines) => {
      const item = JSON.parse(lines[lines.length - 1]);
      item.action = 'tampered';
      lines[lines.length - 1] = JSON.stringify(item);
      return lines;
    });
    const broken = await server.request('GET', '/audit/verify', { token: server.tokens.reviewer });
    assert.equal(broken.status, 409);
    assert.equal(broken.data.ok, false);
    assert.ok(broken.data.brokenAt);

    // 导出格式校验与内容
    const badFormat = await server.request('GET', '/audit/export?format=xml', { token: server.tokens.reviewer });
    assert.equal(badFormat.status, 400);
  } finally {
    await server.close();
  }
});

test('API：/audit/export 返回非 JSON 响应（csv / jsonl）', async () => {
  const server = await startTestServer();
  try {
    await server.request('POST', '/packages', { token: server.tokens.publisher, body: skillPayload() });

    const csvResp = await fetch(`${server.url}/api/v1/audit/export?format=csv`, {
      headers: { Authorization: `Bearer ${server.tokens.reviewer}` },
    });
    assert.equal(csvResp.headers.get('content-type'), 'text/csv; charset=utf-8');
    const csvText = await csvResp.text();
    assert.ok(csvText.startsWith('ts,actor,role,action,target,ip,seq,hash,meta'));

    const jsonlResp = await fetch(`${server.url}/api/v1/audit/export?format=jsonl&actor=publisher`, {
      headers: { Authorization: `Bearer ${server.tokens.reviewer}` },
    });
    assert.equal(jsonlResp.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const lines = (await jsonlResp.text()).trim().split('\n');
    assert.ok(lines.length >= 1);
    assert.ok(JSON.parse(lines[0]).hash);
  } finally {
    await server.close();
  }
});
