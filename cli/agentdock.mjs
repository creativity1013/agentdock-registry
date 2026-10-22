#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { readBundleFromDirectory, KINDS, KIND_LABEL } from '../src/bundle.mjs';
import { analyzeInput } from '../src/pipeline.mjs';
import { buildImportPayload } from '../src/import.mjs';
import { parseFrontmatter } from '../src/yaml.mjs';
import {
  planInstall,
  applyInstall,
  summarizePlan,
  listInstalls,
  readInstallManifest,
  uninstallPlan,
  applyUninstall,
  TARGET_LABEL,
  TARGET_IDS,
} from '../src/targets.mjs';
import {
  renderPresetPatch,
  upsertProfilePatch,
  writePresetFragment,
} from '../src/dsh-preset.mjs';
import { loadConfig, resolveHome, CLI_CONFIG_FILE } from '../src/config.mjs';
import { publisherSignaturePayload, publicKeyPemFromPrivate } from '../src/signing.mjs';
import { verifyInclusionProof } from '../src/transparency.mjs';
import { pushToGitHub } from '../src/registry.mjs';
import { QUALITY_LABEL } from '../src/quality.mjs';
import { compareVersions, formatBytes } from '../src/util.mjs';
import { BACKUP_EXTENSION, readBackup, restoreBackup, writeBackup } from '../src/backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:7788';

const HELP = `AgentDock — 跨 harness 的 skill / agent / plugin 能力市场与治理平台

用法：
  agentdock serve                                  启动本地服务（默认 http://127.0.0.1:7788）
  agentdock login [--url <url>] [--token <token>]  登录并保存令牌到 ~/.agentdock/config.json
  agentdock whoami                                 查看当前用户

  agentdock publish <目录|文件> [--type skill|agent|plugin] [--version 0.1.0] [--name <name>] [--dry-run]
                    支持目录 / .json bundle / .zip / .tar.gz / .md（单文件技能或 agent）/ plugin.json
                    [--key <私钥 PEM>] [--key-name <名字>]  附加发布者内容签名（TOFU 自动注册公钥）
  agentdock verify <目录|文件>                     本地校验 + 安全扫描，不提交（格式同 publish）
  agentdock import-claude [--dir ~/.claude/agents] [--publish] [--presets] [--presets-dir <目录>] [--profile <profile>]
                                                   导入 Claude Code agent；可同时生成 DSH agent-preset 片段

  agentdock list [--kind skill|agent|plugin] [--q 关键词] [--status published]
  agentdock install <kind>/<name>[@version] [--target dsh|dsh-agent|claude|codex|shared|dir] [--dir <路径>] [--force] [--profile <profile>]
                    [--no-verify] [--allow-risk]  安装前默认扫描 + 验签（--no-verify 跳过）
                                                   target=dsh-agent 生成 DSH preset 片段；--profile 会并入该 profile 的 cordis.patch.yml

  agentdock outdated [--target <target>] [--dir <路径>] [--json]
                                                   检查本地已安装包是否有新版本（读取安装清单）
  agentdock upgrade <kind>/<name>[@version] [--target dsh|dsh-agent|claude|codex|shared|dir] [--dir <路径>] [--profile <profile>]
                    [--no-verify] [--allow-risk]  升级前默认扫描 + 验签（--no-verify 跳过）
                                                   升级本地安装到最新（或指定）版本，默认覆盖同名文件

  agentdock verify-signature <kind>/<name>[@version]
                                                   验证平台内容签名（ed25519，重算磁盘内容哈希）
  agentdock keys [--mine]                          查看平台签名公钥 / 我的发布者公钥（--mine）
  agentdock keygen [--out <目录>] [--name <名字>] [--force]
                                                   生成发布者 ed25519 密钥对（私钥 600，公钥可公开）
  agentdock register-key --key <公钥 PEM 文件> [--name <名字>]
                                                   把公钥注册到当前账号（publish --key 也会自动 TOFU 注册）

  agentdock transparency [head|verify|entries|proof <kind>/<name>[@version]]
                                                   可验证透明日志：查看头部 / 验链 / 列表 / 版本包含证明

  agentdock sbom <kind>/<name>[@version]            查看版本 SBOM（文件哈希 + 工具/MCP 组件）
  agentdock policy show                             查看自动审批策略（需 reviewer）
  agentdock policy set --file <policy.json>         更新自动审批策略（需 admin）
  agentdock sync sources                           查看已配置的外部 registry 适配器
  agentdock sync import github <owner/repo> [--path 子目录] [--ref 分支] [--version 0.1.0] [--dry-run]
                                                   从 GitHub 导入 skill/agent/plugin，进入待审核队列
  agentdock sync import mcp <server-name> [--version 1.0.0] [--dry-run]
                                                   从 MCP registry 导入 server 为 plugin 能力包
  agentdock sync export [--out <文件>]             导出中立市场目录（agentdock-marketplace@1）
  agentdock sync push github <kind>/<name>[@version] --repo <owner/repo> [--path 子目录] [--branch main]
                    [--message "..."] [--dry-run]  把已上架能力包推送为 GitHub 单次 commit（需 GITHUB_TOKEN）

  agentdock review list                            审核队列（需 reviewer 角色）
  agentdock review approve <kind>/<name>@<version> [--note "..."]
  agentdock review reject  <kind>/<name>@<version> [--note "..."]

  agentdock audit [--limit 50] [--offset N] [--action <动作>] [--actor <用户>] [--target <子串>]
                    [--from <ISO 时间>] [--to <ISO 时间>]     审计日志查询（需 reviewer 角色）
  agentdock audit verify [--all]                   校验审计哈希链（--all 含归档；失败 exit 1）
  agentdock audit export --format csv|jsonl [--out <文件>] [过滤 flags]
                                                   导出审计记录（时间正序，CSV 按 RFC 4180 转义）
  agentdock tokens create <name> --role reviewer   创建令牌（需 admin 角色）
  agentdock users disable|enable <id或名字>         禁用/启用用户（禁用即踢下线，需 admin）
  agentdock users revoke <id或名字>                 强制该用户所有会话下线（需 admin）
  agentdock sessions revoke-all                     强制全员会话下线（需 admin）
  agentdock notify show                             查看 webhook 通知配置（需 admin）
  agentdock notify set <配置.json>                   设置通知配置（需 admin）
  agentdock notify test                             发送一条测试通知（需 admin）

  agentdock backup [--data <目录>] [--out <文件>] [--no-bootstrap]
                                                   备份 data/ 为带校验和的 gzip 归档（默认 agentdock-backup-<时间>.json.gz）
  agentdock restore <备份文件> [--data <目录>] [--force] [--dry-run]
                                                   恢复备份到数据目录（需先停服；--dry-run 只校验）

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

async function loadBundleFromPath(target, flags) {
  if (!target) throw new Error('缺少文件或目录参数');
  let stats;
  try {
    stats = fs.statSync(target);
  } catch (error) {
    throw new Error(`路径不存在或不可读：${target}`);
  }
  const overrides = {
    kind: flags.type ? String(flags.type) : undefined,
    name: flags.name ? String(flags.name) : undefined,
    version: flags.version ? String(flags.version) : undefined,
    description: flags.description ? String(flags.description) : undefined,
    tags: flags.tags ? String(flags.tags).split(',').map((item) => item.trim()).filter(Boolean) : undefined,
  };
  if (stats.isDirectory()) {
    const loaded = loadBundleFromDir(target, flags);
    return { ...loaded, format: 'directory' };
  }
  const buffer = fs.readFileSync(target);
  const built = await buildImportPayload({
    filename: path.basename(target),
    contentType: '',
    buffer,
    overrides,
  });
  if (!built.payload) throw new Error('导入文件解析失败：没有生成包内容');
  return {
    files: built.payload.files,
    warnings: [],
    meta: {
      kind: built.payload.kind,
      name: built.payload.name,
      version: built.payload.version,
      description: built.payload.description || '',
      tags: built.payload.tags || [],
    },
    format: built.format,
  };
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
      if (finding.reason) lines.push(`      为什么判定：${finding.reason}`);
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
  const target = positionals[0];
  const { files, warnings, meta, format } = await loadBundleFromPath(target, flags);
  if (format && format !== 'directory') console.log(`▸ 已解析 ${format} 导入格式`);
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
  if (flags.key) {
    payload.publisherSignature = buildPublisherSignature({
      keyFile: String(flags.key),
      keyName: flags['key-name'] ? String(flags['key-name']) : '',
      kind: meta.kind,
      name: meta.name,
      version: meta.version,
      contentHash: report.bundle.contentHash,
    });
    console.log(`▸ 已附加发布者签名（${payload.publisherSignature.keyName}）`);
  }
  const result = await api(conn, 'POST', '/api/v1/packages', {
    ...payload,
    overrideScan: Boolean(flags['override-scan']),
  });
  const statusNote = result.autoApproved ? '已通过策略自动审批并上架' : '等待审核';
  console.log(`✓ 已提交 ${result.package.kind}/${result.package.name}@${result.version.version}，${statusNote}`);
  if (result.version.scan?.summary?.total) {
    const summary = result.version.scan.summary;
    console.log(`  安全扫描：高危 ${summary.high} / 中危 ${summary.medium} / 低危 ${summary.low}`);
  }
}

async function cmdVerify(positionals, flags) {
  const target = positionals[0];
  const { files, warnings, meta, format } = await loadBundleFromPath(target, flags);
  if (format && format !== 'directory') console.log(`▸ 已解析 ${format} 导入格式`);
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
  query.set('pageSize', '100');
  const data = await api(conn, 'GET', `/api/v1/packages?${query.toString()}`);
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  printTable(
    data.items.map((item) => [
      `${item.kind}/${item.name}`,
      item.latestVersion,
      item.status,
      QUALITY_LABEL[item.quality?.level] || item.quality?.level || '-',
      item.installs,
      item.description || '',
    ]),
    ['包', '版本', '状态', '质量', '安装', '描述'],
  );
  console.log(`\n共 ${data.total} 个包`);
}

async function cmdQuality(positionals, flags) {
  const conn = resolveConnection(flags);
  const spec = parseSpec(positionals[0]);
  const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
  const version = spec.version || detail.latestVersion;
  if (!version) throw new Error('该包还没有已发布版本');
  const data = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}`,
  );
  const versionDoc = data?.quality ? data : (data?.version && typeof data.version === 'object' ? data.version : data);
  if (flags.json) return console.log(JSON.stringify(versionDoc.quality || null, null, 2));
  const quality = versionDoc.quality || { level: 'community', label: '社区', checks: {} };
  console.log(`${spec.kind}/${spec.name}@${version}`);
  console.log(`  质量：${quality.label}（${quality.level}）`);
  const checks = quality.checks || {};
  const mark = (value) => (value ? '✓' : '✗');
  console.log(`  平台签名：${mark(checks.signed)}   发布者签名：${mark(checks.publisherSigned)}`);
  console.log(`  审核通过：${mark(checks.reviewed)}   人工审核：${mark(checks.humanReview)}`);
  console.log(`  无高危：${mark(checks.scanNoHigh)}   无高危/中危：${mark(checks.scanClean)}`);
}

/**
 * 安装/升级前的本地复检：默认开启安全扫描与签名校验。
 * --no-verify 跳过两者；--allow-risk 在命中高危/签名无效时仍继续。
 */
async function preflightInstall(conn, bundle, flags) {
  const skipAll = Boolean(flags['no-verify']);
  const wantScan = !skipAll && flags.scan !== false;
  const wantVerify = !skipAll && flags.verify !== false;
  if (wantScan) {
    const report = analyzeInput(bundle);
    const summary = report.scan.summary;
    console.log(`  安装前扫描：高危 ${summary.high} / 中危 ${summary.medium} / 低危 ${summary.low}`);
    for (const finding of report.scan.findings.slice(0, 3)) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.log(`  ! [${finding.severity}] ${finding.ruleId} ${location} ${finding.title}`);
      if (finding.reason) console.log(`    为什么判定：${finding.reason}`);
    }
    if (report.blocked && !flags['allow-risk']) {
      throw new Error('安装前扫描命中高危规则，已中止（如确认可信，加 --allow-risk 跳过）');
    }
  }
  if (wantVerify) {
    const result = await api(
      conn,
      'GET',
      `/api/v1/packages/${bundle.kind}/${bundle.name}/versions/${encodeURIComponent(bundle.version)}/signature?verify=1`,
    );
    if (result.valid) {
      console.log(`  签名校验：✓ ${result.algorithm} ${String(result.keyId || '').slice(0, 16)}…`);
    } else {
      const reasonsText = (result.reasons || []).join('；') || '未知原因';
      if (!flags['allow-risk']) {
        throw new Error(`安装前签名校验失败：${reasonsText}（如确认可信，加 --allow-risk 跳过）`);
      }
      console.log(`  ! 签名校验失败（已按 --allow-risk 继续）：${reasonsText}`);
    }
  }
}

/** 检查本地已安装包是否有新版本 */
async function cmdOutdated(flags) {
  const conn = resolveConnection(flags);
  const home = resolveHome();
  const targets = flags.target ? [String(flags.target)] : TARGET_IDS.filter((item) => item !== 'dir');
  const installs = listInstalls({ home, dir: flags.dir, targets });
  if (installs.length === 0) {
    console.log('没有发现 AgentDock 安装记录。');
    return;
  }
  const rows = [];
  let updates = 0;
  for (const inst of installs) {
    let latest = null;
    let error = null;
    try {
      const detail = await api(conn, 'GET', `/api/v1/packages/${inst.kind}/${inst.name}`);
      latest = detail.latestVersion ?? null;
    } catch (err) {
      error = err.message;
    }
    const hasUpdate = Boolean(latest && inst.version && compareVersions(latest, inst.version) > 0);
    if (hasUpdate) updates += 1;
    rows.push([
      inst.target,
      `${inst.kind}/${inst.name}`,
      inst.version,
      latest ?? (error ? `! ${error}` : '-'),
      hasUpdate ? '有更新' : error ? '查询失败' : '最新',
      inst.installedAt ? new Date(inst.installedAt).toLocaleString('zh-CN', { hour12: false }) : '',
    ]);
  }
  if (flags.json) return console.log(JSON.stringify({ installs, updates }, null, 2));
  printTable(rows, ['目标', '包', '已安装', '最新', '状态', '安装时间']);
  console.log(`\n共 ${installs.length} 个安装，${updates} 个有更新。`);
  if (updates > 0) console.log('升级：agentdock upgrade <kind>/<name> --target <target>');
}

/** 升级本地已安装包到最新（或指定）版本 */
async function cmdUpgrade(positionals, flags) {
  const spec = parseSpec(positionals[0]);
  const conn = resolveConnection(flags);
  requireToken(conn);
  const home = resolveHome();
  const target = flags.target || 'dsh';
  if (!TARGET_LABEL[target]) throw new Error(`未知安装目标：${target}（可选：${TARGET_IDS.join(' / ')}）`);
  const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
  const version = spec.version || detail.latestVersion;
  if (!version) throw new Error('该包还没有已发布版本');
  const installed = listInstalls({ home, dir: flags.dir, targets: [target] }).find(
    (item) => item.kind === spec.kind && item.name === spec.name,
  );
  if (installed && compareVersions(version, installed.version) <= 0 && !flags.force) {
    console.log(`已是最新：${spec.kind}/${spec.name}@${installed.version}（目标 ${target}）`);
    console.log('如需强制重装，请加 --force');
    return;
  }
  const bundleData = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/bundle`,
  );
  await preflightInstall(conn, bundleData.bundle, flags);
  const previous = readInstallManifest({ kind: spec.kind, name: spec.name, target, home, dir: flags.dir }).manifest;
  const history = previous
    ? [
        ...(Array.isArray(previous.history) ? previous.history : []),
        {
          version: previous.package.version,
          contentHash: previous.contentHash || null,
          installedAt: previous.installedAt || null,
        },
      ].slice(-5)
    : [];
  const plan = planInstall(bundleData.bundle, { target, home, dir: flags.dir, force: true, history });
  applyInstall(plan);
  const summary = summarizePlan(plan, { home });
  console.log(
    `✓ 已升级 ${spec.kind}/${spec.name}${installed ? ` ${installed.version} → ` : ' '}${version}（${TARGET_LABEL[target]}）`,
  );
  console.log(`  目标目录：${summary.absolutePath}`);
  for (const note of summary.notes) console.log(`  ! ${note}`);
  if (summary.preset && typeof flags.profile === 'string' && flags.profile.trim()) {
    const merged = upsertProfilePatch({
      profile: flags.profile.trim(),
      home,
      presetId: summary.preset.id,
      body: plan.preset.body,
    });
    console.log(`✓ 已并入 profile「${flags.profile.trim()}」：${merged.file}${merged.replaced ? '（替换旧块）' : ''}`);
  }
  try {
    await api(
      conn,
      'POST',
      `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/install-event`,
      { target },
    );
  } catch (error) {
    console.error(`  ! 安装计数上报失败（不影响升级）：${error.message}`);
  }
}

function findInstalls(spec, flags) {
  const targets = flags.target
    ? [String(flags.target)]
    : TARGET_IDS.filter((item) => item !== 'dir' || flags.dir);
  return listInstalls({ home: resolveHome(), dir: flags.dir, targets }).filter(
    (item) => item.kind === spec.kind && item.name === spec.name,
  );
}

/** 卸载本地已安装的能力包（读取安装清单后删除文件/目录） */
async function cmdUninstall(positionals, flags) {
  const spec = parseSpec(positionals[0]);
  const matches = findInstalls(spec, flags);
  if (matches.length === 0) throw new Error(`未找到已安装的 ${spec.kind}/${spec.name}（可用 list --installed 查看）`);
  for (const entry of matches) {
    const plan = uninstallPlan({
      kind: spec.kind,
      name: spec.name,
      target: entry.target,
      home: resolveHome(),
      dir: flags.dir,
    });
    const result = applyUninstall(plan);
    console.log(`✓ 已卸载 ${spec.kind}/${spec.name}@${entry.version}（${TARGET_LABEL[entry.target]}）`);
    for (const removed of result.removed) console.log(`  - ${removed}`);
  }
}

/** 回滚到安装清单里记录的上一版本 */
async function cmdRollback(positionals, flags) {
  const spec = parseSpec(positionals[0]);
  const conn = resolveConnection(flags);
  requireToken(conn);
  const home = resolveHome();
  const matches = findInstalls(spec, flags);
  if (matches.length === 0) throw new Error(`未找到已安装的 ${spec.kind}/${spec.name}`);
  const entry = matches[0];
  const { manifest } = readInstallManifest({
    kind: spec.kind,
    name: spec.name,
    target: entry.target,
    home,
    dir: flags.dir,
  });
  const history = Array.isArray(manifest?.history) ? manifest.history : [];
  const targetVersion = history[history.length - 1];
  if (!targetVersion?.version) {
    throw new Error(`${spec.kind}/${spec.name} 没有可回滚的历史版本（安装/升级一次后才有记录）`);
  }
  const bundleData = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(targetVersion.version)}/bundle`,
  );
  await preflightInstall(conn, bundleData.bundle, flags);
  // 回滚后把当前版本记入历史，便于再次回滚/前进
  const remaining = history.slice(0, -1);
  if (!remaining.some((item) => item.version === entry.version)) {
    remaining.push({ version: entry.version, installedAt: entry.installedAt ?? null });
  }
  const plan = planInstall(bundleData.bundle, {
    target: entry.target,
    home,
    dir: flags.dir,
    force: true,
    history: remaining,
  });
  applyInstall(plan);
  console.log(`✓ 已回滚 ${spec.kind}/${spec.name}：${entry.version} → ${targetVersion.version}（${TARGET_LABEL[entry.target]}）`);
  console.log(`  目标目录：${plan.dest.absolutePath}`);
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
  await preflightInstall(conn, bundleData.bundle, flags);
  const target = flags.target || 'dsh';
  if (!TARGET_LABEL[target]) throw new Error(`未知安装目标：${target}（可选：${TARGET_IDS.join(' / ')}）`);
  const home = resolveHome();
  const previous = readInstallManifest({ kind: spec.kind, name: spec.name, target, home, dir: flags.dir }).manifest;
  const history = previous
    ? [
        ...(Array.isArray(previous.history) ? previous.history : []),
        {
          version: previous.package.version,
          contentHash: previous.contentHash || null,
          installedAt: previous.installedAt || null,
        },
      ].slice(-5)
    : [];
  const plan = planInstall(bundleData.bundle, {
    target,
    home,
    dir: flags.dir,
    force: Boolean(flags.force),
    history,
  });
  const result = applyInstall(plan);
  const summary = summarizePlan(plan, { home: resolveHome() });
  console.log(`✓ 已安装 ${spec.kind}/${spec.name}@${version} → ${TARGET_LABEL[target]}`);
  console.log(`  目标目录：${summary.absolutePath}`);
  if (history.length) console.log(`  历史版本（可回滚）：${history.map((item) => item.version).join(' → ')}`);
  for (const file of summary.files) console.log(`  - ${file.targetPath}`);
  for (const note of summary.notes) console.log(`  ! ${note}`);
  if (summary.preset) {
    console.log(`  预设 id：${summary.preset.id}`);
    console.log(`  preset 插件行：${summary.preset.pluginIds.join(', ')}`);
    for (const warning of summary.preset.warnings) console.log(`  ! ${warning}`);
    if (typeof flags.profile === 'string' && flags.profile.trim()) {
      const merged = upsertProfilePatch({
        profile: flags.profile.trim(),
        home: resolveHome(),
        presetId: summary.preset.id,
        body: plan.preset.body,
      });
      console.log(
        `✓ 已并入 profile「${flags.profile.trim()}」：${merged.file}${merged.replaced ? '（替换旧块）' : ''}`,
      );
      console.log('  重启 DSH 后即可在 Settings → Agent presets 中选择该 preset。');
    } else {
      console.log('  提示：加 --profile <name> 可自动并入该 profile 的 cordis.patch.yml。');
    }
  }
  try {
    await api(conn, 'POST', `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/install-event`, { target });
  } catch (error) {
    console.error(`  ! 安装计数上报失败（不影响安装）：${error.message}`);
  }
}

/** 读取发布者私钥并生成 detached 签名（publish --key 用） */
function buildPublisherSignature({ keyFile, keyName, kind, name, version, contentHash }) {
  if (!contentHash) throw new Error('缺少 contentHash，无法签名（请先重新校验）');
  const privatePem = fs.readFileSync(keyFile, 'utf8');
  const payload = publisherSignaturePayload({ kind, name, version, contentHash });
  let signature;
  try {
    signature = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privatePem)).toString('base64');
  } catch (error) {
    throw new Error(`私钥无法使用：${error.message}`);
  }
  return {
    signature,
    publicKey: publicKeyPemFromPrivate(privatePem),
    keyName: keyName || path.basename(keyFile).replace(/\.pem$/i, '') || 'publisher',
  };
}

async function cmdKeygen(flags) {
  if (typeof crypto.generateKeyPairSync !== 'function') throw new Error('当前 Node 不支持 ed25519 密钥生成');
  const outDir = path.resolve(flags.out ? String(flags.out) : process.cwd());
  const name = flags.name ? String(flags.name) : 'publisher';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('--name 只能包含字母、数字、点、下划线和短横线');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateFile = path.join(outDir, `${name}-private.pem`);
  const publicFile = path.join(outDir, `${name}-public.pem`);
  if (fs.existsSync(privateFile) && !flags.force) {
    throw new Error(`私钥文件已存在：${privateFile}（加 --force 可覆盖）`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(privateFile, privatePem, { mode: 0o600 });
  fs.writeFileSync(publicFile, publicPem, { mode: 0o644 });
  console.log(`✓ 已生成发布者密钥对`);
  console.log(`  私钥（勿泄露）：${privateFile}`);
  console.log(`  公钥（可公开）：${publicFile}`);
  console.log('');
  console.log('下一步：');
  console.log(`  node cli/agentdock.mjs register-key --key ${publicFile} --name ${name}`);
  console.log(`  node cli/agentdock.mjs publish <目录> --key ${privateFile} --key-name ${name}`);
}

async function cmdRegisterKey(flags) {
  const conn = resolveConnection(flags);
  requireToken(conn);
  const file = flags.key ? String(flags.key) : '';
  const keyPath = file && fs.existsSync(file) ? file : file;
  let publicKeyPem;
  if (keyPath) {
    publicKeyPem = fs.readFileSync(keyPath, 'utf8');
  } else {
    throw new Error('需要 --key <公钥 PEM 文件>');
  }
  const name = flags.name ? String(flags.name) : path.basename(keyPath).replace(/\.pem$/i, '');
  const data = await api(conn, 'POST', '/api/v1/me/keys', { name, publicKeyPem });
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`✓ 已注册密钥 ${data.key.name}（keyId ${data.key.keyId}）`);
  console.log('  下次发布：agentdock publish <目录> --key <私钥 PEM>');
}

async function cmdTransparency(positionals, flags) {
  const conn = resolveConnection(flags);
  const sub = positionals[0] || 'head';
  if (sub === 'head' || sub === 'entries') {
    if (sub === 'entries') {
      const limit = flags.limit ? String(flags.limit) : '20';
      const data = await api(conn, 'GET', `/api/v1/transparency/entries?limit=${encodeURIComponent(limit)}`);
      if (flags.json) return console.log(JSON.stringify(data, null, 2));
      console.log(`透明日志：${data.head.size} 条事件，Merkle 根 ${data.head.merkleRoot || '（空）'}`);
      for (const entry of data.items) {
        console.log(`  #${entry.seq} ${entry.at}  ${entry.kind}/${entry.name}@${entry.version}`);
        console.log(`     contentHash ${entry.contentHash.slice(0, 16)}…  平台签名 ${entry.platformKeyId || '无'}  发布者签名 ${entry.publisherKeyId || '无'}`);
      }
      return;
    }
    const head = await api(conn, 'GET', '/api/v1/transparency/head');
    if (flags.json) return console.log(JSON.stringify(head, null, 2));
    console.log(`透明日志头部：`);
    console.log(`  事件数：${head.size}`);
    console.log(`  头部哈希：${head.headHash}`);
    console.log(`  Merkle 根：${head.merkleRoot || '（空）'}`);
    console.log(`  最后事件：${head.lastEventAt || '-'}`);
    return;
  }
  if (sub === 'verify') {
    const data = await api(conn, 'GET', '/api/v1/transparency/verify');
    if (flags.json) {
      console.log(JSON.stringify(data, null, 2));
      if (!data.ok) process.exitCode = 1;
      return;
    }
    if (data.ok) {
      console.log(`✓ 透明日志校验通过（${data.size} 条事件，头部 ${data.headHash.slice(0, 16)}…）`);
    } else {
      console.error(`✗ 透明日志校验失败：${data.reasons.join('；')}`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === 'proof') {
    const spec = parseSpec(positionals[1]);
    const conn2 = conn;
    let version = spec.version;
    if (!version) {
      const detail = await api(conn2, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
      if (!detail.latestVersion) throw new Error('该包还没有已发布版本');
      version = detail.latestVersion;
    }
    const query = new URLSearchParams({ kind: spec.kind, name: spec.name, version });
    const data = await api(conn2, 'GET', `/api/v1/transparency/proof?${query.toString()}`);
    const checked = verifyInclusionProof({
      leafHash: data.entry.hash,
      index: data.index,
      size: data.size,
      proof: data.proof,
      root: data.root,
    });
    if (flags.json) {
      console.log(JSON.stringify({ ...data, localVerified: checked }, null, 2));
      if (!checked) process.exitCode = 1;
      return;
    }
    console.log(`▸ ${spec.kind}/${spec.name}@${version} 透明日志包含证明`);
    console.log(`  事件序号：#${data.entry.seq}（index ${data.index} / size ${data.size}）`);
    console.log(`  事件哈希：${data.entry.hash}`);
    console.log(`  Merkle 根：${data.root}`);
    console.log(`  本地校验：${checked ? '✓ 通过' : '✗ 失败'}`);
    if (!checked) process.exitCode = 1;
    return;
  }
  throw new Error(`未知子命令：transparency ${sub}（支持 head / verify / entries / proof）`);
}

async function cmdPolicy(positionals, flags) {
  const conn = resolveConnection(flags);
  const sub = positionals[0] || 'show';
  if (sub === 'show') {
    const data = await api(conn, 'GET', '/api/v1/policy');
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    const auto = data.policy.autoApprove;
    console.log(`自动审批策略（来源：${data.source === 'file' ? 'policy.json' : '默认值'}）`);
    console.log(`  启用：${auto.enabled ? '是' : '否'}`);
    console.log(`  允许 kind：${auto.kinds.join(', ')}`);
    console.log(`  信任发布者：${auto.trustedPublishers.length ? auto.trustedPublishers.join(', ') : '（不限）'}`);
    console.log(`  要求发布者签名：${auto.requirePublisherSignature ? '是' : '否'}`);
    console.log(`  中危上限：${auto.maxMedium}`);
    console.log(`  文件数上限：${auto.maxFiles}  体积上限：${formatBytes(auto.maxTotalBytes)}`);
    if (data.policy.updatedAt) console.log(`  更新：${data.policy.updatedAt} by ${data.policy.updatedBy || '-'}`);
    return;
  }
  if (sub === 'set') {
    requireToken(conn);
    if (!flags.file) throw new Error('需要 --file <policy.json>');
    const raw = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
    const data = await api(conn, 'PUT', '/api/v1/policy', raw.policy ? raw : { policy: raw });
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`✓ ${data.message}（启用：${data.policy.autoApprove.enabled ? '是' : '否'}）`);
    return;
  }
  throw new Error(`未知子命令：policy ${sub}（可用 show / set）`);
}

async function cmdSbom(positionals, flags) {
  const notFound = positionals[0];
  if (!notFound) throw new Error('用法：agentdock sbom <kind>/<name>[@version]');
  const spec = parseSpec(notFound);
  const conn = resolveConnection(flags);
  let version = spec.version;
  if (!version) {
    const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
    version = detail.latestVersion || detail.versions?.find((item) => item.status === 'published')?.version;
    if (!version) throw new Error('该包还没有已发布版本');
  }
  const data = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/sbom`,
  );
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  const sbom = data.sbom;
  console.log(`SBOM ${sbom.schema} — ${spec.kind}/${spec.name}@${sbom.subject.version}`);
  console.log(`  digest：${sbom.digest}`);
  console.log(`  contentHash：${sbom.subject.contentHash}`);
  console.log(`  文件：${sbom.summary.fileCount} 个，${formatBytes(sbom.summary.totalBytes)}；组件：${sbom.summary.componentCount} 个`);
  for (const [type, count] of Object.entries(sbom.summary.counts || {})) {
    console.log(`    ${type}: ${count}`);
  }
  for (const component of sbom.components) {
    const extra = component.command ? `  command=${component.command}` : component.url ? `  url=${component.url}` : '';
    console.log(`  - [${component.type}] ${component.name}${extra}`);
  }
  for (const file of sbom.files) {
    console.log(`    ${file.path}  ${formatBytes(file.bytes)}  sha256:${file.sha256.slice(0, 16)}…`);
  }
}

async function cmdKeys(flags) {
  const conn = resolveConnection(flags);
  if (flags.mine) {
    requireToken(conn);
    const mine = await api(conn, 'GET', '/api/v1/me/keys');
    if (flags.json) return console.log(JSON.stringify(mine, null, 2));
    if (mine.keys.length === 0) {
      console.log('当前账号还没有发布者密钥。生成：agentdock keygen --out ~/.agentdock/keys');
      return;
    }
    for (const key of mine.keys) {
      console.log(`${key.name}  keyId=${key.keyId}  ${key.algorithm}  创建于 ${new Date(key.createdAt).toLocaleString('zh-CN', { hour12: false })}`);
    }
    return;
  }
  const data = await api(conn, 'GET', '/api/v1/keys');
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  for (const key of data.keys) {
    console.log(`算法：${key.algorithm}`);
    console.log(`keyId：${key.keyId}`);
    console.log(`创建时间：${new Date(key.createdAt).toLocaleString('zh-CN', { hour12: false })}`);
    console.log('公钥（PEM）：');
    console.log(key.publicKey.trimEnd());
  }
  console.log('\n离线验签：用该公钥对载荷 [agentdock-v1, kind, name, version, contentHash].join(\'\\n\') 做 ed25519 验签。');
}

async function cmdVerifySignature(positionals, flags) {
  const spec = parseSpec(positionals[0]);
  const conn = resolveConnection(flags);
  let version = spec.version;
  if (!version) {
    const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
    if (!detail.latestVersion) throw new Error('该包还没有已发布版本');
    version = detail.latestVersion;
  }
  const data = await api(
    conn,
    'GET',
    `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/signature?verify=1`,
  );
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    if (!data.valid) process.exitCode = 1;
    return;
  }
  console.log(`▸ ${spec.kind}/${spec.name}@${version}`);
  console.log(`  状态：${data.statusLabel || data.status}${data.signed ? '（已签名）' : '（未签名）'}`);
  if (data.keyId) console.log(`  keyId：${data.keyId}（${data.algorithm || 'ed25519'}）`);
  if (data.signedAt) console.log(`  签名时间：${new Date(data.signedAt).toLocaleString('zh-CN', { hour12: false })}`);
  if (data.contentHash) console.log(`  contentHash：${data.contentHash}`);
  if (data.diskContentHash && data.diskContentHash !== data.contentHash) {
    console.log(`  磁盘哈希：${data.diskContentHash}（不一致！）`);
  }
  if (data.valid) {
    console.log('  ✓ 签名有效，内容完整性校验通过');
  } else {
    console.log('  ✗ 签名校验未通过：');
    for (const reason of data.reasons || []) console.log(`    - ${reason}`);
    process.exitCode = 1;
  }
}

async function cmdSync(positionals, flags) {
  const conn = resolveConnection(flags);
  const sub = positionals[0];

  if (!sub || sub === 'sources') {
    const data = await api(conn, 'GET', '/api/v1/registry');
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    console.log('外部 registry 适配器：');
    for (const adapter of data.adapters) {
      console.log(`  ${adapter.type.padEnd(8)} ${adapter.label}`);
      console.log(`           ${adapter.description}`);
      console.log(`           base：${adapter.baseUrl}${adapter.tokenConfigured ? '（已配置 token）' : ''}`);
    }
    console.log(`\n市场目录导出：${data.exportUrl}`);
    return;
  }

  if (sub === 'export') {
    const catalog = await api(conn, 'GET', '/api/v1/registry/export');
    const text = `${JSON.stringify(catalog, null, 2)}\n`;
    if (flags.out) {
      const out = path.resolve(String(flags.out));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
      console.log(`✓ 已导出市场目录：${out}（${catalog.count} 个能力包，digest ${catalog.digest.slice(0, 16)}…）`);
    } else {
      process.stdout.write(text);
    }
    return;
  }

  if (sub === 'import') {
    requireToken(conn);
    const type = positionals[1];
    const target = positionals[2];
    if (!type || !target) {
      throw new Error('用法：agentdock sync import github <owner/repo> [--path 子目录] 或 sync import mcp <server-name>');
    }
    let source;
    if (type === 'github') {
      source = { type: 'github', repo: target, path: flags.path || '', ref: flags.ref || '' };
    } else if (type === 'mcp') {
      source = { type: 'mcp', name: target, version: flags.version || '' };
    } else {
      throw new Error(`不支持的 source 类型：${type}（可选 github / mcp）`);
    }
    const body = {
      source,
      dryRun: Boolean(flags['dry-run']),
      ...(flags.version ? { version: String(flags.version) } : {}),
      ...(flags.description ? { description: String(flags.description) } : {}),
    };
    const data = await api(conn, 'POST', '/api/v1/sync/import', body);
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    const formatWarning = (warning) =>
      typeof warning === 'string' ? warning : warning?.message || JSON.stringify(warning);
    if (data.dryRun) {
      const label = `${data.kind}/${data.name}@${data.version}`;
      const scanSummary = data.scan?.summary || {};
      console.log(`▸ 导入预检：${label}（source: ${data.source.type}）`);
      console.log(`  校验：${data.valid ? '通过' : '未通过'}  扫描：高 ${scanSummary.high ?? 0} / 中 ${scanSummary.medium ?? 0} / 低 ${scanSummary.low ?? 0}`);
      for (const warning of data.warnings || []) console.log(`  ! ${formatWarning(warning)}`);
      if (!data.ok) {
        for (const error of data.errors || []) console.log(`  ✗ ${error.field}：${error.message}`);
        process.exitCode = 1;
      }
      return;
    }
    const label = `${data.package.kind}/${data.package.name}@${data.version.version}`;
    const statusNote = data.autoApproved ? '已通过策略自动审批' : '等待审核';
    console.log(`✓ 已从 ${data.source.type} registry 导入 ${label}，${statusNote}`);
    for (const warning of data.warnings || []) console.log(`  ! ${formatWarning(warning)}`);
    if (!data.autoApproved) {
      console.log(`  下一步：agentdock review approve ${data.package.kind}/${data.package.name}@${data.version.version}`);
    }
    return;
  }

  if (sub === 'push') {
    const type = positionals[1];
    if (type !== 'github') {
      throw new Error('推送目前只支持 GitHub：agentdock sync push github <kind>/<name>[@version> --repo <owner/repo>');
    }
    const spec = parseSpec(positionals[2]);
    const repo = flags.repo ? String(flags.repo) : '';
    if (!repo) throw new Error('缺少 --repo <owner/repo>');
    const branch = flags.branch ? String(flags.branch) : 'main';
    const basePath = flags.path ? String(flags.path) : '';
    let version = spec.version;
    if (!version) {
      const detail = await api(conn, 'GET', `/api/v1/packages/${spec.kind}/${spec.name}`);
      version = detail.latestVersion;
      if (!version) throw new Error('该包还没有已发布版本');
    }
    const bundleData = await api(
      conn,
      'GET',
      `/api/v1/packages/${spec.kind}/${spec.name}/versions/${encodeURIComponent(version)}/bundle`,
    );
    const files = bundleData.bundle.files || [];
    if (flags['dry-run']) {
      console.log(`▸ 推送预检：${spec.kind}/${spec.name}@${version} → github ${repo}@${branch}${basePath ? `/${basePath}` : ''}`);
      console.log(`  将写入 ${files.length} 个文件（单次 commit）：`);
      for (const file of files) console.log(`  - ${basePath ? `${basePath.replace(/\/+$/, '')}/${file.path}` : file.path}`);
      console.log('  （dry-run：未调用 GitHub API）');
      return;
    }
    const token = (flags['github-token'] && String(flags['github-token'])) || process.env.GITHUB_TOKEN || '';
    const result = await pushToGitHub({
      repo,
      path: basePath,
      branch,
      token,
      message: flags.message
        ? String(flags.message)
        : `chore(agentdock): sync ${spec.kind}/${spec.name}@${version}`,
      files,
    });
    console.log(`✓ 已推送到 GitHub：${repo}@${branch}（${result.files} 个文件，commit ${result.commit.slice(0, 10)}…）`);
    console.log(`  ${result.url}`);
    return;
  }

  throw new Error('用法：agentdock sync sources | import github|mcp <目标> | export [--out 文件] | push github <包> --repo <owner/repo>');
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

async function cmdAudit(positionals, flags) {
  const conn = resolveConnection(flags);
  requireToken(conn);
  const sub = positionals[0];

  // agentdock audit verify [--all] —— 校验哈希链（失败 exit 1）
  if (sub === 'verify') {
    // 409 也携带完整校验结果，故不复用 api()（其对非 2xx 直接抛错）
    const headers = { Authorization: `Bearer ${conn.token}` };
    let response;
    try {
      response = await fetch(`${conn.url}/api/v1/audit/verify${flags.all ? '?all=1' : ''}`, { headers });
    } catch (error) {
      throw new Error(`无法连接 AgentDock（${conn.url}）：${error.cause?.code || error.message}`);
    }
    const data = await response.json();
    if (flags.json) {
      console.log(JSON.stringify(data, null, 2));
      if (!data.ok) process.exitCode = 1;
      return;
    }
    if (data.ok) {
      const legacy = data.legacy ? `，另含 ${data.legacy} 条旧格式记录` : '';
      console.log(`✓ 审计日志校验通过（${data.entries} 条链式记录${legacy}，头部 ${data.headHash.slice(0, 16)}…）`);
    } else {
      console.error(`✗ 审计日志校验失败（断链位置：${data.brokenAt || '未知'}）`);
      for (const reason of data.reasons || []) console.error(`  - ${reason}`);
      process.exitCode = 1;
    }
    return;
  }

  // agentdock audit export --format csv|jsonl [--out <文件>] [过滤 flags]
  if (sub === 'export') {
    const format = String(flags.format || 'jsonl');
    if (format !== 'csv' && format !== 'jsonl') throw new Error(`--format 只能是 csv / jsonl：${format}`);
    const query = new URLSearchParams({ format, ...Object.fromEntries(auditQuery(flags)) });
    const headers = { Authorization: `Bearer ${conn.token}` };
    let response;
    try {
      response = await fetch(`${conn.url}/api/v1/audit/export?${query.toString()}`, { headers });
    } catch (error) {
      throw new Error(`无法连接 AgentDock（${conn.url}）：${error.cause?.code || error.message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch {
        /* 保留默认消息 */
      }
      throw new Error(message);
    }
    if (flags.out) {
      fs.writeFileSync(flags.out, text, 'utf8');
      console.log(`✓ 已导出 ${text.split('\n').filter(Boolean).length} 条记录到 ${flags.out}`);
      return;
    }
    process.stdout.write(text);
    return;
  }

  if (sub) throw new Error('audit 子命令：（无，直接查询）/ verify / export');

  // agentdock audit [--limit N] [--offset N] [--action ...] [--actor ...] [--target ...] [--from ISO] [--to ISO]
  const data = await api(conn, 'GET', `/api/v1/audit?${auditQuery(flags).toString()}`);
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  printTable(
    data.items.map((item) => [
      item.ts?.slice(0, 19).replace('T', ' '),
      item.actor,
      item.action,
      item.target,
      item.seq ? `#${item.seq}` : '-',
    ]),
    ['时间', '操作者', '动作', '对象', '序号'],
  );
  console.log(`\n共 ${data.total} 条审计记录（哈希链防篡改，agentdock audit verify 校验）`);
}

/** 审计查询/导出共用的过滤参数 */
function auditQuery(flags) {
  const query = new URLSearchParams();
  for (const key of ['action', 'actor', 'target', 'from', 'to', 'tenant', 'limit', 'offset']) {
    const value = flags[key];
    if (value !== undefined && value !== true && value !== '') query.set(key, String(value));
  }
  return query;
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

async function resolveAdminUser(conn, key) {
  const data = await api(conn, 'GET', '/api/v1/admin/users');
  const user = data.items.find((item) => item.id === key || item.name === key);
  if (!user) throw new Error(`用户不存在：${key}`);
  return user;
}

async function cmdNotify(positionals, flags) {
  const action = positionals[0] || 'show';
  const conn = resolveConnection(flags);
  requireToken(conn);
  if (action === 'show') {
    const data = await api(conn, 'GET', '/api/v1/notify');
    console.log(`通知：${data.notify.enabled ? '已启用' : '未启用'}（${data.notify.webhooks.length} 个 webhook）`);
    console.log(`配置文件：${data.file}`);
    for (const hook of data.notify.webhooks) {
      console.log(`  - ${hook.name} [${hook.format}] ${hook.url}`);
      console.log(`    事件：${hook.events.length ? hook.events.join(', ') : '全部'}${hook.secret ? ' · 已配置签名' : ''}`);
    }
    return;
  }
  if (action === 'set') {
    const file = positionals[1];
    if (!file) throw new Error('用法：agentdock notify set <配置.json>');
    const notify = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const data = await api(conn, 'PUT', '/api/v1/notify', { notify });
    console.log(`✓ 通知配置已更新：${data.notify.enabled ? '已启用' : '未启用'}，${data.notify.webhooks.length} 个 webhook`);
    return;
  }
  if (action === 'test') {
    const data = await api(conn, 'POST', '/api/v1/notify/test', {});
    console.log(`✓ 测试通知已发送（${data.sent} 个 webhook）`);
    for (const result of data.results || []) {
      console.log(`  - ${result.name}: ${result.ok ? `HTTP ${result.status}` : result.error}`);
    }
    return;
  }
  throw new Error('notify 子命令：show | set <配置.json> | test');
}

async function cmdUsers(positionals, flags) {
  const action = positionals[0];
  const key = positionals[1];
  if (!['disable', 'enable', 'revoke'].includes(action) || !key) {
    throw new Error('users 子命令：disable <id或名字> | enable <id或名字> | revoke <id或名字>');
  }
  const conn = resolveConnection(flags);
  requireToken(conn);
  const user = await resolveAdminUser(conn, key);
  if (action === 'revoke') {
    await api(conn, 'POST', `/api/v1/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`);
    console.log(`✓ 已强制下线 ${user.name} 的所有会话（sessionEpoch +1）`);
    return;
  }
  await api(conn, 'PATCH', `/api/v1/admin/users/${encodeURIComponent(user.id)}`, {
    disabled: action === 'disable',
  });
  console.log(`✓ 已${action === 'disable' ? '禁用' : '启用'}用户 ${user.name}${action === 'disable' ? '（会话已全部失效）' : ''}`);
}

async function cmdSessions(positionals, flags) {
  if (positionals[0] !== 'revoke-all') throw new Error('sessions 子命令：revoke-all');
  const conn = resolveConnection(flags);
  requireToken(conn);
  const data = await api(conn, 'POST', '/api/v1/admin/sessions/revoke-all', {});
  console.log(`✓ 已强制全员会话下线（globalEpoch=${data.globalEpoch}）`);
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
  const presetsMode = Boolean(flags.presets || flags['presets-dir'] || flags.profile);
  const customPresetsDir =
    typeof flags['presets-dir'] === 'string' ? path.resolve(flags['presets-dir']) : null;
  const targetProfile = typeof flags.profile === 'string' ? flags.profile.trim() : '';
  let ok = 0;
  let failed = 0;
  let presetsWritten = 0;
  let skipped = 0;
  const seenNames = new Set();
  if (presetsMode) {
    console.log(
      `（同时生成 DSH agent-preset 片段${customPresetsDir ? `到 ${customPresetsDir}` : ''}${targetProfile ? `，并入 profile「${targetProfile}」` : ''}）`,
    );
  }
  for (const fileName of entries) {
    const abs = path.join(dir, fileName);
    const content = fs.readFileSync(abs, 'utf8');
    const frontmatter = parseFrontmatter(content).data || {};
    const name = String(frontmatter.name || fileName.replace(/\.md$/, '')).trim();
    if (seenNames.has(name)) {
      skipped += 1;
      console.log(`- ${name}  跳过：${fileName} 与之前的文件使用了相同 name`);
      continue;
    }
    seenNames.add(name);
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
    let presetNote = '';
    if (presetsMode) {
      try {
        const preset = renderPresetPatch(payload);
        let presetFile;
        if (customPresetsDir) {
          presetFile = path.join(customPresetsDir, `${name}.patch.yml`);
          fs.mkdirSync(path.dirname(presetFile), { recursive: true });
          fs.writeFileSync(presetFile, preset.yaml);
        } else {
          presetFile = writePresetFragment({ home: resolveHome(), name, yaml: preset.yaml });
        }
        presetNote = `  preset → ${presetFile}`;
        presetsWritten += 1;
        if (targetProfile) {
          const merged = upsertProfilePatch({
            profile: targetProfile,
            home: resolveHome(),
            presetId: preset.presetId,
            body: preset.body,
          });
          presetNote += `（已并入 profile ${targetProfile}${merged.replaced ? '，替换旧块' : ''}）`;
        }
        if (preset.warnings.length > 0) {
          for (const warning of preset.warnings) console.log(`  ! ${warning}`);
        }
      } catch (error) {
        console.log(`✗ ${name}  生成 DSH preset 失败：${error.message}`);
        failed += 1;
        continue;
      }
    }
    if (!publish) {
      ok += 1;
      console.log(`${status} ${name}  ${frontmatter.description || ''}${presetNote}`);
      continue;
    }
    try {
      await api(conn, 'POST', '/api/v1/packages', payload);
      ok += 1;
      console.log(`✓ 已提交 ${name}${presetNote}`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${name}  ${error.message}`);
    }
  }
  console.log('');
  if (publish) console.log(`导入完成：成功 ${ok}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}（提交后需审核）`);
  else console.log(`扫描完成：可发布 ${ok}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}。加 --publish 提交到服务端`);
  if (presetsMode) console.log(`DSH preset 片段：已生成 ${presetsWritten} 个${targetProfile ? `，并已并入 profile「${targetProfile}」` : ''}。重启 DSH 后生效`);
}

/** 备份 data/ 目录（带 sha256 校验和的 gzip JSON） */
async function cmdBackup(flags) {
  const config = loadConfig();
  const dataDir = flags.data ? path.resolve(String(flags.data)) : config.dataDir;
  const out = flags.out
    ? path.resolve(String(flags.out))
    : path.join(ROOT, `agentdock-backup-${new Date().toISOString().replace(/[:.]/g, '-')}${BACKUP_EXTENSION}`);
  const { file, manifest } = writeBackup({
    dataDir,
    out,
    includeBootstrap: flags['no-bootstrap'] !== true,
  });
  console.log(`✓ 已备份 ${manifest.fileCount} 个文件（${formatBytes(manifest.totalBytes)}）`);
  console.log(`  数据目录：${dataDir}`);
  console.log(`  归档文件：${file}`);
  console.log(`  校验摘要：${manifest.digest.slice(0, 16)}…`);
  console.log('  恢复：agentdock restore <归档文件> --data <数据目录>（恢复前请停服）');
}

/** 从备份归档恢复 data/ 目录 */
async function cmdRestore(positionals, flags) {
  const input = positionals[0];
  if (!input) throw new Error('用法：agentdock restore <备份文件> [--data <目录>] [--force] [--dry-run]');
  const config = loadConfig();
  const dataDir = flags.data ? path.resolve(String(flags.data)) : config.dataDir;
  const file = path.resolve(input);
  const preview = readBackup(file);
  if (flags['dry-run']) {
    const result = restoreBackup({ file, dataDir, force: Boolean(flags.force), dryRun: true });
    console.log(`✓ 备份校验通过：${result.fileCount} 个文件（${formatBytes(result.totalBytes)}），dry-run 未写入`);
    console.log(`  目标数据目录：${result.target}`);
    return;
  }
  const result = restoreBackup({ file, dataDir, force: Boolean(flags.force), dryRun: false });
  console.log(`✓ 已恢复 ${result.fileCount} 个文件（${formatBytes(result.totalBytes)}）→ ${result.target}`);
  console.log('  备份时间：' + (result.createdAt || '未知'));
  console.log('  请确认已停止旧服务，恢复后重新启动：agentdock serve');
  if (preview.manifest.digest) console.log(`  校验摘要：${preview.manifest.digest.slice(0, 16)}…`);
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
    case 'import':
      return cmdPublish(positionals, flags);
    case 'verify':
      return cmdVerify(positionals, flags);
    case 'list':
      return cmdList(flags);
    case 'uninstall':
      await cmdUninstall(positionals, flags);
      break;
    case 'rollback':
      await cmdRollback(positionals, flags);
      break;
    case 'install':
      return cmdInstall(positionals, flags);
    case 'outdated':
      return cmdOutdated(flags);
    case 'upgrade':
      return cmdUpgrade(positionals, flags);
    case 'review':
      return cmdReview(positionals, flags);
    case 'audit':
      return cmdAudit(positionals, flags);
    case 'quality':
      return cmdQuality(positionals, flags);
    case 'keys':
      return cmdKeys(flags);
    case 'verify-signature':
      return cmdVerifySignature(positionals, flags);
    case 'keygen':
      return cmdKeygen(flags);
    case 'register-key':
      return cmdRegisterKey(flags);
    case 'transparency':
      return cmdTransparency(positionals, flags);
    case 'sbom':
      return cmdSbom(positionals, flags);
    case 'policy':
      return cmdPolicy(positionals, flags);
    case 'sync':
      return cmdSync(positionals, flags);
    case 'users':
      await cmdUsers(positionals, flags);
      break;
    case 'sessions':
      await cmdSessions(positionals, flags);
      break;
    case 'notify':
      await cmdNotify(positionals, flags);
      break;
    case 'tokens':
      return cmdTokens(positionals, flags);
    case 'backup':
      return cmdBackup(flags);
    case 'restore':
      return cmdRestore(positionals, flags);
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
