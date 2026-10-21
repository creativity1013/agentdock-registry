import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderPresetPatch,
  presetFragmentPath,
  profilePatchPath,
  writePresetFragment,
  upsertProfilePatch,
  presetIdFor,
  dshHome,
} from '../src/dsh-preset.mjs';
import { AppError } from '../src/errors.mjs';

function agentBundle(overrides = {}) {
  const content = `---\nname: reviewer\ndescription: 代码评审 agent\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\n---\n\n你是一名严格的代码评审工程师。\n\n## 规则\n\n- 只看真实风险。\n- 每条给出 文件:行号。\n`;
  return {
    kind: 'agent',
    name: 'reviewer',
    version: '0.1.0',
    description: '代码评审 agent',
    files: [{ path: 'agent.md', content, encoding: 'utf8' }],
    ...overrides,
  };
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-preset-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('agent.md 渲染为 DSH agent-preset 片段', () => {
  const preset = renderPresetPatch(agentBundle());
  assert.equal(preset.presetId, 'agentdock-reviewer');
  assert.equal(preset.title, 'AgentDock · reviewer');
  assert.match(preset.yaml, /^- insert:$/m);
  assert.match(preset.yaml, /id: preset-agentdock-reviewer/);
  assert.match(preset.yaml, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.match(preset.yaml, /^        id: agentdock-reviewer$/m);
  assert.deepEqual(
    preset.plugins.map((plugin) => plugin.id),
    ['persona', 'agent-instructions', 'time-context', 'tool-fs', 'tool-fs-search', 'tool-bash'],
  );
  // 同一插件组只生成一行
  assert.equal(preset.yaml.match(/id: tool-fs$/gm).length, 1);
  assert.equal(preset.yaml.match(/id: tool-fs-search$/gm).length, 1);
  // persona 的系统提示词以 YAML 块标量写入，正文中的行全部保留
  assert.match(preset.yaml, /              prefix: \|/);
  assert.match(preset.yaml, /                你是一名严格的代码评审工程师。/);
  assert.match(preset.yaml, /                - 每条给出 文件:行号。/);
  assert.deepEqual(preset.warnings, []);
});

test('工具名数组、未知工具与 skills 的处理', () => {
  const content = `---\nname: mixed\ndescription: 混合工具\ntools:\n  - Read\n  - WebFetch\n  - Task\n  - MysteryTool\nskills:\n  - doc-style\n---\n\n提示词。\n`;
  const preset = renderPresetPatch({
    kind: 'agent',
    name: 'mixed',
    version: '0.1.0',
    files: [{ path: 'agent.md', content, encoding: 'utf8' }],
  });
  const ids = preset.plugins.map((plugin) => plugin.id);
  assert.ok(ids.includes('tool-fs'));
  assert.ok(ids.includes('tool-web'));
  assert.ok(ids.includes('skill-filesystem'));
  assert.ok(ids.includes('tool-skill'));
  assert.ok(!ids.includes('tool-bash'));
  assert.ok(preset.warnings.some((warning) => warning.includes('Task')));
  assert.ok(preset.warnings.some((warning) => warning.includes('MysteryTool')));
  assert.ok(preset.warnings.some((warning) => warning.includes('doc-style')));
});

test('正文为空时用 description 兜底并告警', () => {
  const content = `---\nname: empty\ndescription: 没有正文\n---\n`;
  const preset = renderPresetPatch({
    kind: 'agent',
    name: 'empty',
    version: '0.1.0',
    files: [{ path: 'agent.md', content, encoding: 'utf8' }],
  });
  const persona = preset.plugins.find((plugin) => plugin.id === 'persona');
  assert.equal(persona.config.prefix, '没有正文');
  assert.ok(preset.warnings.some((warning) => warning.includes('正文为空')));
});

test('只接受 agent 包，且必须有 agent.md', () => {
  assert.throws(
    () => renderPresetPatch({ kind: 'skill', name: 'x', version: '0.1.0', files: [] }),
    (error) => error instanceof AppError && error.status === 400,
  );
  assert.throws(
    () => renderPresetPatch({ kind: 'agent', name: 'x', version: '0.1.0', files: [{ path: 'README.md', content: 'x', encoding: 'utf8' }] }),
    (error) => error instanceof AppError && error.status === 400,
  );
});

test('presetIdFor 拒绝非法名字', () => {
  assert.equal(presetIdFor('code-reviewer'), 'agentdock-code-reviewer');
  assert.throws(() => presetIdFor('Bad Name'), (error) => error.status === 400);
});

test('writePresetFragment 写入 ~/.dsh/agentdock/presets/<name>.patch.yml', (t) => {
  const home = tempHome(t);
  const preset = renderPresetPatch(agentBundle());
  const file = writePresetFragment({ home, name: 'reviewer', yaml: preset.yaml });
  assert.equal(file, presetFragmentPath(home, 'reviewer'));
  assert.equal(file, path.join(home, '.dsh', 'agentdock', 'presets', 'reviewer.patch.yml'));
  assert.equal(fs.readFileSync(file, 'utf8'), preset.yaml);
});

test('upsertProfilePatch 首次创建、重复执行按标记替换而不叠加', (t) => {
  const home = tempHome(t);
  const preset = renderPresetPatch(agentBundle());
  const file = profilePatchPath('desktop', home);
  assert.equal(file, path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'));

  const first = upsertProfilePatch({ profile: 'desktop', home, presetId: preset.presetId, body: preset.body });
  assert.equal(first.replaced, false);
  let text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# >>> agentdock preset agentdock-reviewer/m);
  assert.match(text, /id: preset-agentdock-reviewer/);

  const second = upsertProfilePatch({ profile: 'desktop', home, presetId: preset.presetId, body: preset.body });
  assert.equal(second.replaced, true);
  text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/# >>> agentdock preset agentdock-reviewer/g).length, 1);
  assert.equal(text.match(/- insert:/g).length, 1);
  assert.ok(text.includes('cordis.patch.yml') === false); // 不写入无关内容
});

test('dshHome 支持 DSH_HOME 覆盖', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-custom-home';
  try {
    // 未显式传 home（解析真实用户 home）时 DSH_HOME 生效
    assert.equal(dshHome(), path.resolve('/tmp/dsh-custom-home'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
