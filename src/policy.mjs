/**
 * 审批策略：决定「哪些版本可以在发布时自动通过审核」。
 *
 * 默认关闭自动审批。开启后，只有同时满足白名单发布者、允许的 kind、
 * 无高危扫描、中危不超过阈值、体积/文件数上限、且带发布者签名（可选）的
 * 版本才会被自动发布；其余仍进入人工审核队列。
 *
 * 策略只影响「approve 时机」，不改变签名/透明日志/审计流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './util.mjs';

export const POLICY_SCHEMA = 'agentdock-policy@1';

const MAX_FILES_CAP = 200;
const MAX_TOTAL_BYTES_CAP = 2 * 1024 * 1024;

export class PolicyError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PolicyError';
    this.details = details;
  }
}

export function defaultPolicy() {
  return {
    schema: POLICY_SCHEMA,
    updatedAt: null,
    updatedBy: null,
    autoApprove: {
      enabled: false,
      kinds: ['skill', 'agent', 'plugin'],
      trustedPublishers: [],
      requirePublisherSignature: false,
      maxMedium: 0,
      maxFiles: 100,
      maxTotalBytes: 2 * 1024 * 1024,
    },
    // 租户配额：0 表示不限制
    quota: {
      maxPackages: 0,
      maxVersionsPerPackage: 0,
      maxStorageBytes: 0,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateKindList(value, field, errors) {
  const kinds = ['skill', 'agent', 'plugin'];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ field, message: 'kinds 必须是非空数组，取值 skill/agent/plugin' });
    return;
  }
  for (const kind of value) {
    if (!kinds.includes(kind)) errors.push({ field, message: `不支持的 kind：${String(kind)}` });
  }
}

/** 归一化/校验完整策略（未知键忽略，类型错误抛 PolicyError） */
export function normalizePolicy(input, base = defaultPolicy()) {
  if (!isPlainObject(input)) throw new PolicyError('策略必须是对象', [{ field: '', message: '需为 JSON 对象' }]);
  const errors = [];
  const autos = isPlainObject(input.autoApprove) ? input.autoApprove : {};
  const baseAuto = base.autoApprove;
  const auto = {
    enabled: autos.enabled === undefined ? baseAuto.enabled : autos.enabled,
    kinds: autos.kinds === undefined ? [...baseAuto.kinds] : autos.kinds,
    trustedPublishers: autos.trustedPublishers === undefined ? [...baseAuto.trustedPublishers] : autos.trustedPublishers,
    requirePublisherSignature:
      autos.requirePublisherSignature === undefined ? baseAuto.requirePublisherSignature : autos.requirePublisherSignature,
    maxMedium: autos.maxMedium === undefined ? baseAuto.maxMedium : autos.maxMedium,
    maxFiles: autos.maxFiles === undefined ? baseAuto.maxFiles : autos.maxFiles,
    maxTotalBytes: autos.maxTotalBytes === undefined ? baseAuto.maxTotalBytes : autos.maxTotalBytes,
  };
  if (typeof auto.enabled !== 'boolean') errors.push({ field: 'autoApprove.enabled', message: '必须是布尔值' });
  validateKindList(auto.kinds, 'autoApprove.kinds', errors);
  if (!Array.isArray(auto.trustedPublishers)) {
    errors.push({ field: 'autoApprove.trustedPublishers', message: '必须是字符串数组' });
  } else {
    auto.trustedPublishers = auto.trustedPublishers.map((name) => String(name).trim()).filter(Boolean);
  }
  if (typeof auto.requirePublisherSignature !== 'boolean') {
    errors.push({ field: 'autoApprove.requirePublisherSignature', message: '必须是布尔值' });
  }
  if (!Number.isInteger(auto.maxMedium) || auto.maxMedium < 0) {
    errors.push({ field: 'autoApprove.maxMedium', message: '必须是非负整数' });
  }
  if (!Number.isInteger(auto.maxFiles) || auto.maxFiles < 1 || auto.maxFiles > MAX_FILES_CAP) {
    errors.push({ field: 'autoApprove.maxFiles', message: `必须是 1..${MAX_FILES_CAP} 的整数` });
  }
  if (!Number.isInteger(auto.maxTotalBytes) || auto.maxTotalBytes < 1 || auto.maxTotalBytes > MAX_TOTAL_BYTES_CAP) {
    errors.push({ field: 'autoApprove.maxTotalBytes', message: `必须是 1..${MAX_TOTAL_BYTES_CAP} 的整数` });
  }
  const baseQuota = base.quota || { maxPackages: 0, maxVersionsPerPackage: 0, maxStorageBytes: 0 };
  const quotas = isPlainObject(input.quota) ? input.quota : {};
  const quota = {
    maxPackages: quotas.maxPackages === undefined ? baseQuota.maxPackages : quotas.maxPackages,
    maxVersionsPerPackage:
      quotas.maxVersionsPerPackage === undefined ? baseQuota.maxVersionsPerPackage : quotas.maxVersionsPerPackage,
    maxStorageBytes: quotas.maxStorageBytes === undefined ? baseQuota.maxStorageBytes : quotas.maxStorageBytes,
  };
  for (const key of ['maxPackages', 'maxVersionsPerPackage', 'maxStorageBytes']) {
    if (!Number.isInteger(quota[key]) || quota[key] < 0) {
      errors.push({ field: `quota.${key}`, message: '必须是非负整数（0 表示不限制）' });
    }
  }
  if (errors.length > 0) throw new PolicyError('策略校验未通过', errors);
  return {
    schema: POLICY_SCHEMA,
    updatedAt: input.updatedAt ?? base.updatedAt ?? null,
    updatedBy: input.updatedBy ?? base.updatedBy ?? null,
    autoApprove: auto,
    quota,
  };
}

/**
 * 判断某次发布是否可以自动通过。
 * @param {object} policy normalizePolicy 产物
 * @param {{kind:string,fileCount:number,totalBytes:number,scan?:{high:number,medium:number,low:number},verdictBlocked?:boolean,publisher?:string,publisherSignature?:object|null,sbom?:object|null}} ctx
 * @returns {{approve:boolean,reasons:string[],failed:Array<{rule:string,message:string}>}}
 */
export function evaluateAutoApproval(policy, ctx = {}) {
  const auto = policy?.autoApprove;
  const failed = [];
  const reasons = [];
  if (!auto || auto.enabled !== true) {
    return { approve: false, reasons: [], failed: [{ rule: 'disabled', message: '自动审批未启用' }] };
  }
  reasons.push('自动审批已启用');
  if (!auto.kinds.includes(ctx.kind)) failed.push({ rule: 'kind', message: `kind=${ctx.kind} 不在自动审批列表` });
  if (auto.trustedPublishers.length > 0) {
    if (!auto.trustedPublishers.includes(ctx.publisher)) {
      failed.push({ rule: 'publisher', message: `发布者「${ctx.publisher || '未知'}」不在信任列表` });
    } else {
      reasons.push(`发布者「${ctx.publisher}」在信任列表`);
    }
  }
  if (auto.requirePublisherSignature) {
    if (ctx.publisherSignature?.signature) reasons.push('已带发布者签名');
    else failed.push({ rule: 'publisherSignature', message: '策略要求发布者签名，但本次提交未签名' });
  }
  if (ctx.verdictBlocked) failed.push({ rule: 'blocked', message: '安全扫描命中阻断阈值' });
  const scan = ctx.scan || { high: 0, medium: 0, low: 0 };
  if (scan.high > 0) failed.push({ rule: 'high', message: `存在 ${scan.high} 条高危扫描发现` });
  if (scan.medium > auto.maxMedium) failed.push({ rule: 'medium', message: `中危 ${scan.medium} 条超过上限 ${auto.maxMedium}` });
  if (ctx.fileCount > auto.maxFiles) failed.push({ rule: 'maxFiles', message: `文件数 ${ctx.fileCount} 超过上限 ${auto.maxFiles}` });
  if (ctx.totalBytes > auto.maxTotalBytes) {
    failed.push({ rule: 'maxTotalBytes', message: `总体积 ${ctx.totalBytes} 超过上限 ${auto.maxTotalBytes}` });
  }
  if (!ctx.sbom) failed.push({ rule: 'sbom', message: '缺少 SBOM' });
  else reasons.push('SBOM 已生成');
  if (failed.length === 0) reasons.push(`扫描高危 0 / 中危 ${scan.medium}（≤${auto.maxMedium}）`);
  return { approve: failed.length === 0, reasons, failed };
}

/** 归一化策略文件（多租户容器）：兼容旧的单策略文件 */
export function normalizePolicyFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schema: POLICY_SCHEMA, tenants: {} };
  if (raw.tenants && typeof raw.tenants === 'object' && !Array.isArray(raw.tenants)) {
    const tenants = {};
    for (const [name, policy] of Object.entries(raw.tenants)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) continue;
      tenants[name] = normalizePolicy(policy);
    }
    return { schema: POLICY_SCHEMA, tenants };
  }
  // 旧格式：整个文件就是一个策略，归入 default 租户
  return { schema: POLICY_SCHEMA, tenants: { default: normalizePolicy(raw) } };
}

/** 取某租户生效的策略（无租户级配置时回落到 default） */
export function policyFor(policyFile, tenant = 'default') {
  const tenants = policyFile?.tenants || {};
  return tenants[tenant] || tenants.default || defaultPolicy();
}

/** 写入某租户策略，返回新的策略文件对象 */
export function setPolicyFor(policyFile, tenant, policy) {
  const tenants = { ...(policyFile?.tenants || {}) };
  tenants[tenant] = normalizePolicy(policy);
  return { schema: POLICY_SCHEMA, tenants };
}

/** 读取策略文件；不存在返回空容器（按需回落到 defaultPolicy） */
export function loadPolicy(config) {
  const file = config?.files?.policy;
  if (!file || !fs.existsSync(file)) {
    return { policies: { schema: POLICY_SCHEMA, tenants: {} }, source: 'default', file: file ?? null };
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { policies: normalizePolicyFile(raw), source: 'file', file };
}

/** 写入策略文件（原子替换） */
export function savePolicy(config, policies) {
  const file = config.files.policy;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, policies);
  return file;
}
