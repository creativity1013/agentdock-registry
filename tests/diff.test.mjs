import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffBundles, splitLines } from '../src/diff.mjs';

test('splitLines 统一换行并去掉末尾空行', () => {
  assert.deepEqual(splitLines('a\r\nb\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('diffLines：完全相同的文本', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(diff.unchanged, 3);
  assert.equal(diff.mode, 'lcs');
  assert.ok(diff.lines.every((line) => line.type === 'same'));
});

test('diffLines：增删改同时出现', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nx\nc\nd\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.unchanged, 2);
  const types = diff.lines.map((line) => `${line.type}:${line.text}`);
  assert.ok(types.includes('same:a'));
  assert.ok(types.includes('del:b'));
  assert.ok(types.includes('add:x'));
  assert.ok(types.includes('same:c'));
  assert.ok(types.includes('add:d'));
  // 行号来自各自一侧
  assert.equal(diff.lines.find((line) => line.type === 'del').oldLine, 2);
  assert.equal(diff.lines.find((line) => line.text === 'x').newLine, 2);
});

test('diffLines：空基线视为整段新增', () => {
  const diff = diffLines('', 'x\ny\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.equal(diff.lines[0].newLine, 1);
});

test('diffLines：超大输入退化为 coarse 而不爆内存', () => {
  const big = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join('\n');
  const diff = diffLines(big, `${big}\nextra`, { maxLines: 2000 });
  assert.equal(diff.mode, 'coarse');
  assert.equal(diff.added, 2101);
  assert.equal(diff.removed, 2100);
  assert.equal(diff.lines.at(-1).type, 'add');
});

test('diffBundles：新增/删除/修改/未变化与二进制标记', () => {
  const from = {
    files: [
      { path: 'SKILL.md', encoding: 'utf8', bytes: 10, content: 'a\nb\n' },
      { path: 'notes.md', encoding: 'utf8', bytes: 10, content: 'x\n' },
      { path: 'icon.bin', encoding: 'base64', bytes: 4, content: 'AAECAw==' },
    ],
  };
  const to = {
    files: [
      { path: 'SKILL.md', encoding: 'utf8', bytes: 14, content: 'a\nb\nc\n' },
      { path: 'notes.md', encoding: 'utf8', bytes: 10, content: 'x\n' },
      { path: 'logo.bin', encoding: 'base64', bytes: 4, content: 'AAECAw==' },
    ],
  };
  const result = diffBundles(from, to);
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.stats.modified, 1);
  assert.equal(result.stats.same, 1);
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
  assert.equal(byPath['SKILL.md'].status, 'modified');
  assert.equal(byPath['SKILL.md'].added, 1);
  assert.equal(byPath['icon.bin'].status, 'removed');
  assert.equal(byPath['icon.bin'].binary, true);
  assert.equal(byPath['logo.bin'].status, 'added');
  assert.equal(byPath['logo.bin'].binary, true);
  assert.equal(byPath['notes.md'], undefined, '未变化文件不应返回');
});
