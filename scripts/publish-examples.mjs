#!/usr/bin/env node
/**
 * 把 examples/ 下的示例能力包发布到正在运行的 AgentDock，可选自动审核通过。
 *
 * 用法：
 *   node scripts/publish-examples.mjs [--url http://127.0.0.1:7788] [--data ./data] [--approve]
 *
 * 令牌来源优先级：
 *   1. --publisher-token / --reviewer-token
 *   2. 环境变量 AGENTDOCK_PUBLISHER_TOKEN / AGENTDOCK_REVIEWER_TOKEN
 *   3. <data>/BOOTSTRAP-TOKENS.txt（首次启动时生成）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'agentdock.mjs');
const EXAMPLES = path.join(ROOT, 'examples');

const EXAMPLES_LIST = [
  { dir: 'skill-code-reviewer', spec: 'skill/code-reviewer@0.1.0' },
  { dir: 'agent-code-reviewer', spec: 'agent/code-reviewer@0.1.0' },
  { dir: 'plugin-ops-kit', spec: 'plugin/ops-kit@0.1.0' },
];

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function loadBootstrapTokens(dataDir) {
  const file = path.join(dataDir, 'BOOTSTRAP-TOKENS.txt');
  const tokens = {};
  if (!fs.existsSync(file)) return tokens;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(\S+)\s+(\S+)/.exec(trimmed);
    if (match) tokens[match[1]] = match[2];
  }
  return tokens;
}

function runCli(args, url, token) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDOCK_URL: url, AGENTDOCK_TOKEN: token },
  });
  if (result.status !== 0) {
    throw new Error(`agentdock ${args.join(' ')} 失败：\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write(result.stdout);
}

const flags = parseFlags(process.argv.slice(2));
const url = String(flags.url || process.env.AGENTDOCK_URL || 'http://127.0.0.1:7788');
const dataDir = path.resolve(String(flags.data || path.join(ROOT, 'data')));
const bootstrap = loadBootstrapTokens(dataDir);
const publisherToken = flags['publisher-token'] || process.env.AGENTDOCK_PUBLISHER_TOKEN || bootstrap.publisher;
const reviewerToken = flags['reviewer-token'] || process.env.AGENTDOCK_REVIEWER_TOKEN || bootstrap.reviewer;

if (!publisherToken) {
  console.error(`找不到发布令牌：请用 --publisher-token 指定，或确认 ${path.join(dataDir, 'BOOTSTRAP-TOKENS.txt')} 存在。`);
  process.exit(1);
}

console.log(`发布示例能力包 → ${url}`);
for (const example of EXAMPLES_LIST) {
  runCli(['publish', path.join(EXAMPLES, example.dir)], url, publisherToken);
}

if (flags.approve) {
  if (!reviewerToken) {
    console.error('缺少审核令牌，无法自动审核。');
    process.exit(1);
  }
  for (const example of EXAMPLES_LIST) {
    runCli(['review', 'approve', example.spec, '--note', '示例数据'], url, reviewerToken);
  }
}

console.log('');
console.log(`完成：打开 ${url} 查看市场${flags.approve ? '（示例已审核发布）' : '（示例待审核）'}`);
