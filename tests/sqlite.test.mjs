import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadConfig } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { sqliteAvailable, sqliteUnavailableReason } from '../src/sqlite.mjs';
import { skillPayload } from './helpers.mjs';

const require = createRequire(import.meta.url);
const skip = !sqliteAvailable() ? `node:sqlite 不可用：${sqliteUnavailableReason()}` : false;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-sqlite-'));
}

function makeConfig(root, overrides = {}) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return loadConfig({}, { dataDir: path.join(root, 'data'), home, ...overrides });
}

test('sqlite 后端：发布/审核/安装持久化，重启后从 SQLite 恢复', { skip }, () => {
  const root = makeRoot();
  try {
    const config = makeConfig(root, { store: { backend: 'sqlite' } });
    assert.equal(config.store.backend, 'sqlite');
    const store = createStore(config);
    assert.equal(store.backend, 'sqlite');

    const report = store.analyze(skillPayload());
    assert.equal(report.valid, true, JSON.stringify(report.errors));
    const { version } = store.publish(skillPayload(), { actor: 'alice' });
    assert.equal(version.status, 'pending');

    store.review('skill', 'demo-skill', '0.1.0', { decision: 'approve', actor: 'reviewer', role: 'reviewer' });
    store.recordInstall('skill', 'demo-skill', '0.1.0', { actor: 'bob' });

    assert.ok(fs.existsSync(config.files.sqlite), '应创建 SQLite 数据库文件');
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(config.files.sqlite);
    const packageRows = raw.prepare('SELECT kind, name, description FROM packages').all();
    const versionRows = raw.prepare('SELECT version, status FROM versions').all();
    raw.close();
    assert.equal(packageRows.length, 1);
    assert.equal(packageRows[0].kind, 'skill');
    assert.equal(packageRows[0].name, 'demo-skill');
    assert.equal(versionRows.length, 1);
    assert.equal(versionRows[0].status, 'published');

    store.close();
    const reopened = createStore(config);
    const restored = reopened.getVersion('skill', 'demo-skill', '0.1.0');
    assert.equal(restored.status, 'published');
    assert.equal(restored.installs, 1);
    assert.equal(restored.version, '0.1.0');
    assert.match(restored.signature.algorithm, /ed25519/);
    const bundle = reopened.bundleContent('skill', 'demo-skill', '0.1.0');
    assert.equal(bundle.files.length, 1);
    assert.equal(reopened.stats().published, 1);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sqlite 后端：从已有 db.json 自动迁移（migrated_from 标记）', { skip }, () => {
  const root = makeRoot();
  try {
    const jsonConfig = makeConfig(root);
    const jsonStore = createStore(jsonConfig);
    assert.equal(jsonStore.backend, 'json');
    jsonStore.publish(skillPayload({ name: 'legacy-skill', files: [
      {
        path: 'SKILL.md',
        encoding: 'utf8',
        content: '---\nname: legacy-skill\ndescription: 迁移测试\n---\n\n正文\n',
      },
    ] }), { actor: 'alice' });
    jsonStore.close();
    assert.ok(fs.existsSync(jsonConfig.files.db));

    const sqliteConfig = makeConfig(root, { store: { backend: 'sqlite' } });
    const sqliteStore = createStore(sqliteConfig);
    const migrated = sqliteStore.getVersion('skill', 'legacy-skill', '0.1.0');
    assert.ok(migrated, '应从 db.json 迁移出版本');
    assert.equal(migrated.status, 'pending');
    const info = sqliteStore.backendInfo();
    assert.equal(info.kind, 'sqlite');
    assert.equal(info.migratedFromDbJson, true);
    assert.equal(sqliteStore.stats().packages, 1);
    sqliteStore.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('后端选择：默认 json，AGENTDOCK_STORE=sqlite 生效，非法值报错', () => {
  const root = makeRoot();
  try {
    const dataDir = path.join(root, 'data');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    assert.equal(loadConfig({}, { dataDir, home }).store.backend, 'json');
    assert.equal(loadConfig({ AGENTDOCK_STORE: 'sqlite' }, { dataDir, home }).store.backend, 'sqlite');
    assert.equal(loadConfig({ AGENTDOCK_STORE: 'SQLite' }, { dataDir, home }).store.backend, 'sqlite');
    assert.throws(() => loadConfig({ AGENTDOCK_STORE: 'bogus' }, { dataDir, home }), /AGENTDOCK_STORE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
