import { normalizeBundle } from './bundle.mjs';
import { validateBundle, describeBundle } from './validate.mjs';
import { scanBundle, scanVerdict } from './scan.mjs';

/**
 * 能力包分析流水线：归一化 → 结构校验 → 安全扫描。
 * 纯函数，不落库；服务端发布/校验与 CLI 本地校验共用同一套逻辑。
 *
 * @returns {{valid:boolean, blocked:boolean, errors:Array, warnings:Array,
 *            scan:object|null, verdict:object|null, manifest:object|null,
 *            summary:object|null, bundle:object|null}}
 */
export function analyzeInput(input, { scanBlock = 'high' } = {}) {
  const normalized = normalizeBundle(input);
  const report = {
    valid: false,
    blocked: false,
    errors: [...normalized.errors],
    warnings: [...normalized.warnings],
    scan: null,
    verdict: null,
    manifest: null,
    summary: null,
    bundle: normalized.bundle,
  };
  if (!normalized.ok) return report;

  const validation = validateBundle(normalized.bundle);
  report.errors.push(...validation.errors);
  report.warnings.push(...validation.warnings);
  report.manifest = validation.manifest;

  const scan = scanBundle(normalized.bundle);
  const verdict = scanVerdict(scan, scanBlock);
  report.scan = scan;
  report.verdict = verdict;
  report.valid = report.errors.length === 0;
  report.blocked = report.valid && verdict.blocked;

  const bundle = normalized.bundle;
  report.summary = {
    kind: bundle.kind,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    tags: bundle.tags,
    fileCount: bundle.fileCount,
    totalBytes: bundle.totalBytes,
    contentHash: bundle.contentHash,
    manifestDescription: describeBundle(report.manifest),
  };
  return report;
}
