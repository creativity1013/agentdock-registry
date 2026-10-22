import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeBundle, sanitizePath, isValidName, readBundleFromDirectory, LIMITS } from '../src/bundle.mjs';

function payload(overrides = {}) {
  return {
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    description: '演示',
    tags: ['demo'],
    files: [{ path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: 演示\n---\n', encoding: 'utf8' }],
    ...overrides,
  };
}

test('normalizeBundle 接受合法包并计算哈希', () => {
  const result = normalizeBundle(payload());
  assert.equal(result.ok, true);
  assert.equal(result.bundle.kind, 'skill');
  assert.equal(result.bundle.name, 'demo-skill');
  assert.match(result.bundle.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.bundle.files.length, 1);
});

test('normalizeBundle 拒绝危险路径与重复路径', () => {
  const traversal = normalizeBundle(payload({ files: [{ path: '../etc/passwd', content: 'x' }] }));
  assert.equal(traversal.ok, false);
  assert.ok(traversal.errors.some((error) => error.field.endsWith('.path')));

  const duplicate = normalizeBundle(
    payload({
      files: [
        { path: 'a.txt', content: '1' },
        { path: 'a.txt', content: '2' },
      ],
    }),
  );
  assert.equal(duplicate.ok, false);
});

test('normalizeBundle 校验名称、版本、类型与文件大小', () => {
  assert.equal(normalizeBundle(payload({ kind: 'nope' })).ok, false);
  assert.equal(normalizeBundle(payload({ name: 'Bad Name' })).ok, false);
  assert.equal(normalizeBundle(payload({ version: 'v1' })).ok, false);
  assert.equal(normalizeBundle(payload({ files: [] })).ok, false);
  const tooMany = Array.from({ length: LIMITS.maxFiles + 1 }, (_, index) => ({ path: `f${index}.txt`, content: 'x' }));
  assert.equal(normalizeBundle(payload({ files: tooMany })).ok, false);
});

test('normalizeBundle 支持 base64 文件', () => {
  const result = normalizeBundle(
    payload({ files: [{ path: 'logo.bin', content: Buffer.from([0, 1, 2, 3]).toString('base64'), encoding: 'base64' }] }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.bundle.files[0].encoding, 'base64');
  assert.equal(result.bundle.files[0].bytes, 4);
});

test('sanitizePath 拒绝绝对路径、反斜杠与隐藏文件', () => {
  assert.equal(sanitizePath('/etc/passwd'), null);
  assert.equal(sanitizePath('a\\b'), 'a/b');
  assert.equal(sanitizePath('.env'), null);
  assert.equal(sanitizePath('a/../b'), null);
  assert.equal(sanitizePath('node_modules/x.js'), null);
  assert.equal(sanitizePath('skills/demo/SKILL.md'), 'skills/demo/SKILL.md');
});

test('isValidName 只接受小写安全字符', () => {
  assert.equal(isValidName('code-reviewer'), true);
  assert.equal(isValidName('a.b_c-1'), true);
  assert.equal(isValidName('-bad'), false);
  assert.equal(isValidName('UPPER'), false);
  assert.equal(isValidName(''), false);
});

test('readBundleFromDirectory 跳过隐藏文件并识别文本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-bundle-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: x\n---\n');
    fs.writeFileSync(path.join(dir, 'sub', 'extra.txt'), 'hello');
    fs.writeFileSync(path.join(dir, '.hidden'), 'secret');
    const { files, warnings } = readBundleFromDirectory(dir);
    assert.deepEqual(files.map((file) => file.path).sort(), ['SKILL.md', 'sub/extra.txt']);
    assert.ok(warnings.some((warning) => warning.field === '.hidden'));
    assert.ok(files.every((file) => file.encoding === 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
