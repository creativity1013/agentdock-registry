import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir, nowIso, sha256, writeFileAtomic } from './util.mjs';
import { sanitizePath } from './bundle.mjs';

/**
 * 零依赖备份/恢复：把 data/ 目录打包成单个带校验和的 gzip JSON。
 *
 * 备份格式：gzip(JSON)
 *   { schema: 'agentdock-backup@1', createdAt, files: [{ path, bytes, sha256, content(base64) }] }
 * path 为 data/ 内的相对路径（做过路径消毒），sha256 为文件内容校验和。
 *
 * 注意：服务运行中 SQLite 可能处于 WAL 未 checkpoint 状态，正式备份应
 * 先停服；恢复也必须在停服状态执行。
 */

export const BACKUP_SCHEMA = 'agentdock-backup@1';
export const BACKUP_EXTENSION = '.agentdock-backup.json.gz';

function walk(dir, base = dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, files);
    } else if (entry.isFile()) {
      files.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return files;
}

/** 生成备份对象（不写盘），返回 {manifest, buffer} */
export function buildBackup({ dataDir, includeBootstrap = true, createdAt = nowIso() } = {}) {
  if (!dataDir || !fs.existsSync(dataDir)) throw new Error(`数据目录不存在：${dataDir}`);
  const files = [];
  let totalBytes = 0;
  for (const relative of walk(dataDir).sort()) {
    if (!includeBootstrap && relative === 'BOOTSTRAP-TOKENS.txt') continue;
    const absolute = path.join(dataDir, relative);
    const buf = fs.readFileSync(absolute);
    files.push({ path: relative, bytes: buf.length, sha256: sha256(buf), content: buf.toString('base64') });
    totalBytes += buf.length;
  }
  const manifest = {
    schema: BACKUP_SCHEMA,
    createdAt,
    dataDir: path.basename(dataDir),
    fileCount: files.length,
    totalBytes,
    digest: sha256(JSON.stringify({ schema: BACKUP_SCHEMA, files: files.map(({ path, sha256: hash }) => [path, hash]) })),
  };
  const payload = { ...manifest, files };
  return { manifest, buffer: zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')) };
}

/** 写备份到文件，返回 {file, manifest} */
export function writeBackup({ dataDir, out, includeBootstrap = true } = {}) {
  const target = out || path.join(process.cwd(), `agentdock-backup-${new Date().toISOString().replace(/[:.]/g, '-')}${BACKUP_EXTENSION}`);
  ensureDir(path.dirname(target));
  const { manifest, buffer } = buildBackup({ dataDir, includeBootstrap });
  fs.writeFileSync(target, buffer, { mode: 0o600 });
  return { file: target, manifest };
}

/** 读取备份文件（自动识别 gzip），校验结构、路径与每个文件的 sha256 */
export function readBackup(file) {
  if (!fs.existsSync(file)) throw new Error(`备份文件不存在：${file}`);
  const raw = fs.readFileSync(file);
  const isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是合法的 JSON');
  }
  if (parsed?.schema !== BACKUP_SCHEMA) throw new Error(`备份格式不支持：${parsed?.schema ?? '未知'}`);
  if (!Array.isArray(parsed.files)) throw new Error('备份文件缺少 files 清单');
  const files = [];
  for (const entry of parsed.files) {
    const clean = sanitizePath(entry?.path);
    if (clean !== entry.path) throw new Error(`备份包含不安全路径：${entry?.path}`);
    const buf = Buffer.from(String(entry.content ?? ''), 'base64');
    if (buf.length !== entry.bytes) throw new Error(`文件大小不符：${entry.path}`);
    if (sha256(buf) !== entry.sha256) throw new Error(`文件校验失败（内容已被修改）：${entry.path}`);
    files.push({ path: clean, buf });
  }
  const manifest = {
    schema: parsed.schema,
    createdAt: parsed.createdAt ?? null,
    dataDir: parsed.dataDir ?? null,
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.buf.length, 0),
    digest: parsed.digest ?? null,
  };
  return { manifest, files };
}

/** 恢复到目标数据目录；默认拒绝覆盖非空目录 */
export function restoreBackup({ file, dataDir, force = false, dryRun = false } = {}) {
  const { manifest, files } = readBackup(file);
  const hasExisting = fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0;
  if (!dryRun && hasExisting && !force) {
    throw new Error(`目标数据目录非空：${dataDir}（确认覆盖请加 --force）`);
  }
  if (!dryRun) {
    ensureDir(dataDir);
    for (const entry of files) {
      const target = path.join(dataDir, entry.path);
      ensureDir(path.dirname(target));
      writeFileAtomic(target, entry.buf);
    }
  }
  return { target: dataDir, fileCount: files.length, totalBytes: manifest.totalBytes, createdAt: manifest.createdAt, dryRun };
}
