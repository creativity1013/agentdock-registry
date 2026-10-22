/**
 * 多样化导入：把市场常见的分发格式统一转换成 bundle payload。
 * 支持：AgentDock JSON bundle、{files} 文件夹上传、.zip、.tar.gz/.tgz/.tar、
 *       单文件 markdown（SKILL.md / agent.md / <name>.md）、单文件 plugin.json。
 * 只做格式识别与元数据推断；结构校验、扫描、发布仍走 pipeline/store。
 */
import { readArchive, ArchiveError, ARCHIVE_LIMITS } from './archive.mjs';
import { detectKind, describeImportedFiles, slugifyName } from './registry.mjs';
import { parseFrontmatter } from './yaml.mjs';

// 原始上传上限（含 base64 JSON 约 4/3 膨胀），解码后的包总大小仍由 bundle LIMITS（100MB）把关
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

export function importFromError(error) {
  return error instanceof ArchiveError;
}

function stemOf(filename) {
  const base = String(filename || '').split('/').pop() || '';
  return base.replace(/\.(zip|tar\.gz|tgz|tar|json|md|markdown)$/i, '').replace(/\s+/g, '-');
}

function contentTypeOf(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return 'unknown';
}

/** 把 markdown 文件包装成 skill 或 agent 包 */
export function wrapMarkdown(filename, text, overrides = {}) {
  let data = {};
  let body = text;
  try {
    const parsed = parseFrontmatter(text);
    data = parsed.data || {};
    body = parsed.body ?? text;
  } catch {
    data = {};
  }
  const wantsAgent = overrides.kind === 'agent'
    || data.tools !== undefined
    || data.model !== undefined
    || /(^|\/)agent\.md$/i.test(filename)
    || /\.agent\.md$/i.test(filename);
  const kind = overrides.kind === 'skill' ? 'skill' : wantsAgent ? 'agent' : 'skill';
  const fallbackName = slugifyName(String(data.name || stemOf(filename) || 'imported-md'), 'imported-md');
  return {
    kind,
    format: 'markdown',
    files: [{ path: kind === 'agent' ? 'agent.md' : 'SKILL.md', content: text, encoding: 'utf8' }],
    hints: { name: fallbackName, description: data.description ? String(data.description) : '' },
  };
}

function payloadFromJsonBuffer(buffer, overrides) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ArchiveError(`JSON 解析失败：${error.message}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ArchiveError('JSON 内容必须是一个对象');
  }
  // 文件夹上传：{ files: [{path, content, encoding}] }
  if (Array.isArray(body.files) && !body.kind) {
    const files = body.files.filter((file) => file && typeof file.path === 'string');
    if (files.length === 0) throw new ArchiveError('JSON 的 files 数组为空');
    return { format: 'files-json', files: files.map((file) => ({ path: file.path, content: file.content, encoding: file.encoding || 'utf8' })) };
  }
  const merged = { ...body };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null && value !== '' && (merged[key] === undefined || merged[key] === null)) {
      merged[key] = value;
    }
  }
  return { format: 'bundle-json', payload: merged };
}

/** 核心入口：根据文件名/Content-Type/内容生成待发布的 bundle payload */
export async function buildImportPayload({ filename = '', contentType = '', buffer, overrides = {} } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length === 0) throw new ArchiveError('导入内容为空');
  if (buf.length > MAX_IMPORT_BYTES) throw new ArchiveError(`导入内容过大（上限 ${MAX_IMPORT_BYTES} 字节）`);

  const declaredType = String(contentType || '').split(';')[0].trim().toLowerCase();
  const kindHint = overrides.kind;

  // 1) JSON（AgentDock bundle 或文件夹上传）
  if (declaredType === 'application/json' || contentTypeOf(filename) === 'json') {
    const parsed = payloadFromJsonBuffer(buf, overrides);
    if (parsed.payload) {
      return { format: parsed.format, payload: parsed.payload, files: parsed.payload.files || [] };
    }
    const files = parsed.files;
    return finalizeFromFiles(files, { filename, overrides, format: parsed.format });
  }

  // 2) 单文件 markdown / plugin.json
  if (declaredType.startsWith('text/') || declaredType === 'application/octet-stream' || contentTypeOf(filename) === 'markdown' || /\.md$/i.test(filename)) {
    const text = buf.toString('utf8');
    if (/plugin\.json$/i.test(filename)) {
      return {
        format: 'plugin-json',
        payload: {
          kind: 'plugin',
          name: overrides.name || slugifyName(stemOf(filename), 'imported-plugin'),
          version: overrides.version || '0.1.0',
          description: overrides.description || '',
          tags: overrides.tags || ['imported'],
          files: [{ path: 'plugin.json', content: text.replace(/^\uFEFF/, ''), encoding: 'utf8' }],
        },
        files: [{ path: 'plugin.json', content: text, encoding: 'utf8' }],
      };
    }
    const wrapped = wrapMarkdown(filename, text, { kind: kindHint });
    const overridden = {
      ...wrapped,
      hints: {
        name: overrides.name || wrapped.hints.name,
        description: overrides.description || wrapped.hints.description,
      },
    };
    return finalizeFromFiles(overridden.files, { filename, overrides: { ...overrides, kind: overridden.kind }, format: 'markdown', hints: overridden.hints });
  }

  // 3) 归档
  const archive = readArchive(buf, filename);
  return finalizeFromFiles(archive.files, { filename, overrides, format: archive.format });
}

/** 文件夹上传时浏览器会带上 .DS_Store、.git/、node_modules/ 等，直接过滤掉 */
const IGNORED_SEGMENTS = new Set(['node_modules', '__macosx', 'thumbs.db', 'desktop.ini']);
export function isIgnoredImportPath(filePath) {
  return String(filePath)
    .split('/')
    .some((segment) => segment.startsWith('.') || IGNORED_SEGMENTS.has(segment.toLowerCase()));
}

function cleanImportFiles(files) {
  const seen = new Set();
  const cleaned = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    const filePath = file.path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!filePath || isIgnoredImportPath(filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    cleaned.push({
      path: filePath,
      content: file.content,
      encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
    });
  }
  return cleaned;
}

const MANIFEST_BASENAMES = new Set(['skill.md', 'agent.md', 'plugin.json']);

const NESTED_ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar)$/i;

/** 文件夹里直接放着若干 .zip/.tar.gz 时，逐个解压成独立能力包 */
function extractNestedArchives(files) {
  const archives = [];
  const loose = [];
  for (const file of files) {
    if (!NESTED_ARCHIVE_RE.test(file.path) || file.encoding !== 'base64') {
      loose.push(file);
      continue;
    }
    const buffer = Buffer.from(file.content, 'base64');
    let read;
    try {
      read = readArchive(buffer, file.path);
    } catch (error) {
      throw new ArchiveError(`归档 ${file.path} 解析失败：${error.message}`);
    }
    archives.push({ root: file.path.replace(NESTED_ARCHIVE_RE, ''), files: read.files, format: read.format });
  }
  return { archives, loose };
}

function manifestRootsOf(files) {
  const roots = [];
  for (const file of files) {
    const parts = file.path.split('/');
    const base = parts[parts.length - 1].toLowerCase();
    if (!MANIFEST_BASENAMES.has(base)) continue;
    const root = parts.slice(0, -1).join('/');
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * 文件夹里可能多套一层目录（如 parent/my-skill/SKILL.md），也可能一次选了一批包
 * （parent/skill-a/SKILL.md + parent/skill-b/SKILL.md）。这里拆分出单个/多个包根目录。
 */
export function splitFolderPackages(files) {
  const roots = manifestRootsOf(files);
  if (roots.length === 0) return [{ root: '', files }];
  if (roots.includes('')) return [{ root: '', files }];
  // 只保留最外层包根：plugin/plugin.json 与 plugin/skills/x/SKILL.md 属于同一个包
  const minimalRoots = roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)));
  const strip = (root) => files
    .filter((file) => file.path.startsWith(`${root}/`))
    .map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
  if (minimalRoots.length === 1) return [{ root: minimalRoots[0], files: strip(minimalRoots[0]) }];
  return minimalRoots.map((root) => ({ root, files: strip(root) }));
}

async function finalizeSinglePackage(files, { filename, overrides, format, hints = {} } = {}) {
  const kind = overrides.kind || detectKind(files) || 'skill';
  const fallbackName = hints.name || overrides.name || slugifyName(stemOf(filename), 'imported-package');
  let meta;
  try {
    meta = await describeImportedFiles(files, { kind, fallbackName });
  } catch {
    meta = { name: fallbackName, version: '0.1.0', description: '', tags: ['imported'] };
  }
  return {
    format,
    files,
    payload: {
      kind,
      name: overrides.name || meta.name || fallbackName,
      version: overrides.version || meta.version || '0.1.0',
      description: overrides.description || meta.description || hints.description || '',
      tags: overrides.tags || meta.tags || ['imported'],
      files,
    },
  };
}

async function finalizeFromFiles(files, { filename, overrides, format, hints = {} } = {}) {
  const cleaned = cleanImportFiles(files);
  if (cleaned.length === 0) throw new ArchiveError('没有可导入的文件（隐藏文件、.git、node_modules 等已被过滤）');
  const { archives, loose } = extractNestedArchives(cleaned);
  if (archives.length > 0) {
    const packages = [];
    for (const archive of archives) {
      packages.push(await finalizeSinglePackage(archive.files, {
        filename: archive.root,
        overrides: { ...overrides, name: undefined, version: undefined },
        format: `${format}+${archive.format}`,
        hints,
      }));
    }
    for (const folder of splitFolderPackages(loose)) {
      if (manifestRootsOf(folder.files).length === 0) continue;
      packages.push(await finalizeSinglePackage(folder.files, {
        filename: folder.root,
        overrides: { ...overrides, name: undefined, version: undefined },
        format,
        hints,
      }));
    }
    if (packages.length === 1) return packages[0];
    return { format: `${format}-batch`, packages };
  }
  if (manifestRootsOf(cleaned).length === 0) {
    const tops = [...new Set(cleaned.map((file) => file.path.split('/')[0]))].slice(0, 8);
    throw new ArchiveError(`没有找到清单文件（SKILL.md / agent.md / plugin.json）。当前文件/目录：${tops.join('、') || '（空）'}`);
  }
  const folders = splitFolderPackages(cleaned);
  if (folders.length > 1) {
    const packages = [];
    for (const folder of folders) {
      packages.push(await finalizeSinglePackage(folder.files, {
        filename: folder.root,
        overrides: { ...overrides, name: undefined, version: undefined },
        format,
        hints,
      }));
    }
    return { format: `${format}-batch`, packages };
  }
  return finalizeSinglePackage(folders[0].files, { filename, overrides, format, hints });
}
