import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip, readTarGz, ArchiveError, normalizeArchivePath } from '../src/archive.mjs';
import { makeZip, makeTarGz } from './helpers-archive.mjs';

test('ZIP：stored 与 deflate 条目都能读取，二进制自动 base64', () => {
  const zip = makeZip([
    { path: 'SKILL.md', content: '# hello', method: 0 },
    { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', method: 8 },
    { path: 'assets/logo.bin', content: Buffer.from([0, 1, 2, 3, 255]), method: 8 },
  ]);
  const files = readZip(zip);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.equal(byPath['SKILL.md'].content, '# hello');
  assert.equal(byPath['SKILL.md'].encoding, 'utf8');
  assert.equal(byPath['scripts/run.sh'].encoding, 'utf8');
  assert.equal(byPath['assets/logo.bin'].encoding, 'base64');
  assert.equal(Buffer.from(byPath['assets/logo.bin'].content, 'base64').length, 5);
});

test('ZIP：剥离 GitHub 单根目录，跳过隐藏/保留目录与 .. 路径', () => {
  const zip = makeZip([
    { path: 'my-skill/SKILL.md', content: '# skill' },
    { path: 'my-skill/.DS_Store', content: 'junk' },
    { path: 'my-skill/.github/workflows/ci.yml', content: 'on: push' },
    { path: '../evil.sh', content: 'rm -rf /' },
  ]);
  const files = readZip(zip);
  assert.deepEqual(files.map((file) => file.path), ['SKILL.md']);
});

test('ZIP：条目过大与非法输入抛 ArchiveError', () => {
  assert.throws(() => readZip(Buffer.from('not a zip')), ArchiveError);
  const big = Buffer.alloc(64);
  const zip = makeZip([{ path: 'big.bin', content: big, method: 0 }]);
  // 手工把中央目录与本地头里的 uncompressed size 改成超大值
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(9 * 1024 * 1024, central + 24);
  assert.throws(() => readZip(zip, { maxEntryBytes: 1024, maxTotalBytes: 1024 }), /条目过大/);
});

test('TAR.GZ：读取常规文件并剥离单根目录', () => {
  const tgz = makeTarGz([
    { path: 'plugin-ops-kit/plugin.json', content: '{"name":"plugin-ops-kit"}' },
    { path: 'plugin-ops-kit/skills/check/SKILL.md', content: '# check' },
  ]);
  const files = readTarGz(tgz);
  assert.deepEqual(files.map((file) => file.path), ['plugin.json', 'skills/check/SKILL.md']);
  assert.equal(files[0].content, '{"name":"plugin-ops-kit"}');
});

test('路径规范化：拒绝绝对路径、.. 与隐藏段', () => {
  assert.equal(normalizeArchivePath('./a/b.md'), 'a/b.md');
  assert.equal(normalizeArchivePath('/etc/passwd'), null);
  assert.equal(normalizeArchivePath('a/../../etc'), null);
  assert.equal(normalizeArchivePath('.hidden/x'), null);
  assert.equal(normalizeArchivePath('a\\b\\c.md'), 'a/b/c.md');
});
