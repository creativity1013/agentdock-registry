import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { sha256 } from '../src/util.mjs';
import {
  BACKUP_SCHEMA,
  buildBackup,
  readBackup,
  restoreBackup,
  writeBackup,
} from '../src/backup.mjs';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedData(dir, { bootstrap = true } = {}) {
  fs.mkdirSync(path.join(dir, 'packages', 'skill', 'demo-skill', '0.1.0', 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ schemaVersion: 1, packages: {} }));
  fs.writeFileSync(path.join(dir, 'transparency.log'), '{"seq":0}\n');
  fs.writeFileSync(
    path.join(dir, 'packages', 'skill', 'demo-skill', '0.1.0', 'files', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: x\n---\n',
  );
  if (bootstrap) fs.writeFileSync(path.join(dir, 'BOOTSTRAP-TOKENS.txt'), 'admin token\n', { mode: 0o600 });
}

test('备份/恢复：gzip 归档往返，文件与校验和一致', (t) => {
  const dataDir = tempDir(t, 'agentdock-backup-src-');
  seedData(dataDir);
  const out = path.join(tempDir(t, 'agentdock-backup-out-'), 'snapshot.json.gz');
  const written = writeBackup({ dataDir, out });
  assert.ok(fs.existsSync(out));
  assert.equal(written.manifest.schema, BACKUP_SCHEMA);
  assert.equal(written.manifest.fileCount, 4);
  assert.ok(written.manifest.digest.length >= 32);

  const target = path.join(tempDir(t, 'agentdock-backup-dst-'), 'data');
  const result = restoreBackup({ file: out, dataDir: target });
  assert.equal(result.fileCount, 4);
  assert.deepEqual(
    fs.readFileSync(path.join(target, 'packages', 'skill', 'demo-skill', '0.1.0', 'files', 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(dataDir, 'packages', 'skill', 'demo-skill', '0.1.0', 'files', 'SKILL.md'), 'utf8'),
  );
  assert.ok(fs.existsSync(path.join(target, 'BOOTSTRAP-TOKENS.txt')));
});

test('备份可排除初始化令牌文件', (t) => {
  const dataDir = tempDir(t, 'agentdock-backup-src-');
  seedData(dataDir);
  const { manifest, buffer } = buildBackup({ dataDir, includeBootstrap: false });
  assert.equal(manifest.fileCount, 3);
  const out = path.join(tempDir(t, 'agentdock-backup-out-'), 'snapshot.json.gz');
  fs.writeFileSync(out, buffer);
  const { files } = readBackup(out);
  assert.ok(!files.some((file) => file.path === 'BOOTSTRAP-TOKENS.txt'));
});

test('恢复：非空数据目录默认拒绝，--force 才覆盖；dry-run 不写盘', (t) => {
  const dataDir = tempDir(t, 'agentdock-backup-src-');
  seedData(dataDir);
  const out = path.join(tempDir(t, 'agentdock-backup-out-'), 'snapshot.json.gz');
  writeBackup({ dataDir, out });

  const target = tempDir(t, 'agentdock-backup-dst-');
  fs.writeFileSync(path.join(target, 'existing.txt'), 'stale');
  assert.throws(() => restoreBackup({ file: out, dataDir: target }), /目标数据目录非空/);

  const dry = restoreBackup({ file: out, dataDir: target, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(!fs.existsSync(path.join(target, 'db.json')), 'dry-run 不应写盘');

  const forced = restoreBackup({ file: out, dataDir: target, force: true });
  assert.equal(forced.fileCount, 4);
  assert.ok(fs.existsSync(path.join(target, 'db.json')));
});

test('恢复校验：篡改内容 / 不安全路径 / 未知 schema 均被拒绝', (t) => {
  const dir = tempDir(t, 'agentdock-backup-bad-');
  const write = (name, payload) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));
    return file;
  };

  const unsafe = write('unsafe.json.gz', {
    schema: BACKUP_SCHEMA,
    files: [{ path: '../evil', bytes: 1, sha256: 'x', content: Buffer.from('a').toString('base64') }],
  });
  assert.throws(() => readBackup(unsafe), /不安全路径/);

  const tampered = write('tampered.json.gz', {
    schema: BACKUP_SCHEMA,
    files: [
      {
        path: 'db.json',
        bytes: 4,
        sha256: 'deadbeef',
        content: Buffer.from('evil').toString('base64'),
      },
    ],
  });
  assert.throws(() => readBackup(tampered), /文件校验失败/);

  const wrongSchema = write('wrong.json.gz', { schema: 'other@1', files: [] });
  assert.throws(() => readBackup(wrongSchema), /备份格式不支持/);
});

test('readBackup 兼容未压缩 JSON 备份', (t) => {
  const dir = tempDir(t, 'agentdock-backup-plain-');
  const payload = {
    schema: BACKUP_SCHEMA,
    files: [
      {
        path: 'db.json',
        bytes: 2,
        sha256: sha256(Buffer.from('{}')),
        content: Buffer.from('{}').toString('base64'),
      },
    ],
  };
  const file = path.join(dir, 'plain.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  const { files } = readBackup(file);
  assert.equal(files[0].path, 'db.json');
});
