import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { sha256 } from '../src/util.mjs';
import {
  GENESIS_HASH,
  createTransparencyLog,
  entryHash,
  inclusionProof,
  merkleRoot,
  verifyInclusionProof,
} from '../src/transparency.mjs';

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-transparency-'));
  return loadConfig({}, { dataDir: path.join(root, 'data'), home: path.join(root, 'home') });
}

const leaf = (seed) => sha256(seed);

test('Merkle 树为任意大小/位置的叶子生成可校验包含证明', () => {
  for (let size = 1; size <= 9; size += 1) {
    const hashes = Array.from({ length: size }, (_, index) => leaf(`leaf-${size}-${index}`));
    const root = merkleRoot(hashes);
    assert.equal(typeof root, 'string');
    for (let index = 0; index < size; index += 1) {
      const proof = inclusionProof(hashes, index);
      assert.ok(Array.isArray(proof));
      assert.equal(
        verifyInclusionProof({ leafHash: hashes[index], index, size, proof, root }),
        true,
        `size=${size} index=${index} 应校验通过`,
      );
      assert.equal(
        verifyInclusionProof({ leafHash: sha256('tampered'), index, size, proof, root }),
        false,
      );
    }
    assert.equal(inclusionProof(hashes, size), null);
  }
  assert.equal(merkleRoot([]), null);
});

test('透明日志追加后哈希链自洽，且可生成包含证明', () => {
  const config = tempConfig();
  const log = createTransparencyLog(config);
  assert.equal(log.verify().ok, true);
  assert.equal(log.head().size, 0);

  const first = log.append({
    kind: 'skill',
    name: 'alpha',
    version: '0.1.0',
    contentHash: 'a'.repeat(64),
    publisher: 'alice',
    platformKeyId: 'platform-key',
    publisherKeyId: 'publisher-key',
  });
  const second = log.append({
    kind: 'agent',
    name: 'beta',
    version: '1.0.0',
    contentHash: 'b'.repeat(64),
    publisher: 'bob',
    platformKeyId: 'platform-key',
  });

  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(first.hash, entryHash(first));
  assert.equal(second.prevHash, first.hash);
  assert.equal(second.seq, 2);

  const verify = log.verify();
  assert.equal(verify.ok, true);
  assert.equal(verify.size, 2);
  assert.equal(verify.headHash, second.hash);
  assert.equal(verify.brokenAt, null);

  const head = log.head();
  assert.equal(head.size, 2);
  assert.equal(head.merkleRoot, merkleRoot([first.hash, second.hash]));
  assert.equal(head.genesisHash, GENESIS_HASH);

  const found = log.find('skill', 'alpha', '0.1.0');
  assert.equal(found.index, 0);
  const proof = log.proof('skill', 'alpha', '0.1.0');
  assert.equal(proof.size, 2);
  assert.equal(proof.entry.hash, first.hash);
  assert.equal(
    verifyInclusionProof({
      leafHash: proof.entry.hash,
      index: proof.index,
      size: proof.size,
      proof: proof.proof,
      root: proof.root,
    }),
    true,
  );

  // 最新事件在前
  assert.equal(log.list().items[0].seq, 2);
  // 从磁盘重新加载后仍一致
  const reloaded = createTransparencyLog(config);
  assert.equal(reloaded.verify().ok, true);
  assert.equal(reloaded.size, 2);
  assert.equal(reloaded.proof('agent', 'beta', '1.0.0').index, 1);
});

test('日志内容被篡改时 verify 能定位并报告', () => {
  const config = tempConfig();
  const log = createTransparencyLog(config);
  log.append({ kind: 'skill', name: 'alpha', version: '0.1.0', contentHash: 'a'.repeat(64) });
  log.append({ kind: 'skill', name: 'beta', version: '0.1.0', contentHash: 'b'.repeat(64) });

  const file = config.files.transparency;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.contentHash = 'f'.repeat(64);
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const reloaded = createTransparencyLog(config);
  const result = reloaded.verify();
  assert.equal(result.ok, false);
  assert.equal(result.size, 2);
  assert.ok(result.reasons.length > 0);
  assert.equal(result.brokenAt, 1);
});

test('未记录的版本不返回包含证明', () => {
  const config = tempConfig();
  const log = createTransparencyLog(config);
  log.append({ kind: 'skill', name: 'alpha', version: '0.1.0', contentHash: 'a'.repeat(64) });
  assert.equal(log.find('skill', 'alpha', '9.9.9'), null);
  assert.equal(log.proof('skill', 'alpha', '9.9.9'), null);
});
