import { parseFrontmatter, YamlError } from './yaml.mjs';
import { isValidName, sanitizePath, LIMITS } from './bundle.mjs';
import { truncate, formatBytes, parseVersion } from './util.mjs';

const SKILL_FIELDS = new Set([
  'name',
  'description',
  'whenToUse',
  'metadata',
  'license',
  'allowed-tools',
  'user-invocable',
  'disable-model-invocation',
  'tags',
]);

const AGENT_FIELDS = new Set(['name', 'description', 'tools', 'model', 'skills', 'mcp', 'color', 'metadata', 'tags', 'whenToUse']);
const PLUGIN_FIELDS = new Set([
  'name',
  'version',
  'description',
  'skills',
  'agents',
  'mcp',
  'hooks',
  'commands',
  'author',
  'license',
  'keywords',
  'homepage',
  'repository',
  'requires',
  'tags',
]);

const KNOWN_AGENT_TOOLS = new Set([
  // Claude Code 常用工具名
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task',
  'NotebookEdit', 'TodoWrite', 'MultiEdit', 'BashOutput', 'KillShell', 'SlashCommand',
  'AskUserQuestion', 'Skill',
  // DSH / 通用小写工具名
  'read', 'write', 'edit', 'bash', 'grep', 'glob', 'fetch', 'search', 'web_fetch',
  'web_search', 'subagent', 'subagent_fork', 'spawn_teammate', 'send_message',
  'todo', 'skill', 'present', 'task', 'notebook_edit', 'multi_edit', 'bash_output',
  'kill_shell', 'ask_user_question',
]);

function textFile(fileMap, filePath) {
  const file = fileMap.get(filePath);
  if (!file) return null;
  if (file.encoding !== 'utf8') return null;
  return file.buf.toString('utf8');
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  return null;
}

function checkFrontmatterFields(data, allowed, filePath, warn) {
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) warn(filePath, `未知 frontmatter 字段：${key}（运行时可能忽略）`);
  }
}

function parseMarkdownFile(fileMap, filePath, err, warnings) {
  const text = textFile(fileMap, filePath);
  if (text === null) {
    const file = fileMap.get(filePath);
    if (file && file.encoding !== 'utf8') err(filePath, '文件必须是 UTF-8 文本');
    return null;
  }
  try {
    const parsed = parseFrontmatter(text);
    if (typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      err(filePath, 'frontmatter 必须是键值映射');
      return null;
    }
    return parsed;
  } catch (e) {
    if (e instanceof YamlError) {
      err(filePath, e.message);
    } else {
      err(filePath, `解析失败：${e.message}`);
    }
    return null;
  }
}

function validateNameField(data, bundle, filePath, err) {
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    err(filePath, 'frontmatter 缺少必填字段 name');
    return;
  }
  const name = data.name.trim();
  if (!isValidName(name)) {
    err(filePath, `name 不合法：${name}（小写字母/数字/._-，≤63 字符）`);
    return;
  }
  if (name !== bundle.name) {
    err(filePath, `frontmatter name（${name}）必须与包名（${bundle.name}）一致`);
  }
}

function validateDescriptionField(data, bundle, filePath, err, warn) {
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    err(filePath, 'frontmatter 缺少必填字段 description');
  } else if (data.description.length > LIMITS.maxDescription) {
    err(filePath, `description 不能超过 ${LIMITS.maxDescription} 字符`);
  } else if (data.description.length < 10) {
    warn(filePath, 'description 较短，建议写清用途与触发场景');
  }
  if (!bundle.description.trim()) {
    warn('description', '包描述为空；市场列表与模型路由会依赖它');
  }
}

function validateSkill(bundle, fileMap, err, warn) {
  const entry = 'SKILL.md';
  if (!fileMap.has(entry)) {
    err('files', 'skill 包必须在根目录包含 SKILL.md');
    return null;
  }
  const parsed = parseMarkdownFile(fileMap, entry, err, warn);
  if (!parsed) return null;
  const { data, body } = parsed;
  checkFrontmatterFields(data, SKILL_FIELDS, entry, warn);
  validateNameField(data, bundle, entry, err);
  validateDescriptionField(data, bundle, entry, err, warn);
  if (data.whenToUse !== undefined && typeof data.whenToUse !== 'string') {
    err(entry, 'whenToUse 必须是字符串');
  }
  if (data.metadata !== undefined && data.metadata !== null) {
    if (typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
      err(entry, 'metadata 必须是键值映射');
    } else {
      for (const [key, value] of Object.entries(data.metadata)) {
        if (value !== null && typeof value === 'object') {
          err(entry, `metadata.${key} 必须是标量值`);
        }
      }
    }
  }
  for (const flag of ['user-invocable', 'disable-model-invocation']) {
    if (data[flag] !== undefined && typeof data[flag] !== 'boolean') {
      err(entry, `${flag} 必须是布尔值`);
    }
  }
  if (data['allowed-tools'] !== undefined) {
    const tools = normalizeStringArray(data['allowed-tools']);
    if (!tools) err(entry, 'allowed-tools 必须是字符串或字符串数组');
  }
  if (body.trim() === '') err(entry, 'SKILL.md 正文不能为空');
  if (body.length > 100_000) warn(entry, 'SKILL.md 正文超过 100K 字符，建议拆分为 references/');
  if (body.split('\n').length > 500) warn(entry, 'SKILL.md 正文超过 500 行，建议使用 references/ 渐进披露');

  const allowedTools = normalizeStringArray(data['allowed-tools']) || [];
  return {
    title: String(data.name || '').trim(),
    description: (data.description || '').trim(),
    capabilities: { entry, allowedTools, whenToUse: data.whenToUse || '' },
    frontmatter: data,
  };
}

function validateAgent(bundle, fileMap, err, warn) {
  const entry = 'agent.md';
  if (!fileMap.has(entry)) {
    err('files', 'agent 包必须在根目录包含 agent.md（frontmatter + 系统提示正文）');
    return null;
  }
  const parsed = parseMarkdownFile(fileMap, entry, err, warn);
  if (!parsed) return null;
  const { data, body } = parsed;
  checkFrontmatterFields(data, AGENT_FIELDS, entry, warn);
  validateNameField(data, bundle, entry, err);
  validateDescriptionField(data, bundle, entry, err, warn);

  let tools = [];
  if (data.tools !== undefined) {
    const normalized = normalizeStringArray(data.tools);
    if (!normalized) {
      err(entry, 'tools 必须是字符串（逗号分隔）或字符串数组');
    } else {
      tools = normalized;
      if (tools.length > 50) warn(entry, 'tools 超过 50 个，模型选择工具可能变慢');
      for (const tool of tools) {
        if (!/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(tool)) {
          err(entry, `非法工具名：${truncate(tool, 40)}`);
        } else if (!KNOWN_AGENT_TOOLS.has(tool) && !tool.startsWith('mcp__')) {
          warn(entry, `未知工具名（运行时可能忽略）：${tool}`);
        }
      }
    }
  }

  let model = '';
  if (data.model !== undefined) {
    if (typeof data.model !== 'string' || data.model.trim() === '') {
      err(entry, 'model 必须是非空字符串');
    } else {
      model = data.model.trim();
      if (model.length > 100) err(entry, 'model 名称过长');
    }
  }

  let skills = [];
  if (data.skills !== undefined) {
    const normalized = normalizeStringArray(data.skills);
    if (!normalized) {
      err(entry, 'skills 必须是字符串数组');
    } else {
      skills = normalized;
      for (const skill of skills) {
        if (!isValidName(skill)) warn(entry, `skills 中存在不合法的技能名：${truncate(skill, 40)}`);
      }
    }
  }

  let mcp = [];
  if (data.mcp !== undefined) {
    if (Array.isArray(data.mcp)) {
      const bad = data.mcp.some((item) => typeof item !== 'string' || item.trim() === '');
      if (bad) err(entry, 'mcp 必须是字符串数组（MCP server 名称）');
      else mcp = data.mcp.map((s) => s.trim());
    } else if (typeof data.mcp === 'string') {
      mcp = [data.mcp.trim()];
    } else {
      err(entry, 'mcp 必须是字符串数组');
    }
  }

  if (body.trim() === '') err(entry, 'agent.md 正文不能为空（应为系统提示）');
  if (body.length > 100_000) warn(entry, 'agent.md 正文超过 100K 字符，建议精简或拆分为技能');

  return {
    title: String(data.name || '').trim(),
    description: (data.description || '').trim(),
    capabilities: { entry, tools, model, skills, mcp },
    frontmatter: data,
  };
}

function validatePluginComponentPath(fileMap, refPath, kind, err) {
  const safe = sanitizePath(refPath);
  if (!safe) {
    err('plugin.json', `组件路径不安全：${truncate(String(refPath), 60)}`);
    return null;
  }
  if (kind === 'skill') {
    if (fileMap.has(`${safe}/SKILL.md`)) return { path: safe, entry: `${safe}/SKILL.md` };
    if (fileMap.has(safe)) return { path: safe, entry: safe };
    err('plugin.json', `skills 引用了不存在的目录：${safe}`);
    return null;
  }
  if (fileMap.has(safe)) return { path: safe, entry: safe };
  if (fileMap.has(`${safe}/agent.md`)) return { path: safe, entry: `${safe}/agent.md` };
  err('plugin.json', `组件路径不存在：${safe}`);
  return null;
}

function validatePlugin(bundle, fileMap, err, warn) {
  const entry = 'plugin.json';
  if (!fileMap.has(entry)) {
    err('files', 'plugin 包必须在根目录包含 plugin.json');
    return null;
  }
  const raw = textFile(fileMap, entry);
  if (raw === null) {
    err(entry, 'plugin.json 必须是 UTF-8 文本');
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    err(entry, `plugin.json 不是合法 JSON：${e.message}`);
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    err(entry, 'plugin.json 必须是 JSON 对象');
    return null;
  }
  for (const key of Object.keys(data)) {
    if (!PLUGIN_FIELDS.has(key)) warn(entry, `未知字段：${key}`);
  }
  if (typeof data.name !== 'string' || data.name.trim() === '') err(entry, 'plugin.json 缺少必填字段 name');
  else if (data.name.trim() !== bundle.name) err(entry, `name（${data.name}）必须与包名（${bundle.name}）一致`);
  if (!parseVersion(data.version)) err(entry, 'plugin.json 缺少合法 semver version');
  else if (data.version !== bundle.version) err(entry, `version（${data.version}）必须与发布版本（${bundle.version}）一致`);
  if (typeof data.description !== 'string' || data.description.trim() === '') err(entry, 'plugin.json 缺少必填字段 description');

  const skills = [];
  const agents = [];
  const commands = [];
  const hooks = [];
  const mcp = [];

  if (data.skills !== undefined) {
    if (!Array.isArray(data.skills)) err(entry, 'skills 必须是数组');
    else {
      for (const ref of data.skills) {
        if (typeof ref !== 'string') {
          err(entry, 'skills 数组元素必须是字符串路径');
          continue;
        }
        const resolved = validatePluginComponentPath(fileMap, ref, 'skill', err);
        if (!resolved) continue;
        const parsed = parseMarkdownFile(fileMap, resolved.entry, err, warn);
        if (parsed) {
          if (typeof parsed.data.name !== 'string' || !parsed.data.name) err(resolved.entry, '技能缺少 name');
          if (typeof parsed.data.description !== 'string' || !parsed.data.description) {
            err(resolved.entry, '技能缺少 description');
          }
          skills.push({ name: parsed.data.name || resolved.path, path: resolved.path });
        }
      }
    }
  }
  if (data.agents !== undefined) {
    if (!Array.isArray(data.agents)) err(entry, 'agents 必须是数组');
    else {
      for (const ref of data.agents) {
        if (typeof ref !== 'string') {
          err(entry, 'agents 数组元素必须是字符串路径');
          continue;
        }
        const resolved = validatePluginComponentPath(fileMap, ref, 'agent', err);
        if (!resolved) continue;
        const parsed = parseMarkdownFile(fileMap, resolved.entry, err, warn);
        if (parsed) {
          if (typeof parsed.data.name !== 'string' || !parsed.data.name) err(resolved.entry, 'agent 缺少 name');
          if (typeof parsed.data.description !== 'string' || !parsed.data.description) {
            err(resolved.entry, 'agent 缺少 description');
          }
          agents.push({ name: parsed.data.name || resolved.path, path: resolved.path });
        }
      }
    }
  }
  if (data.commands !== undefined) {
    const refs = normalizeStringArray(data.commands);
    if (!refs) err(entry, 'commands 必须是字符串数组');
    else {
      for (const ref of refs) {
        const resolved = validatePluginComponentPath(fileMap, ref, 'file', err);
        if (resolved) commands.push(resolved.path);
      }
    }
  }
  if (data.hooks !== undefined) {
    const refs = normalizeStringArray(data.hooks);
    if (!refs) err(entry, 'hooks 必须是字符串数组');
    else {
      for (const ref of refs) {
        const resolved = validatePluginComponentPath(fileMap, ref, 'file', err);
        if (resolved) hooks.push(resolved.path);
      }
    }
  }
  if (data.mcp !== undefined) {
    if (!Array.isArray(data.mcp)) err(entry, 'mcp 必须是数组');
    else {
      for (const [index, item] of data.mcp.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          err(entry, `mcp[${index}] 必须是对象 { name, command? | url? }`);
          continue;
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
          err(entry, `mcp[${index}] 缺少 name`);
          continue;
        }
        const hasCommand = typeof item.command === 'string' && item.command.trim() !== '';
        const hasUrl = typeof item.url === 'string' && item.url.trim() !== '';
        if (!hasCommand && !hasUrl) err(entry, `mcp[${index}]（${item.name}）必须提供 command 或 url`);
        if (hasUrl) {
          if (!/^https?:\/\//i.test(item.url)) err(entry, `mcp[${index}].url 必须是 http(s) URL`);
          else if (!/^https:\/\//i.test(item.url)) warn(entry, `mcp[${index}].url 未使用 HTTPS`);
        }
        mcp.push({ name: item.name.trim(), command: item.command || '', url: item.url || '' });
      }
    }
  }

  if (skills.length === 0 && agents.length === 0 && commands.length === 0 && hooks.length === 0 && mcp.length === 0) {
    warn(entry, 'plugin 未包含任何可加载组件（skills/agents/mcp/commands/hooks 均为空）');
  }

  const allNames = [...skills, ...agents].map((c) => c.name);
  if (new Set(allNames).size !== allNames.length) warn(entry, '组件名称存在重复');

  return {
    title: bundle.name,
    description: (data.description || '').trim(),
    capabilities: {
      entry,
      skills,
      agents,
      mcp: mcp.map((m) => m.name),
      commands,
      hooks,
      mcpConfigs: mcp,
    },
    frontmatter: data,
  };
}

/**
 * 校验归一化后的能力包。
 * @returns {{ok:boolean, errors:Array, warnings:Array, manifest:object|null}}
 */
export function validateBundle(bundle) {
  const errors = [];
  const warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });
  const fileMap = new Map(bundle.files.map((f) => [f.path, f]));

  let manifest = null;
  if (bundle.kind === 'skill') manifest = validateSkill(bundle, fileMap, err, warn);
  else if (bundle.kind === 'agent') manifest = validateAgent(bundle, fileMap, err, warn);
  else if (bundle.kind === 'plugin') manifest = validatePlugin(bundle, fileMap, err, warn);
  else err('kind', `不支持的能力类型：${bundle.kind}`);

  if (manifest && manifest.description && bundle.description && manifest.description !== bundle.description) {
    warn('description', '包描述与组件内描述不一致，市场展示以包描述为准');
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

/** 供 CLI / Web 展示的包统计信息 */
export function describeBundle(manifest) {
  if (!manifest) return '';
  const caps = manifest.capabilities || {};
  const parts = [];
  if (caps.entry) parts.push(`入口 ${caps.entry}`);
  if (caps.tools?.length) parts.push(`${caps.tools.length} 个工具`);
  if (caps.model) parts.push(`模型 ${caps.model}`);
  if (caps.skills?.length) parts.push(`${caps.skills.length} 个技能`);
  if (caps.agents?.length) parts.push(`${caps.agents.length} 个 agent`);
  if (caps.mcp?.length) parts.push(`${caps.mcp.length} 个 MCP`);
  return parts.join(' · ');
}

export { KNOWN_AGENT_TOOLS };
