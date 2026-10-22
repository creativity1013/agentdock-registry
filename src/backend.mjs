import { readJson, writeJsonAtomic } from './util.mjs';
import { createSqliteBackend, sqliteAvailable } from './sqlite.mjs';

/**
 * 元数据后端选择：json（默认，db.json 单文件）或 sqlite（data/agentdock.sqlite）。
 * 包内容始终落盘在 data/packages/...，后端只负责元数据。
 *
 * 两者暴露同一接口：
 *   load() -> state（{schemaVersion, packages}）
 *   savePackage(pkgKey, pkg)       增量写一个包（含其全部版本）
 *   saveVersion(pkgKey, versionDoc) 增量写一个版本
 *   close() / info()
 */

export const BACKEND_KINDS = ['json', 'sqlite'];

function createJsonBackend(file) {
  let state = normalizeState(readJson(file, null));

  function load() {
    state = normalizeState(state);
    return state;
  }

  return {
    kind: 'json',
    file,
    load,
    savePackage() {
      writeJsonAtomic(file, state);
    },
    saveVersion() {
      writeJsonAtomic(file, state);
    },
    close() {},
    info() {
      return { kind: 'json', file };
    },
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.packages || typeof raw.packages !== 'object') {
    return { schemaVersion: 1, packages: {} };
  }
  return raw;
}

export function createBackend(config) {
  const kind = config.store?.backend === 'sqlite' ? 'sqlite' : 'json';
  if (kind === 'sqlite') return createSqliteBackend(config);
  return createJsonBackend(config.files.db);
}

export function describeBackends(config) {
  return {
    configured: config.store?.backend === 'sqlite' ? 'sqlite' : 'json',
    available: {
      json: true,
      sqlite: sqliteAvailable(),
    },
    files: { db: config.files.db, sqlite: config.files.sqlite },
  };
}
