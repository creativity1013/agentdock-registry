import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, nowIso, readJson, writeFileAtomic } from './util.mjs';
import { badRequest, conflict, notFound } from './errors.mjs';
import { dshHome, renderPresetPatch } from './dsh-preset.mjs';

export const TARGET_IDS = ['dsh', 'dsh-agent', 'claude', 'codex', 'shared', 'dir'];
export const TARGET_LABEL = {
  dsh: 'DeepSeek Harness (~/.dsh)',
  'dsh-agent': 'DSH Agent Preset (~/.dsh/agentdock/presets)',
  claude: 'Claude Code (~/.claude)',
  codex: 'Codex CLI (~/.codex)',
  shared: '共享目录 (~/.agents)',
  dir: '自定义目录',
};
export const TARGET_NOTE = {
  dsh: '技能装到 ~/.dsh/skills/<name>/；agent 装到 ~/.dsh/agents/<name>/；插件装到 ~/.dsh/plugins/<name>/',
  'dsh-agent':
    '只接受 agent 包：生成 DSH agent-preset 片段到 ~/.dsh/agentdock/presets/<name>.patch.yml；加 --profile <name> 可自动并入该 profile 的 cordis.patch.yml',
  claude: '技能装到 ~/.claude/skills/<name>/；agent 写成 ~/.claude/agents/<name>.md',
  codex: '技能装到 ~/.codex/skills/<name>/',
  shared: '统一装到 ~/.agents/{skills,agents,plugins}/<name>/，供多个 harness 共享',
  dir: '需要额外提供目录（--dir / AGENTDOCK_TARGET_DIR）',
};

const KIND_SUBDIR = { skill: 'skills', agent: 'agents', plugin: 'plugins' };

export function resolveTargetBase(target, { home = os.homedir(), dir } = {}) {
  const baseHome = home || os.homedir();
  switch (target) {
    case 'dsh':
      return path.join(baseHome, '.dsh');
    case 'dsh-agent':
      return dshHome(baseHome);
    case 'claude':
      return path.join(baseHome, '.claude');
    case 'codex':
      return path.join(baseHome, '.codex');
    case 'shared':
      return path.join(baseHome, '.agents');
    case 'dir': {
      if (!dir || typeof dir !== 'string' || dir.trim() === '') {
        throw badRequest('安装目标为 dir 时必须提供目录（--dir 或 request body.dir）');
      }
      return path.resolve(dir.trim());
    }
    default:
      throw badRequest(`未知安装目标：${String(target)}，可选：${TARGET_IDS.join(' / ')}`);
  }
}

export function installDestination(kind, name, { target, home, dir } = {}) {
  const base = resolveTargetBase(target, { home, dir });
  if (target === 'dsh-agent') {
    if (kind !== 'agent') {
      throw badRequest('安装目标 dsh-agent 只适用于 agent 包（会生成 DSH agent-preset 片段）');
    }
    const baseDir = path.join(base, 'agentdock', 'presets');
    return {
      layout: 'dsh-preset',
      baseDir,
      absolutePath: path.join(baseDir, `${name}.patch.yml`),
      mainFile: 'agent.md',
    };
  }
  if (kind === 'agent' && target === 'claude') {
    return {
      layout: 'file',
      baseDir: path.join(base, 'agents'),
      absolutePath: path.join(base, 'agents', `${name}.md`),
      mainFile: 'agent.md',
    };
  }
  const subdir = KIND_SUBDIR[kind];
  if (!subdir) throw badRequest(`不支持安装的能力类型：${kind}`);
  return {
    layout: 'dir',
    baseDir: path.join(base, subdir),
    absolutePath: path.join(base, subdir, name),
    mainFile: null,
  };
}

function writeContent(file) {
  if (file.encoding === 'base64') return Buffer.from(String(file.content || ''), 'base64');
  return Buffer.from(String(file.content ?? ''), 'utf8');
}

function manifestFile(bundle, manifestPath, targetPath = path.basename(manifestPath)) {
  return {
    path: manifestPath,
    targetPath,
    encoding: 'utf8',
    content: `${JSON.stringify(
      {
        package: { kind: bundle.kind, name: bundle.name, version: bundle.version },
        installedAt: nowIso(),
        source: 'agentdock',
      },
      null,
      2,
    )}\n`,
  };
}

/**
 * 规划一次安装（不写盘）。
 * @param {{kind:string,name:string,version:string,files:Array<{path:string,content:string,encoding:string}>}} bundle
 */
export function planInstall(bundle, { target, home = os.homedir(), dir, force = false } = {}) {
  if (!bundle || !bundle.kind || !bundle.name || !Array.isArray(bundle.files)) {
    throw badRequest('安装包数据不完整');
  }
  const dest = installDestination(bundle.kind, bundle.name, { target, home, dir });
  const files = [];
  const notes = [];

  if (dest.layout === 'dsh-preset') {
    const preset = renderPresetPatch(bundle);
    if (!force && fs.existsSync(dest.absolutePath)) {
      throw conflict(`安装目标已存在：${dest.absolutePath}（确认覆盖请加 --force）`);
    }
    files.push({
      path: dest.absolutePath,
      targetPath: `${bundle.name}.patch.yml`,
      content: preset.yaml,
      encoding: 'utf8',
    });
    const manifestPath = path.join(dest.baseDir, `${bundle.name}.agentdock.json`);
    files.push(manifestFile(bundle, manifestPath));
    notes.push(
      '已生成 DSH agent-preset 片段；片段本身不会自动生效。',
      '并入 profile：追加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml 顶层数组，或重跑并加 --profile <name> 自动追加（按标记替换，可重复执行）。',
      '临时挂载：dsh <profile> --patch <片段文件>；重启 DSH 后在 Settings → Agent presets 选择该 preset。',
      'preset 不携带模型；模型由会话/默认模型决定。',
    );
    return { target, dest, files, notes, manifestPath, force, preset };
  }

  if (dest.layout === 'file') {
    const main =
      bundle.files.find((file) => file.path === dest.mainFile) ||
      bundle.files.find((file) => file.path.endsWith('/agent.md'));
    if (!main) throw badRequest('Claude Code 需要 agent.md 作为单文件 agent 定义');
    files.push({ path: dest.absolutePath, targetPath: `${bundle.name}.md`, content: main.content, encoding: main.encoding });
    const rest = bundle.files.filter((file) => file !== main);
    if (rest.length > 0) {
      const sideDir = path.join(dest.baseDir, `${bundle.name}.agentdock`);
      for (const file of rest) {
        files.push({ path: path.join(sideDir, file.path), targetPath: path.relative(dest.baseDir, path.join(sideDir, file.path)), content: file.content, encoding: file.encoding });
      }
      notes.push(`Claude Code 的 agent 是单文件格式；其余 ${rest.length} 个文件写入 ${sideDir}`);
    }
  } else {
    for (const file of bundle.files) {
      files.push({ path: path.join(dest.absolutePath, file.path), targetPath: file.path, content: file.content, encoding: file.encoding });
    }
  }

  if (!force) {
    if (dest.layout === 'dir' && fs.existsSync(dest.absolutePath)) {
      throw conflict(`安装目标已存在：${dest.absolutePath}（确认覆盖请加 --force）`);
    }
    if (dest.layout === 'file' && fs.existsSync(dest.absolutePath)) {
      throw conflict(`安装目标已存在：${dest.absolutePath}（确认覆盖请加 --force）`);
    }
  }

  const manifestPath =
    dest.layout === 'file'
      ? path.join(dest.baseDir, `${bundle.name}.agentdock.json`)
      : path.join(dest.absolutePath, '.agentdock-install.json');
  files.push(manifestFile(bundle, manifestPath, path.relative(dest.baseDir, manifestPath)));

  return { target, dest, files, notes, manifestPath, force };
}

export function applyInstall(plan) {
  for (const file of plan.files) {
    ensureDir(path.dirname(file.path));
    writeFileAtomic(file.path, writeContent(file));
  }
  return {
    target: plan.target,
    baseDir: plan.dest.baseDir,
    absolutePath: plan.dest.absolutePath,
    layout: plan.dest.layout,
    installedFiles: plan.files.length,
    manifestPath: plan.manifestPath,
    notes: plan.notes,
  };
}

/**
 * 扫描本地已安装的能力包（读取安装清单）。
 * @param {{home?:string, dir?:string, targets?:string[]}} options
 */
export function listInstalls({ home = os.homedir(), dir, targets = TARGET_IDS } = {}) {
  const results = [];
  const pushManifest = (target, base, manifestPath, expectedKind = null) => {
    let manifest;
    try {
      manifest = readJson(manifestPath, null);
    } catch {
      return;
    }
    const pkg = manifest?.package;
    if (!pkg?.kind || !pkg?.name || !pkg?.version) return;
    if (expectedKind && pkg.kind !== expectedKind) return;
    results.push({
      target,
      baseDir: base,
      manifestPath,
      kind: pkg.kind,
      name: pkg.name,
      version: pkg.version,
      installedAt: manifest.installedAt ?? null,
    });
  };

  for (const target of targets) {
    if (!TARGET_IDS.includes(target)) continue;
    if (target === 'dir' && !dir) continue;
    const base = resolveTargetBase(target, { home, dir });

    if (target === 'dsh-agent') {
      const presetDir = path.join(base, 'agentdock', 'presets');
      for (const entry of readDirSafe(presetDir)) {
        if (entry.isFile() && entry.name.endsWith('.agentdock.json')) {
          pushManifest(target, base, path.join(presetDir, entry.name), 'agent');
        }
      }
      continue;
    }

    for (const kind of ['skill', 'agent', 'plugin']) {
      const kindDir = path.join(base, KIND_SUBDIR[kind]);
      for (const entry of readDirSafe(kindDir)) {
        if (entry.isDirectory()) {
          pushManifest(target, base, path.join(kindDir, entry.name, '.agentdock-install.json'), kind);
        } else if (entry.isFile() && entry.name.endsWith('.agentdock.json')) {
          pushManifest(target, base, path.join(kindDir, entry.name), kind);
        }
      }
    }
  }

  return results.sort((a, b) =>
    `${a.target}/${a.kind}/${a.name}`.localeCompare(`${b.target}/${b.kind}/${b.name}`),
  );
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 供 API / CLI 展示的安装计划（隐藏主机绝对路径前缀） */
export function summarizePlan(plan, { home = os.homedir() } = {}) {
  const strip = (absolute) => {
    const base = home || os.homedir();
    return absolute.startsWith(base) ? `~${absolute.slice(base.length)}` : absolute;
  };
  const summary = {
    target: plan.target,
    layout: plan.dest.layout,
    baseDir: strip(plan.dest.baseDir),
    absolutePath: strip(plan.dest.absolutePath),
    manifestPath: strip(plan.manifestPath),
    files: plan.files.map((file) => ({ path: strip(file.path), targetPath: file.targetPath })),
    notes: plan.notes,
  };
  if (plan.preset) {
    summary.preset = {
      id: plan.preset.presetId,
      title: plan.preset.title,
      pluginIds: plan.preset.plugins.map((plugin) => plugin.id),
      warnings: plan.preset.warnings,
    };
  }
  return summary;
}

export function listTargets({ home = os.homedir() } = {}) {
  return TARGET_IDS.map((id) => ({
    id,
    label: TARGET_LABEL[id],
    note: TARGET_NOTE[id],
    baseDir:
      id === 'dir'
        ? null
        : id === 'dsh-agent'
          ? path.join(resolveTargetBase(id, { home }), 'agentdock', 'presets')
          : resolveTargetBase(id, { home }),
  }));
}

// 供 CLI / 测试做路径规划
export { writeContent };
