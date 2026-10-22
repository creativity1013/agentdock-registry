import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import {
  NOTIFY_EVENTS,
  createNotifier,
  defaultNotify,
  loadNotify,
  normalizeNotifyConfig,
  renderPayload,
  signBody,
} from '../src/notify.mjs';
import { loadConfig } from '../src/config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { startTestServer, skillPayload } from './helpers.mjs';

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-notify-'));
  const config = loadConfig({}, { dataDir: path.join(root, 'data'), home: path.join(root, 'home'), port: 0 });
  return { config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function startWebhookServer() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null, raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('通知：各平台 payload 渲染与 HMAC 签名', async () => {
  const event = { type: 'package.published', at: '2026-01-01T00:00:00.000Z', data: { kind: 'skill', name: 'demo', version: '1.0.0', tenant: 'acme' } };
  const json = renderPayload('json', event);
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.event, 'package.published');
  assert.match(parsed.text, /skill\/demo@1\.0\.0/);
  assert.equal(JSON.parse(renderPayload('slack', event).body).text, parsed.text);
  assert.equal(JSON.parse(renderPayload('feishu', event).body).msg_type, 'text');
  assert.equal(JSON.parse(renderPayload('dingtalk', event).body).msgtype, 'text');
  assert.equal(JSON.parse(renderPayload('wecom', event).body).msgtype, 'text');
  const signature = await signBody('s3cret', json.body);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
});

test('通知：配置校验（URL/格式/事件/数量）与默认值', () => {
  assert.deepEqual(defaultNotify(), { schema: 'agentdock-notify@1', enabled: false, webhooks: [] });
  const normalized = normalizeNotifyConfig({
    enabled: true,
    webhooks: [
      { url: 'https://hooks.slack.com/services/x', format: 'slack' },
      { name: 'im', url: 'http://127.0.0.1:9/hook', format: 'feishu', events: ['review.approved'], secret: 'k' },
    ],
  });
  assert.equal(normalized.webhooks.length, 2);
  assert.equal(normalized.webhooks[0].name, 'webhook-1');
  assert.throws(() => normalizeNotifyConfig({ webhooks: [{ url: 'ftp://x/y' }] }), /只支持 http\/https/);
  assert.throws(() => normalizeNotifyConfig({ webhooks: [{ url: 'https://x/y', format: 'email' }] }), /格式必须是/);
  assert.throws(() => normalizeNotifyConfig({ webhooks: [{ url: 'https://x/y', events: ['nope'] }] }), /未知通知事件/);
  assert.ok(NOTIFY_EVENTS.includes('review.auto_approved'));
});

test('通知：emit 按事件过滤、失败不抛错且写审计', async (t) => {
  const webhook = await startWebhookServer();
  t.after(() => webhook.close());
  const { config, cleanup } = tempConfig();
  t.after(cleanup);
  const auditEvents = [];
  const notifier = createNotifier(config, { append: (entry) => auditEvents.push(entry) });
  notifier.set({
    enabled: true,
    webhooks: [
      { name: 'all', url: webhook.url, format: 'json' },
      { name: 'only-approve', url: webhook.url, format: 'slack', events: ['review.approved'], secret: 'sec' },
      { name: 'down', url: 'http://127.0.0.1:1/hook', format: 'json', events: ['package.published'] },
    ],
  });
  const result = await notifier.emit('package.published', { kind: 'skill', name: 'demo', version: '0.1.0' });
  assert.equal(result.sent, 2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(webhook.received.length, 1);
  assert.equal(webhook.received[0].body.event, 'package.published');
  assert.ok(auditEvents.some((entry) => entry.action === 'notify.failed'));
  assert.equal(notifier.get().enabled, true);
  assert.equal(loadNotify(config).source, 'file');
  await notifier.emit('review.approved', { kind: 'skill', name: 'demo', version: '0.1.0' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const signed = webhook.received.find((item) => item.body?.text);
  assert.ok(webhook.received.some((item) => item.headers['x-agentdock-signature']), '带 secret 的 webhook 应签名');
  void signed;
});

test('通知 API：发布/审核触发 webhook，权限与测试端点', async (t) => {
  const webhook = await startWebhookServer();
  t.after(() => webhook.close());
  const server = await startTestServer();
  t.after(() => server.close());

  const denied = await server.request('PUT', '/notify', { token: server.tokens.publisher, body: { enabled: true, webhooks: [] } });
  assert.equal(denied.status, 403);

  const put = await server.request('PUT', '/notify', {
    token: server.tokens.admin,
    body: { notify: { enabled: true, webhooks: [{ name: 'test-hook', url: webhook.url, format: 'json' }] } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.notify.webhooks.length, 1);

  const testNotify = await server.request('POST', '/notify/test', { token: server.tokens.admin });
  assert.equal(testNotify.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(webhook.received.length >= 1);

  const published = await server.request('POST', '/packages', { token: server.tokens.publisher, body: skillPayload() });
  assert.equal(published.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(webhook.received.some((item) => item.body?.data?.name === 'demo-skill'));

  const approved = await server.request('POST', '/review', {
    token: server.tokens.reviewer,
    body: { kind: 'skill', name: 'demo-skill', version: '0.1.0', decision: 'approve', note: 'ok' },
  });
  assert.equal(approved.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(webhook.received.some((item) => item.body?.event === 'review.approved'));

  const shown = await server.request('GET', '/notify', { token: server.tokens.admin });
  assert.equal(shown.status, 200);
  assert.equal(shown.data.notify.webhooks[0].name, 'test-hook');
});
