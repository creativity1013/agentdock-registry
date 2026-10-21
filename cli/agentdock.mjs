#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { readBundleFromDirectory, KINDS, KIND_LABEL } from '../src/bundle.mjs';
import { analyzeInput } from '../src/pipeline.mjs';
import { parseFrontmatter } from '../src/yaml.mjs';
import { planInstall, applyInstall, summarizePlan, TARGET_LABEL, TARGET_IDS } from '../src/targets.mjs';
import { resolveHome, CLI_CONFIG_FILE } from '../src/config.mjs';
import { formatBytes } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:7788';

const HELP = `AgentDock — 跨 harness 的 skill / agent / plugin 能力市场与治理平台

用法：
  agentdock serve                                  启动本地服务（默认 http://127.0.0.1:7788）
  agentdock login [--url <url>] [--token <token>]  登录并保存令牌到 ~/.agentdock/config.json
  agentdock whoami                                 查看当前用户

  agentdock publish <目录> [--type skill|agent|plugin] [--version 0.1.0] [--name <name>] [--dry-run]
  agentdock verify <目录>                          本地校验 + 安全扫描，不提交
  agentdock import-claude [--dir ~/.claude/agents] [--publish]   导入 Claude Code 的 agent 定义

  agentdock list [--kind skill|agent|plugin] [--q 关键词] [--status published]
  agentdock install <kind>/<name>[@version] [--target dsh|claude|codex|shared|dir] [--dir <路径>] [--force]

  agentdock review list                            审核队列（需 reviewer 角色）
  agentdock review approve <kind>/<name>@<version> [--note "..."]
  agentdock review reject  <kind>/<name>@<version> [--note "..."]

  agentdock audit [--limit 50]                     审计日志（需 reviewer 角色）
  agentdock tokens create <name> --role reviewer   创建令牌（需 admin 角色）

全局选项：
  --url <url>       服务地址（默认 ${DEFAULT_URL}，或 $AGENTDOCK_URL）
  --token <token>   令牌（或 $AGENTDOCK_TOKEN）
  --json            以 JSON 输出

安装目标：${TARGET_IDS.map((id) => `${id}（${TARGET_LABEL[id]}）`).join('、')}
`;

/* ------------------------------ 参数与配置 ------------------------------ */

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function readCliConfig() {
  try {
    return JSON.parse(fs.readFileSync(CLI_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCliConfig(patch) {
  fs.mkdirSync(path.dirname(CLI_CONFIG_FILE), { recursive: true });
  const next = { ...readCliConfig(), ...patch };
  fs.writeFileSync(CLI_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function resolveConnection(flags) {
  const config = readCliConfig();
  const url = String(flags.url || process.env.AGENTDOCK_URL || config.url || DEFAULT_URL).replace(/\/+$/, '');
  const token = flags.token || process.env.AGENTDOCK_TOKEN || config.token || null;
  return { url, token };
}

/* ------------------------------ HTTP 客户端 ------------------------------ */

async function api(conn, method, pathname, body) {
  const headers = {};
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${conn.url}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`无法连接 AgentDock（${conn.url}）：${error.cause?.code || error.message}`);
  }
  const text = await response.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const error = new Error(json?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.details = json?.error?.details ?? null;
    throw error;
  }
  return json;
}

function requireToken(conn) {
  if (!conn.token) {
    throw new Error('缺少令牌：请先执行 agentdock login --token <token>，或设置 $AGENTDOCK_TOKEN');
  }
}

/* ------------------------------ 包构建与展示 ------------------------------ */

function detectKind(byPath, forced) {
  if (forced) {
    if (!KINDS.includes(forced)) throw new Error(`--type 只能是 ${KINDS.join(' / ')}`);
    return forced;
  }
  if (byPath.has('SKILL.md')) return 'skill';
  if (byPath.has('plugin.json')) return 'plugin';
  if (byPath.has('agent.md')) return 'agent';
  return null;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function loadBundleFromDir(dir, flags) {
  if (!dir) throw new Error('缺少目录参数');
  const { files, warnings } = readBundleFromDirectory(dir);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kind = detectKind(byPath, flags.type);
  if (!kind) throw new Error('无法识别能力类型：请提供 --type skill|agent|plugin（目录需包含 SKILL.md / agent.md / plugin.json 之一）');

  const meta = {
    kind,
    name: flags.name || null,
    version: flags.version || null,
    description: flags.description || '',
    tags: [],
  };

  if (kind === 'skill') {
    const entry = byPath.get('SKILL.md');
    const frontmatter = parseFrontmatter(entry.content).data || {};
    meta.name ||= frontmatter.name;
    meta.description ||= frontmatter.description || '';
    meta.tags = normalizeTags(frontmatter.tags || frontmatter.metadata?.tags);
  } else if (kind === 'agent') {
    const entry = byPath.get('agent.md');
    const frontmatter = parseFrontmatter(entry.content).data || {};
    meta.name ||= frontmatter.name;
    meta.description ||= frontmatter.description || '';
    meta.tags = normalizeTags(frontmatter.tags);
  } else if (kind === 'plugin') {
    let manifest;
    try {
      manifest = JSON.parse(byPath.get('plugin.json').content);
    } catch (error) {
      throw new Error(`plugin.json 不是合法 JSON：${error.message}`);
    }
    meta.name ||= manifest.name;
    meta.version ||= manifest.version;
    meta.description ||= manifest.description || '';
    meta.tags = normalizeTags(manifest.tags || manifest.keywords);
  }

  if (!meta.name) throw new Error('无法确定包名：请用 --name 指定');
  meta.version ||= '0.1.0';
  return { files, warnings, meta };
}

function printAnalysis(report) {
  const lines = [];
  if (report.summary) {
    lines.push(`包        ${report.summary.kind}/${report.summary.name}@${report.summary.version}`);
    lines.push(`文件      ${report.summary.fileCount} 个，${formatBytes(report.summary.totalBytes)}`);
    lines.push(`内容哈希  ${report.summary.contentHash.slice(0, 16)}…`);
    if (report.summary.manifestDescription) lines.push(`能力      ${report.summary.manifestDescription}`);
  }
  if (report.errors.length > 0) {
    lines.push('', '✗ 校验错误');
    for (const item of report.errors) lines.push(`  - [${item.field}] ${item.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', '! 警告');
    for (const item of report.warnings.slice(0, 15)) lines.push(`  - [${item.field}] ${item.message}`);
    if (report.warnings.length > 15) lines.push(`  … 另有 ${report.warnings.length - 15} 条警告`);
  }
  if (report.scan) {
    const summary = report.scan.summary;
    lines.push('', `安全扫描  高危 ${summary.high} / 中危 ${summary.medium} / 低危 ${summary.low}`);
    for (const finding of report.scan.findings.slice(0, 12)) {
      const location = finding.line ? `${finding.file}#L${finding.line}` : finding.file;
      lines.push(`  - [${finding.severity}] ${finding.ruleId} ${finding.title}（${location}）`);
    }
    if (report.scan.findings.length > 12) lines.push(`  … 另有 ${report.scan.findings.length - 12} 条`);
  }
  lines.push('');
  lines.push(report.valid && !report.blocked ? '✓ 校验通过，可以发布' : report.valid ? '✗ 安全扫描命中阻断规则（管理员可用 --override-scan 覆盖）' : '✗ 校验未通过');
  console.log(lines.join('\n'));
}

function printTable(rows, headers) {
  if (rows.length === 0) {
    console.log('（空）');
    return;
  }
  const widths = headers.map((header, index) => Math.max(strWidth(header), ...rows.map((row) => strWidth(String(row[index] ?? '')))));
  console.log(headers.map((header, index) => pad(header, widths[index])).join('  '));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(row.map((cell, index) => pad(String(cell ?? ''), widths[index])).join('  '));
  }
}

function strWidth(text) {
  let width = 0;
  for (const char of text) width += /[\u4e00-\u9fff]/.test(char) ? 2 : 1;
  return width;
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - strWidth(text)));
}

function parseSpec(spec) {
  const match = /^([a-z]+)\/([A-Za-z0-9._-]+)(?:@([0-9A-Za-z.+-]+))?$/.exec(String(spec || ''));
  if (!match) {
    throw new Error(`规格格式应为 <kind>/<name>[@version]，例如 skill/code-reviewer@0.1.0（收到：${spec}）`);
  }
  const [, kind, name, version] = match;
  if (!KINDS.includes(kind)) throw new Error(`kind 只能是 ${KINDS.join(' / ')}（收到：${kind}）`);
  return { kind, name, version };
}

/* ------------------------------ 命令实现 ------------------------------ */

async function cmdServe(flags) {
  const { startServer } = await import('../server.mjs');
  const { loadConfig } = await import('../src/config.mjs');
  const config = loadConfig(process.env, {
    port: flags.port !== undefined ? Number(flags.port) : undefined,
    host: flags.host,
    dataDir: flags.data,
    publicUrl: flags['public-url'],
  });
  const app = await startServer(config);
  console.log('');
  console.log(`  AgentDock 已启动：${app.url}`);
  console.log(`  数据目录：${config.dataDir}`);
  console.log(`  初始化令牌：${config.files.bootstrapTokens}`);
  console.log('');
  const shutdown = () => {
    console.log('正在关闭 AgentDock ...');
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdLogin(flags) {
  const conn = resolveConnection(flags);
  let token = conn.token;
  if (!token && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('请输入 AgentDock 令牌：')).trim();
    rl.close();
  }
  if (!token) throw new Error('缺少令牌：请用 --token 或 $AGENTDOCK_TOKEN 提供');
  const data = await api({ url: conn.url, token }, 'GET', '/api/v1/me');
  saveCliConfig({ url: conn.url, token });
  console.log(`✓ 已登录：${data.user.name}（${data.user.role}） @ ${conn.url}`);
}

async function cmdWhoami(flags) {
  const conn = resolveConnection(flags);
  requireToken(conn);
  const data = await api(conn, 'GET', '/api/v1/me');
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.user.name}（${data.user.role}） @ ${conn.url}`);
}

async function cmdPublish(positionals, flags) {
  const dir = positionals[0];
  const { files, warnings, meta } = loadBundleFromDir(dir, flags);
  const payload = {
    kind: meta.kind,
    name: meta.name,
    version: meta.version,
    description: meta.description,
    tags: meta.tags,
    files,
  };
  const report = analyzeInput(payload, { scanBlock: flags['scan-block'] || 'high' });
  for (const warning of warnings) report.warnings.push(warning);
  if (flags['dry-run']) {
    printAnalysis(report);
    return;
  }
  if (!report.valid) {
    printAnalysis(report);
    process.exitCode = 1;
    return;
  }
  if (report.blocked && !flags['override-scan']) {
    printAnalysis(report);
    process.exitCode = 1;
    return;
  }
  const conn = resolveConnection(flags);
  requireToken(conn);
  const result = await api(conn, 'POST', '/api/v1/packages', {
    ...payload,
    overrideScan: Boolean(flags['override-scan']),
  });
  console.log(`✓ 已提交 ${result.package.kind}/${result.package.name}@${result.version.version}，等待审核`);
  if (result.version.scan?.summary?.total) {
    const summary = result.version.scan.summary;
    console.log(`  安全扫描：高危 ${summary.high} / 中危 ${summary.medium} / 低危 ${summary.low}`);
  }
}

async function cmdVerify(positionals, flags) {
  const dir = positionals[0];
  const { files, warnings, meta } = loadBundleFromDir(dir, flags);
  const report = analyzeInput(
    { kind: meta.kind, name: meta.name, version: meta.version, description: meta.description, tags: meta.tags, files },
    { scanBlock: flags['scan-block'] || 'high' },
  );
  for (const warning of warnings) report.warnings.push(warning);
  if (flags.json) {
    console.log(JSON.stringify({ ...report, bundle: undefined }, null, 2));
  } else {
    printAnalysis(report);
  }
  if (!report.valid || report.blocked) process.exitCode = 1;
}

async function cmdList(flags) {
  const conn = resolveConnection(flags);
  const query = new URLSearchParams();
  if (flags.kind) query.set('kind', String(flags.kind));
  if (flags.q) query.set('q', String(flags.q));
  if (flags.status) query.set('status', String(flags.status));
  const data = await api(conn, 'GET', `/api/v1/packages?${query.toString()}`);
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  printTable(
    data.items.map((item) => [
      `${item.kind}/${item.name}`,
      item.latestVersion,
      item.status,
      KIND_LABEL[item.kind] || item.kind,
      item.installs,
      item.description || '',
    ]),
    ['包', '版本', '状态', '类型', '安装', '描述'],
  );
  console.log(`\n共 ${data.total} 个包`);
}

async function cmdInstall(positionals, flags) {
  const spec = parseSpec(positionals[0]);
  const conn = resolveConnection(flags);
  requireToken(conn);
  let version = spec.version;
  if (!version) {
    const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
    if (!detail.latestVersion) throw new Error('该包还没有已发布版本');
    version = detail.latestVersion;
  }
  const bundleData = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/bundle`,
  );
  const target = flags.target || 'dsh';
  if (!TARGET_LABEL[target]) throw new Error(`未知安装目标：${target}（可选：${TARGET_IDS.join(' / ')}）`);
  const plan = planInstall(bundleData.bundle, {
    target,
    home: resolveHome(),
    dir: flags.dir,
    force: Boolean(flags.force),
  });
  const result = applyInstall(plan);
  const summary = summarizePlan(plan, { home: resolveHome() });
  console.log(`✓ 已安装 ${spec.kind}/${spec.name}@${version} → ${TARGET_LABEL[target]}`);
  console.log(`  目标目录：${summary.absolutePath}`);
  for (const file of summary.files) console.log(`  - ${file.targetPath}`);
  for (const note of summary.notes) console.log(`  ! ${note}`);
  try {
    await api(conn, 'POST', `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/install-event`, { target });
  } catch (error) {
    console.error(`  ! 安装计数上报失败（不影响安装）：${error.message}`);
  }
}

async function cmdReview(positionals, flags) {
  const conn = resolveConnection(flags);
  requireToken(conn);
  const sub = positionals[0];

  if (!sub || sub === 'list') {
    const data = await api(conn, 'GET', '/api/v1/review/queue');
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    printTable(
      data.items.map((item) => [
        `${item.kind}/${item.name}@${item.version}`,
        item.submittedAt?.slice(0, 19).replace('T', ' ') || '',
        item.submittedBy,
        item.scanSummary ? `高${item.scanSummary.high}/中${item.scanSummary.medium}` : '-',
        item.manifestDescription || item.description || '',
      ]),
      ['待审核包', '提交时间', '提交人', '扫描', '说明'],
    );
    console.log(`\n共 ${data.total} 个待审核版本`);
    return;
  }

  if (sub !== 'approve' && sub !== 'reject') {
    throw new Error('review 子命令：list / approve / reject');
  }
  const spec = parseSpec(positionals[1]);
  if (!spec.version) throw new Error('审核必须指定版本，例如 skill/code-reviewer@0.1.0');
  const result = await api(conn, 'POST', '/api/v1/review', {
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
    decision: sub === 'approve' ? 'approve' : 'reject',
    note: flags.note || '',
  });
  console.log(`✓ 已${sub === 'approve' ? '通过' : '拒绝'} ${spec.kind}/${spec.name}@${spec.version}`);
}

async function cmdAudit(flags) {
  const conn = resolveConnection(flags);
  requireToken(conn);
  const limit = Number(flags.limit || 50);
  const data = await api(conn, 'GET', `/api/v1/audit?limit=${limit}`);
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  printTable(
    data.items.map((item) => [item.ts?.slice(0, 19).replace('T', ' '), item.actor, item.action, item.target]),
    ['时间', '操作者', '动作', '对象'],
  );
  console.log(`\n共 ${data.total} 条审计记录`);
}

async function cmdTokens(positionals, flags) {
  if (positionals[0] !== 'create') throw new Error('tokens 子命令：create <name> --role <role>');
  const name = positionals[1];
  if (!name) throw new Error('缺少用户名');
  const role = flags.role || 'publisher';
  const conn = resolveConnection(flags);
  requireToken(conn);
  const data = await api(conn, 'POST', '/api/v1/admin/tokens', { name, role });
  console.log(`✓ 已创建用户 ${data.user.name}（${data.user.role}）`);
  console.log(`  令牌（只显示一次）：${data.token}`);
}

async function cmdImportClaude(flags) {
  const dir = flags.dir || path.join(os.homedir(), '.claude', 'agents');
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  if (entries.length === 0) {
    console.log(`（${dir} 下没有 .md 文件）`);
    return;
  }
  const conn = resolveConnection(flags);
  const publish = Boolean(flags.publish);
  let ok = 0;
  let failed = 0;
  for (const fileName of entries) {
    const abs = path.join(dir, fileName);
    const content = fs.readFileSync(abs, 'utf8');
    const frontmatter = parseFrontmatter(content).data || {};
    const name = String(frontmatter.name || fileName.replace(/\.md$/, '')).trim();
    const payload = {
      kind: 'agent',
      name,
      version: flags.version || '0.1.0',
      description: frontmatter.description || '',
      tags: normalizeTags(frontmatter.tags),
      files: [{ path: 'agent.md', content, encoding: 'utf8' }],
    };
    const report = analyzeInput(payload);
    const status = report.valid && !report.blocked ? '✓' : '✗';
    if (!report.valid || report.blocked) {
      failed += 1;
      console.log(`${status} ${name}  ${report.valid ? '扫描阻断' : '校验失败'}`);
      for (const item of [...report.errors, ...(report.scan?.findings || []).filter((f) => f.severity === 'high')].slice(0, 3)) {
        console.log(`    - ${item.message || item.title}`);
      }
      continue;
    }
    if (!publish) {
      ok += 1;
      console.log(`${status} ${name}  ${frontmatter.description || ''}`);
      continue;
    }
    try {
      await api(conn, 'POST', '/api/v1/packages', payload);
      ok += 1;
      console.log(`✓ 已提交 ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${name}  ${error.message}`);
    }
  }
  console.log('');
  if (publish) console.log(`导入完成：成功 ${ok}，失败 ${failed}（提交后需审核）`);
  else console.log(`扫描完成：可发布 ${ok}，失败 ${failed}。加 --publish 提交到服务端`);
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, positionals } = parseArgs(argv.slice(1));

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'serve':
      return cmdServe(flags);
    case 'login':
      return cmdLogin(flags);
    case 'whoami':
      return cmdWhoami(flags);
    case 'publish':
      return cmdPublish(positionals, flags);
    case 'verify':
      return cmdVerify(positionals, flags);
    case 'list':
      return cmdList(flags);
    case 'install':
      return cmdInstall(positionals, flags);
    case 'review':
      return cmdReview(positionals, flags);
    case 'audit':
      return cmdAudit(flags);
    case 'tokens':
      return cmdTokens(positionals, flags);
    case 'import-claude':
      return cmdImportClaude(flags);
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
