import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
  nowIso,
  sha256,
  compareVersions,
} from './util.mjs';
import { KINDS, KIND_LABEL, isValidName, computeContentHash } from './bundle.mjs';
import { describeBundle } from './validate.mjs';
import { analyzeInput } from './pipeline.mjs';
import { ensureDataLayout } from './config.mjs';
import { badRequest, conflict, notFound, unprocessable } from './errors.mjs';
import { loadOrCreateSigningKey, signVersion, verifyVersionSignature } from './signing.mjs';

export const VERSION_STATUSES = ['pending', 'published', 'rejected'];
export const VERSION_STATUS_LABEL = { pending: '待审核', published: '已发布', rejected: '已拒绝' };

const MAX_REVIEW_NOTE = 2000;

/**
 * 元数据 + 包文件存储。db.json 只放元数据，能力包内容落盘到 data/packages/<kind>/<name>/<version>/files。
 * 所有版本内容不可变；唯一例外是被拒绝的版本允许重新提交覆盖。
 */
export function createStore(config, { audit } = {}) {
  ensureDataLayout(config);
  const dbFile = config.files.db;
  const packagesDir = config.files.packages;

  let db = null;
  if (fs.existsSync(dbFile)) db = readJson(dbFile);
  if (!db || typeof db !== 'object' || !db.packages || typeof db.packages !== 'object') {
    db = { schemaVersion: 1, packages: {} };
  }

  let signingKey = null;
  const getSigningKey = () => {
    if (!signingKey) signingKey = loadOrCreateSigningKey(config);
    return signingKey;
  };

  const persist = () => writeJsonAtomic(dbFile, db);
  const keyOf = (kind, name) => `${kind}/${name}`;
  const versionDir = (kind, name, version) => path.join(packagesDir, kind, name, version);
  const filesDir = (kind, name, version) => path.join(versionDir(kind, name, version), 'files');

  function assertKind(kind) {
    if (!KINDS.includes(kind)) throw badRequest(`kind 必须是 ${KINDS.join(' / ')} 之一`);
  }

  function requirePackage(kind, name) {
    assertKind(kind);
    if (!isValidName(name)) throw notFound('包名不合法');
    const pkg = db.packages[keyOf(kind, name)];
    if (!pkg) throw notFound(`包不存在：${kind}/${name}`);
    return pkg;
  }

  function latestPublished(pkg) {
    const published = Object.values(pkg.versions).filter((item) => item.status === 'published');
    if (published.length === 0) return null;
    return published.sort((a, b) => compareVersions(a.version, b.version))[published.length - 1];
  }

  function totalInstalls(pkg) {
    return Object.values(pkg.versions).reduce((sum, item) => sum + (item.installs || 0), 0);
  }

  /** 归一化 + 结构校验 + 安全扫描，不落库 */
  function analyze(input) {
    return analyzeInput(input, { scanBlock: config.scanBlock });
  }

  /** 发布：校验 + 扫描通过后进入待审核队列 */
  function publish(input, { actor = 'unknown', role = '', ip = '' } = {}) {
    const report = analyze(input);
    if (!report.valid) {
      throw unprocessable('能力包校验未通过', { errors: report.errors, warnings: report.warnings });
    }
    if (report.blocked && !(role === 'admin' && input?.overrideScan === true)) {
      throw unprocessable('安全扫描命中高危规则，已阻止发布（管理员可带 overrideScan: true 覆盖）', {
        scan: report.scan,
        threshold: config.scanBlock,
      });
    }
    const bundle = report.bundle;
    const pkgKey = keyOf(bundle.kind, bundle.name);
    let pkg = db.packages[pkgKey];
    const existing = pkg?.versions?.[bundle.version];
    if (existing && existing.status !== 'rejected') {
      throw conflict(`版本已存在：${bundle.kind}/${bundle.name}@${bundle.version}（当前状态：${existing.status}）`);
    }
    if (existing && existing.status === 'rejected') {
      fs.rmSync(versionDir(bundle.kind, bundle.name, bundle.version), { recursive: true, force: true });
      delete pkg.versions[bundle.version];
    }

    const dir = filesDir(bundle.kind, bundle.name, bundle.version);
    ensureDir(dir);
    for (const file of bundle.files) {
      const abs = path.join(dir, file.path);
      ensureDir(path.dirname(abs));
      writeFileAtomic(abs, file.buf);
    }

    const submittedAt = nowIso();
    const versionDoc = {
      version: bundle.version,
      status: 'pending',
      description: bundle.description,
      tags: bundle.tags,
      contentHash: bundle.contentHash,
      fileCount: bundle.fileCount,
      totalBytes: bundle.totalBytes,
      files: bundle.manifestFiles,
      manifest: report.manifest,
      scan: report.scan,
      submittedAt,
      submittedBy: actor,
      review: null,
      installs: 0,
      overrideScan: Boolean(report.blocked),
    };
    writeJsonAtomic(path.join(versionDir(bundle.kind, bundle.name, bundle.version), 'meta.json'), {
      kind: bundle.kind,
      name: bundle.name,
      ...versionDoc,
    });

    if (!pkg) {
      pkg = {
        kind: bundle.kind,
        name: bundle.name,
        description: bundle.description,
        tags: bundle.tags,
        createdAt: submittedAt,
        createdBy: actor,
        versions: {},
      };
      db.packages[pkgKey] = pkg;
    }
    if (bundle.description) pkg.description = bundle.description;
    if (bundle.tags.length > 0) pkg.tags = bundle.tags;
    pkg.updatedAt = submittedAt;
    pkg.versions[bundle.version] = versionDoc;
    persist();

    audit?.append({
      actor,
      role,
      action: 'package.publish',
      target: `${pkgKey}@${bundle.version}`,
      meta: { fileCount: versionDoc.fileCount, totalBytes: versionDoc.totalBytes, contentHash: versionDoc.contentHash, blocked: versionDoc.overrideScan },
      ip,
    });
    return { package: summarizePackage(pkgKey, pkg), version: versionDoc };
  }

  /** 审核：approve → published；reject → rejected */
  function review(kind, name, version, { decision, note = '', actor = 'unknown', role = '', ip = '' } = {}) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw badRequest('decision 必须是 approve 或 reject');
    }
    if (typeof note !== 'string' || note.length > MAX_REVIEW_NOTE) {
      throw badRequest(`note 必须是不超过 ${MAX_REVIEW_NOTE} 字符的字符串`);
    }
    const pkg = requirePackage(kind, name);
    const versionDoc = pkg.versions[version];
    if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
    if (versionDoc.status !== 'pending') {
      throw conflict(`该版本当前状态为「${VERSION_STATUS_LABEL[versionDoc.status]}」，不能重复审核`);
    }
    const signature =
      decision === 'approve'
        ? signVersion(getSigningKey(), {
            kind,
            name,
            version: versionDoc.version,
            contentHash: versionDoc.contentHash,
          })
        : null;
    versionDoc.status = decision === 'approve' ? 'published' : 'rejected';
    versionDoc.review = {
      decision,
      note: note.trim(),
      reviewer: actor,
      reviewedAt: nowIso(),
    };
    if (signature) versionDoc.signature = signature;
    persist();
    audit?.append({
      actor,
      role,
      action: decision === 'approve' ? 'review.approve' : 'review.reject',
      target: `${kind}/${name}@${version}`,
      meta: { note: note.trim().slice(0, 200), ...(signature ? { keyId: signature.keyId } : {}) },
      ip,
    });
    return versionDoc;
  }

  /** 取版本元数据（不校验发布状态） */
  function getVersion(kind, name, version) {
    if (!KINDS.includes(kind) || !isValidName(name)) return null;
    const pkg = db.packages[keyOf(kind, name)];
    return pkg?.versions?.[version] ?? null;
  }

  /** 取可安装版本：未指定版本时取最新已发布版本 */
  function requirePublished(kind, name, version) {
    const pkg = requirePackage(kind, name);
    let versionDoc;
    if (version) {
      versionDoc = pkg.versions[version];
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      if (versionDoc.status !== 'published') throw notFound('该版本尚未发布或未通过审核');
    } else {
      versionDoc = latestPublished(pkg);
      if (!versionDoc) throw notFound('该包还没有已发布的版本');
    }
    return versionDoc;
  }

  function bundleFromVersion(kind, name, versionDoc) {
    const base = filesDir(kind, name, versionDoc.version);
    const files = versionDoc.files.map((file) => {
      const abs = path.join(base, file.path);
      if (!fs.existsSync(abs)) throw notFound(`存储文件缺失：${file.path}`);
      const buf = fs.readFileSync(abs);
      return {
        path: file.path,
        encoding: file.encoding,
        bytes: file.bytes,
        content: file.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
      };
    });
    return {
      kind,
      name,
      version: versionDoc.version,
      description: versionDoc.description,
      tags: versionDoc.tags,
      manifest: versionDoc.manifest,
      scan: versionDoc.scan,
      submittedAt: versionDoc.submittedAt,
      contentHash: versionDoc.contentHash,
      signature: versionDoc.signature ?? null,
      files,
    };
  }

  /** 下载包内容（用于 CLI 安装） */
  function bundleContent(kind, name, version) {
    return bundleFromVersion(kind, name, requirePublished(kind, name, version));
  }

  /** 审核 diff 用：读取任意状态的版本内容（可见性由调用方校验） */
  function rawBundle(kind, name, version) {
    const versionDoc = getVersion(kind, name, version);
    if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
    return bundleFromVersion(kind, name, versionDoc);
  }

  /** 单文件预览 */
  function fileContent(kind, name, version, filePath) {
    const versionDoc = requirePublished(kind, name, version);
    const file = versionDoc.files.find((item) => item.path === filePath);
    if (!file) throw notFound(`文件不存在：${filePath}`);
    if (file.encoding !== 'utf8') throw unprocessable('二进制文件不支持在线预览');
    const abs = path.join(filesDir(kind, name, versionDoc.version), file.path);
    if (!fs.existsSync(abs)) throw notFound('存储文件缺失');
    return { path: file.path, bytes: file.bytes, content: fs.readFileSync(abs, 'utf8') };
  }

  /** 平台签名公钥信息（公开，供离线验签） */
  function signingKeyInfo() {
    const key = getSigningKey();
    return {
      algorithm: key.algorithm,
      keyId: key.keyId,
      publicKey: key.publicKeyPem,
      createdAt: key.createdAt,
    };
  }

  /**
   * 验证某个版本的平台签名：
   * 1) 重新读取磁盘文件计算 contentHash，与发布时记录比对（防篡改存储）；
   * 2) 用平台公钥验证 ed25519 签名与载荷。
   */
  function verifySignature(kind, name, version) {
    const versionDoc = getVersion(kind, name, version);
    if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
    if (!versionDoc.signature) {
      return {
        kind,
        name,
        version,
        status: versionDoc.status,
        statusLabel: VERSION_STATUS_LABEL[versionDoc.status],
        signed: false,
        valid: false,
        reasons: [
          versionDoc.status === 'published' ? '该版本没有签名记录' : `版本状态为「${VERSION_STATUS_LABEL[versionDoc.status]}」，尚未签名`,
        ],
        contentHash: versionDoc.contentHash,
      };
    }
    const base = filesDir(kind, name, versionDoc.version);
    const reasons = [];
    let diskContentHash = null;
    try {
      const manifestFiles = versionDoc.files.map((file) => {
        const abs = path.join(base, file.path);
        if (!fs.existsSync(abs)) {
          reasons.push(`存储文件缺失：${file.path}`);
          return { path: file.path, encoding: file.encoding, bytes: 0, sha256: '' };
        }
        const buf = fs.readFileSync(abs);
        return { path: file.path, encoding: file.encoding, bytes: buf.length, sha256: sha256(buf) };
      });
      diskContentHash = computeContentHash(manifestFiles);
    } catch (error) {
      reasons.push(`读取存储内容失败：${error.message}`);
    }
    if (diskContentHash && diskContentHash !== versionDoc.contentHash) {
      reasons.push('存储内容已被修改：磁盘内容哈希与发布时记录的 contentHash 不一致');
    }
    const result = verifyVersionSignature({
      kind,
      name,
      version: versionDoc.version,
      contentHash: versionDoc.contentHash,
      signature: versionDoc.signature,
      publicKeyPem: getSigningKey().publicKeyPem,
    });
    for (const reason of result.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    return {
      kind,
      name,
      version,
      status: versionDoc.status,
      statusLabel: VERSION_STATUS_LABEL[versionDoc.status],
      signed: true,
      valid: reasons.length === 0,
      reasons,
      algorithm: versionDoc.signature.algorithm,
      keyId: versionDoc.signature.keyId,
      signedAt: versionDoc.signature.signedAt,
      contentHash: versionDoc.contentHash,
      diskContentHash,
      signature: versionDoc.signature,
    };
  }

  function summarizePackage(pkgKey, pkg) {
    const latest = latestPublished(pkg);
    const versions = Object.values(pkg.versions);
    return {
      key: pkgKey,
      kind: pkg.kind,
      name: pkg.name,
      description: pkg.description,
      tags: pkg.tags || [],
      latestVersion: latest?.version ?? null,
      manifest: latest?.manifest ?? null,
      installs: totalInstalls(pkg),
      versionsCount: versions.length,
      updatedAt: pkg.updatedAt || pkg.createdAt,
    };
  }

  /** 市场列表 */
  function listPackages({ q = '', kind = '', status = 'published', includePending = false } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const items = [];
    for (const [pkgKey, pkg] of Object.entries(db.packages)) {
      if (kind && pkg.kind !== kind) continue;
      const visible = Object.values(pkg.versions).filter(
        (item) => includePending || item.status === 'published',
      );
      const matching = status ? visible.filter((item) => item.status === status) : visible;
      if (matching.length === 0) continue;
      const latest = matching.sort((a, b) => compareVersions(a.version, b.version))[matching.length - 1];
      const haystack = `${pkg.name} ${pkg.description || ''} ${(pkg.tags || []).join(' ')}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      items.push({
        key: pkgKey,
        kind: pkg.kind,
        kindLabel: KIND_LABEL[pkg.kind],
        name: pkg.name,
        description: latest.description || pkg.description,
        tags: latest.tags || pkg.tags || [],
        latestVersion: latest.version,
        status: latest.status,
        updatedAt: latest.submittedAt,
        submittedBy: latest.submittedBy,
        installs: totalInstalls(pkg),
        versionsCount: matching.length,
        fileCount: latest.fileCount,
        totalBytes: latest.totalBytes,
        manifest: latest.manifest,
        scanSummary: latest.scan?.summary ?? null,
      });
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { total: items.length, items };
  }

  /** 包详情（版本列表按需过滤 pending） */
  function packageDetail(kind, name, { includePending = false } = {}) {
    const pkg = requirePackage(kind, name);
    const latest = latestPublished(pkg);
    const versions = Object.values(pkg.versions)
      .filter((item) => includePending || item.status === 'published')
      .sort((a, b) => compareVersions(b.version, a.version));
    return {
      kind: pkg.kind,
      kindLabel: KIND_LABEL[pkg.kind],
      name: pkg.name,
      description: latest?.description || pkg.description,
      tags: latest?.tags || pkg.tags || [],
      createdAt: pkg.createdAt,
      createdBy: pkg.createdBy,
      latestVersion: latest?.version ?? null,
      manifest: latest?.manifest ?? null,
      installs: totalInstalls(pkg),
      versions: versions.map((item) => ({
        ...item,
        statusLabel: VERSION_STATUS_LABEL[item.status],
        manifestDescription: describeBundle(item.manifest),
      })),
    };
  }

  /** 审核队列（最早提交的在前） */
  function reviewQueue() {
    const items = [];
    for (const [pkgKey, pkg] of Object.entries(db.packages)) {
      for (const versionDoc of Object.values(pkg.versions)) {
        if (versionDoc.status !== 'pending') continue;
        items.push({
          key: pkgKey,
          kind: pkg.kind,
          name: pkg.name,
          version: versionDoc.version,
          description: versionDoc.description,
          submittedAt: versionDoc.submittedAt,
          submittedBy: versionDoc.submittedBy,
          fileCount: versionDoc.fileCount,
          totalBytes: versionDoc.totalBytes,
          scan: versionDoc.scan,
          scanSummary: versionDoc.scan?.summary ?? null,
          manifest: versionDoc.manifest,
          manifestDescription: describeBundle(versionDoc.manifest),
        });
      }
    }
    items.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
    return { total: items.length, items };
  }

  /** 安装计数 */
  function recordInstall(kind, name, version, { actor = 'unknown', ip = '', target = '' } = {}) {
    const versionDoc = requirePublished(kind, name, version);
    versionDoc.installs = (versionDoc.installs || 0) + 1;
    persist();
    audit?.append({
      actor,
      role: '',
      action: 'package.install',
      target: `${kind}/${name}@${versionDoc.version}`,
      meta: { target },
      ip,
    });
    return versionDoc;
  }

  function stats() {
    const result = {
      packages: 0,
      versions: 0,
      pending: 0,
      published: 0,
      rejected: 0,
      installs: 0,
      byKind: { skill: 0, agent: 0, plugin: 0 },
    };
    for (const pkg of Object.values(db.packages)) {
      result.packages += 1;
      result.byKind[pkg.kind] = (result.byKind[pkg.kind] || 0) + 1;
      result.installs += totalInstalls(pkg);
      for (const versionDoc of Object.values(pkg.versions)) {
        result.versions += 1;
        result[versionDoc.status] = (result[versionDoc.status] || 0) + 1;
      }
    }
    return result;
  }

  return {
    dbFile,
    packagesDir,
    analyze,
    publish,
    review,
    getVersion,
    requirePublished,
    bundleContent,
    rawBundle,
    fileContent,
    listPackages,
    packageDetail,
    reviewQueue,
    recordInstall,
    signingKeyInfo,
    verifySignature,
    stats,
    latestPublished,
    keyOf,
    sha256,
  };
}
