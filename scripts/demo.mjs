#!/usr/bin/env node
/**
 * 一键演示：docker compose 起服务 → 等健康检查 → 取引导令牌 → 发布示例能力包 → 自动审核。
 *
 * 用法：
 *   npm run demo                       # 等价于下面这条
 *   node scripts/demo.mjs [--url http://127.0.0.1:7788]
 *
 * 结束后打开 <url> 即可看到带数据的市场；拆除环境：docker compose down -v。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'agentdock.mjs');

const EXAMPLES_LIST = [
  { dir: 'skill-code-reviewer', spec: 'skill/code-reviewer@0.1.0' },
  { dir: 'agent-code-reviewer', spec: 'agent/code-reviewer@0.1.0' },
  { dir: 'plugin-ops-kit', spec: 'plugin/ops-kit@0.1.0' },
];

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
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

function run(cmd, args, { capture = false, token } = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, AGENTDOCK_URL: baseUrl, ...(token ? { AGENTDOCK_TOKEN: token } : {}) },
  });
  if (result.status !== 0) {
    const detail = capture ? result.stderr : `${result.stdout}\n${result.stderr}`;
    console.error(`命令失败：${cmd} ${args.join(' ')}\n${detail.trim()}`);
    process.exit(1);
  }
  process.stdout.write(capture ? '' : result.stdout);
  return result.stdout;
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function waitForHealth(baseUrl, timeoutMs = 180_000) {
  const start = Date.now();
  process.stdout.write('等待服务健康检查');
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) {
        process.stdout.write(' 通过\n');
        return true;
      }
    } catch {
      // 尚未就绪，继续等
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write(' 超时\n');
  return false;
}

/** 解析 BOOTSTRAP-TOKENS.txt：`role      token  # name` */
function parseBootstrapTokens(text) {
  const tokens = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (match && !line.trim().startsWith('#')) tokens[match[1]] = match[2];
  }
  return tokens;
}

const flags = parseFlags(process.argv.slice(2));
const baseUrl = String(flags.url || 'http://127.0.0.1:7788');

// 1) 起容器（首次会构建镜像）
run('docker', ['compose', 'up', '-d', '--build']);

// 2) 等健康检查
if (!(await waitForHealth(baseUrl))) {
  console.error('服务未在 180 秒内就绪，查看日志：docker compose logs agentdock');
  process.exit(1);
}

// 3) 从卷里取引导令牌
const tokensText = run('docker', ['compose', 'exec', '-T', 'agentdock', 'cat', '/data/BOOTSTRAP-TOKENS.txt'], { capture: true });
const tokens = parseBootstrapTokens(tokensText);
if (!tokens.publisher || !tokens.reviewer) {
  console.error('BOOTSTRAP-TOKENS.txt 缺少 publisher/reviewer 令牌，内容：\n' + tokensText);
  process.exit(1);
}

// 4) 发布示例（跳过已存在的）并自动审核
console.log(`发布示例能力包 → ${baseUrl}`);
for (const example of EXAMPLES_LIST) {
  const [kind, name] = example.spec.split('/');
  const exists = await fetchJson(`${baseUrl}/api/v1/packages/${kind}/${name}`, tokens.reviewer);
  if (exists.status === 200) {
    console.log(`跳过（已存在）：${example.spec}`);
    continue;
  }
  run(process.execPath, [CLI, 'publish', path.join(ROOT, 'examples', example.dir)], { token: tokens.publisher });
}

for (const example of EXAMPLES_LIST) {
  run(process.execPath, [CLI, 'review', 'approve', example.spec, '--note', '示例数据'], { token: tokens.reviewer });
}

console.log('');
console.log(`✅ 演示环境就绪：${baseUrl}`);
console.log('   打开页面后粘贴 admin 令牌登录（审核/策略页需要）；查看令牌：');
console.log('   docker compose exec agentdock cat /data/BOOTSTRAP-TOKENS.txt');
console.log('   拆除环境（含数据）：docker compose down -v');
