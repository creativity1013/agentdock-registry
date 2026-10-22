/**
 * 多样化导入：把市场常见的分发格式统一转换成 bundle payload。
 * 支持：AgentDock JSON bundle、{files} 文件夹上传、.zip、.tar.gz/.tgz/.tar、
 *       单文件 markdown（SKILL.md / agent.md / <name>.md）、单文件 plugin.json。
 * 只做格式识别与元数据推断；结构校验、扫描、发布仍走 pipeline/store。
 */
import { readArchive, ArchiveError, ARCHIVE_LIMITS } from './archive.mjs';
import { detectKind, describeImportedFiles, slugifyName } from './registry.mjs';
import { parseFrontmatter } from './yaml.mjs';

export const MAX_IMPORT_BYTES = ARCHIVE_LIMITS.maxTotalBytes;

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

async function finalizeFromFiles(files, { filename, overrides, format, hints = {} } = {}) {
  const cleaned = files
    .filter((file) => file && typeof file.path === 'string')
    .map((file) => ({ path: file.path, content: file.content, encoding: file.encoding === 'base64' ? 'base64' : 'utf8' }));
  if (cleaned.length === 0) throw new ArchiveError('没有可导入的文件');
  const kind = overrides.kind || detectKind(cleaned) || 'skill';
  const fallbackName = hints.name || overrides.name || slugifyName(stemOf(filename), 'imported-package');
  let meta;
  try {
    meta = await describeImportedFiles(cleaned, { kind, fallbackName });
  } catch {
    meta = { name: fallbackName, version: '0.1.0', description: '', tags: ['imported'] };
  }
  return {
    format,
    files: cleaned,
    payload: {
      kind,
      name: overrides.name || meta.name || fallbackName,
      version: overrides.version || meta.version || '0.1.0',
      description: overrides.description || meta.description || hints.description || '',
      tags: overrides.tags || meta.tags || ['imported'],
      files: cleaned,
    },
  };
}
