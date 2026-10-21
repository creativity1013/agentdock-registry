import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';

/** 启动一个使用临时数据目录的测试服务 */
export async function startTestServer(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-test-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const config = loadConfig(
    {},
    { port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), home, ...overrides },
  );
  const app = createApp(config);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = app.server.address();
  const url = `http://127.0.0.1:${port}`;
  const tokens = Object.fromEntries((app.users.bootstrap || []).map((entry) => [entry.name, entry.token]));

  async function request(method, pathname, { token, body } = {}) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${url}/api/v1${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
  }

  return {
    app,
    config,
    root,
    home,
    url,
    tokens,
    request,
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function skillPayload(overrides = {}) {
  return {
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    description: '演示用技能',
    tags: ['demo'],
    files: [
      {
        path: 'SKILL.md',
        encoding: 'utf8',
        content: '---\nname: demo-skill\ndescription: 演示用技能\n---\n\n# 演示\n\n做演示。\n',
      },
    ],
    ...overrides,
  };
}
