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
  const config = loadConfig(process.env, { port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), home });
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
  const installOut = await runCli(
    ['install', 'skill/code-reviewer', '--target', 'dir', '--dir', installDir, '--force', '--scan', '--verify'],
    tokens.publisher,
  );
  assert(installOut.includes('安装前扫描') && installOut.includes('高危 0'), '安装前扫描输出异常');
  assert(installOut.includes('签名校验：✓'), '安装前签名校验未通过');
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

  // 内容签名：审核通过后自动 ed25519 签名，CLI 可验签、可导出公钥
  const verified = await runCli(['verify-signature', 'skill/code-reviewer'], tokens.publisher);
  assert(verified.includes('签名有效'), `CLI 验签未通过：\n${verified}`);
  const keys = await runCli(['keys'], tokens.publisher);
  assert(keys.includes('ed25519') && keys.includes('BEGIN PUBLIC KEY'), 'CLI keys 缺少公钥');
  console.log('✓ 内容签名：审核后自动签名，CLI 验签与公钥查询正常');

  // 发布者签名 + 可验证透明日志
  const keyDir = path.join(home, '.agentdock', 'keys');
  const keygen = await runCli(['keygen', '--out', keyDir, '--name', 'smoke-publisher'], tokens.publisher);
  assert(keygen.includes('已生成发布者密钥对'), `keygen 输出异常：${keygen}`);
  const privateKeyFile = path.join(keyDir, 'smoke-publisher-private.pem');
  const publicKeyFile = path.join(keyDir, 'smoke-publisher-public.pem');
  assert(fs.existsSync(privateKeyFile) && fs.existsSync(publicKeyFile), 'keygen 未生成密钥文件');
  assert((fs.statSync(privateKeyFile).mode & 0o777) === 0o600, '私钥文件权限不是 600');

  await runCli(['register-key', '--key', publicKeyFile, '--name', 'smoke-publisher'], tokens.publisher);
  const mineKeys = await runCli(['keys', '--mine'], tokens.publisher);
  assert(mineKeys.includes('smoke-publisher'), 'CLI keys --mine 未显示已注册密钥');

  await runCli(
    [
      'publish',
      path.join(EXAMPLES, 'skill-code-reviewer'),
      '--version',
      '0.2.0',
      '--key',
      privateKeyFile,
      '--key-name',
      'smoke-publisher',
    ],
    tokens.publisher,
  );
  await runCli(['review', 'approve', 'skill/code-reviewer@0.2.0', '--note', 'signed smoke'], tokens.reviewer);

  const qualityOut = await runCli(['quality', 'skill/code-reviewer@0.2.0'], tokens.reviewer);
  assert(qualityOut.includes('官方'), `质量分级应为官方：\n${qualityOut}`);
  assert(qualityOut.includes('发布者签名：✓'), `质量分级缺少发布者签名：\n${qualityOut}`);
  const qualityList = await runCli(['list'], tokens.reviewer);
  assert(qualityList.includes('官方'), `list 应显示质量列：\n${qualityList}`);
  console.log('✓ 质量分级：发布者签名 + 人工审核 → 官方');
  const transparencyEntries = await runCli(['transparency', 'entries', '--limit', '10'], tokens.reviewer);
  assert(transparencyEntries.includes('skill/code-reviewer@0.2.0'), '透明日志缺少带发布者签名的版本');
  const transparencyVerify = await runCli(['transparency', 'verify'], tokens.reviewer);
  assert(transparencyVerify.includes('校验通过'), `透明日志链校验失败：${transparencyVerify}`);
  const transparencyProof = await runCli(
    ['transparency', 'proof', 'skill/code-reviewer@0.2.0'],
    tokens.reviewer,
  );
  assert(transparencyProof.includes('本地校验：✓ 通过'), `透明日志包含证明校验失败：${transparencyProof}`);
  console.log('✓ 发布者签名 + 透明日志：keygen / 注册 / 签名发布 / 链校验 / 包含证明均正常');

  // 升级检查：本地 0.1.0 安装，服务端已 0.2.0
  const outdatedOut = await runCli(['outdated', '--target', 'dir', '--dir', installDir], tokens.publisher);
  assert(outdatedOut.includes('有更新'), `outdated 未发现更新：\n${outdatedOut}`);
  assert(outdatedOut.includes('0.1.0') && outdatedOut.includes('0.2.0'), 'outdated 版本信息不完整');
  const upgradeOut = await runCli(
    ['upgrade', 'skill/code-reviewer', '--target', 'dir', '--dir', installDir],
    tokens.publisher,
  );
  assert(upgradeOut.includes('已升级') && upgradeOut.includes('0.2.0'), `upgrade 输出异常：\n${upgradeOut}`);
  const upgradedManifest = JSON.parse(
    fs.readFileSync(path.join(installDir, 'skills', 'code-reviewer', '.agentdock-install.json'), 'utf8'),
  );
  assert(upgradedManifest.package.version === '0.2.0', '升级后安装清单版本未更新');
  console.log('✓ 版本检查与升级：outdated 发现新版本，upgrade 更新本地安装');

  // 回滚 + 卸载：读取安装清单里的版本历史，回滚到 0.1.0 后再卸载
  const rollbackOut = await runCli(
    ['rollback', 'skill/code-reviewer', '--target', 'dir', '--dir', installDir],
    tokens.publisher,
  );
  assert(rollbackOut.includes('已回滚') && rollbackOut.includes('0.1.0'), `rollback 输出异常：\n${rollbackOut}`);
  const rolledManifest = JSON.parse(
    fs.readFileSync(path.join(installDir, 'skills', 'code-reviewer', '.agentdock-install.json'), 'utf8'),
  );
  assert(rolledManifest.package.version === '0.1.0', '回滚后安装清单版本未更新');
  assert(rolledManifest.history.some((item) => item.version === '0.2.0'), '回滚后应保留版本历史');
  const uninstallOut = await runCli(
    ['uninstall', 'skill/code-reviewer', '--target', 'dir', '--dir', installDir],
    tokens.publisher,
  );
  assert(uninstallOut.includes('已卸载'), `uninstall 输出异常：\n${uninstallOut}`);
  assert(!fs.existsSync(path.join(installDir, 'skills', 'code-reviewer', 'SKILL.md')), '卸载后文件仍存在');
  console.log('✓ 回滚与卸载：按清单历史回滚版本，卸载清理文件');

  // 外部 registry：适配器信息 + 中立市场目录导出
  const syncSources = await runCli(['sync', 'sources'], tokens.publisher);
  assert(syncSources.includes('GitHub 仓库') && syncSources.includes('MCP registry'), 'sync sources 输出异常');
  const exportFile = path.join(home, 'marketplace.json');
  const syncExport = await runCli(['sync', 'export', '--out', exportFile], tokens.publisher);
  assert(syncExport.includes('已导出市场目录'), `sync export 输出异常：${syncExport}`);
  const catalog = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  assert(catalog.schema === 'agentdock-marketplace@1' && catalog.count >= 3, '导出的市场目录内容异常');
  assert(catalog.items.every((item) => item.bundleUrl && item.contentHash.length === 64), '市场目录缺少 bundleUrl/contentHash');
  const pushDry = await runCli(
    ['sync', 'push', 'github', 'skill/code-reviewer@0.2.0', '--repo', 'acme/skills', '--path', 'skills/code-reviewer', '--dry-run'],
    tokens.publisher,
  );
  assert(pushDry.includes('推送预检') && pushDry.includes('SKILL.md'), `sync push dry-run 输出异常：\n${pushDry}`);
  assert(pushDry.includes('未调用 GitHub API'), 'dry-run 不应调用 GitHub');
  console.log('✓ 外部 registry：适配器信息、市场目录导出与推送预检正常');

  // SBOM + 自动审批策略
  const sbomOut = await runCli(['sbom', 'skill/code-reviewer@0.2.0'], tokens.publisher);
  assert(sbomOut.includes('SBOM agentdock-sbom@1') && sbomOut.includes('digest'), `CLI sbom 输出异常：\n${sbomOut}`);
  const policyBefore = await runCli(['policy', 'show'], tokens.reviewer);
  assert(policyBefore.includes('启用：否'), `默认策略应关闭：\n${policyBefore}`);
  const policyFile = path.join(root, 'policy.json');
  fs.writeFileSync(
    policyFile,
    JSON.stringify({ autoApprove: { enabled: true, kinds: ['skill'], trustedPublishers: ['publisher'], maxMedium: 0 } }),
  );
  await runCli(['policy', 'set', '--file', policyFile], tokens.admin);
  const policyAfter = await runCli(['policy', 'show'], tokens.reviewer);
  assert(policyAfter.includes('启用：是') && policyAfter.includes('publisher'), `策略更新失败：\n${policyAfter}`);
  const autoPublish = await runCli(
    ['publish', path.join(EXAMPLES, 'skill-code-reviewer'), '--version', '0.3.0'],
    tokens.publisher,
  );
  assert(autoPublish.includes('自动审批'), `批准策略未生效：\n${autoPublish}`);
  const autoVerified = await runCli(['verify-signature', 'skill/code-reviewer@0.3.0'], tokens.publisher);
  assert(autoVerified.includes('签名有效'), `自动审批版本验签失败：\n${autoVerified}`);
  const autoEntries = await runCli(['transparency', 'entries', '--limit', '10'], tokens.reviewer);
  assert(autoEntries.includes('skill/code-reviewer@0.3.0'), '透明日志缺少自动审批版本');
  const autoSbom = await runCli(['sbom', 'skill/code-reviewer@0.3.0'], tokens.publisher);
  assert(autoSbom.includes('SBOM agentdock-sbom@1'), `自动审批版本 SBOM 异常：\n${autoSbom}`);
  console.log('✓ SBOM + 自动审批策略：策略下发 / 自动上架 / 验签 / 透明日志 / SBOM 均正常');

  // 冒烟结果
  const stats = await fetch(`${server.url}/api/v1/stats`).then((response) => response.json());
  console.log('');
  console.log('SMOKE OK');
  console.log(`  市场：${server.url}`);
  console.log(`  元数据后端：${server.store.backend}`);
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
