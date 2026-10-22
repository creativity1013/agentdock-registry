/**
 * 能力质量分级（从版本元数据推导，不额外存储）：
 *   community  仅已发布
 *   verified   平台签名 + 审核通过（人工或自动）+ 无高危
 *   official   verified + 发布者签名 + 人工审核（未被策略自动放行）+ 无高危/中危
 */

export const QUALITY_LEVELS = ['community', 'verified', 'official'];
export const QUALITY_LABEL = {
  community: '社区',
  verified: '已验证',
  official: '官方',
};

export function qualityOf(versionDoc = {}) {
  const signed = Boolean(versionDoc.signature?.signature);
  const publisherSigned = Boolean(versionDoc.publisherSignature?.signature);
  const reviewed = Boolean(versionDoc.review && versionDoc.review.decision === 'approve');
  const humanReview = reviewed && !versionDoc.review?.auto;
  const scan = versionDoc.scan?.summary ?? {};
  const high = Number(scan.high || 0);
  const medium = Number(scan.medium || 0);
  const scanNoHigh = high === 0;
  const scanClean = high === 0 && medium === 0;

  let level = 'community';
  if (signed && reviewed && scanNoHigh) level = 'verified';
  if (signed && humanReview && publisherSigned && scanClean) level = 'official';

  return {
    level,
    label: QUALITY_LABEL[level],
    checks: { signed, publisherSigned, reviewed, humanReview, scanNoHigh, scanClean },
  };
}
