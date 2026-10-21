#!/usr/bin/env node
/**
 * 端到端冒烟测试：真实启动服务 + 真实 CLI 命令 + 真实落盘安装。
 * 不依赖任何第三方包：node scripts/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'agentdock.mjs');
const EXAMPLES = path.join(ROOT, 'examples');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-smoke-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const execFileAsync = promisify(execFile);
let server = null;

async function runCli(args, token) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DSH_HOME: path.join(home, '.dsh'),
        AGENTDOCK_URL: server.url,
        AGENTDOCK_TOKEN: token,
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    throw new Error(`agentdock ${args.join(' ')} 失败：\n${error.stdout || ''}\n${error.stderr || error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const config = loadConfig({}, { port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), home });
  server = await startServer(config);
  const tokens = Object.fromEntries((server.users.bootstrap || []).map((entry) => [entry.name, entry.token]));
  assert(tokens.admin && tokens.reviewer && tokens.publisher, '应生成 admin/reviewer/publisher 初始化令牌');

  const health = await fetch(`${server.url}/api/v1/health`).then((response) => response.json());
  assert(health.ok === true, '健康检查失败');
  console.log('✓ 服务启动与健康检查');

  const page = await fetch(`${server.url}/`);
  assert(page.status === 200 && (await page.text()).includes('AgentDock'), 'Web 首页不可用');
  console.log('✓ Web 首页可访问');

  // 发布三个示例（CLI 本地校验 + 服务端发布）
  await runCli(['publish', path.join(EXAMPLES, 'skill-code-reviewer')], tokens.publisher);
  await runCli(['publish', path.join(EXAMPLES, 'agent-code-reviewer')], tokens.publisher);
  await runCli(['publish', path.join(EXAMPLES, 'plugin-ops-kit')], tokens.publisher);
  console.log('✓ CLI 发布 3 个示例能力包（进入待审核）');

  // 审核队列与通过
  const queue = await fetch(`${server.url}/api/v1/review/queue`, {
    headers: { Authorization: `Bearer ${tokens.reviewer}` },
  }).then((response) => response.json());
  assert(queue.total === 3, `待审核数量应为 3，实际 ${queue.total}`);
  for (const spec of ['skill/code-reviewer@0.1.0', 'agent/code-reviewer@0.1.0', 'plugin/ops-kit@0.1.0']) {
    await runCli(['review', 'approve', spec, '--note', 'smoke 测试'], tokens.reviewer);
  }
  console.log('✓ CLI 审核通过 3 个版本');

  // 市场可见
  const list = await runCli(['list'], tokens.publisher);
  for (const name of ['code-reviewer', 'ops-kit']) {
    assert(list.includes(name), `市场列表缺少 ${name}`);
  }
  console.log('✓ CLI list 显示已发布能力包');

  // 安装：skill → 自定义目录；agent → Claude Code；plugin → DSH
  const installDir = path.join(root, 'install-target');
  await runCli(['install', 'skill/code-reviewer', '--target', 'dir', '--dir', installDir, '--force'], tokens.publisher);
  assert(fs.existsSync(path.join(installDir, 'skills', 'code-reviewer', 'SKILL.md')), 'skill 安装失败');
  assert(fs.existsSync(path.join(installDir, 'skills', 'code-reviewer', '.agentdock-install.json')), '缺少安装清单');

  await runCli(['install', 'agent/code-reviewer', '--target', 'claude', '--force'], tokens.publisher);
  assert(fs.existsSync(path.join(home, '.claude', 'agents', 'code-reviewer.md')), 'agent 安装到 Claude Code 失败');

  await runCli(['install', 'plugin/ops-kit', '--target', 'dsh', '--force'], tokens.publisher);
  assert(fs.existsSync(path.join(home, '.dsh', 'plugins', 'ops-kit', 'plugin.json')), 'plugin 安装到 DSH 失败');
  assert(fs.existsSync(path.join(home, '.dsh', 'plugins', 'ops-kit', 'skills', 'incident-checklist', 'SKILL.md')), 'plugin 内技能未落盘');

  // agent → DSH agent-preset 片段，并自动并入 profile patch
  const presetArgs = ['install', 'agent/code-reviewer', '--target', 'dsh-agent', '--profile', 'web', '--force'];
  await runCli(presetArgs, tokens.publisher);
  const fragmentFile = path.join(home, '.dsh', 'agentdock', 'presets', 'code-reviewer.patch.yml');
  assert(fs.existsSync(fragmentFile), 'agent 的 DSH preset 片段未生成');
  const fragment = fs.readFileSync(fragmentFile, 'utf8');
  assert(fragment.includes('preset-agentdock-code-reviewer'), 'preset 片段缺少 preset 行');
  assert(fragment.includes("- id: tool-fs"), 'preset 片段缺少工具插件行');
  const profilePatch = path.join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  assert(fs.existsSync(profilePatch), 'profile patch 未写入');
  assert(
    fs.readFileSync(profilePatch, 'utf8').includes('# >>> agentdock preset agentdock-code-reviewer'),
    'profile patch 缺少 agentdock 标记块',
  );
  await runCli(presetArgs, tokens.publisher);
  const patchText = fs.readFileSync(profilePatch, 'utf8');
  assert(
    (patchText.match(/id: preset-agentdock-code-reviewer/g) || []).length === 1,
    '重复并入 profile 产生了叠加',
  );
  console.log('✓ CLI 安装到自定义目录 / Claude Code / DSH / DSH agent-preset 均成功');

  // 安装计数与审计
  const detail = await fetch(`${server.url}/api/v1/packages/skill/code-reviewer`).then((response) => response.json());
  assert(detail.installs >= 1, '安装计数未累加');
  const audit = await runCli(['audit', '--limit', '50'], tokens.reviewer);
  assert(audit.includes('review.approve'), '审计日志缺少 review.approve');
  assert(audit.includes('package.install'), '审计日志缺少 package.install');
  console.log('✓ 安装计数与审计日志正常');

  // 冒烟结果
  const stats = await fetch(`${server.url}/api/v1/stats`).then((response) => response.json());
  console.log('');
  console.log('SMOKE OK');
  console.log(`  市场：${server.url}`);
  console.log(`  数据：${JSON.stringify(stats)}`);
}

main()
  .catch((error) => {
    console.error('SMOKE FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
