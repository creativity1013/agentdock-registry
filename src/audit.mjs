import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, sha256 } from './util.mjs';
import { ensureDataLayout } from './config.mjs';

/**
 * 追加式审计日志（JSONL），带防篡改哈希链。
 *
 * 每条记录包含 seq（文件内递增）、prevHash、hash 三个链字段：
 *   hash = sha256([seq, prevHash, ts, actor, role, action, target, meta, ip])
 * 追加写入时在内存中维护链头；verify() 读磁盘重算全链，可发现任何
 * 篡改 / 删除 / 插入。文件超过 AGENTDOCK_AUDIT_MAX_BYTES 时轮转到
 * data/audit/archive/，新文件首条记录的 prevHash 接续旧链头（链跨文件连续）。
 *
 * 该日志独立于 transparency.log：audit 是运维审计（含角色、IP 等内部信息），
 * transparency 是对外可复核的发布历史（含 Merkle 证明），两者定位不同。
 */

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** 单条记录哈希（固定字段顺序数组，避免 JSON 序列化歧义） */
export function auditEntryHash(entry) {
  return sha256(
    JSON.stringify([
      entry.seq,
      entry.prevHash,
      entry.ts,
      entry.actor,
      entry.role,
      entry.action,
      entry.target,
      entry.meta ?? {},
      entry.ip,
    ]),
  );
}

/** 是带链字段的新格式记录（否则视为升级前的 legacy 行，只跳过不校验） */
function isChained(entry) {
  return Boolean(
    entry
      && Number.isInteger(entry.seq)
      && typeof entry.prevHash === 'string'
      && typeof entry.hash === 'string',
  );
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function createAuditLog(config) {
  ensureDataLayout(config);
  const file = config.files.audit;
  ensureDir(path.dirname(file));
  const archiveDir = config.files.auditArchive;
  const maxBytes = config.audit.maxBytes; // 0 = 不轮转
  const keep = config.audit.keep; // 0 = 归档不限量

  let head = null; // { seq, hash } 内存链头；懒加载
  let lastArchiveName = null; // 已用过的最大归档文件名（保证名字单调 = 创建顺序，不受墙钟回拨影响）

  function loadHead() {
    if (head) return head;
    head = null;
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(lines[i]);
          if (isChained(entry)) {
            head = { seq: entry.seq, hash: entry.hash };
            break;
          }
        } catch {
          // 损坏行不参与链头定位，verify() 会报告
        }
      }
    }
    return head;
  }

  /* ------------------------------ 轮转与保留 ------------------------------ */

  function archiveStamp() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }

  function listArchives() {
    if (!fs.existsSync(archiveDir)) return [];
    return fs
      .readdirSync(archiveDir)
      .filter((name) => name.startsWith('audit-') && name.endsWith('.log'))
      .sort()
      .map((name) => path.join(archiveDir, name));
  }

  /** 归档名毫秒/秒数值 +1（999 进位到秒；仅保证字典序递增，不保证是真实时刻） */
  function bumpArchiveName(name) {
    const m = /^audit-(\d{8})-(\d{6})-(\d{3})\.log$/.exec(name);
    if (!m) return `${name.slice(0, -4)}-z.log`; // 未识别格式，加后缀兜底
    const [, date, time, ms] = m;
    let second = Number(ms) + 1;
    let clock = time;
    if (second > 999) {
      second = 0;
      clock = String(Number(time) + 1).padStart(6, '0');
    }
    return `audit-${date}-${clock}-${String(second).padStart(3, '0')}.log`;
  }

  function rotate() {
    if (!fs.existsSync(file)) return;
    ensureDir(archiveDir);
    if (lastArchiveName === null) {
      const existing = listArchives();
      lastArchiveName = existing.length ? path.basename(existing[existing.length - 1]) : '';
    }
    const pad3 = (x) => String(x).padStart(3, '0');
    let name = `audit-${archiveStamp()}-${pad3(new Date().getMilliseconds())}.log`;
    while (name <= lastArchiveName) name = bumpArchiveName(name);
    lastArchiveName = name;
    fs.renameSync(file, path.join(archiveDir, name));
    head = null;
    if (keep > 0) {
      const archives = listArchives();
      for (const stale of archives.slice(0, Math.max(0, archives.length - keep))) {
        try {
          fs.unlinkSync(stale);
        } catch {
          // 删除失败不影响写入主流程
        }
      }
    }
  }

  function maybeRotate() {
    if (maxBytes <= 0) return;
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size >= maxBytes) rotate();
  }

  /* ------------------------------ 追加 ------------------------------ */

  function append({ actor = 'anonymous', role = 'anonymous', action, target = '', meta = {}, ip = '' }) {
    // 先取链头再轮转：新文件首条记录的 prevHash 必须接续旧链头（锚点续链）
    const prev = loadHead();
    maybeRotate();
    const entry = {
      ts: nowIso(),
      actor,
      role,
      action,
      target,
      meta,
      ip,
      seq: prev ? prev.seq + 1 : 1,
      prevHash: prev ? prev.hash : AUDIT_GENESIS_HASH,
    };
    entry.hash = auditEntryHash(entry);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    head = { seq: entry.seq, hash: entry.hash };
    return entry;
  }

  /* ------------------------------ 读取 ------------------------------ */

  function parseFile(filePath) {
    const entries = [];
    let corrupt = 0;
    if (!fs.existsSync(filePath)) return { entries, corrupt };
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        corrupt += 1; // 忽略损坏行，避免审计日志导致服务不可用
      }
    }
    return { entries, corrupt };
  }

  function matchFilters(entry, { action, actor, target, from, to }) {
    if (action && entry.action !== action) return false;
    if (actor && entry.actor !== actor) return false;
    if (target) {
      const needle = target.toLowerCase();
      const haystack = String(entry.target ?? '').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (from || to) {
      const time = parseTime(entry.ts);
      if (time === null) return false;
      const fromTime = parseTime(from);
      const toTime = parseTime(to);
      if (fromTime !== null && time < fromTime) return false;
      if (toTime !== null && time > toTime) return false;
    }
    return true;
  }

  function normalizeFilters({ action = '', actor = '', target = '', from = '', to = '' } = {}) {
    return {
      action: String(action || ''),
      actor: String(actor || ''),
      target: String(target || ''),
      from: String(from || ''),
      to: String(to || ''),
    };
  }

  function read({ limit = 100, offset = 0, action = '', actor = '', target = '', from = '', to = '' } = {}) {
    const filters = normalizeFilters({ action, actor, target, from, to });
    const { entries } = parseFile(file);
    const filtered = entries.filter((entry) => matchFilters(entry, filters));
    const reversed = filtered.slice().reverse();
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.max(1, Number(limit) || 100);
    return { total: filtered.length, items: reversed.slice(start, start + take) };
  }

  /* ------------------------------ 校验 ------------------------------ */

  function verifyFile(filePath, carry) {
    // carry：上一文件末条 { hash, seq }（null = 本文件是校验起点）。seq 跨文件连续
    const reasons = [];
    let brokenAt = null;
    let entries = 0;
    let legacy = 0;
    let prev = carry;
    const label = path.relative(path.dirname(file), filePath) || path.basename(file);

    const { entries: parsed, corrupt } = parseFile(filePath);
    if (corrupt > 0) {
      reasons.push(`${label}：${corrupt} 行无法解析（疑似损坏或篡改）`);
      brokenAt ??= label;
    }
    for (const entry of parsed) {
      if (!isChained(entry)) {
        legacy += 1; // 升级前的旧格式记录，只统计不校验
        continue;
      }
      entries += 1;
      const at = `${label}:#${entry.seq}`;
      if (prev === null) {
        // 校验起点：seq / prevHash 的起点不作断言（更早的归档可能已被轮转删除）
        if (carry !== null && entry.prevHash !== carry.hash) {
          reasons.push(`${at} prevHash 与上一文件末条不衔接（归档缺失或被删？）`);
          brokenAt ??= at;
        }
      } else {
        if (entry.seq !== prev.seq + 1) {
          reasons.push(`${at} 序号错乱（应为 ${prev.seq + 1}）`);
          brokenAt ??= at;
        }
        if (entry.prevHash !== prev.hash) {
          reasons.push(`${at} prevHash 与上一条不匹配（记录被删或插入？）`);
          brokenAt ??= at;
        }
      }
      if (entry.hash !== auditEntryHash(entry)) {
        reasons.push(`${at} 内容哈希不匹配（疑似篡改）`);
        brokenAt ??= at;
      }
      prev = { hash: entry.hash, seq: entry.seq };
    }
    return { prev, reasons, brokenAt, entries, legacy, label };
  }

  function verify({ all = false } = {}) {
    const reasons = [];
    let brokenAt = null;
    let entries = 0;
    let legacy = 0;
    let prev = null;
    const files = all ? [...listArchives(), file] : [file];
    for (const filePath of files) {
      const result = verifyFile(filePath, prev);
      reasons.push(...result.reasons);
      brokenAt ??= result.brokenAt;
      entries += result.entries;
      legacy += result.legacy;
      prev = result.prev;
    }
    return {
      ok: reasons.length === 0,
      entries,
      legacy,
      headHash: prev ? prev.hash : AUDIT_GENESIS_HASH,
      brokenAt,
      files: files.length,
      reasons,
    };
  }

  /* ------------------------------ 导出 ------------------------------ */

  function csvEscape(value) {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  /**
   * 导出过滤后的全部记录（时间正序）。jsonl 每行一条完整 JSON；
   * csv 列为 ts,actor,role,action,target,ip,seq,hash,meta（RFC 4180 转义）。
   */
  function exportLines({ format = 'jsonl', ...rest } = {}) {
    const filters = normalizeFilters(rest);
    const { entries } = parseFile(file);
    const matched = entries.filter((entry) => matchFilters(entry, filters));
    if (format === 'csv') {
      const header = ['ts', 'actor', 'role', 'action', 'target', 'ip', 'seq', 'hash', 'meta'];
      const rows = matched.map((entry) =>
        [
          entry.ts,
          entry.actor,
          entry.role,
          entry.action,
          entry.target,
          entry.ip,
          entry.seq ?? '',
          entry.hash ?? '',
          JSON.stringify(entry.meta ?? {}),
        ]
          .map(csvEscape)
          .join(','),
      );
      return { contentType: 'text/csv; charset=utf-8', body: `${[header.join(','), ...rows].join('\r\n')}\r\n` };
    }
    return {
      contentType: 'application/x-ndjson; charset=utf-8',
      body: matched.map((entry) => JSON.stringify(entry)).join('\n') + (matched.length ? '\n' : ''),
    };
  }

  return {
    file,
    archiveDir,
    append,
    read,
    verify,
    exportLines,
    archives: listArchives,
  };
}
