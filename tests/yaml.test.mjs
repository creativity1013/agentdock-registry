import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, parseFrontmatter, parseScalar, YamlError } from '../src/yaml.mjs';

test('parseScalar 处理字符串、数字、布尔与引号', () => {
  assert.equal(parseScalar('hello'), 'hello');
  assert.equal(parseScalar('42'), 42);
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar('"a: b"'), 'a: b');
  assert.equal(parseScalar("'it''s'"), "it's");
});

test('parseFrontmatter 解析基础字段与正文', () => {
  const text = ['---', 'name: demo', 'description: 演示技能', 'tags: [a, b]', '---', '', '# 标题', '正文内容'].join('\n');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'demo');
  assert.equal(data.description, '演示技能');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.match(body, /# 标题/);
  assert.match(body, /正文内容/);
});

test('parseFrontmatter 支持嵌套对象、块标量与列表', () => {
  const text = [
    '---',
    'name: demo',
    'description: |',
    '  第一行',
    '  第二行',
    'metadata:',
    '  author: tester',
    '  tags:',
    '    - one',
    '    - two',
    '---',
    '正文',
  ].join('\n');
  const { data } = parseFrontmatter(text);
  assert.equal(data.description, '第一行\n第二行\n');
  assert.equal(data.metadata.author, 'tester');
  assert.deepEqual(data.metadata.tags, ['one', 'two']);
});

test('parseFrontmatter 缺少 frontmatter 时抛错', () => {
  assert.throws(() => parseFrontmatter('# 没有 frontmatter'), (error) => error instanceof YamlError);
});

test('parseYaml 解析普通映射与注释', () => {
  const value = parseYaml(['# 注释', 'name: demo', 'count: 3', 'enabled: true'].join('\n'));
  assert.deepEqual(value, { name: 'demo', count: 3, enabled: true });
});

test('parseYaml 对非法缩进抛错', () => {
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\n'), (error) => error instanceof YamlError);
});
