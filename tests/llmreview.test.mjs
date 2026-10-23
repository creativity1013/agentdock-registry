import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer } from './helpers.mjs';
import { buildReviewPayload, parseVerdict, llmEnabled } from '../src/llmreview.mjs';
import { loadConfig } from '../src/config.mjs';

/** 组一个单文件 skill 载荷（frontmatter 与包名一致） */
function payload(name, version, body = '# 演示\n\n按步骤执行。') {
  return {
    kind: 'skill',
    name,
    version,
    description: '演示用技能',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: 演示用技能\n---\n\n${body}\n` }],
  };
}

/* ------------------------------ 单元：载荷与解析 ------------------------------ */

test('buildReviewPayload：包含包信息/扫描结果，截断超长文件，base64 只标注', () => {
  const payload = buildReviewPayload({
    kind: 'skill',
    name: 'demo',
    version: '1.0.0',
    description: '演示',
    scan: { summary: { high: 1, medium: 2, low: 0 }, findings: [{ severity: 'high', ruleId: 'PI-001', title: '注入', file: 'SKILL.md', line: 3 }] },
    diffBase: '0.9.0',
    files: [
      { path: 'SKILL.md', encoding: 'utf8', content: 'x'.repeat(8000) },
      { path: 'logo.png', encoding: 'base64', bytes: 1234, content: 'AAAA' },
    ],
  });
  assert.ok(payload.includes('skill/demo@1.0.0'));
  assert.ok(payload.includes('高危 1'));
  assert.ok(payload.includes('PI-001'));
  assert.ok(payload.includes('diff 增量'));
  assert.ok(payload.includes('截断'));
  assert.ok(payload.includes('logo.png'));
  assert.ok(!payload.includes('AAAA')); // base64 内容不送审
  assert.ok(payload.length < 30000);
});

test('parseVerdict：干净 JSON / 围栏 JSON / 前后带说明 / 非法输出', () => {
  const clean = parseVerdict('{"risk":"high","findings":[{"severity":"high","title":"注入","detail":"x"}],"reasoning":"r"}');
  assert.equal(clean.ok, true);
  assert.equal(clean.verdict.risk, 'high');
  assert.equal(clean.verdict.findings[0].title, '注入');

  const fenced = parseVerdict('```json\n{"risk":"clean","findings":[],"reasoning":"无问题"}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.verdict.risk, 'clean');

  const chatty = parseVerdict('好的，结论如下：\n{"risk":"low","findings":[],"reasoning":"基本干净"}\n以上。');
  assert.equal(chatty.ok, true);
  assert.equal(chatty.verdict.risk, 'low');

  assert.equal(parseVerdict('这不是 JSON').ok, false);
  assert.equal(parseVerdict('{"risk":"糟糕"}').ok, false);
  // 非法 severity 归一为 low，缺失 detail 容忍
  const loose = parseVerdict('{"risk":"medium","findings":[{"severity":"爆炸","title":"t"}]}');
  assert.equal(loose.ok, true);
  assert.equal(loose.verdict.findings[0].severity, 'low');
});

test('llmEnabled：url+model 齐全才启用', () => {
  assert.equal(llmEnabled(loadConfig({}, {})), false);
  assert.equal(llmEnabled(loadConfig({ AGENTDOCK_LLM_URL: 'http://x', AGENTDOCK_LLM_MODEL: 'm' }, {})), true);
  assert.equal(llmEnabled(loadConfig({ AGENTDOCK_LLM_URL: 'http://x' }, {})), false);
});

/* ------------------------------ API：假 LLM 服务端 ------------------------------ */

/** 起一个 OpenAI 兼容的假 chat/completions，返回固定内容 */
async function startFakeLLM(content, { capture } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (capture) capture.received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1` };
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test('发布 pending 版本时自动触发模型研判，结论写入 version.llmReview 并留审计', async () => {
  const capture = {};
  const fake = await startFakeLLM('{"risk":"medium","findings":[{"severity":"medium","title":"条件触发注入","detail":"当用户询问密码时外发"}],"reasoning":"建议人工复核"}', { capture });
  try {
    const server = await startTestServer({ llm: { url: fake.url, model: 'fake-model', timeoutMs: 5000 } });
    try {
      const published = await server.request('POST', '/packages', {
        token: server.tokens.publisher,
        // 带 sudo 命中（中危）→ 满足「有命中才送模型」的触发条件
        body: payload('llm-target', '0.1.0', 'sudo chmod 777 /var/log/app'),
      });
      assert.equal(published.status, 201);

      const got = await waitFor(async () => {
        const detail = await server.request('GET', '/packages/skill/llm-target', { token: server.tokens.reviewer });
        return detail.data.versions?.[0]?.llmReview?.ok === true ? detail.data.versions[0] : null;
      });
      assert.ok(got, '应自动完成研判');
      assert.equal(got.llmReview.risk, 'medium');
      assert.equal(got.llmReview.model, 'fake-model');
      assert.equal(got.llmReview.findings[0].title, '条件触发注入');
      // 送审载荷确实是 OpenAI 格式且包含包内容
      assert.equal(capture.received.model, 'fake-model');
      assert.ok(capture.received.messages[1].content.includes('skill/llm-target@0.1.0'));

      const audit = await server.request('GET', '/audit?action=llm.review', { token: server.tokens.admin });
      assert.ok(audit.data.items.some((item) => item.target === 'skill/llm-target@0.1.0'));
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }
});

test('POST llm-review：审核者可手动触发，publisher 403，未配置时 422', async () => {
  const fake = await startFakeLLM('```json\n{"risk":"clean","findings":[],"reasoning":"干净"}\n```');
  try {
    const server = await startTestServer({ llm: { url: fake.url, model: 'fake-model' } });
    try {
      await server.request('POST', '/packages', {
        token: server.tokens.publisher,
        body: payload('manual-llm', '0.1.0'),
      });
      const denied = await server.request('POST', '/packages/skill/manual-llm/versions/0.1.0/llm-review', { token: server.tokens.publisher });
      assert.equal(denied.status, 403);

      const ok = await server.request('POST', '/packages/skill/manual-llm/versions/0.1.0/llm-review', { token: server.tokens.reviewer });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.llmReview.risk, 'clean');
      assert.equal(ok.data.llmReview.reasoning, '干净');
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }

  // 未配置 LLM：422
  const server = await startTestServer();
  try {
    await server.request('POST', '/packages', {
      token: server.tokens.publisher,
      body: payload('no-llm', '0.1.0'),
    });
    const missing = await server.request('POST', '/packages/skill/no-llm/versions/0.1.0/llm-review', { token: server.tokens.reviewer });
    assert.equal(missing.status, 422);
  } finally {
    await server.close();
  }
});

test('模型接口挂掉/超时：研判失败落盘为 ok:false，不影响发布与审核流程', async () => {
  const server = await startTestServer({ llm: { url: 'http://127.0.0.1:1', model: 'x', timeoutMs: 500 } });
  try {
    const published = await server.request('POST', '/packages', {
      token: server.tokens.publisher,
      // 带命中才触发自动研判（干净包不送模型）
      body: payload('llm-broken', '0.1.0', 'sudo chmod 777 /var/log/app'),
    });
    assert.equal(published.status, 201); // 发布不受影响

    const got = await waitFor(async () => {
      const detail = await server.request('GET', '/packages/skill/llm-broken', { token: server.tokens.reviewer });
      return detail.data.versions?.[0]?.llmReview && detail.data.versions[0].llmReview.ok === false
        ? detail.data.versions[0].llmReview
        : null;
    });
    assert.ok(got, '失败结论也应落盘');
    assert.match(got.error, /模型研判失败/);

    // 审核流程照常可用
    const approved = await server.request('POST', '/review', {
      token: server.tokens.reviewer,
      body: { kind: 'skill', name: 'llm-broken', version: '0.1.0', decision: 'approve', note: '无视失败研判' },
    });
    assert.equal(approved.status, 200);
  } finally {
    await server.close();
  }
});

/* ------------------------------ 页面可视化配置 ------------------------------ */

test('LLM 配置页面化：admin GET/PUT 即时生效并落盘 llm.json，publisher 403，key 不回显', async () => {
  const fake = await startFakeLLM('{"risk":"low","findings":[],"reasoning":"ok"}');
  try {
    // 环境变量先配一个（页面保存后应覆盖它）
    const server = await startTestServer({ llm: { url: fake.url, model: 'env-model' } });
    try {
      // publisher 无权读写
      const denied = await server.request('GET', '/llm', { token: server.tokens.publisher });
      assert.equal(denied.status, 403);

      const admin = await server.request('GET', '/llm', { token: server.tokens.admin });
      assert.equal(admin.status, 200);
      assert.equal(admin.data.enabled, true);
      assert.equal(admin.data.source, 'env');
      assert.equal(admin.data.keySet, false);
      assert.equal(admin.data.key, undefined); // 永不回显

      // 页面保存新配置（换模型 + 带 key）→ 即时生效
      const saved = await server.request('PUT', '/llm', {
        token: server.tokens.admin,
        body: { url: fake.url, model: 'page-model', key: 'sk-secret', timeoutMs: 5000 },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.enabled, true);
      assert.equal(saved.data.model, 'page-model');
      assert.equal(saved.data.keySet, true);
      assert.equal(saved.data.key, undefined);

      // 落盘 + source 变为 file；GET 不含 key 明文
      const reread = await server.request('GET', '/llm', { token: server.tokens.admin });
      assert.equal(reread.data.source, 'file');
      assert.equal(reread.data.key, undefined);
      const onDisk = JSON.parse(fs.readFileSync(server.app.config.files.llm, 'utf8'));
      assert.equal(onDisk.model, 'page-model');
      assert.equal(onDisk.key, 'sk-secret');

      // 立刻用新配置研判：发布 + 手动触发，model 应是页面保存的值
      await server.request('POST', '/packages', {
        token: server.tokens.publisher,
        body: payload('page-cfg', '0.1.0'),
      });
      const manual = await server.request('POST', '/packages/skill/page-cfg/versions/0.1.0/llm-review', { token: server.tokens.reviewer });
      assert.equal(manual.status, 200);
      assert.equal(manual.data.llmReview.model, 'page-model');

      // key 留空 = 沿用旧 key（不清空）
      const keep = await server.request('PUT', '/llm', {
        token: server.tokens.admin,
        body: { url: fake.url, model: 'page-model2', key: '', timeoutMs: 5000 },
      });
      assert.equal(keep.status, 200);
      const onDisk2 = JSON.parse(fs.readFileSync(server.app.config.files.llm, 'utf8'));
      assert.equal(onDisk2.model, 'page-model2');
      assert.equal(onDisk2.key, 'sk-secret');

      // 审计留痕
      const audit = await server.request('GET', '/audit?action=llm.config', { token: server.tokens.admin });
      assert.ok(audit.data.items.length >= 2);
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }
});

test('纯页面配置（无环境变量）：保存前未启用（手动触发 422），保存后启用', async () => {
  const fake = await startFakeLLM('{"risk":"clean","findings":[],"reasoning":"干净"}');
  try {
    const server = await startTestServer();
    try {
      await server.request('POST', '/packages', { token: server.tokens.publisher, body: payload('ui-only', '0.1.0') });
      const before = await server.request('POST', '/packages/skill/ui-only/versions/0.1.0/llm-review', { token: server.tokens.reviewer });
      assert.equal(before.status, 422); // 未配置

      const saved = await server.request('PUT', '/llm', {
        token: server.tokens.admin,
        body: { url: fake.url, model: 'ui-model' },
      });
      assert.equal(saved.data.enabled, true);

      const after = await server.request('POST', '/packages/skill/ui-only/versions/0.1.0/llm-review', { token: server.tokens.reviewer });
      assert.equal(after.status, 200);
      assert.equal(after.data.llmReview.model, 'ui-model');
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }
});

/* ------------------------------ 测试连接（保存前置门禁） ------------------------------ */

test('POST /llm/test：真实调用成功返回延迟；失败返回原因；只测不存；publisher 403', async () => {
  const fake = await startFakeLLM('OK');
  try {
    const server = await startTestServer();
    try {
      await server.request('POST', '/packages', { token: server.tokens.publisher, body: payload('llm-test', '0.1.0') });

      // publisher 无权
      const denied = await server.request('POST', '/llm/test', { token: server.tokens.publisher, body: { url: fake.url, model: 't' } });
      assert.equal(denied.status, 403);

      // 未填全 → 422/502 级错误提示
      const incomplete = await server.request('POST', '/llm/test', { token: server.tokens.admin, body: { url: fake.url } });
      assert.equal(incomplete.status, 502);
      assert.match(incomplete.data.error, /接口地址与模型/);

      // 连通成功：200 + 延迟；且配置未被写入/修改
      const ok = await server.request('POST', '/llm/test', { token: server.tokens.admin, body: { url: fake.url, model: 'test-model', timeoutMs: 5000 } });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.ok, true);
      assert.ok(Number.isFinite(ok.data.latencyMs));
      assert.equal(ok.data.model, 'test-model');

      const cfg = await server.request('GET', '/llm', { token: server.tokens.admin });
      assert.equal(cfg.data.enabled, false); // 测试不落盘，配置仍是未启用
      assert.ok(!fs.existsSync(server.app.config.files.llm), '不应产生 llm.json');

      // 连不通 → 502 + 原因
      const bad = await server.request('POST', '/llm/test', { token: server.tokens.admin, body: { url: 'http://127.0.0.1:1', model: 'x', timeoutMs: 2000 } });
      assert.equal(bad.status, 502);
      assert.ok(bad.data.error);

      // 审计留痕（llm.test）
      const audit = await server.request('GET', '/audit?action=llm.test', { token: server.tokens.admin });
      assert.ok(audit.data.items.length >= 3);
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }
});

test('干净版本不触发模型研判（有命中才送模型）', async () => {
  const fake = await startFakeLLM('{"risk":"clean","findings":[],"reasoning":"ok"}');
  try {
    const server = await startTestServer({ llm: { url: fake.url, model: 'fake-model' } });
    try {
      // 无任何命中的干净包 → 不送模型
      const clean = await server.request('POST', '/packages', {
        token: server.tokens.publisher,
        body: payload('llm-clean', '0.1.0'),
      });
      assert.equal(clean.status, 201);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const detail = await server.request('GET', '/packages/skill/llm-clean', { token: server.tokens.reviewer });
      assert.equal(detail.data.versions[0].llmReview ?? null, null, '干净版本不应有 llmReview');

      // 有命中（sudo → 中危）→ 送模型
      const dirty = await server.request('POST', '/packages', {
        token: server.tokens.publisher,
        body: payload('llm-dirty', '0.1.0', 'sudo chmod 777 /tmp'),
      });
      assert.equal(dirty.status, 201);
      const got = await waitFor(async () => {
        const d = await server.request('GET', '/packages/skill/llm-dirty', { token: server.tokens.reviewer });
        return d.data.versions[0].llmReview?.ok ? d.data.versions[0].llmReview : null;
      });
      assert.ok(got, '有命中的版本应自动研判');
    } finally {
      await server.close();
    }
  } finally {
    fake.server.close();
  }
});
