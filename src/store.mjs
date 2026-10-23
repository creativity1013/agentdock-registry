import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  writeJsonAtomic,
  writeFileAtomic,
  nowIso,
  sha256,
  compareVersions,
  editDistanceLE,
} from './util.mjs';
import { createBackend } from './backend.mjs';
import { KINDS, KIND_LABEL, isValidName, computeContentHash } from './bundle.mjs';
import { describeBundle } from './validate.mjs';
import { analyzeInput } from './pipeline.mjs';
import { scanChanges, scanVerdict } from './scan.mjs';
import { diffLines } from './diff.mjs';
import { llmEnabled, reviewWithLLM } from './llmreview.mjs';
import { ensureDataLayout } from './config.mjs';
import { badRequest, conflict, notFound, unprocessable } from './errors.mjs';
import {
  loadOrCreateSigningKey,
  signVersion,
  verifyVersionSignature,
  publisherSignaturePayload,
  verifyDetachedSignature,
  keyIdFor,
} from './signing.mjs';
import { buildSbom } from './sbom.mjs';
import { evaluateAutoApproval, policyFor, setPolicyFor } from './policy.mjs';
import { qualityOf } from './quality.mjs';

export const VERSION_STATUSES = ['pending', 'published', 'rejected'];
export const VERSION_STATUS_LABEL = { pending: '待审核', published: '已发布', rejected: '已拒绝' };

const MAX_REVIEW_NOTE = 2000;

/**
 * 元数据 + 包文件存储。db.json 只放元数据，能力包内容落盘到 data/packages/<kind>/<name>/<version>/files。
 * 所有版本内容不可变；唯一例外是被拒绝的版本允许重新提交覆盖。
 */
export function createStore(config, { audit, users, transparency, notifier } = {}) {
  ensureDataLayout(config);
  const dbFile = config.files.db;
  const packagesDir = config.files.packages;
  const backend = createBackend(config);
  const db = backend.load();

  let signingKey = null;
  let policies = { schema: 'agentdock-policy@1', tenants: {} };

  /** 设置多租户策略容器（由 app 启动/更新策略时调用） */
  function setPolicies(next) {
    policies = next && typeof next === 'object' && next.tenants ? next : { schema: 'agentdock-policy@1', tenants: {} };
    return policies;
  }

  function getPolicies() {
    return policies;
  }

  /** 写入单租户策略（便捷方法，测试用） */
  function setPolicy(next, tenant = 'default') {
    policies = setPolicyFor(policies, tenant, next);
    return getPolicy(tenant);
  }

  /** 读取某租户生效策略（无租户级配置时回落到 default，再回落到内置默认） */
  function getPolicy(tenant = 'default') {
    return policyFor(policies, tenant);
  }

  /** 配额检查：发布前按租户策略中的 quota 校验 */
  function enforceQuota(tenant, pkgKey, kind, name, totalBytes) {
    const quota = getPolicy(tenant).quota;
    if (!quota) return;
    const owned = Object.values(db.packages).filter((item) => (item.tenant || 'default') === tenant);
    const pkg = db.packages[pkgKey];
    const sameTenantPkg = pkg && (pkg.tenant || 'default') === tenant;
    if (quota.maxPackages > 0 && !sameTenantPkg && owned.length >= quota.maxPackages) {
      throw unprocessable('租户能力包数量已达上限', {
        quota: 'maxPackages',
        limit: quota.maxPackages,
        current: owned.length,
      });
    }
    if (quota.maxVersionsPerPackage > 0 && sameTenantPkg) {
      const count = Object.keys(pkg.versions || {}).length;
      if (count >= quota.maxVersionsPerPackage) {
        throw unprocessable('该包版本数量已达租户上限', {
          quota: 'maxVersionsPerPackage',
          limit: quota.maxVersionsPerPackage,
          current: count,
          package: `${kind}/${name}`,
        });
      }
    }
    if (quota.maxStorageBytes > 0) {
      const used = owned.reduce(
        (sum, item) =>
          sum + Object.values(item.versions || {}).reduce((inner, version) => inner + (version.totalBytes || 0), 0),
        0,
      );
      if (used + totalBytes > quota.maxStorageBytes) {
        throw unprocessable('租户存储配额不足', {
          quota: 'maxStorageBytes',
          limit: quota.maxStorageBytes,
          current: used,
          requested: totalBytes,
        });
      }
    }
  }

  const getSigningKey = () => {
    if (!signingKey) signingKey = loadOrCreateSigningKey(config);
    return signingKey;
  };

  const persistPackage = (pkgKey, pkg) => backend.savePackage(pkgKey, pkg);
  const persistVersion = (kind, name, versionDoc) => backend.saveVersion(`${kind}/${name}`, versionDoc);
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

  /**
   * 发布者内容签名（可选）：带 publisherSignature 时校验，并支持 TOFU 注册公钥。
   * 返回写入 versionDoc.publisherSignature 的记录；未附带签名时返回 null。
   */
  function verifyPublisherSignature({ input, bundle, actorId, actor }) {
    const attachment = input?.publisherSignature;
    if (!attachment || typeof attachment !== 'object') return null;
    if (!users) throw unprocessable('服务端未启用发布者密钥管理');
    const signature = typeof attachment.signature === 'string' ? attachment.signature.trim() : '';
    if (!signature) throw unprocessable('publisherSignature.signature 缺失');
    const keys = actorId ? users.keysOf(actorId) : [];
    let key = null;
    if (typeof attachment.keyId === 'string' && attachment.keyId) {
      key = keys.find((item) => item.keyId === attachment.keyId) || null;
    }
    if (!key && typeof attachment.publicKey === 'string' && attachment.publicKey.trim()) {
      const publicKeyPem = attachment.publicKey.trim();
      const keyId = keyIdFor(publicKeyPem);
      key = keys.find((item) => item.keyId === keyId) || null;
      if (!key) {
        const info = users.registerKey(actorId, {
          name: attachment.keyName || `${actor}-key`,
          publicKeyPem,
        });
        key = { keyId: info.keyId, name: info.name, publicKeyPem: info.publicKey };
      }
    }
    if (!key) {
      throw unprocessable(
        '未找到发布者公钥：请先调用 POST /api/v1/me/keys 注册密钥，或在 publisherSignature 中附带 publicKey',
      );
    }
    const payload = publisherSignaturePayload({
      kind: bundle.kind,
      name: bundle.name,
      version: bundle.version,
      contentHash: bundle.contentHash,
    });
    const result = verifyDetachedSignature({ payload, signature, publicKeyPem: key.publicKeyPem });
    if (!result.valid) {
      throw unprocessable('发布者签名校验失败', { reasons: result.reasons });
    }
    return {
      algorithm: 'ed25519',
      keyId: key.keyId,
      keyName: key.name,
      payload,
      signature,
      signedAt: nowIso(),
    };
  }

  /**
   * 供应链层检查（需要库内上下文，单包扫描覆盖不到）：
   *   1. 抢注嫌疑：与同 kind 已有包名编辑距离 ≤2 → SUP-001（中危 + 警告）
   *   2. 更新突变：相对最新已有版本的「新增内容」做定向扫描 → SUP-002
   *      （老版本干净、新版本引入高危行为是投放恶意更新的标准打法；
   *        命中高危按 high 计入阈值判定，其余以中危提示人工比对 diff）
   */
  function supplyChainReview(bundle, pkg, tenant) {
    const findings = [];
    const warnings = [];

    // 1) 抢注嫌疑（短包名噪声大，只对比 ≥5 字符的名字）
    if (bundle.name.length >= 5) {
      for (const other of Object.values(db.packages)) {
        if (other.kind !== bundle.kind) continue;
        if (other.name === bundle.name) continue;
        if ((other.tenant || 'default') !== tenant) continue;
        if (other.name.length < 5) continue;
        if (editDistanceLE(other.name.toLowerCase(), bundle.name.toLowerCase(), 2)) {
          findings.push({
            ruleId: 'SUP-001',
            severity: 'medium',
            title: `包名与已有包 ${other.kind}/${other.name} 高度相似（疑似抢注）`,
            file: '-',
            line: 0,
            snippet: `${bundle.name} ≈ ${other.name}`,
          });
          warnings.push(`包名 ${bundle.name} 与已有包 ${other.name} 高度相似，请人工确认不是抢注`);
          if (findings.length >= 3) break;
        }
      }
    }

    // 2) 更新突变扫描（相对最新非 rejected 版本的新增内容）
    let diff = null;
    const latest = pkg?.versions
      ? Object.keys(pkg.versions)
          .filter((version) => pkg.versions[version].status !== 'rejected')
          .sort(compareVersions)
          .pop()
      : null;
    if (latest) {
      try {
        const oldBundle = rawBundle(bundle.kind, bundle.name, latest, tenant);
        const oldByPath = new Map(oldBundle.files.map((file) => [file.path, file]));
        const pieces = [];
        for (const file of bundle.files) {
          if (file.encoding !== 'utf8') continue;
          const text = file.buf.toString('utf8');
          const oldFile = oldByPath.get(file.path);
          if (!oldFile) {
            pieces.push({ path: file.path, text }); // 新增文件整篇
          } else if (oldFile.encoding === 'utf8' && oldFile.content !== text) {
            // 修改的文件只扫新增行
            const result = diffLines(oldFile.content, text);
            const added = result.lines.filter((line) => line.type === 'add').map((line) => line.text);
            if (added.length > 0) pieces.push({ path: file.path, text: added.join('\n') });
          }
        }
        if (pieces.length > 0) {
          const result = scanChanges(pieces);
          if (result.findings.length > 0) {
            const hasHigh = result.summary.high > 0;
            findings.push({
              ruleId: 'SUP-002',
              severity: hasHigh ? 'high' : 'medium',
              title: `相对上一版本 ${latest} 新增内容命中扫描规则（更新突变检测）`,
              file: pieces[0].path,
              line: 0,
              snippet: result.findings.map((finding) => finding.ruleId).slice(0, 6).join(', '),
            });
            warnings.push(
              `与上一版本 ${latest} 相比新增内容命中 ${result.summary.total} 条扫描规则（高危 ${result.summary.high}），请重点比对 diff`,
            );
          }
          diff = { base: latest, ...result };
        }
      } catch {
        // 旧版本文件缺失等场景跳过 diff 检查，不阻塞发布
      }
    }

    return { findings, warnings, diff };
  }

  /** 发布：校验 + 扫描通过后进入待审核队列 */
  function publish(input, { actor = 'unknown', actorId = '', role = '', ip = '', tenant = 'default' } = {}) {
    const report = analyze(input);
    if (!report.valid) {
      throw unprocessable('能力包校验未通过', { errors: report.errors, warnings: report.warnings });
    }
    const bundle = report.bundle;
    const pkgKey = keyOf(bundle.kind, bundle.name);
    let pkg = db.packages[pkgKey];
    if (pkg && (pkg.tenant || 'default') !== tenant) {
      throw conflict(`包名已被其他租户占用：${bundle.kind}/${bundle.name}`);
    }
    const existing = pkg?.versions?.[bundle.version];
    if (existing && existing.status !== 'rejected') {
      throw conflict(`版本已存在：${bundle.kind}/${bundle.name}@${bundle.version}（当前状态：${existing.status}）`);
    }
    if (existing && existing.status === 'rejected') {
      fs.rmSync(versionDir(bundle.kind, bundle.name, bundle.version), { recursive: true, force: true });
      delete pkg.versions[bundle.version];
    }

    // 供应链层：抢注 + 更新突变。发现项并入扫描结果后再做阈值判定，
    // 因此「更新引入高危」与普通高危一样会被阻断（管理员可覆盖）
    const supply = supplyChainReview(bundle, pkg, tenant);
    if (supply.findings.length > 0) {
      report.scan.findings.push(...supply.findings);
      report.scan.summary = {
        high: report.scan.summary.high + supply.findings.filter((finding) => finding.severity === 'high').length,
        medium: report.scan.summary.medium + supply.findings.filter((finding) => finding.severity === 'medium').length,
        low: report.scan.summary.low + supply.findings.filter((finding) => finding.severity === 'low').length,
        total: report.scan.summary.total + supply.findings.length,
      };
      if (supply.diff) report.scan.diff = supply.diff;
    }
    report.warnings.push(...supply.warnings);
    report.blocked = report.valid && scanVerdict(report.scan, config.scanBlock).blocked;
    if (report.blocked && !(role === 'admin' && input?.overrideScan === true)) {
      throw unprocessable('安全扫描命中高危规则，已阻止发布（管理员可带 overrideScan: true 覆盖）', {
        scan: report.scan,
        threshold: config.scanBlock,
      });
    }
    enforceQuota(tenant, pkgKey, bundle.kind, bundle.name, bundle.totalBytes);

    const publisherSignature = verifyPublisherSignature({ input, bundle, actorId, actor });

    const dir = filesDir(bundle.kind, bundle.name, bundle.version);
    ensureDir(dir);
    for (const file of bundle.files) {
      const abs = path.join(dir, file.path);
      ensureDir(path.dirname(abs));
      writeFileAtomic(abs, file.buf);
    }

    const submittedAt = nowIso();
    const sbom = buildSbom(bundle, report.manifest);
    const versionDoc = {
      version: bundle.version,
      status: 'pending',
      tenant,
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
      publisherSignature,
      sbom,
      review: null,
      installs: 0,
      overrideScan: Boolean(report.blocked),
    };
    const vdir = versionDir(bundle.kind, bundle.name, bundle.version);
    writeJsonAtomic(path.join(vdir, 'meta.json'), {
      kind: bundle.kind,
      name: bundle.name,
      ...versionDoc,
    });
    writeJsonAtomic(path.join(vdir, 'sbom.json'), sbom);

    if (!pkg) {
      pkg = {
        kind: bundle.kind,
        name: bundle.name,
        tenant,
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
    persistPackage(pkgKey, pkg);

    audit?.append({
      actor,
      role,
      action: 'package.publish',
      target: `${pkgKey}@${bundle.version}`,
      meta: { tenant: versionDoc.tenant || 'default', fileCount: versionDoc.fileCount, totalBytes: versionDoc.totalBytes, contentHash: versionDoc.contentHash, blocked: versionDoc.overrideScan, sbomDigest: versionDoc.sbom.digest },
      ip,
    });

    // 策略自动审批：满足条件的版本直接发布（仍会签名 + 写透明日志）
    let autoApproved = false;
    const tenantPolicy = getPolicy(tenant);
    if (tenantPolicy?.autoApprove?.enabled) {
      const evaluation = evaluateAutoApproval(tenantPolicy, {
        kind: bundle.kind,
        fileCount: versionDoc.fileCount,
        totalBytes: versionDoc.totalBytes,
        scan: versionDoc.scan?.summary ?? { high: 0, medium: 0, low: 0 },
        verdictBlocked: Boolean(report.blocked),
        publisher: actor,
        publisherSignature: versionDoc.publisherSignature,
        sbom: versionDoc.sbom,
      });
      if (evaluation.approve) {
        approveVersion(bundle.kind, bundle.name, versionDoc, {
          actor: 'policy',
          role: 'auto',
          ip,
          note: `自动审批：${evaluation.reasons.join('；')}`,
          auto: true,
        });
        autoApproved = true;
      } else {
        audit?.append({
          actor,
          role,
          action: 'review.auto_skipped',
          target: `${pkgKey}@${bundle.version}`,
          meta: { failed: evaluation.failed.map((item) => item.rule) },
          ip,
        });
      }
    }
    const notifyEvent = autoApproved ? 'review.auto_approved' : 'package.published';
    notifier?.emit(notifyEvent, {
      kind: bundle.kind,
      name: bundle.name,
      version: versionDoc.version,
      tenant: versionDoc.tenant || 'default',
      submittedBy: actor,
      autoApproved,
    });

    // 模型研判：仅对「有命中（低/中/高危）且进入人工审核」的 pending 版本自动触发，
    // 干净版本不送模型（省成本、无信息量）；fire-and-forget，
    // 绝不阻塞发布响应，也绝不因研判失败而影响发布结果
    if (llmEnabled(config) && !autoApproved && (report.scan.summary?.total ?? 0) > 0) {
      runLlmReview(bundle.kind, bundle.name, bundle.version, { actor: 'system', role: 'auto', ip }).catch(() => {});
    }
    return { package: summarizePackage(pkgKey, pkg), version: versionDoc, autoApproved };
  }

  /** 标记版本为已发布：签名 + 审核记录 + 透明日志 + 审计（人工与自动共用） */
  function approveVersion(kind, name, versionDoc, { actor = 'unknown', role = '', ip = '', note = '', auto = false } = {}) {
    const signature = signVersion(getSigningKey(), {
      kind,
      name,
      version: versionDoc.version,
      contentHash: versionDoc.contentHash,
    });
    versionDoc.status = 'published';
    versionDoc.review = {
      decision: 'approve',
      note: String(note || '').trim(),
      reviewer: actor,
      reviewedAt: nowIso(),
      auto,
    };
    versionDoc.signature = signature;
    persistVersion(kind, name, versionDoc);
    audit?.append({
      actor,
      role,
      action: auto ? 'review.auto_approve' : 'review.approve',
      target: `${kind}/${name}@${versionDoc.version}`,
      meta: { tenant: versionDoc.tenant || 'default', note: String(note || '').trim().slice(0, 200), keyId: signature.keyId, auto },
      ip,
    });
    transparency?.append({
      kind,
      name,
      version: versionDoc.version,
      contentHash: versionDoc.contentHash,
      publisher: versionDoc.submittedBy || '',
      platformKeyId: signature.keyId,
      publisherKeyId: versionDoc.publisherSignature?.keyId || '',
      review: { decision: 'approve', reviewer: actor, auto },
    });
    notifier?.emit(auto ? 'review.auto_approved' : 'review.approved', {
      kind,
      name,
      version: versionDoc.version,
      tenant: versionDoc.tenant || 'default',
      actor,
      autoApproved: auto,
      note: String(note || '').trim(),
    });
    return versionDoc;
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
    if (decision === 'approve') {
      return approveVersion(kind, name, versionDoc, { actor, role, ip, note });
    }
    versionDoc.status = 'rejected';
    versionDoc.review = {
      decision: 'reject',
      note: note.trim(),
      reviewer: actor,
      reviewedAt: nowIso(),
    };
    persistVersion(kind, name, versionDoc);
    audit?.append({
      actor,
      role,
      action: 'review.reject',
      target: `${kind}/${name}@${version}`,
      meta: { tenant: versionDoc.tenant || 'default', note: note.trim().slice(0, 200) },
      ip,
    });
    notifier?.emit('review.rejected', {
      kind,
      name,
      version,
      tenant: versionDoc.tenant || 'default',
      actor,
      reason: note.trim().slice(0, 500),
    });
    return versionDoc;
  }

  /** 取版本元数据（不校验发布状态） */
  function getVersion(kind, name, version, tenant = '') {
    if (!KINDS.includes(kind) || !isValidName(name)) return null;
    const pkg = db.packages[keyOf(kind, name)];
    if (pkg && tenant && (pkg.tenant || 'default') !== tenant) return null;
    return pkg?.versions?.[version] ?? null;
  }

  /** 取可安装版本：未指定版本时取最新已发布版本 */
  function requirePublished(kind, name, version, tenant = '') {
    const pkg = requirePackage(kind, name);
    if (tenant && (pkg.tenant || 'default') !== tenant) throw notFound(`包不存在：${kind}/${name}`);
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
  function bundleContent(kind, name, version, tenant = '') {
    return bundleFromVersion(kind, name, requirePublished(kind, name, version, tenant));
  }

  /** 审核 diff 用：读取任意状态的版本内容（可见性由调用方校验） */
  function rawBundle(kind, name, version, tenant = '') {
    const versionDoc = getVersion(kind, name, version, tenant);
    if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
    return bundleFromVersion(kind, name, versionDoc);
  }

  /** 单文件预览 */
  function fileContent(kind, name, version, filePath, tenant = '') {
    const versionDoc = requirePublished(kind, name, version, tenant);
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
      tenant: pkg.tenant || 'default',
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

  /** 市场列表：SQLite 后端下推到 SQL，JSON 后端在内存过滤 */
  function listPackages({ q = '', kind = '', status = 'published', includePending = false, tenant = '' } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const items = [];
    if (typeof backend.queryPackages === 'function') {
      const rows = backend.queryPackages({ q: query, kind, status, includePending, tenant });
      const grouped = new Map();
      for (const row of rows) {
        if (tenant && row.tenant && row.tenant !== tenant) continue;
        const pkgKey = `${row.kind}/${row.name}`;
        if (!grouped.has(pkgKey)) {
          grouped.set(pkgKey, {
            kind: row.kind,
            name: row.name,
            description: row.description,
            tags: safeJsonArray(row.tags),
            versions: {},
          });
        }
        if (row.payload) grouped.get(pkgKey).versions[row.version] = row.payload;
      }
      for (const [pkgKey, pkg] of grouped) {
        const item = listItemFor(pkgKey, pkg, { query, kind, status, includePending });
        if (item) items.push(item);
      }
    } else {
      for (const [pkgKey, pkg] of Object.entries(db.packages)) {
        if (tenant && (pkg.tenant || 'default') !== tenant) continue;
        const item = listItemFor(pkgKey, pkg, { query, kind, status, includePending });
        if (item) items.push(item);
      }
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { total: items.length, items };
  }

  /** 把单个包裁剪成市场列表项（两种后端共用） */
  function listItemFor(pkgKey, pkg, { query, kind, status, includePending }) {
    if (kind && pkg.kind !== kind) return null;
    const includeAll = includePending || status === 'pending' || status === 'rejected';
    const visible = Object.values(pkg.versions).filter(
      (item) => includeAll || item.status === 'published',
    );
    const matching = status ? visible.filter((item) => item.status === status) : visible;
    if (matching.length === 0) return null;
    const latest = matching.sort((a, b) => compareVersions(a.version, b.version))[matching.length - 1];
    const haystack = `${pkg.name} ${pkg.description || ''} ${(pkg.tags || []).join(' ')}`.toLowerCase();
    if (query && !haystack.includes(query)) return null;
    return {
      key: pkgKey,
      kind: pkg.kind,
      tenant: pkg.tenant || 'default',
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
      quality: qualityOf(latest),
    };
  }

  function safeJsonArray(value) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 包详情（版本列表按需过滤 pending） */
  function packageDetail(kind, name, { includePending = false, tenant = '' } = {}) {
    const pkg = requirePackage(kind, name);
    if (tenant && (pkg.tenant || 'default') !== tenant) throw notFound(`包不存在：${kind}/${name}`);
    const latest = latestPublished(pkg);
    const versions = Object.values(pkg.versions)
      .filter((item) => includePending || item.status === 'published')
      .sort((a, b) => compareVersions(b.version, a.version));
    return {
      kind: pkg.kind,
      kindLabel: KIND_LABEL[pkg.kind],
      name: pkg.name,
      tenant: pkg.tenant || 'default',
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
        quality: qualityOf(item),
      })),
    };
  }

  /**
   * 模型研判：把版本内容送给配置的 LLM 做第二次安全研判，结论写入
   * versionDoc.llmReview。**纯建议性**——不改状态、不参与阻断判定；
   * 失败（未配置/超时/输出不合法）也照常落盘为 ok:false 的记录，便于排查。
   */
  async function runLlmReview(kind, name, version, { actor = 'system', role = '', ip = '' } = {}) {
    if (!llmEnabled(config)) {
      throw unprocessable('模型研判未启用（需配置 AGENTDOCK_LLM_URL 与 AGENTDOCK_LLM_MODEL）');
    }
    const versionDoc = getVersion(kind, name, version);
    if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
    const bundle = bundleFromVersion(kind, name, versionDoc);
    const result = await reviewWithLLM(config, {
      kind,
      name,
      version: versionDoc.version,
      description: versionDoc.description,
      scan: versionDoc.scan,
      files: bundle.files,
      diffBase: versionDoc.scan?.diff?.base ?? null,
    });
    versionDoc.llmReview = result.ok
      ? { ok: true, ...result.verdict }
      : { ok: false, error: result.error, at: nowIso(), model: config.llm.model };
    persistVersion(kind, name, versionDoc);
    audit?.append({
      actor,
      role,
      action: 'llm.review',
      target: `${kind}/${name}@${versionDoc.version}`,
      meta: { risk: result.ok ? result.verdict.risk : null, findings: result.ok ? result.verdict.findings.length : 0, ok: result.ok },
      ip,
    });
    return versionDoc.llmReview;
  }

  /**
   * 删除待审核版本（支持批量）：仅 pending 可删，磁盘文件一并清除；
   * 已发布/已拒绝版本不受影响。逐条独立处理，失败的条目不影响其余。
   */
  function deletePendingVersions(entries, { actor = 'unknown', role = '', ip = '' } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw badRequest('entries 不能为空（形如 [{kind, name, version}, …]）');
    }
    const results = [];
    for (const entry of entries.slice(0, 100)) {
      const { kind, name, version } = entry || {};
      try {
        if (!KINDS.includes(kind) || !isValidName(name) || typeof version !== 'string') {
          throw badRequest(`条目不合法：${JSON.stringify(entry)}`);
        }
        const pkg = requirePackage(kind, name);
        const versionDoc = pkg.versions[version];
        if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
        if (versionDoc.status !== 'pending') {
          throw conflict(`仅待审核版本可删除（${kind}/${name}@${version} 当前：${VERSION_STATUS_LABEL[versionDoc.status]}）`);
        }
        fs.rmSync(versionDir(kind, name, version), { recursive: true, force: true });
        delete pkg.versions[version];
        persistPackage(keyOf(kind, name), pkg);
        audit?.append({
          actor,
          role,
          action: 'review.delete',
          target: `${kind}/${name}@${version}`,
          meta: { tenant: pkg.tenant || 'default', batch: entries.length > 1 },
          ip,
        });
        results.push({ kind, name, version, ok: true });
      } catch (error) {
        results.push({ kind, name, version, ok: false, error: error.message });
      }
    }
    return {
      deleted: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok),
      results,
    };
  }

  /** 审核队列（最早提交的在前） */
  function reviewQueue(tenant = '') {
    const items = [];
    for (const [pkgKey, pkg] of Object.entries(db.packages)) {
      for (const versionDoc of Object.values(pkg.versions)) {
        if (versionDoc.status !== 'pending') continue;
        if (tenant && (pkg.tenant || 'default') !== tenant) continue;
        items.push({
          key: pkgKey,
          kind: pkg.kind,
          name: pkg.name,
          tenant: pkg.tenant || 'default',
          version: versionDoc.version,
          description: versionDoc.description,
          submittedAt: versionDoc.submittedAt,
          submittedBy: versionDoc.submittedBy,
          fileCount: versionDoc.fileCount,
          totalBytes: versionDoc.totalBytes,
          scan: versionDoc.scan,
          scanSummary: versionDoc.scan?.summary ?? null,
          llmReview: versionDoc.llmReview ?? null,
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
    persistVersion(kind, name, versionDoc);
    audit?.append({
      actor,
      role: '',
      action: 'package.install',
      target: `${kind}/${name}@${versionDoc.version}`,
      meta: { target, tenant: versionDoc.tenant || 'default' },
      ip,
    });
    return versionDoc;
  }

  function stats(tenant = '') {
    if (typeof backend.queryStats === 'function') return backend.queryStats(tenant);
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
      if (tenant && (pkg.tenant || 'default') !== tenant) continue;
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

  /** 获取版本 SBOM */
  function sbom(kind, name, version, tenant = '') {
    const versionDoc = getVersion(kind, name, version, tenant);
    return versionDoc?.sbom ?? null;
  }

  return {
    dbFile,
    packagesDir,
    backend: backend.kind,
    backendInfo: () => backend.info(),
    close: () => backend.close(),
    setPolicies,
    getPolicies,
    setPolicy,
    getPolicy,
    sbom,
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
    runLlmReview,
    deletePendingVersions,
    recordInstall,
    signingKeyInfo,
    verifySignature,
    stats,
    latestPublished,
    keyOf,
    sha256,
  };
}
