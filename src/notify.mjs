import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
  sha256,
} from './util.mjs';
import { badRequest } from './errors.mjs';

/**
 * 事件通知：发布/审核结果推送到 webhook 或 IM（Slack / Discord / 飞书 / 钉钉 / 企业微信）。
 * 零依赖：只用全局 fetch 与 node:crypto（sha256 通过 util 提供 HMAC 由 crypto 处理）。
 * 安全边界：webhook URL 只能由 admin 通过 API/CLI/配置文件设置（不接受请求体里的任意 URL），
 * 出站固定 5s 超时、失败只审计不外抛。
 */

export const NOTIFY_SCHEMA = 'agentdock-notify@1';
export const NOTIFY_EVENTS = [
  'package.published',
  'review.approved',
  'review.rejected',
  'review.auto_approved',
];
export const NOTIFY_EVENT_LABEL = {
  'package.published': '新版本待审核',
  'review.approved': '审核通过',
  'review.rejected': '审核拒绝',
  'review.auto_approved': '策略自动通过',
};
export const NOTIFY_FORMATS = ['json', 'slack', 'discord', 'feishu', 'dingtalk', 'wecom'];

const MAX_WEBHOOKS = 10;
const FETCH_TIMEOUT_MS = 5000;

export function defaultNotify() {
  return { schema: NOTIFY_SCHEMA, enabled: false, webhooks: [] };
}

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`webhook URL 不合法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(`webhook URL 只支持 http/https：${url}`);
  }
  return parsed.toString();
}

/** 校验并补全通知配置（enabled / webhooks[name,url,format,events,secret]） */
export function normalizeNotifyConfig(input, base = defaultNotify()) {
  if (!input || typeof input !== 'object') throw badRequest('通知配置必须是对象');
  const enabled = input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled);
  const rawHooks = Array.isArray(input.webhooks) ? input.webhooks : base.webhooks || [];
  if (rawHooks.length > MAX_WEBHOOKS) throw badRequest(`webhook 数量不能超过 ${MAX_WEBHOOKS}`);
  const webhooks = rawHooks.map((hook, index) => {
    if (!hook || typeof hook !== 'object') throw badRequest(`第 ${index + 1} 个 webhook 必须是对象`);
    const url = assertHttpUrl(String(hook.url || ''));
    const format = hook.format || 'json';
    if (!NOTIFY_FORMATS.includes(format)) {
      throw badRequest(`webhook 格式必须是 ${NOTIFY_FORMATS.join(' / ')}`);
    }
    const events = Array.isArray(hook.events) && hook.events.length ? hook.events : [];
    for (const event of events) {
      if (!NOTIFY_EVENTS.includes(event)) throw badRequest(`未知通知事件：${event}`);
    }
    const name = String(hook.name || `webhook-${index + 1}`).trim().slice(0, 64) || `webhook-${index + 1}`;
    const result = { name, url, format, events };
    if (hook.secret) result.secret = String(hook.secret).slice(0, 256);
    return result;
  });
  return { schema: NOTIFY_SCHEMA, enabled, webhooks };
}

export function loadNotify(config) {
  const file = config.files.notify;
  const raw = readJson(file, null);
  if (!raw) return { notify: defaultNotify(), source: 'default', file };
  try {
    return { notify: normalizeNotifyConfig(raw), source: 'file', file };
  } catch {
    return { notify: defaultNotify(), source: 'invalid-file', file };
  }
}

export function saveNotify(config, notify) {
  const file = config.files.notify;
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, normalizeNotifyConfig(notify));
  return file;
}

function eventText(event) {
  const label = NOTIFY_EVENT_LABEL[event.type] || event.type;
  const data = event.data || {};
  const subject = [data.kind, data.name].filter(Boolean).join('/');
  const version = data.version ? `@${data.version}` : '';
  const actor = data.actor || data.submittedBy || '';
  const lines = [
    `[AgentDock] ${label}`,
    subject ? `能力：${subject}${version}` : '',
    data.tenant && data.tenant !== 'default' ? `租户：${data.tenant}` : '',
    actor ? `操作者：${actor}` : '',
    data.autoApproved ? '（策略自动通过）' : '',
    data.reason ? `原因：${data.reason}` : '',
    `时间：${event.at}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** 渲染各 webhook 平台的请求体 */
export function renderPayload(format, event) {
  const text = eventText(event);
  switch (format) {
    case 'slack':
    case 'discord':
      return { contentType: 'application/json', body: JSON.stringify({ text }) };
    case 'feishu':
      return { contentType: 'application/json', body: JSON.stringify({ msg_type: 'text', content: { text } }) };
    case 'dingtalk':
      return { contentType: 'application/json', body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
    case 'wecom':
      return { contentType: 'application/json', body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
    case 'json':
      return { contentType: 'application/json', body: JSON.stringify({ event: event.type, text, data: event.data, at: event.at }) };
    default:
      throw badRequest(`未知 webhook 格式：${format}`);
  }
}

/** HMAC-SHA256 签名（十六进制），头 x-agentdock-signature: sha256=<hex> */
export async function signBody(secret, body) {
  const { createHmac } = await import('node:crypto');
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** 创建通知器：emit 只做投递与审计，失败不抛错；配置从通知器内缓存读取 */
export function createNotifier(config, audit) {
  let loaded = loadNotify(config);
  const get = () => loaded.notify;
  const set = (next) => {
    loaded = { notify: normalizeNotifyConfig(next), source: 'memory', file: loaded.file };
    saveNotify(config, loaded.notify);
    return loaded.notify;
  };
  const reload = () => {
    loaded = loadNotify(config);
    return loaded;
  };

  async function emit(type, data = {}) {
    const notify = get();
    if (!notify.enabled || notify.webhooks.length === 0) return { sent: 0, results: [] };
    const event = { type, at: new Date().toISOString(), data };
    const results = [];
    for (const hook of notify.webhooks) {
      if (hook.events.length && !hook.events.includes(type)) continue;
      const { contentType, body } = renderPayload(hook.format, event);
      const headers = { 'content-type': contentType, 'user-agent': 'AgentDock/0.1' };
      let signature = null;
      if (hook.secret) {
        signature = await signBody(hook.secret, body);
        headers['x-agentdock-signature'] = signature;
      }
      try {
        const response = await fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        results.push({ name: hook.name, ok: response.ok, status: response.status });
        audit?.append({
          actor: 'system',
          role: 'system',
          action: response.ok ? 'notify.sent' : 'notify.failed',
          target: hook.name,
          meta: { event: type, status: response.status, urlHost: new URL(hook.url).host },
          ip: '',
        });
      } catch (error) {
        results.push({ name: hook.name, ok: false, error: error.message });
        audit?.append({
          actor: 'system',
          role: 'system',
          action: 'notify.failed',
          target: hook.name,
          meta: { event: type, error: error.message, urlHost: new URL(hook.url).host },
          ip: '',
        });
      }
    }
    return { sent: results.length, results };
  }

  return { get, set, reload, emit };
}

/** 供调用方生成简单事件摘要（测试/文档用） */
export function eventDigest(event) {
  return sha256(JSON.stringify(event)).slice(0, 16);
}
