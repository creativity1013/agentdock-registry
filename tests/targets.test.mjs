import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planInstall,
  applyInstall,
  summarizePlan,
  resolveTargetBase,
  installDestination,
  listTargets,
  TARGET_IDS,
} from '../src/targets.mjs';
import { AppError } from '../src/errors.mjs';

function skillBundle(files = null) {
  return {
    kind: 'skill',
    name: 'demo-skill',
    version: '0.1.0',
    files: files || [{ path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: x\n---\n', encoding: 'utf8' }],
  };
}

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-targets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('skill 安装到 ~/.dsh/skills/<name>', (t) => {
  const home = withHome(t);
  const plan = planInstall(skillBundle(), { target: 'dsh', home });
  assert.equal(plan.dest.layout, 'dir');
  assert.equal(plan.dest.absolutePath, path.join(home, '.dsh', 'skills', 'demo-skill'));
  assert.ok(plan.files.some((file) => file.path.endsWith(path.join('demo-skill', 'SKILL.md'))));
  assert.ok(plan.files.some((file) => file.path.endsWith('.agentdock-install.json')));

  const result = applyInstall(plan);
  assert.equal(result.installedFiles, plan.files.length);
  assert.ok(fs.existsSync(path.join(home, '.dsh', 'skills', 'demo-skill', 'SKILL.md')));
});

test('agent 安装到 Claude Code 使用单文件 + sidecar', (t) => {
  const home = withHome(t);
  const bundle = {
    kind: 'agent',
    name: 'reviewer',
    version: '0.1.0',
    files: [
      { path: 'agent.md', content: '---\nname: reviewer\ndescription: 评审\n---\n', encoding: 'utf8' },
      { path: 'notes/guide.md', content: '额外说明', encoding: 'utf8' },
    ],
  };
  const plan = planInstall(bundle, { target: 'claude', home });
  assert.equal(plan.dest.layout, 'file');
  assert.equal(plan.dest.absolutePath, path.join(home, '.claude', 'agents', 'reviewer.md'));
  const main = plan.files.find((file) => file.path === plan.dest.absolutePath);
  assert.ok(main);
  assert.ok(plan.files.some((file) => file.path.includes('reviewer.agentdock')));
  assert.ok(plan.notes.some((note) => note.includes('单文件')));

  applyInstall(plan);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agents', 'reviewer.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agents', 'reviewer.agentdock', 'notes', 'guide.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agents', 'reviewer.agentdock.json')));
});

test('目标已存在时冲突，force 可覆盖', (t) => {
  const home = withHome(t);
  const bundle = skillBundle();
  applyInstall(planInstall(bundle, { target: 'shared', home }));
  assert.throws(
    () => planInstall(bundle, { target: 'shared', home }),
    (error) => error instanceof AppError && error.status === 409,
  );
  const forced = planInstall(bundle, { target: 'shared', home, force: true });
  assert.equal(forced.force, true);
});

test('base64 文件按二进制写入', (t) => {
  const home = withHome(t);
  const bundle = skillBundle([
    { path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: x\n---\n', encoding: 'utf8' },
    { path: 'icon.bin', content: Buffer.from([0, 1, 2, 3]).toString('base64'), encoding: 'base64' },
  ]);
  applyInstall(planInstall(bundle, { target: 'dir', home, dir: path.join(home, 'custom') }));
  const bytes = fs.readFileSync(path.join(home, 'custom', 'skills', 'demo-skill', 'icon.bin'));
  assert.deepEqual([...bytes], [0, 1, 2, 3]);
});

test('summarizePlan 用 ~ 缩写 home 路径', (t) => {
  const home = withHome(t);
  const plan = planInstall(skillBundle(), { target: 'dsh', home });
  const summary = summarizePlan(plan, { home });
  assert.ok(summary.absolutePath.startsWith('~/.dsh/'));
  assert.ok(summary.files.every((file) => file.path.startsWith('~/')));
});

test('目标解析与校验', () => {
  assert.equal(resolveTargetBase('dsh', { home: '/tmp/h' }), path.join('/tmp/h', '.dsh'));
  assert.throws(() => resolveTargetBase('dir', { home: '/tmp/h' }), (error) => error.status === 400);
  assert.throws(() => resolveTargetBase('unknown', { home: '/tmp/h' }), (error) => error.status === 400);
  assert.equal(installDestination('skill', 'x', { target: 'claude', home: '/tmp/h' }).layout, 'dir');
  const targets = listTargets({ home: '/tmp/h' });
  assert.deepEqual(targets.map((target) => target.id), TARGET_IDS);
  assert.equal(targets.find((target) => target.id === 'dir').baseDir, null);
});
