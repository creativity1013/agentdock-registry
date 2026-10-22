import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';
import { makeZip, makeTarGz, SKILL_MD, AGENT_MD } from './helpers-archive.mjs';

let server;
let publisher;

before(async () => {
  server = await startTestServer();
  publisher = server.tokens.publisher;
});

after(async () => {
  await server.close();
});

async function upload(filename, body, contentType, { token = publisher, query = '' } = {}) {
  const response = await fetch(`${server.url}/api/v1/import?filename=${encodeURIComponent(filename)}${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  const data = await response.json();
  return { status: response.status, data };
}

test('导入 ZIP：自动识别 skill 并进入待审核', async () => {
  const zip = makeZip([
    { path: 'my-skill/SKILL.md', content: SKILL_MD },
    { path: 'my-skill/notes.md', content: '# notes' },
  ]);
  const { status, data } = await upload('my-skill.zip', zip, 'application/zip', { query: '&version=0.1.1' });
  assert.equal(status, 201);
  assert.equal(data.format, 'zip');
  assert.equal(data.package.kind, 'skill');
  assert.equal(data.package.name, 'imported-skill');
  assert.equal(data.version.status, 'pending');
  assert.equal(data.version.version, '0.1.1');
});

test('导入 tar.gz：plugin 目录带 plugin.json 自动识别并发布', async () => {
  const tgz = makeTarGz([
    {
      path: 'ops-kit/plugin.json',
      content: JSON.stringify({ name: 'ops-kit', version: '0.2.0', description: '运维工具箱', skills: ['skills/check'] }),
    },
    { path: 'ops-kit/skills/check/SKILL.md', content: '---\nname: check\ndescription: 检查\ntags:\n  - ops\n---\n\n# check\n' },
  ]);
  const { status, data } = await upload('ops-kit.tar.gz', tgz, 'application/gzip', { query: '&version=0.2.0' });
  assert.equal(status, 201);
  assert.equal(data.format, 'tar.gz');
  assert.equal(data.package.kind, 'plugin');
  assert.equal(data.package.name, 'ops-kit');
  assert.equal(data.version.version, '0.2.0');
});

test('导入单文件 markdown：默认技能；带 tools 的 md 自动成为 agent', async () => {
  const skill = await upload('release-check.md', SKILL_MD, 'text/markdown', { query: '&version=0.1.2' });
  assert.equal(skill.status, 201);
  assert.equal(skill.data.package.kind, 'skill');
  assert.equal(skill.data.package.name, 'imported-skill');

  const agent = await upload('agent.md', AGENT_MD, 'text/markdown', { query: '&version=0.1.3' });
  assert.equal(agent.status, 201);
  assert.equal(agent.data.package.kind, 'agent');
  assert.equal(agent.data.package.name, 'imported-agent');
});

test('文件夹上传（files JSON）：自动识别 skill', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=my-folder.json&version=0.1.4`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'SKILL.md', content: SKILL_MD, encoding: 'utf8' },
        { path: 'extra/readme.md', content: '# hi', encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.format, 'files-json');
  assert.equal(data.package.kind, 'skill');
  assert.equal(data.package.name, 'imported-skill');
});

test('文件夹上传：自动过滤 .DS_Store/.git/node_modules 等隐藏系统文件', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=my-folder.json&version=0.1.5`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: '.DS_Store', content: 'junk', encoding: 'utf8' },
        { path: '.git/config', content: '[core]', encoding: 'utf8' },
        { path: 'node_modules/a/index.js', content: 'module.exports=1', encoding: 'utf8' },
        { path: '__MACOSX/._SKILL.md', content: 'junk', encoding: 'utf8' },
        { path: 'SKILL.md', content: SKILL_MD, encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.package.kind, 'skill');
  assert.equal(data.version.files.length, 1);
  assert.equal(data.version.files[0].path, 'SKILL.md');
});

test('文件夹上传：过滤后没有文件时返回清晰错误', async () => {
  const { status, data } = await upload('empty-folder.json', JSON.stringify({
    files: [
      { path: '.DS_Store', content: 'junk', encoding: 'utf8' },
      { path: '.git/HEAD', content: 'ref', encoding: 'utf8' },
    ],
  }), 'application/json');
  assert.equal(status, 422);
  assert.match(data.error.message, /没有可导入的文件/);
});

test('文件夹多套一层目录：自动剥离包装目录后识别', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=wrapper.json&version=0.1.6`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'my-skill/SKILL.md', content: SKILL_MD, encoding: 'utf8' },
        { path: 'my-skill/notes.md', content: '# notes', encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.package.kind, 'skill');
  assert.equal(data.package.name, 'imported-skill');
  assert.equal(data.version.files.length, 2);
});

test('文件夹包含多个能力包：批量导入并分别进入待审核', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=batch.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'skill-a/SKILL.md', content: '---\nname: batch-skill-a\ndescription: A\n---\n\n# A\n', encoding: 'utf8' },
        { path: 'skill-b/SKILL.md', content: '---\nname: batch-skill-b\ndescription: B\n---\n\n# B\n', encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.batch, true);
  assert.equal(data.results.length, 2);
  assert.ok(data.results.every((item) => item.ok));
  assert.deepEqual(data.results.map((item) => item.package.name).sort(), ['batch-skill-a', 'batch-skill-b']);
});

test('文件夹按分组存放多个包（skills/a、skills/b）：仍批量导入', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=grouped.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'skills/group-a/SKILL.md', content: '---\nname: group-a\ndescription: A\n---\n\n# A\n', encoding: 'utf8' },
        { path: 'skills/group-b/SKILL.md', content: '---\nname: group-b\ndescription: B\n---\n\n# B\n', encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.batch, true);
  assert.equal(data.results.length, 2);
});

test('plugin 包内含子目录 skill 时视为同一个包', async () => {
  const response = await fetch(`${server.url}/api/v1/import?filename=my-plugin.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'my-plugin/plugin.json', content: JSON.stringify({ name: 'nested-plugin', version: '0.2.0', description: 'p' }), encoding: 'utf8' },
        { path: 'my-plugin/skills/check/SKILL.md', content: '---\nname: check\ndescription: c\n---\n\n# c\n', encoding: 'utf8' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.batch ?? false, false);
  assert.equal(data.package.kind, 'plugin');
  assert.equal(data.package.name, 'nested-plugin');
});

test('文件夹里没有清单文件时给出清晰错误', async () => {
  const { status, data } = await upload('no-manifest.json', JSON.stringify({
    files: [{ path: 'docs/readme.md', content: '# hi', encoding: 'utf8' }],
  }), 'application/json');
  assert.equal(status, 422);
  assert.match(data.error.message, /没有找到清单文件/);
});

test('文件夹里放多个 zip：逐个解压为独立能力包批量导入', async () => {
  const zipA = makeZip([{ path: 'a/SKILL.md', content: '---\nname: nested-zip-a\ndescription: A\n---\n\n# A\n' }]);
  const zipB = makeZip([{ path: 'b/SKILL.md', content: '---\nname: nested-zip-b\ndescription: B\n---\n\n# B\n' }]);
  const response = await fetch(`${server.url}/api/v1/import?filename=bundle-folder.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'zip-a.zip', content: zipA.toString('base64'), encoding: 'base64' },
        { path: 'zip-b.zip', content: zipB.toString('base64'), encoding: 'base64' },
      ],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.batch, true);
  assert.deepEqual(data.results.map((item) => item.package.name).sort(), ['nested-zip-a', 'nested-zip-b']);
});

test('文件夹里只有一个 zip：按单个包导入', async () => {
  const zip = makeZip([{ path: 'only/SKILL.md', content: '---\nname: only-zip\ndescription: only\n---\n\n# only\n' }]);
  const response = await fetch(`${server.url}/api/v1/import?filename=folder-one.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ path: 'only.zip', content: zip.toString('base64'), encoding: 'base64' }],
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.batch ?? false, false);
  assert.equal(data.package.name, 'only-zip');
  assert.equal(data.version.status, 'pending');
});

test('dryRun：只预览不落库', async () => {
  const before = await fetch(`${server.url}/api/v1/packages?pageSize=100`).then((res) => res.json());
  const response = await fetch(`${server.url}/api/v1/import?dryRun=1&filename=dry.zip&name=dry-skill&version=0.1.0`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/zip' },
    body: makeZip([{ path: 'SKILL.md', content: SKILL_MD.replace('name: imported-skill', 'name: dry-skill') }]),
  });
  const dry = await response.json();
  assert.equal(response.status, 200);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.valid, true);
  const after = await fetch(`${server.url}/api/v1/packages?pageSize=100`).then((res) => res.json());
  assert.equal(after.total, before.total);
});

test('错误处理：匿名 401、非法归档 422、路径穿越被过滤后无文件 422', async () => {
  const anon = await fetch(`${server.url}/api/v1/import?filename=x.zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: makeZip([{ path: 'SKILL.md', content: SKILL_MD }]),
  });
  assert.equal(anon.status, 401);

  const bad = await upload('bad.zip', Buffer.from('not a zip'), 'application/zip');
  assert.equal(bad.status, 422);
  assert.match(bad.data.error.message, /导入文件解析失败/);

  const traversal = await upload('evil.zip', makeZip([{ path: '../evil.sh', content: 'x' }]), 'application/zip');
  assert.equal(traversal.status, 422);
});
