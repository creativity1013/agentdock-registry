import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  describeImportedFiles,
  detectKind,
  importFromGitHub,
  importFromMcpRegistry,
  mcpServerToPlugin,
  slugifyName,
  buildMarketplaceCatalog,
  pushToGitHub,
  RegistryError,
} from '../src/registry.mjs';

/** 起一个可编程的 mock HTTP 服务，返回 { url, routes, close } */
async function startMock(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

const SKILL_MD = '---\nname: reviewer-skill\nversion: 0.2.0\ndescription: 代码审查技能\n---\n\n# 审查\n\n先读风险点。\n';

function githubRoutes(base, requests) {
  return (req, res) => {
    const url = new URL(req.url, 'http://mock');
    requests.push(url.pathname + url.search);
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/repos/acme/skills/contents/skills/review') {
      return json(200, [
        { name: 'SKILL.md', path: 'skills/review/SKILL.md', type: 'file', size: SKILL_MD.length, download_url: `${base}/raw/SKILL.md` },
        { name: 'README.md', path: 'skills/review/README.md', type: 'file', size: 8, download_url: `${base}/raw/README.md` },
        { name: 'icon.png', path: 'skills/review/icon.png', type: 'file', size: 8, download_url: `${base}/raw/icon.png` },
        { name: '.secret', path: 'skills/review/.secret', type: 'file', size: 4, download_url: `${base}/raw/.secret` },
        { name: 'sub', path: 'skills/review/sub', type: 'dir' },
      ]);
    }
    if (url.pathname === '/raw/SKILL.md') return res.end(SKILL_MD);
    if (url.pathname === '/raw/README.md') return res.end('# readme\n');
    if (url.pathname === '/raw/icon.png') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
    }
    if (url.pathname === '/raw/.secret') return res.end('nope');
    if (url.pathname === '/repos/acme/missing/contents/') return json(404, { message: 'Not Found' });
    return json(404, { message: 'not found' });
  };
}

test('GitHub 导入：识别 skill、相对路径、跳过隐藏/二进制、标记非文件条目', async () => {
  const requests = [];
  let mock;
  mock = await startMock((req, res) => githubRoutes(mock.url, requests)(req, res));
  try {
    const imported = await importFromGitHub({ repo: 'acme/skills', path: 'skills/review', apiBase: mock.url });
    assert.equal(imported.kind, 'skill');
    assert.deepEqual(imported.meta, {
      kind: 'skill',
      name: 'reviewer-skill',
      version: '0.2.0',
      description: '代码审查技能',
      tags: ['imported'],
    });
    const paths = imported.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['README.md', 'SKILL.md', 'icon.png']);
    const icon = imported.files.find((file) => file.path === 'icon.png');
    assert.equal(icon.encoding, 'base64');
    assert.ok(imported.warnings.some((warning) => warning.includes('非文件条目')));
    assert.ok(imported.warnings.some((warning) => warning.includes('.secret')));
    assert.equal(imported.source.type, 'github');
    assert.equal(imported.source.repo, 'acme/skills');
  } finally {
    await mock.close();
  }
});

test('GitHub 导入：非法 repo、404 与空内容都抛 RegistryError', async () => {
  await assert.rejects(importFromGitHub({ repo: 'bad repo', apiBase: 'http://127.0.0.1:1' }), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.status, 400);
    return true;
  });

  let mock;
  mock = await startMock((req, res) => githubRoutes(mock.url, [])(req, res));
  try {
    await assert.rejects(importFromGitHub({ repo: 'acme/missing', apiBase: mock.url }), (error) => {
      assert.ok(error instanceof RegistryError);
      assert.match(error.message, /404/);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test('MCP registry 导入：remotes/packages 转成 plugin 的 mcp 声明', async () => {
  const requests = [];
  const mock = await startMock((req, res) => {
    const url = new URL(req.url, 'http://mock');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/v0/servers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        servers: [
          {
            server: {
              name: 'io.github.acme/weather',
              version: '1.2.3',
              description: 'Weather MCP server',
              remotes: [{ type: 'sse', url: 'https://weather.example/sse' }],
              packages: [{ registryType: 'npm', identifier: '@acme/weather-mcp', packageArguments: [{ name: '--port', value: '8090' }] }],
            },
          },
        ],
      }));
    }
    res.writeHead(404);
    res.end('nope');
  });
  try {
    const imported = await importFromMcpRegistry({ name: 'weather', baseUrl: mock.url });
    assert.equal(imported.kind, 'plugin');
    assert.equal(imported.meta.name, 'weather');
    assert.equal(imported.meta.version, '1.2.3');
    assert.deepEqual(imported.files.map((file) => file.path), ['plugin.json', 'registry-source.json']);
    const manifest = JSON.parse(imported.files[0].content);
    assert.equal(manifest.name, 'weather');
    assert.equal(manifest.mcp.length, 2);
    assert.equal(manifest.mcp[0].url, 'https://weather.example/sse');
    assert.equal(manifest.mcp[1].command, '@acme/weather-mcp');
    assert.deepEqual(manifest.mcp[1].args, ['8090']);
    assert.equal(new URL(`http://x${requests[0]}`).searchParams.get('search'), 'weather');
  } finally {
    await mock.close();
  }
});

test('MCP registry 导入：找不到 server → 404，参数缺失 → 400', async () => {
  const mock = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ servers: [] }));
  });
  try {
    await assert.rejects(importFromMcpRegistry({ name: 'ghost', baseUrl: mock.url }), (error) => {
      assert.ok(error instanceof RegistryError);
      assert.equal(error.status, 404);
      return true;
    });
    await assert.rejects(importFromMcpRegistry({ baseUrl: mock.url }), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test('工具函数：slugify / detectKind / describeImportedFiles / mcpServerToPlugin', async () => {
  assert.equal(slugifyName('Hello World!'), 'hello-world');
  assert.equal(slugifyName('---'), 'imported-package');
  assert.equal(slugifyName('a'.repeat(100)).length, 63);
  assert.equal(detectKind([{ path: 'SKILL.md' }]), 'skill');
  assert.equal(detectKind([{ path: 'agent.md' }]), 'agent');
  assert.equal(detectKind([{ path: 'plugin.json' }]), 'plugin');
  assert.equal(detectKind([{ path: 'README.md' }]), null);

  const { manifest } = mcpServerToPlugin({ name: 'acme/tool', version: 'v2.0.0', description: 'x' });
  assert.equal(manifest.name, 'tool');
  assert.equal(manifest.version, '2.0.0');
  assert.deepEqual(manifest.mcp, []);

  const meta = await describeImportedFiles(
    [{ path: 'plugin.json', encoding: 'utf8', content: JSON.stringify({ name: 'Acme Kit', version: '1.0.0', description: 'kit', tags: ['ops'] }) }],
    { kind: 'plugin', fallbackName: 'fallback' },
  );
  assert.equal(meta.name, 'acme-kit');
  assert.equal(meta.version, '1.0.0');
  assert.deepEqual(meta.tags, ['imported', 'ops']);
});

test('导出市场目录：schema、bundleUrl、签名摘要与 digest', () => {
  const store = {
    listPackages: () => ({
      total: 2,
      items: [
        {
          kind: 'skill',
          name: 'demo',
          description: '演示',
          tags: ['demo'],
          latestVersion: '1.2.0',
          installs: 3,
        },
        {
          kind: 'agent',
          name: 'pending-only',
          latestVersion: '0.1.0',
        },
      ],
    }),
    getVersion: (kind, name, version) => {
      if (kind === 'skill' && version === '1.2.0') {
        return {
          status: 'published',
          contentHash: 'abc123',
          signature: { algorithm: 'ed25519', keyId: 'k1', signedAt: '2026-01-01T00:00:00.000Z' },
          publisherSignature: { algorithm: 'ed25519', keyId: 'p1', keyName: 'desk', signedAt: '2026-01-01T00:00:00.000Z' },
        };
      }
      return null;
    },
  };
  const catalog = buildMarketplaceCatalog(store, { baseUrl: 'https://dock.example', generatedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(catalog.schema, 'agentdock-marketplace@1');
  assert.equal(catalog.count, 1);
  assert.equal(catalog.items[0].latestVersion, '1.2.0');
  assert.equal(catalog.items[0].bundleUrl, 'https://dock.example/api/v1/packages/skill/demo/versions/1.2.0/bundle');
  assert.equal(catalog.items[0].contentHash, 'abc123');
  assert.equal(catalog.items[0].publisherSignature.keyName, 'desk');
  assert.equal(catalog.digest.length, 64);
});

test('网络错误映射为 RegistryError：超时 504，连接失败 502', async () => {
  const timeoutFetch = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(importFromGitHub({ repo: 'acme/kit', apiBase: 'http://127.0.0.1:1', fetchImpl: timeoutFetch }), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.status, 504);
    assert.match(error.message, /超时/);
    return true;
  });
  const failingFetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(importFromMcpRegistry({ name: 'x', baseUrl: 'http://127.0.0.1:1', fetchImpl: failingFetch }), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.status, 502);
    assert.match(error.message, /无法访问外部 registry/);
    return true;
  });
});

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
}

test('GitHub 推送：一次 commit 写入全部文件，包含 base_tree 与 ref 更新', async () => {
  const calls = [];
  const mock = await startMock(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://mock');
    calls.push({ method: req.method, path: url.pathname, body: req.method === 'GET' ? null : await readBody(req) });
    if (url.pathname === '/repos/acme/skills/git/ref/heads/main') {
      return json(200, { object: { sha: 'head111', type: 'commit' } });
    }
    if (url.pathname === '/repos/acme/skills/git/commits/head111') {
      return json(200, { sha: 'head111', tree: { sha: 'basetree222' } });
    }
    if (url.pathname === '/repos/acme/skills/git/blobs' && req.method === 'POST') {
      return json(201, { sha: `blob${calls.length}` });
    }
    if (url.pathname === '/repos/acme/skills/git/trees' && req.method === 'POST') {
      return json(201, { sha: 'newtree333' });
    }
    if (url.pathname === '/repos/acme/skills/git/commits' && req.method === 'POST') {
      return json(201, { sha: 'commit444' });
    }
    if (url.pathname === '/repos/acme/skills/git/refs/heads/main' && req.method === 'PATCH') {
      return json(200, { ok: true });
    }
    return json(404, { message: 'not found' });
  });
  try {
    const result = await pushToGitHub({
      repo: 'acme/skills',
      path: 'catalog/review',
      branch: 'main',
      token: 'gh-token',
      apiBase: mock.url,
      message: 'sync review',
      files: [
        { path: 'SKILL.md', encoding: 'utf8', content: '# review\n' },
        { path: 'README.md', encoding: 'utf8', content: '# readme\n' },
      ],
    });
    assert.equal(result.commit, 'commit444');
    assert.equal(result.files, 2);
    assert.match(result.url, /acme\/skills\/commit\/commit444/);

    const treeCall = calls.find((call) => call.path === '/repos/acme/skills/git/trees');
    assert.equal(treeCall.body.base_tree, 'basetree222');
    assert.deepEqual(
      treeCall.body.tree.map((entry) => entry.path),
      ['catalog/review/SKILL.md', 'catalog/review/README.md'],
    );
    const blobCall = calls.find((call) => call.path === '/repos/acme/skills/git/blobs');
    assert.equal(Buffer.from(blobCall.body.content, 'base64').toString('utf8'), '# review\n');
    const refCall = calls.find((call) => call.method === 'PATCH' && call.path.endsWith('refs/heads/main'));
    assert.deepEqual(refCall.body, { sha: 'commit444', force: false });

    await assert.rejects(
      () => pushToGitHub({ repo: 'acme/skills', token: '', apiBase: mock.url, files: [] }),
      (error) => error instanceof RegistryError && error.status === 401,
    );
  } finally {
    await mock.close();
  }
});
