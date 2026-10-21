import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso } from './util.mjs';
import { ensureDataLayout } from './config.mjs';

/**
 * 追加式审计日志（JSONL）。
 */
export function createAuditLog(config) {
  ensureDataLayout(config);
  const file = config.files.audit;
  ensureDir(path.dirname(file));

  function append({ actor = 'anonymous', role = 'anonymous', action, target = '', meta = {}, ip = '' }) {
    const entry = { ts: nowIso(), actor, role, action, target, meta, ip };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  function read({ limit = 100, offset = 0, action = '' } = {}) {
    if (!fs.existsSync(file)) return { total: 0, items: [] };
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // 忽略损坏行，避免审计日志导致服务不可用
      }
    }
    const filtered = action ? entries.filter((entry) => entry.action === action) : entries;
    const reversed = filtered.slice().reverse();
    return {
      total: filtered.length,
      items: reversed.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit)),
    };
  }

  return { file, append, read };
}
