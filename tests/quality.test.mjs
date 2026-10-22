import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityOf, QUALITY_LABEL, QUALITY_LEVELS } from '../src/quality.mjs';

const version = (overrides = {}) => ({
  version: '0.1.0',
  status: 'published',
  signature: { algorithm: 'ed25519', signature: 'sig', keyId: 'k1' },
  publisherSignature: null,
  review: { decision: 'approve', reviewer: 'reviewer', auto: false },
  scan: { summary: { high: 0, medium: 0, low: 0, total: 0 } },
  ...overrides,
});

test('质量分级：待审核版本为社区级', () => {
  const quality = qualityOf(version({ status: 'pending', signature: null, review: null }));
  assert.equal(quality.level, 'community');
  assert.equal(quality.label, QUALITY_LABEL.community);
  assert.deepEqual(QUALITY_LEVELS, ['community', 'verified', 'official']);
});

test('质量分级：平台签名 + 人工审核 + 无高危 → 已验证', () => {
  const quality = qualityOf(version());
  assert.equal(quality.level, 'verified');
  assert.equal(quality.checks.signed, true);
  assert.equal(quality.checks.publisherSigned, false);
});

test('质量分级：人工审核 + 发布者签名 + 无高危/中危 → 官方', () => {
  const quality = qualityOf(version({ publisherSignature: { signature: 'psig' } }));
  assert.equal(quality.level, 'official');
  assert.equal(quality.checks.humanReview, true);
  assert.equal(quality.checks.scanClean, true);
});

test('质量分级：自动审批不加分；中危或高危阻止晋级', () => {
  assert.equal(
    qualityOf(version({ publisherSignature: { signature: 'psig' }, review: { decision: 'approve', auto: true } })).level,
    'verified',
  );
  assert.equal(
    qualityOf(version({ publisherSignature: { signature: 'psig' }, scan: { summary: { high: 0, medium: 1, low: 0 } } })).level,
    'verified',
  );
  assert.equal(
    qualityOf(version({ publisherSignature: { signature: 'psig' }, scan: { summary: { high: 1, medium: 0, low: 0 } } })).level,
    'community',
  );
});

test('质量分级：缺字段的安全兜底', () => {
  assert.equal(qualityOf().level, 'community');
  assert.equal(qualityOf({ scan: null, review: null }).label, '社区');
});
