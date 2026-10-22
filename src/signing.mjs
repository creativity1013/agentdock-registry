/**
 * 内容签名与验签（ed25519，Node 内置 crypto，零第三方依赖）。
 *
 * 语义：平台在版本**审核通过（published）**时，用平台私钥对
 * 「kind / name / version / contentHash」的规范化载荷签名，证明
 * 「这份经过审核的内容确实由本平台发布，且之后未被替换」。
 *
 * 私钥只存在于数据目录 `signing-key.json`（600 权限），公钥通过
 * `GET /api/v1/keys` 公开，任何人可离线验签。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, readJson, writeJsonAtomic, sha256 } from './util.mjs';

export const SIGNATURE_ALGORITHM = 'ed25519';
export const SIGNATURE_CONTEXT = 'agentdock-v1';

/** 规范化签名载荷：字段顺序固定，换行分隔，避免 JSON 序列化歧义 */
export function signaturePayload({ kind, name, version, contentHash }) {
  return [SIGNATURE_CONTEXT, kind, name, version, contentHash].join('\n');
}

/** 公钥指纹（用作 keyId），取 PEM 的 SHA-256 前 32 位十六进制 */
export function keyIdFor(publicKeyPem) {
  return sha256(publicKeyPem).slice(0, 32);
}

function keyFilePath(config) {
  return config.files?.signingKey || path.join(config.dataDir, 'signing-key.json');
}

/**
 * 加载平台签名密钥；不存在时生成并落盘（首次启动自动完成）。
 * @returns {{file:string, algorithm:string, keyId:string, publicKeyPem:string, createdAt:string,
 *            publicKey:() => crypto.KeyObject, sign:(text:string) => string}}
 */
export function loadOrCreateSigningKey(config) {
  const file = keyFilePath(config);
  let record = readJson(file, null);
  if (!record || typeof record.privateKeyPem !== 'string' || typeof record.publicKeyPem !== 'string') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(SIGNATURE_ALGORITHM);
    record = {
      algorithm: SIGNATURE_ALGORITHM,
      keyId: keyIdFor(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      createdAt: nowIso(),
    };
    ensureDir(path.dirname(file));
    writeJsonAtomic(file, record);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows 等不支持 chmod 的环境忽略
    }
  }
  return {
    file,
    algorithm: record.algorithm || SIGNATURE_ALGORITHM,
    keyId: record.keyId || keyIdFor(record.publicKeyPem),
    publicKeyPem: record.publicKeyPem,
    createdAt: record.createdAt,
    publicKey() {
      return crypto.createPublicKey(record.publicKeyPem);
    },
    sign(text) {
      const privateKey = crypto.createPrivateKey(record.privateKeyPem);
      return crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
    },
  };
}

/** 为一个版本生成签名记录（写入版本元数据） */
export function signVersion(signer, { kind, name, version, contentHash }) {
  const payload = signaturePayload({ kind, name, version, contentHash });
  return {
    algorithm: SIGNATURE_ALGORITHM,
    keyId: signer.keyId,
    payload,
    signature: signer.sign(payload),
    signedAt: nowIso(),
  };
}

/**
 * 校验签名记录。
 * @returns {{valid:boolean, reasons:string[], keyId?:string, algorithm?:string, signedAt?:string}}
 */
export function verifyVersionSignature({ kind, name, version, contentHash, signature, publicKeyPem }) {
  const reasons = [];
  if (!signature || typeof signature !== 'object') {
    return { valid: false, reasons: ['该版本没有签名记录'] };
  }
  if (signature.algorithm !== SIGNATURE_ALGORITHM) {
    reasons.push(`不支持的签名算法：${signature.algorithm || '(空)'}`);
  }
  const expectedPayload = signaturePayload({ kind, name, version, contentHash });
  if (signature.payload !== expectedPayload) {
    reasons.push('签名载荷与版本内容不匹配');
  }
  let expectedKeyId = '';
  try {
    expectedKeyId = keyIdFor(publicKeyPem);
  } catch {
    reasons.push('公钥不可解析');
  }
  if (expectedKeyId && signature.keyId !== expectedKeyId) {
    reasons.push('签名 keyId 与平台公钥不匹配');
  }
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(signature.payload || '', 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signature.signature || '', 'base64'),
    );
  } catch (error) {
    reasons.push(`签名校验失败：${error.message}`);
  }
  if (!signatureValid && !reasons.some((reason) => reason.startsWith('签名校验失败'))) {
    reasons.push('签名校验失败');
  }
  return {
    valid: signatureValid && reasons.length === 0,
    reasons,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
    signedAt: signature.signedAt,
  };
}
