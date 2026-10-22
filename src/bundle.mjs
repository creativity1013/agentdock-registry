import fs from 'node:fs';
import path from 'node:path';
import { parseVersion, sha256, isPlainObject, truncate, formatBytes } from './util.mjs';

/** 支持的能力包类型 */
export const KINDS = ['skill', 'agent', 'plugin'];
export const KIND_LABEL = { skill: '技能', agent: '智能体', plugin: '插件' };

/** 包名规则：小写字母/数字开头，允许 . _ -，≤63 字符 */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export const LIMITS = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxPathLength: 180,
  maxDescription: 1024,
  maxTags: 10,
  maxTagLength: 32,
};

const RESERVED_SEGMENTS = new Set(['node_modules']);
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', 'data', '.agentdock']);

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * 归一化并校验包内相对路径；非法返回 null。
 * 拒绝：绝对路径、盘符、..、空段、控制字符、首尾空格、隐藏文件、Windows 保留名、超长。
 */
export function sanitizePath(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const segments = [];
  for (const seg of raw.split('/')) {
    if (seg === '') continue;
    if (seg === '.' || seg === '..') return null;
    if (seg.length > 100) return null;
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
    if (seg !== seg.trim()) return null;
    if (seg.startsWith('.')) return null;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(seg)) return null;
    if (RESERVED_SEGMENTS.has(seg)) return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  const normalized = segments.join('/');
  if (normalized.length > LIMITS.maxPathLength) return null;
  return normalized;
}

function decodeFileContent(content, encoding, field, errors) {
  if (typeof content !== 'string') {
    errors.push({ field, message: '文件内容必须是字符串' });
    return null;
  }
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) {
      errors.push({ field, message: 'base64 内容包含非法字符' });
      return null;
    }
    return Buffer.from(content, 'base64');
  }
  return Buffer.from(content, 'utf8');
}

/**
 * 归一化并校验一个待发布的能力包。
 * @returns {{ok:boolean, errors:Array, warnings:Array, bundle:object|null}}
 */
export function normalizeBundle(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ field: 'bundle', message: '请求体必须是 JSON 对象' }], warnings, bundle: null };
  }

  const kind = input.kind;
  const name = input.name;
  const version = input.version;
  let description = input.description ?? '';
  let tags = input.tags ?? [];

  if (!KINDS.includes(kind)) errors.push({ field: 'kind', message: `kind 必须是 ${KINDS.join(' / ')} 之一` });
  if (!isValidName(name)) {
    errors.push({ field: 'name', message: 'name 必须由小写字母/数字/._- 组成，以字母或数字开头，≤63 字符' });
  }
  if (!parseVersion(version)) {
    errors.push({ field: 'version', message: 'version 必须是合法 semver，例如 0.1.0' });
  }
  if (typeof description !== 'string') {
    errors.push({ field: 'description', message: 'description 必须是字符串' });
    description = '';
  } else if (description.length > LIMITS.maxDescription) {
    errors.push({ field: 'description', message: `description 不能超过 ${LIMITS.maxDescription} 字符` });
  }
  if (typeof tags === 'string') {
    tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(tags)) {
    errors.push({ field: 'tags', message: 'tags 必须是字符串数组' });
    tags = [];
  } else {
    if (tags.length > LIMITS.maxTags) errors.push({ field: 'tags', message: `tags 最多 ${LIMITS.maxTags} 个` });
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '' || tag.length > LIMITS.maxTagLength) {
        errors.push({ field: 'tags', message: `非法 tag：${truncate(String(tag), 40)}` });
        break;
      }
    }
  }

  const inputFiles = input.files;
  const files = [];
  let totalBytes = 0;
  const seen = new Map();
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
    errors.push({ field: 'files', message: 'files 不能为空' });
  } else if (inputFiles.length > LIMITS.maxFiles) {
    errors.push({ field: 'files', message: `文件数量不能超过 ${LIMITS.maxFiles}` });
  } else {
    for (const [idx, entry] of inputFiles.entries()) {
      const field = `files[${idx}]`;
      if (!isPlainObject(entry)) {
        errors.push({ field, message: '文件项必须是对象 { path, content, encoding? }' });
        continue;
      }
      const safePath = sanitizePath(entry.path);
      if (!safePath) {
        errors.push({ field: `${field}.path`, message: `非法或不安全的文件路径：${truncate(String(entry.path), 80)}` });
        continue;
      }
      const encoding = entry.encoding === 'base64' ? 'base64' : 'utf8';
      const buf = decodeFileContent(entry.content, encoding, field, errors);
      if (!buf) continue;
      if (buf.length > LIMITS.maxFileBytes) {
        errors.push({ field, message: `单文件超过 ${formatBytes(LIMITS.maxFileBytes)}：${safePath}` });
        continue;
      }
      if (seen.has(safePath)) {
        errors.push({ field: `${field}.path`, message: `重复的文件路径：${safePath}` });
        continue;
      }
      const lower = safePath.toLowerCase();
      if (seen.has(lower) && seen.get(lower) !== safePath) {
        warnings.push({ field: `${field}.path`, message: `路径大小写冲突：${safePath}` });
      }
      seen.set(safePath, safePath);
      seen.set(lower, safePath);
      totalBytes += buf.length;
      files.push({ path: safePath, encoding, bytes: buf.length, buf });
    }
  }
  if (totalBytes > LIMITS.maxTotalBytes) {
    errors.push({ field: 'files', message: `包总大小超过 ${formatBytes(LIMITS.maxTotalBytes)}` });
  }
  if (errors.length > 0) return { ok: false, errors, warnings, bundle: null };

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifestFiles = files.map((f) => ({
    path: f.path,
    encoding: f.encoding,
    bytes: f.bytes,
    sha256: sha256(f.buf),
  }));
  const contentHash = computeContentHash(manifestFiles);

  return {
    ok: true,
    errors,
    warnings,
    bundle: {
      kind,
      name,
      version,
      description: description.trim(),
      tags: [...new Set(tags.map((t) => t.trim()))],
      files,
      manifestFiles,
      contentHash,
      fileCount: files.length,
      totalBytes,
    },
  };
}

/**
 * 由文件清单计算内容哈希：对 [path, sha256, encoding] 排序后取 SHA-256。
 * 服务端签名与验签、安装清单校验都复用同一个定义。
 */
export function computeContentHash(manifestFiles) {
  const entries = [...manifestFiles]
    .map((file) => [file.path, file.sha256, file.encoding])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(entries));
}

/** 安全的对外文件清单（不含内容） */
export function publicFileList(bundle) {
  return bundle.manifestFiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }));
}

function isProbablyText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  let controls = 0;
  for (const byte of buf) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  }
  return buf.length === 0 || controls / buf.length < 0.02;
}

/**
 * 从本地目录读取一个能力包（用于 CLI publish / verify）。
 * 跳过 .git、node_modules、隐藏文件与符号链接。
 * @returns {{files:Array<{path:string,content:string,encoding:string}>, warnings:Array}}
 */
export function readBundleFromDirectory(dir) {
  const abs = path.resolve(String(dir));
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`目录不存在：${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`);

  const files = [];
  const warnings = [];
  let totalBytes = 0;

  const walk = (current, rel) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) {
        warnings.push({ field: relPath, message: `跳过 ${entry.name}` });
        continue;
      }
      const absPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push({ field: relPath, message: '跳过符号链接（出于安全考虑）' });
        continue;
      }
      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= LIMITS.maxFiles) throw new Error(`文件数量超过 ${LIMITS.maxFiles} 个`);
      const buf = fs.readFileSync(absPath);
      if (buf.length > LIMITS.maxFileBytes) {
        throw new Error(`文件超过 ${formatBytes(LIMITS.maxFileBytes)} 限制：${relPath}`);
      }
      totalBytes += buf.length;
      if (totalBytes > LIMITS.maxTotalBytes) {
        throw new Error(`目录总大小超过 ${formatBytes(LIMITS.maxTotalBytes)} 限制`);
      }
      const text = isProbablyText(buf);
      files.push({
        path: relPath,
        content: text ? buf.toString('utf8') : buf.toString('base64'),
        encoding: text ? 'utf8' : 'base64',
      });
    }
  };
  walk(abs, '');
  return { files, warnings };
}
