/**
 * 把 AgentDock 的 agent 包转换成 DeepSeek Harness 的 agent-preset 片段。
 *
 * DSH 的 profile 是「插件 bundle 补丁层」的有序堆叠，用户层是
 * $DSH_HOME/profiles/<profile>/cordis.patch.yml：一个顶层 YAML 数组，元素是
 * loader patch 条目。要新增一个 preset，需要向数组里插入：
 *
 *   - insert:
 *       - id: preset-<id>
 *         name: '@deepseek-ai/dsh-agent-preset'
 *         config:
 *           id: <id>
 *           name: <显示名>
 *           description: <描述>
 *           order: <排序>
 *           plugins: [...]       # 这个 agent 的插件行（persona / tools / skills …）
 *
 * 参考实现（2026-10 桌面版 0.83 默认配置）：preset-standard 的 plugins 里包含
 * persona（config.prefix 为系统提示）、agent-instructions、time-context、
 * tool-bash、tool-fs、tool-fs-search（config.sampleOverCapGlobResults=false）、
 * skill-filesystem、tool-skill、tool-todo、tool-web 等行。
 *
 * patch 方言的两条关键规则（来自 --dump-config-schema 的 patch 描述）：
 * 1. insert 会把条目追加到（可选的）目标 group 后面；
 * 2. 其它 patch 只替换给出的字段，config 是整块替换而非深合并；
 *    带 name 的 patch 是断言现有插件名，不是改名；找不到目标的 patch 会被跳过并告警。
 * 因此本模块统一生成 `- insert:` 形式的片段。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './yaml.mjs';
import { badRequest } from './errors.mjs';
import { ensureDir, truncate, writeFileAtomic } from './util.mjs';

export const DSH_AGENT_TARGET = 'dsh-agent';
export const PRESET_ORDER = 50;
export const PRESET_ID_PREFIX = 'agentdock-';

/**
 * Claude Code / DSH 工具名 → DSH 插件行。
 * 同一组只生成一行，避免重复；未识别的工具名会变成 warning。
 */
export const TOOL_GROUPS = [
  {
    key: 'fs',
    tools: ['read', 'write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'read_file', 'write_file', 'edit_file', 'list_directory'],
    plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }],
  },
  {
    key: 'search',
    tools: ['grep', 'glob', 'ls', 'find', 'search_files', 'file_search'],
    plugins: [
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
    ],
  },
  {
    key: 'bash',
    tools: ['bash', 'shell', 'terminal', 'run_command', 'execute_command'],
    plugins: [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }],
  },
  {
    key: 'web',
    tools: ['webfetch', 'websearch', 'web_search', 'fetch', 'web', 'search_web'],
    plugins: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }],
  },
  {
    key: 'todo',
    tools: ['todowrite', 'todo_write', 'todo', 'todolist'],
    plugins: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }],
  },
  {
    key: 'goal',
    tools: ['goal', 'get_goal', 'create_goal', 'update_goal'],
    plugins: [{ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' }],
  },
  {
    key: 'schedule',
    tools: ['schedule', 'scheduled_task', 'reminder'],
    plugins: [{ id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' }],
  },
  {
    key: 'ask',
    tools: ['askuserquestion', 'ask_user', 'ask_user_question', 'question'],
    plugins: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }],
  },
  {
    key: 'skill',
    tools: ['skill', 'skills'],
    plugins: [
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    ],
  },
  {
    key: 'subagent',
    tools: ['task', 'agent', 'subagent', 'delegate'],
    unsupported:
      '子代理（Task/Agent）工具需要额外挂载 subagent provider（如 dsh-subagent-spawn-in-process + dsh-tool-subagent），本片段不自动生成',
  },
];

const BASE_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
];

const LEGACY_TOOL_ALIASES = new Map([
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['multiedit', 'MultiEdit'],
  ['notebookedit', 'NotebookEdit'],
  ['grep', 'Grep'],
  ['glob', 'Glob'],
  ['ls', 'LS'],
  ['bash', 'Bash'],
  ['webfetch', 'WebFetch'],
  ['websearch', 'WebSearch'],
  ['todowrite', 'TodoWrite'],
  ['task', 'Task'],
  ['skill', 'Skill'],
]);

export const KNOWN_DSH_TOOLS = new Set(TOOL_GROUPS.flatMap((group) => group.tools));

/** $DSH_HOME 优先，其次 ~/.dsh；与 dsh CLI 的行为保持一致。 */
export function dshHome(home) {
  const env = process.env.DSH_HOME;
  const base = path.resolve(home || os.homedir());
  // 显式传入的 home（测试/自定义目录）优先；只有解析真实用户 home 时才让 DSH_HOME 覆盖。
  const isUserHome = base === path.resolve(os.homedir());
  if (isUserHome && env && env.trim()) return path.resolve(env.trim());
  return path.join(base, '.dsh');
}

export function presetIdFor(name) {
  const id = `${PRESET_ID_PREFIX}${String(name || '').toLowerCase()}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) {
    throw badRequest(`无法为 ${String(name)} 生成合法的 DSH preset id`);
  }
  return id;
}

export function presetFragmentPath(home, name) {
  return path.join(dshHome(home), 'agentdock', 'presets', `${name}.patch.yml`);
}

export function profilePatchPath(profile, home) {
  return path.join(dshHome(home), 'profiles', profile, 'cordis.patch.yml');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTools(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const out = [];
  for (const item of list) {
    const value = String(item ?? '').trim();
    if (!value) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function normalizeSkills(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function readAgentFile(bundle) {
  const files = Array.isArray(bundle && bundle.files) ? bundle.files : [];
  const file = files.find((item) => item.path === 'agent.md') || files.find((item) => item.path.endsWith('/agent.md'));
  if (!file) throw badRequest('agent 包缺少根目录 agent.md，无法生成 DSH preset');
  const content =
    file.encoding === 'base64'
      ? Buffer.from(String(file.content || ''), 'base64').toString('utf8')
      : String(file.content ?? '');
  const parsed = parseFrontmatter(content);
  return { data: parsed.data || {}, body: String(parsed.body || '') };
}

/** 生成 preset 插件行；返回 {plugins, warnings}。 */
export function presetPlugins(tools, skills = []) {
  const normalized = tools.map((tool) => tool.toLowerCase());
  const known = new Set(normalized);
  const plugins = BASE_PLUGINS.map((plugin) => ({ ...plugin, config: plugin.config ? { ...plugin.config } : undefined }));
  const warnings = [];
  const covered = new Set();
  let matchedSkill = false;

  for (const group of TOOL_GROUPS) {
    const matched = group.tools.some((tool) => known.has(tool));
    if (!matched) continue;
    for (const tool of group.tools) covered.add(tool);
    if (group.unsupported) {
      warnings.push(`${group.key}: ${group.unsupported}`);
      continue;
    }
    if (group.key === 'skill') matchedSkill = true;
    for (const plugin of group.plugins) {
      if (plugins.some((row) => row.id === plugin.id)) continue;
      plugins.push({ ...plugin, config: plugin.config ? { ...plugin.config } : undefined });
    }
  }

  if (skills.length > 0 && !matchedSkill) {
    for (const plugin of TOOL_GROUPS.find((group) => group.key === 'skill').plugins) {
      if (plugins.some((row) => row.id === plugin.id)) continue;
      plugins.push({ ...plugin });
    }
    warnings.push(`agent 声明了 skills（${skills.join(', ')}），已加入 skill 加载插件；这些技能需要先安装到 ~/.dsh/skills 或 ~/.agents/skills 才会被加载`);
  }

  for (const tool of tools) {
    if (covered.has(tool.toLowerCase())) continue;
    warnings.push(`工具 ${tool} 没有对应的 DSH 插件映射，已跳过（可手动在 preset 中补充）`);
  }
  return { plugins, warnings };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function pushScalar(lines, indent, key, value) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    lines.push(`${' '.repeat(indent)}${key}: ${value}`);
    return;
  }
  lines.push(`${' '.repeat(indent)}${key}: ${yamlString(value)}`);
}

function renderPlugins(plugins) {
  const lines = [];
  for (const plugin of plugins) {
    lines.push(`          - id: ${plugin.id}`);
    lines.push(`            name: '${plugin.name}'`);
    if (plugin.config && Object.keys(plugin.config).length > 0) {
      lines.push('            config:');
      for (const [key, value] of Object.entries(plugin.config)) {
        if (key === 'prefix') {
          const prefix = String(value ?? '');
          if (prefix === '') {
            lines.push('              prefix: ""');
            continue;
          }
          lines.push('              prefix: |');
          for (const rawLine of prefix.split('\n')) {
            lines.push(`                ${rawLine.replace(/\s+$/, '')}`);
          }
        } else {
          pushScalar(lines, 14, key, value);
        }
      }
    }
  }
  return lines;
}

/**
 * 把 agent 包渲染成 DSH profile 补丁片段。
 * @param {{kind:string,name:string,version?:string,description?:string,files:Array<{path:string,content:string,encoding?:string}>}} bundle
 */
export function renderPresetPatch(bundle) {
  if (!bundle || bundle.kind !== 'agent') {
    throw badRequest('dsh-agent 安装目标只接受 agent 包（skill / plugin 不能直接生成 DSH preset）');
  }
  const { data, body } = readAgentFile(bundle);
  const tools = normalizeTools(data.tools);
  const skills = normalizeSkills(data.skills);
  const prompt = String(body || '').trim();
  const { plugins, warnings } = presetPlugins(tools, skills);
  const presetId = presetIdFor(bundle.name);
  const presetName = truncate(String(data.name || bundle.name).replace(/\s+/g, ' ').trim(), 120);
  const title = `AgentDock · ${presetName}`;
  const description =
    truncate(
      String(data.description || bundle.description || '').replace(/\s+/g, ' ').trim(),
      500,
    ) || `AgentDock agent preset for ${bundle.name}`;
  if (!prompt) warnings.push('agent.md 正文为空，preset 的 persona 将使用 description 作为系统提示词');
  const persona = plugins.find((plugin) => plugin.id === 'persona');
  if (persona) persona.config = { prefix: prompt || description };

  const header = [
    '# AgentDock 生成的 DSH agent-preset 片段（由 `agentdock install --target dsh-agent` 生成）',
    `# 来源：agent/${bundle.name}${bundle.version ? `@${bundle.version}` : ''}`,
    '# 接入方式（任选其一）：',
    '#   1. 把下面的条目并入 $DSH_HOME/profiles/<profile>/cordis.patch.yml 的顶层数组；',
    '#   2. 启动时临时挂载：dsh <profile> --patch <本文件>；',
    '#   3. 执行 `agentdock install ... --target dsh-agent --profile <profile>` 自动追加（带标记，可重复执行）。',
    '# 重启 DSH 后，在 Settings → Agent presets 中选择该 preset。',
    '# 注意：DSH 的 preset 不携带模型，模型由会话/默认模型决定。',
  ];

  const content = [];
  content.push('- insert:');
  content.push(`    - id: preset-${presetId}`);
  content.push("      name: '@deepseek-ai/dsh-agent-preset'");
  content.push('      config:');
  content.push(`        id: ${presetId}`);
  content.push(`        name: ${yamlString(title)}`);
  content.push(`        description: ${yamlString(description)}`);
  content.push(`        order: ${PRESET_ORDER}`);
  content.push('        plugins:');
  content.push(...renderPlugins(plugins));

  return {
    presetId,
    title,
    description,
    tools,
    skills,
    plugins,
    warnings,
    yaml: `${[...header, ...content].join('\n')}\n`,
    body: `${content.join('\n')}\n`,
  };
}

/** 把片段写到 ~/.dsh/agentdock/presets/<name>.patch.yml */
export function writePresetFragment({ home, name, yaml }) {
  const file = presetFragmentPath(home, name);
  ensureDir(path.dirname(file));
  writeFileAtomic(file, yaml);
  return file;
}

/**
 * 把 patch 条目追加到某个 profile 的 cordis.patch.yml。
 * 以 `# >>> agentdock preset <id>` / `# <<< agentdock preset <id>` 标记包围，
 * 重复执行会替换旧块而不是叠加。
 */
export function upsertProfilePatch({ profile, home, presetId, body }) {
  if (!profile || typeof profile !== 'string' || profile.trim() === '') {
    throw badRequest('缺少 profile 名称');
  }
  const file = profilePatchPath(profile.trim(), home);
  ensureDir(path.dirname(file));
  const start = `# >>> agentdock preset ${presetId}（AgentDock 管理，勿手改）`;
  const end = `# <<< agentdock preset ${presetId}`;
  let text = '';
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(
    `^${escapeRegExp(start)}[^\\n]*\\n[\\s\\S]*?^${escapeRegExp(end)}[^\\n]*\\n?`,
    'm',
  );
  const replaced = pattern.test(text);
  if (replaced) text = text.replace(pattern, '');
  if (!text.trim()) {
    text = [
      '# AgentDock preset 层（由 AgentDock 追加；本文件其余内容可自由编辑）',
      '# 每个块以 # >>> agentdock preset <id> 开头、# <<< 结尾，重复安装会替换对应块。',
    ].join('\n');
  }
  const block = `${start}\n${String(body || '').trimEnd()}\n${end}\n`;
  const next = `${text.trimEnd()}\n\n${block}`;
  writeFileAtomic(file, next);
  return { file, replaced };
}

export function isPresetTarget(target) {
  return target === DSH_AGENT_TARGET;
}

export { KNOWN_DSH_TOOLS as KNOWN_TOOLS };
