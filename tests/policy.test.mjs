import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPolicy,
  normalizePolicy,
  evaluateAutoApproval,
  PolicyError,
  POLICY_SCHEMA,
} from '../src/policy.mjs';

const cleanContext = {
  kind: 'skill',
  fileCount: 1,
  totalBytes: 128,
  scan: { high: 0, medium: 0, low: 0 },
  verdictBlocked: false,
  publisher: 'publisher',
  publisherSignature: { signature: 'sig' },
  sbom: { digest: 'abc' },
};

function enabledPolicy(overrides = {}) {
  return normalizePolicy({ autoApprove: { enabled: true, ...overrides } });
}

test('默认策略：关闭自动审批', () => {
  const policy = defaultPolicy();
  assert.equal(policy.schema, POLICY_SCHEMA);
  assert.equal(policy.autoApprove.enabled, false);
  const result = evaluateAutoApproval(policy, cleanContext);
  assert.equal(result.approve, false);
  assert.equal(result.failed[0].rule, 'disabled');
});

test('开启且条件全部满足时自动通过，并给出理由', () => {
  const policy = enabledPolicy({ trustedPublishers: ['publisher'] });
  const result = evaluateAutoApproval(policy, cleanContext);
  assert.equal(result.approve, true);
  assert.ok(result.reasons.some((reason) => reason.includes('publisher')));
  assert.ok(result.reasons.some((reason) => reason.includes('SBOM')));
});

test('信任发布者白名单不匹配时拒绝自动审批', () => {
  const policy = enabledPolicy({ trustedPublishers: ['ci-bot'] });
  const result = evaluateAutoApproval(policy, cleanContext);
  assert.equal(result.approve, false);
  assert.ok(result.failed.some((item) => item.rule === 'publisher'));
});

test('kind、高危、中危、体积与签名规则分别生效', () => {
  const policy = enabledPolicy({ kinds: ['plugin'], requirePublisherSignature: true, maxMedium: 1 });
  const kindBlocked = evaluateAutoApproval(policy, cleanContext);
  assert.equal(kindBlocked.approve, false);
  assert.ok(kindBlocked.failed.some((item) => item.rule === 'kind'));

  const unsigned = evaluateAutoApproval(policy, { ...cleanContext, kind: 'plugin', publisherSignature: null });
  assert.equal(unsigned.approve, false);
  assert.ok(unsigned.failed.some((item) => item.rule === 'publisherSignature'));

  const clean = evaluateAutoApproval(policy, { ...cleanContext, kind: 'plugin' });
  assert.equal(clean.approve, true);

  const highRisk = evaluateAutoApproval(policy, {
    ...cleanContext,
    kind: 'plugin',
    scan: { high: 1, medium: 0, low: 0 },
    verdictBlocked: true,
  });
  assert.equal(highRisk.approve, false);
  assert.ok(highRisk.failed.some((item) => item.rule === 'high'));
  assert.ok(highRisk.failed.some((item) => item.rule === 'blocked'));

  const tooBig = evaluateAutoApproval(policy, { ...cleanContext, kind: 'plugin', fileCount: 999 });
  assert.ok(tooBig.failed.some((item) => item.rule === 'maxFiles'));

  const noSbom = evaluateAutoApproval(policy, { ...cleanContext, kind: 'plugin', sbom: null });
  assert.ok(noSbom.failed.some((item) => item.rule === 'sbom'));
});

test('中危数量在上限内可通过，超过上限拒绝', () => {
  const policy = enabledPolicy({ maxMedium: 1 });
  assert.equal(evaluateAutoApproval(policy, { ...cleanContext, scan: { high: 0, medium: 1, low: 0 } }).approve, true);
  assert.equal(evaluateAutoApproval(policy, { ...cleanContext, scan: { high: 0, medium: 2, low: 0 } }).approve, false);
});

test('normalizePolicy：部分字段与默认值合并，非法字段抛 PolicyError', () => {
  const merged = normalizePolicy({ autoApprove: { enabled: true, maxFiles: 5 } });
  assert.equal(merged.autoApprove.enabled, true);
  assert.equal(merged.autoApprove.maxFiles, 5);
  assert.deepEqual(merged.autoApprove.kinds, ['skill', 'agent', 'plugin']);
  assert.equal(merged.autoApprove.maxTotalBytes, 2 * 1024 * 1024);

  for (const bad of [
    { autoApprove: { enabled: 'yes' } },
    { autoApprove: { kinds: ['skill', 'weird'] } },
    { autoApprove: { maxFiles: 0 } },
    { autoApprove: { maxTotalBytes: 10 * 1024 * 1024 } },
    { autoApprove: { trustedPublishers: 'alice' } },
    { autoApprove: { maxMedium: -1 } },
    'not-an-object',
  ]) {
    assert.throws(() => normalizePolicy(bad), PolicyError);
  }
});
