import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SIGNATURE_ALGORITHM,
  signaturePayload,
  keyIdFor,
  loadOrCreateSigningKey,
  signVersion,
  verifyVersionSignature,
} from '../src/signing.mjs';
import { loadConfig } from '../src/config.mjs';

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-signing-'));
  return loadConfig({}, { dataDir: path.join(root, 'data'), home: path.join(root, 'home') });
}

const sample = {
  kind: 'skill',
  name: 'demo-skill',
  version: '0.1.0',
  contentHash: 'a'.repeat(64),
};

test('签名载荷格式固定且与字段顺序绑定', () => {
  const payload = signaturePayload(sample);
  assert.equal(payload, `agentdock-v1\nskill\ndemo-skill\n0.1.0\n${'a'.repeat(64)}`);
});

test('生成签名后可用公钥验签通过', () => {
  const config = tempConfig();
  const signer = loadOrCreateSigningKey(config);
  assert.equal(signer.algorithm, SIGNATURE_ALGORITHM);
  assert.equal(signer.keyId, keyIdFor(signer.publicKeyPem));
  const signature = signVersion(signer, sample);
  assert.equal(signature.algorithm, SIGNATURE_ALGORITHM);
  assert.equal(signature.keyId, signer.keyId);
  assert.ok(signature.signature.length > 40);
  assert.ok(signature.signedAt);
  const result = verifyVersionSignature({ ...sample, signature, publicKeyPem: signer.publicKeyPem });
  assert.equal(result.valid, true, result.reasons.join('; '));
  assert.deepEqual(result.reasons, []);
});

test('载荷被篡改（版本/包名/哈希变化）验签失败', () => {
  const config = tempConfig();
  const signer = loadOrCreateSigningKey(config);
  const signature = signVersion(signer, sample);
  for (const tampered of [
    { ...sample, version: '0.2.0' },
    { ...sample, name: 'other-skill' },
    { ...sample, contentHash: 'b'.repeat(64) },
  ]) {
    const result = verifyVersionSignature({ ...tampered, signature, publicKeyPem: signer.publicKeyPem });
    assert.equal(result.valid, false);
    assert.ok(result.reasons.includes('签名载荷与版本内容不匹配'));
  }
});

test('签名内容被篡改或换了公钥都验不过', () => {
  const config = tempConfig();
  const signer = loadOrCreateSigningKey(config);
  const signature = signVersion(signer, sample);
  const badSignature = { ...signature, signature: Buffer.from('fake-signature-bytes').toString('base64') };
  assert.equal(verifyVersionSignature({ ...sample, signature: badSignature, publicKeyPem: signer.publicKeyPem }).valid, false);

  const otherConfig = tempConfig();
  const otherSigner = loadOrCreateSigningKey(otherConfig);
  const otherSig = signVersion(otherSigner, sample);
  const mismatch = verifyVersionSignature({ ...sample, signature: otherSig, publicKeyPem: signer.publicKeyPem });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.reasons.some((reason) => reason.includes('keyId')));
});

test('签名密钥落盘且重复加载保持一致', () => {
  const config = tempConfig();
  const first = loadOrCreateSigningKey(config);
  const file = config.files.signingKey;
  assert.ok(fs.existsSync(file));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.algorithm, SIGNATURE_ALGORITHM);
  assert.match(record.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.match(record.publicKeyPem, /BEGIN PUBLIC KEY/);
  const second = loadOrCreateSigningKey(config);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.publicKeyPem, first.publicKeyPem);
});

test('不同数据目录生成不同密钥', () => {
  const a = loadOrCreateSigningKey(tempConfig());
  const b = loadOrCreateSigningKey(tempConfig());
  assert.notEqual(a.keyId, b.keyId);
  assert.notEqual(a.publicKeyPem, b.publicKeyPem);
});
