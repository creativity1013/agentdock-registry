/**
 * 零依赖归档/压缩包读取：ZIP（stored/deflate）与 TAR（含 .tar.gz）。
 * 只读取普通文件，跳过目录/符号链接；返回 [{ path, buf }]，路径已做基础安全处理。
 * 真正的路径消毒与体积校验仍由 bundle.normalizeBundle 兜底。
 */
import zlib from 'node:zlib';

export const ARCHIVE_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxPathLength: 200,
  maxRatio: 200,
};

export class ArchiveError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.details = details;
  }
}

const SKIP_SEGMENTS = new Set(['node_modules', '__MACOSX', '.git', '.github', '.vscode', '.idea']);

function isSkippable(rawPath) {
  const segments = rawPath.replace(/\\/g, '/').split('/');
  return segments.some((seg) => seg === '' || seg.startsWith('.') || SKIP_SEGMENTS.has(seg.toLowerCase()));
}

/** 规范化归档内路径：去掉 ./ 前缀与重复斜杠；拒绝绝对路径与 ..；超长/隐藏/保留目录返回 null */
export function normalizeArchivePath(input) {
  if (typeof input !== 'string') return null;
  let path = input.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!path || path.endsWith('/')) return null;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  if (path.length > ARCHIVE_LIMITS.maxPathLength) return null;
  const segments = path.split('/');
  if (segments.length > 20) return null;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg !== seg.trim()) return null;
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
  }
  if (isSkippable(path)) return null;
  return segments.join('/');
}

/** GitHub 打包的 zip 常有一层根目录（repo-ref/），若所有文件都在同一层且根层没有清单文件，则剥掉它 */
export function stripCommonPrefix(entries) {
  const list = entries.filter(Boolean);
  if (list.length === 0) return [];
  const firstSegments = new Set(list.map((entry) => entry.path.split('/')[0]));
  if (firstSegments.size !== 1) return list;
  const root = [...firstSegments][0];
  if (list.some((entry) => entry.path.split('/').length === 1)) return list;
  return list.map((entry) => ({ ...entry, path: entry.path.slice(root.length + 1) })).filter((entry) => entry.path);
}

function likelyBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) > 0.1;
}

function toFileEntry(path, buf) {
  return {
    path,
    buf,
    encoding: likelyBinary(buf) ? 'base64' : 'utf8',
    content: likelyBinary(buf) ? buf.toString('base64') : buf.toString('utf8'),
  };
}

/** 读取 ZIP（支持 stored 与 deflate；不支持 zip64/加密/符号链接） */
export function readZip(buffer, limits = ARCHIVE_LIMITS) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new ArchiveError('ZIP 文件过短');
  const minEocd = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('不是有效的 ZIP 文件（缺少目录尾）');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount > limits.maxEntries) throw new ArchiveError(`ZIP 条目过多（${entryCount} > ${limits.maxEntries}）`);
  if (cdOffset + cdSize > buf.length) throw new ArchiveError('ZIP 目录区越界');

  const files = [];
  let total = 0;
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new ArchiveError('ZIP 中央目录损坏');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const rawName = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new ArchiveError(`ZIP 不支持加密条目：${rawName}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff) throw new ArchiveError('ZIP 不支持 zip64 大文件');
    const filePath = normalizeArchivePath(rawName);
    if (!filePath) continue;
    const mode = externalAttrs >>> 16;
    if ((mode & 0xf000) === 0xa000) continue; // 符号链接
    if (size > limits.maxEntryBytes) throw new ArchiveError(`ZIP 条目过大：${filePath}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('ZIP 解压总量超过限制');
    if (compressedSize > 0 && size > Math.max(1024 * 1024, compressedSize * limits.maxRatio)) {
      throw new ArchiveError(`ZIP 压缩比异常（疑似压缩炸弹）：${filePath}`);
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ArchiveError(`ZIP 本地头损坏：${filePath}`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: size });
    else throw new ArchiveError(`ZIP 不支持的压缩方法（${method}）：${filePath}`);
    if (content.length !== size) throw new ArchiveError(`ZIP 内容长度不符：${filePath}`);
    files.push(toFileEntry(filePath, content));
  }
  return stripCommonPrefix(files);
}

function parseOctal(buf, start, length) {
  const raw = buf.subarray(start, start + length).toString('ascii').replace(/\u0000/g, '').trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/** 读取 TAR（自动跳过 pax/GNU 长名头；不支持稀疏文件） */
export function readTar(buffer, limits = ARCHIVE_LIMITS) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const files = [];
  let total = 0;
  let offset = 0;
  let entries = 0;
  let pendingLongName = '';
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(header[156] || 48);
    const size = parseOctal(header, 124, 12);
    const nameField = header.subarray(0, 100).toString('utf8').replace(/\u0000.*$/s, '');
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\u0000.*$/s, '');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new ArchiveError('TAR 文件被截断');
    const blockData = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    entries += 1;
    if (entries > limits.maxEntries * 2) throw new ArchiveError('TAR 条目过多');

    if (type === 'L') {
      pendingLongName = blockData.toString('utf8').replace(/\u0000.*$/s, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const text = blockData.toString('utf8');
      const match = text.match(/(?:^|\n)\d* ?path=([^\n]*)\n/);
      if (match) pendingLongName = match[1];
      continue;
    }
    if (type !== '0' && type !== '\u0000' && type !== '7') continue;
    const rawName = pendingLongName || (prefixField ? `${prefixField}/${nameField}` : nameField);
    pendingLongName = '';
    const filePath = normalizeArchivePath(rawName);
    if (!filePath) continue;
    if (size > limits.maxEntryBytes) throw new ArchiveError(`TAR 条目过大：${filePath}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('TAR 解压总量超过限制');
    files.push(toFileEntry(filePath, blockData));
  }
  return stripCommonPrefix(files);
}

/** 读取 .tar.gz / .tgz；解压上限用 zlib maxOutputLength 限制，防压缩炸弹 */
export function readTarGz(buffer, limits = ARCHIVE_LIMITS) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let tar;
  try {
    tar = zlib.gunzipSync(buf, { maxOutputLength: limits.maxTotalBytes });
  } catch (error) {
    throw new ArchiveError(`gzip 解压失败：${error.message}`);
  }
  return readTar(tar, limits);
}

export function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5);
}

export function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** 自动识别并读取归档；返回 { format, files } */
export function readArchive(buffer, filename = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (isZip(buf)) return { format: 'zip', files: readZip(buf) };
  if (isGzip(buf)) return { format: 'tar.gz', files: readTarGz(buf) };
  if (/\.tar$/i.test(filename)) return { format: 'tar', files: readTar(buf) };
  throw new ArchiveError('无法识别的归档格式（支持 .zip / .tar.gz / .tgz / .tar）');
}
