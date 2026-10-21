import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBundle } from '../src/bundle.mjs';
import { validateBundle } from '../src/validate.mjs';

function analyze(payload) {
  const normalized = normalizeBundle(payload);
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  return validateBundle(normalized.bundle);
}

test('合法 skill 通过校验', () => {
  const result = analyze({
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    files: [{ path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: 演示\n---\n正文' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.capabilities.entry, 'SKILL.md');
});

test('skill 缺少 SKILL.md 或 name 时报错', () => {
  const missingEntry = analyze({
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    files: [{ path: 'README.md', content: 'x' }],
  });
  assert.equal(missingEntry.ok, false);

  const missingName = analyze({
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    files: [{ path: 'SKILL.md', content: '---\ndescription: 缺少 name\n---\n' }],
  });
  assert.equal(missingName.ok, false);
  assert.ok(missingName.errors.some((error) => error.message.includes('name')));
});

test('agent 需要 agent.md，且工具名未知只警告', () => {
  const ok = analyze({
    kind: 'agent',
    name: 'reviewer',
    version: '0.1.0',
    files: [
      {
        path: 'agent.md',
        content: '---\nname: reviewer\ndescription: 评审\ntools: [read, custom_tool]\nmodel: inherit\n---\n你是一名评审。',
      },
    ],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.capabilities.tools, ['read', 'custom_tool']);
  assert.ok(ok.warnings.some((warning) => warning.message.includes('custom_tool')));

  const missing = analyze({
    kind: 'agent',
    name: 'reviewer',
    version: '0.1.0',
    files: [{ path: 'notes.md', content: 'x' }],
  });
  assert.equal(missing.ok, false);
});

test('plugin 校验 plugin.json 与技能目录', () => {
  const files = [
    { path: 'plugin.json', content: JSON.stringify({ name: 'ops-kit', version: '0.1.0', description: '运维', skills: ['skills/check'] }) },
    { path: 'skills/check/SKILL.md', content: '---\nname: check\ndescription: 检查\n---\n' },
  ];
  const result = analyze({ kind: 'plugin', name: 'ops-kit', version: '0.1.0', files });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.capabilities.skills.map((skill) => skill.path), ['skills/check']);

  const versionMismatch = analyze({
    kind: 'plugin',
    name: 'ops-kit',
    version: '0.1.0',
    files: [{ path: 'plugin.json', content: JSON.stringify({ name: 'ops-kit', version: '0.2.0', skills: [] }) }],
  });
  assert.equal(versionMismatch.ok, false);
});
