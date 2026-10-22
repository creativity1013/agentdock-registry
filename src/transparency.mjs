/**
 * 可验证透明日志（Transparency Log）。
 *
 * 每次「版本被批准发布」都会向 `data/transparency.log` 追加一条事件记录，
 * 记录之间用 prevHash 串成哈希链；所有记录哈希再构造成 Merkle 树，
 * 因此任何人都可以：
 *   1) 校验整条链未被篡改（GET /api/v1/transparency/verify）；
 *   2) 对某个版本生成/校验 Merkle 包含证明（GET .../proof）。
 *
 * 该日志独立于 audit.log：audit 是运维审计（含角色、IP 等内部信息），
 * transparency 是对外可复核的发布历史（不含敏感字段）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256, nowIso } from './util.mjs';

export const TRANSPARENCY_CONTEXT = 'agentdock-transparency-v1';
export const GENESIS_HASH = sha256('agentdock-transparency-genesis');

/** 单条事件哈希（固定字段顺序，避免 JSON 序列化歧义） */
export function entryHash(entry) {
  return sha256(
    JSON.stringify([
      TRANSPARENCY_CONTEXT,
      entry.seq,
      entry.at,
      entry.kind,
      entry.name,
      entry.version,
      entry.contentHash,
      entry.publisher || '',
      entry.platformKeyId || '',
      entry.publisherKeyId || '',
      entry.review || null,
      entry.prevHash,
    ]),
  );
}

/* ------------------------------ Merkle 树（RFC 6962 风格） ------------------------------ */

function leafHashOf(hexHash) {
  return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(hexHash, 'hex')]));
}

function nodeHashOf(leftHex, rightHex) {
  return sha256(Buffer.concat([Buffer.from([0x01]), Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex')]));
}

function largestPowerOfTwoLessThan(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** 由叶子节点原始哈希列表计算 Merkle 根（单叶子时返回其叶子哈希） */
export function merkleRoot(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return null;
  if (hashes.length === 1) return leafHashOf(hashes[0]);
  const k = largestPowerOfTwoLessThan(hashes.length);
  return nodeHashOf(merkleRoot(hashes.slice(0, k)), merkleRoot(hashes.slice(k)));
}

/** 生成 index 处的包含证明（自底向上） */
export function inclusionProof(hashes, index) {
  if (!Array.isArray(hashes) || index < 0 || index >= hashes.length) return null;
  if (hashes.length === 1) return [];
  const k = largestPowerOfTwoLessThan(hashes.length);
  if (index < k) {
    return [...inclusionProof(hashes.slice(0, k), index), merkleRoot(hashes.slice(k))];
  }
  return [...inclusionProof(hashes.slice(k), index - k), merkleRoot(hashes.slice(0, k))];
}

/** 校验包含证明（与 RFC 6962 2.1.2 的验证算法一致） */
export function verifyInclusionProof({ leafHash, index, size, proof, root }) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  if (!Array.isArray(proof) || typeof root !== 'string') return false;
  let fn = index;
  let sn = size - 1;
  let result = leafHashOf(leafHash);
  for (const sibling of proof) {
    if (typeof sibling !== 'string') return false;
    if ((fn & 1) === 1 || fn === sn) {
      result = nodeHashOf(sibling, result);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      result = nodeHashOf(result, sibling);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && result === root;
}

/* ------------------------------ 日志对象 ------------------------------ */

export function createTransparencyLog(config) {
  const file = config.files.transparency;
  let entries = load();

  function load() {
    if (!file || !fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const list = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && Number.isInteger(entry.seq) && typeof entry.hash === 'string') list.push(entry);
      } catch {
        // 保留可解析部分；verify() 会报告损坏位置
      }
    }
    return list;
  }

  const headHash = () => (entries.length ? entries[entries.length - 1].hash : GENESIS_HASH);

  function append({ kind, name, version, contentHash, publisher = '', platformKeyId = '', publisherKeyId = '', review = null }) {
    const entry = {
      seq: entries.length + 1,
      at: nowIso(),
      kind,
      name,
      version,
      contentHash,
      publisher,
      platformKeyId,
      publisherKeyId,
      review,
      prevHash: headHash(),
    };
    entry.hash = entryHash(entry);
    entries.push(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  function verify() {
    const reasons = [];
    let brokenAt = null;
    let prev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.seq !== i + 1) {
        reasons.push(`第 ${i + 1} 条记录序号错乱（seq=${entry.seq}）`);
        brokenAt = brokenAt ?? i + 1;
      }
      if (entry.prevHash !== prev) {
        reasons.push(`第 ${i + 1} 条记录 prevHash 与上一条不匹配`);
        brokenAt = brokenAt ?? i + 1;
      }
      const expected = entryHash(entry);
      if (entry.hash !== expected) {
        reasons.push(`第 ${i + 1} 条记录内容哈希不匹配（疑似篡改）`);
        brokenAt = brokenAt ?? i + 1;
      }
      prev = entry.hash;
    }
    return {
      ok: reasons.length === 0,
      size: entries.length,
      headHash: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
      brokenAt,
      reasons,
    };
  }

  function head() {
    const hashes = entries.map((entry) => entry.hash);
    return {
      size: entries.length,
      headHash: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
      genesisHash: GENESIS_HASH,
      merkleRoot: merkleRoot(hashes),
      lastEventAt: entries.length ? entries[entries.length - 1].at : null,
    };
  }

  function list({ limit = 50, offset = 0 } = {}) {
    const total = entries.length;
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.min(Math.max(1, Number(limit) || 50), 500);
    const items = entries
      .slice(Math.max(0, total - start - take), Math.max(0, total - start))
      .reverse();
    return { total, items };
  }

  function find(kind, name, version) {
    const index = entries.findIndex(
      (entry) => entry.kind === kind && entry.name === name && entry.version === version,
    );
    if (index === -1) return null;
    return { entry: entries[index], index };
  }

  function proof(kind, name, version) {
    const found = find(kind, name, version);
    if (!found) return null;
    const hashes = entries.map((entry) => entry.hash);
    return {
      entry: found.entry,
      index: found.index,
      size: entries.length,
      root: merkleRoot(hashes),
      proof: inclusionProof(hashes, found.index),
    };
  }

  return { file, append, verify, head, list, find, proof, get size() { return entries.length; } };
}
