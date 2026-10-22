import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureDir, readJson, nowIso } from './util.mjs';

/**
 * 可选的 SQLite 元数据后端（Node 内置 node:sqlite，无第三方依赖）。
 *
 * 设计：关系表只存「可查询的键 + 完整版本 JSON payload」——
 *   packages(kind, name, description, tags, created_at, created_by, updated_at)
 *   versions(kind, name, version, status, payload JSON)
 * 这样列表/详情/按状态查询都能走 SQL，新增字段又不需要迁移版本表（payload 向前兼容）。
 * 包内容仍然落在 data/packages/<kind>/<name>/<version>/files，与 JSON 后端一致。
 *
 * node:sqlite 在 Node 24 可用（仍标记 experimental；首次打开会打印一条警告），
 * Node 20/22 上会回落为「不可用」，仅当显式配置 backend=sqlite 时才报错。
 */

const require = createRequire(import.meta.url);

export const SQLITE_BACKEND = 'sqlite';
export const SQLITE_SCHEMA_VERSION = 1;

let cachedModule;
let moduleError;

function loadSqliteModule() {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = require('node:sqlite');
    moduleError = null;
  } catch (error) {
    cachedModule = null;
    moduleError = error;
  }
  return cachedModule;
}

/** 当前 Node 是否提供 node:sqlite（Node 24+ 或启用 --experimental-sqlite） */
export function sqliteAvailable() {
  return Boolean(loadSqliteModule());
}

export function sqliteUnavailableReason() {
  loadSqliteModule();
  return moduleError ? moduleError.message : '';
}

function openDatabase(file) {
  const sqlite = loadSqliteModule();
  if (!sqlite) {
    throw new Error(
      `当前 Node 不支持 node:sqlite（${sqliteUnavailableReason()}）；` +
        'SQLite 后端需要 Node 24+（或使用 --experimental-sqlite 启动）',
    );
  }
  ensureDir(path.dirname(file));
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS packages (
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      tenant TEXT NOT NULL DEFAULT 'default',
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      created_by TEXT,
      updated_at TEXT,
      PRIMARY KEY (kind, name)
    );
    CREATE TABLE IF NOT EXISTS versions (
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (kind, name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_versions_status ON versions (status);
  `);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SQLITE_SCHEMA_VERSION),
  );
  return db;
}

/**
 * @param {{files: {sqlite: string, db: string}}} config
 */
export function createSqliteBackend(config) {
  const file = config.files.sqlite;
  const db = openDatabase(file);
  const state = { schemaVersion: SQLITE_SCHEMA_VERSION, packages: {} };
  let closed = false;
  let migratedFromDbJson = false;

  // 旧库迁移：补 tenant 列（v0.1 之前没有多租户）
  const packageColumns = db.prepare('PRAGMA table_info(packages)').all().map((row) => row.name);
  if (!packageColumns.includes('tenant')) {
    db.exec("ALTER TABLE packages ADD COLUMN tenant TEXT NOT NULL DEFAULT 'default'");
  }

  const insertPackage = db.prepare(`
    INSERT INTO packages (kind, name, tenant, description, tags, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (kind, name) DO UPDATE SET
      tenant = excluded.tenant,
      description = excluded.description,
      tags = excluded.tags,
      updated_at = excluded.updated_at
  `);
  const selectVersions = db.prepare('SELECT version FROM versions WHERE kind = ? AND name = ?');
  const deleteVersion = db.prepare('DELETE FROM versions WHERE kind = ? AND name = ? AND version = ?');
  const upsertVersion = db.prepare(`
    INSERT INTO versions (kind, name, version, status, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, name, version) DO UPDATE SET
      status = excluded.status,
      payload = excluded.payload
  `);
  const selectAllVersions = db.prepare('SELECT kind, name, payload FROM versions');

  const parseTags = (raw) => {
    try {
      const tags = JSON.parse(raw || '[]');
      return Array.isArray(tags) ? tags : [];
    } catch {
      return [];
    }
  };

  function insertVersion(kind, name, versionDoc) {
    upsertVersion.run(kind, name, versionDoc.version, versionDoc.status || 'pending', JSON.stringify(versionDoc));
  }

  function migrateFromJsonIfEmpty() {
    const count = db.prepare('SELECT COUNT(*) AS total FROM packages').get();
    if (Number(count.total) > 0) return null;
    if (!fs.existsSync(config.files.db)) return null;
    const legacy = readJson(config.files.db, null);
    if (!legacy || typeof legacy !== 'object' || !legacy.packages) return null;
    db.exec('BEGIN');
    try {
      for (const [pkgKey, pkg] of Object.entries(legacy.packages)) {
        insertPackage.run(
          pkg.kind,
          pkg.name,
          pkg.tenant ?? 'default',
          pkg.description ?? '',
          JSON.stringify(pkg.tags ?? []),
          pkg.createdAt ?? '',
          pkg.createdBy ?? '',
          pkg.updatedAt ?? '',
        );
        for (const versionDoc of Object.values(pkg.versions ?? {})) insertVersion(pkg.kind, pkg.name, versionDoc);
        state.packages[pkgKey] = normalizedPackage(pkgKey, pkg);
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated_from', 'db.json');
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated_at', nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return legacy;
  }

  function normalizedPackage(pkgKey, pkg) {
    return {
      kind: pkg.kind,
      name: pkg.name,
      tenant: pkg.tenant ?? 'default',
      description: pkg.description ?? '',
      tags: Array.isArray(pkg.tags) ? pkg.tags : [],
      createdAt: pkg.createdAt ?? '',
      createdBy: pkg.createdBy ?? '',
      updatedAt: pkg.updatedAt ?? '',
      versions: { ...(pkg.versions ?? {}) },
    };
  }

  function load() {
    const migrated = migrateFromJsonIfEmpty();
    migratedFromDbJson = Boolean(migrated);
    state.packages = {};
    const packageRows = db
      .prepare('SELECT kind, name, tenant, description, tags, created_at, created_by, updated_at FROM packages')
      .all();
    for (const row of packageRows) {
      state.packages[`${row.kind}/${row.name}`] = {
        kind: row.kind,
        name: row.name,
        tenant: row.tenant ?? 'default',
        description: row.description ?? '',
        tags: parseTags(row.tags),
        createdAt: row.created_at ?? '',
        createdBy: row.created_by ?? '',
        updatedAt: row.updated_at ?? '',
        versions: {},
      };
    }
    for (const row of selectAllVersions.all()) {
      const versionDoc = JSON.parse(row.payload);
      const key = `${row.kind}/${row.name}`;
      const pkg = (state.packages[key] ||= {
        kind: row.kind,
        name: row.name,
        description: '',
        tags: [],
        createdAt: '',
        createdBy: '',
        updatedAt: '',
        versions: {},
      });
      pkg.versions[versionDoc.version] = versionDoc;
    }
    return state;
  }

  function savePackage(pkgKey, pkg) {
    db.exec('BEGIN');
    try {
      insertPackage.run(
        pkg.kind,
        pkg.name,
        pkg.tenant ?? 'default',
        pkg.description ?? '',
        JSON.stringify(pkg.tags ?? []),
        pkg.createdAt ?? '',
        pkg.createdBy ?? '',
        pkg.updatedAt ?? '',
      );
      const keep = new Set();
      for (const versionDoc of Object.values(pkg.versions ?? {})) {
        insertVersion(pkg.kind, pkg.name, versionDoc);
        keep.add(versionDoc.version);
      }
      for (const row of selectVersions.all(pkg.kind, pkg.name)) {
        if (!keep.has(row.version)) deleteVersion.run(pkg.kind, pkg.name, row.version);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function saveVersion(pkgKey, versionDoc) {
    const [kind, name] = pkgKey.split('/');
    upsertVersion.run(kind, name, versionDoc.version, versionDoc.status || 'pending', JSON.stringify(versionDoc));
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* 关闭前 checkpoint 失败不阻塞退出 */
    }
    db.close();
  }

  function info() {
    return {
      kind: SQLITE_BACKEND,
      file,
      sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
      migratedFromDbJson:
        migratedFromDbJson || Boolean(db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_from')),
    };
  }

  /** 列表查询下推：过滤在 SQL 完成，版本 semver 排序在调用方用 JS 处理 */
  function queryPackages({ q = '', kind = '', status = 'published', includePending = false, tenant = '' } = {}) {
    const clauses = [];
    const params = [];
    if (tenant) {
      clauses.push('p.tenant = ?');
      params.push(tenant);
    }
    if (kind) {
      clauses.push('p.kind = ?');
      params.push(kind);
    }
    if (status) {
      clauses.push('v.status = ?');
      params.push(status);
    } else if (!includePending) {
      clauses.push("v.status = 'published'");
    } else {
      clauses.push("v.status <> 'rejected'");
    }
    const query = String(q || '').trim().toLowerCase();
    if (query) {
      clauses.push(
        "lower(p.name || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.tags, '[]')) LIKE ?",
      );
      params.push(`%${query}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT p.kind, p.name, p.tenant, p.description, p.tags, v.version, v.status, v.payload
           FROM packages p
           JOIN versions v ON v.kind = p.kind AND v.name = p.name
           ${where}
           ORDER BY p.kind, p.name`,
      )
      .all(...params);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /** 统计下推：计数与安装量由 SQL 聚合 */
  function queryStats(tenant = '') {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n || 0);
    const hasTenant = Boolean(tenant);
    const where = hasTenant ? ' WHERE tenant = ?' : '';
    const args = hasTenant ? [tenant] : [];
    const versionFrom = hasTenant
      ? ' FROM versions v JOIN packages p ON p.kind = v.kind AND p.name = v.name WHERE p.tenant = ?'
      : ' FROM versions v';
    const result = {
      packages: count(`SELECT COUNT(*) AS n FROM packages${where}`, ...args),
      versions: count(`SELECT COUNT(*) AS n${versionFrom}`, ...args),
      pending: 0,
      published: 0,
      rejected: 0,
      installs: count(
        `SELECT COALESCE(SUM(json_extract(v.payload, '$.installs')), 0) AS n${versionFrom}`,
        ...args,
      ),
      byKind: { skill: 0, agent: 0, plugin: 0 },
    };
    for (const row of db.prepare(`SELECT v.status, COUNT(*) AS n${versionFrom} GROUP BY v.status`).all(...args)) {
      result[row.status] = (result[row.status] || 0) + Number(row.n);
    }
    for (const row of db.prepare(`SELECT kind, COUNT(*) AS n FROM packages${where} GROUP BY kind`).all(...args)) {
      result.byKind[row.kind] = (result.byKind[row.kind] || 0) + Number(row.n);
    }
    return result;
  }

  return { kind: SQLITE_BACKEND, file, load, savePackage, saveVersion, close, info, queryPackages, queryStats };
}
