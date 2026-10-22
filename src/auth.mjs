import fs from 'node:fs';
import { readJson, writeJsonAtomic, sha256, randomToken, nowIso, safeEqual } from './util.mjs';
import { ensureDataLayout } from './config.mjs';
import { unauthorized, forbidden, badRequest, notFound } from './errors.mjs';
import { keyIdFor, isValidEd25519PublicKey } from './signing.mjs';

export const ROLES = ['viewer', 'publisher', 'reviewer', 'admin'];
export const ROLE_RANK = { viewer: 0, publisher: 1, reviewer: 2, admin: 3 };
export const ROLE_LABEL = { viewer: '只读', publisher: '发布者', reviewer: '审核者', admin: '管理员' };

/**
 * 用户与令牌目录。
 * 明文令牌只在首次启动时写入 BOOTSTRAP-TOKENS.txt（权限 600），库内只存 sha256。
 */
export function createUserDirectory(config) {
  ensureDataLayout(config);
  const usersFile = config.files.users;
  const bootstrapFile = config.files.bootstrapTokens;
  let state = null;
  if (fs.existsSync(usersFile)) {
    state = readJson(usersFile);
  }
  let bootstrap = null;
  if (!state || !Array.isArray(state.users) || state.users.length === 0) {
    const seeds = [
      { name: 'admin', role: 'admin' },
      { name: 'reviewer', role: 'reviewer' },
      { name: 'publisher', role: 'publisher' },
    ];
    const plaintext = [];
    const users = seeds.map((seed) => {
      const token = randomToken(24);
      plaintext.push({ name: seed.name, role: seed.role, token });
      return {
        id: `u_${sha256(seed.name).slice(0, 8)}`,
        name: seed.name,
        role: seed.role,
        tenant: 'default',
        tokenHash: sha256(token),
        createdAt: nowIso(),
      };
    });
    state = { schemaVersion: 1, users };
    writeJsonAtomic(usersFile, state);
    const lines = [
      '# AgentDock 初始化令牌（仅本文件保留明文，请妥善保存；删除后无法恢复）',
      '# 用法：Authorization: Bearer <token>，或 CLI 使用 --token 参数 / agentdock login',
      '',
      ...plaintext.map((item) => `${item.role.padEnd(9)} ${item.token}  # ${item.name}`),
      '',
    ];
    fs.writeFileSync(bootstrapFile, lines.join('\n'), { mode: 0o600 });
    bootstrap = plaintext;
  } else {
    state.users = state.users.map((user) => ({
      role: 'viewer',
      tenant: 'default',
      ...user,
      tenant: user.tenant || 'default',
      keys: Array.isArray(user.keys) ? user.keys : [],
    }));
  }

  function authenticate(token) {
    if (!token || typeof token !== 'string') return null;
    const hash = sha256(token);
    for (const user of state.users) {
      if (!user.tokenHash) continue;
      if (safeEqual(hash, user.tokenHash)) {
        return {
          id: user.id,
          name: user.name,
          role: user.role,
          tenant: user.tenant || 'default',
          createdAt: user.createdAt,
        };
      }
    }
    return null;
  }

  function list() {
    return state.users.map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      tenant: user.tenant || 'default',
      auth: user.auth || 'token',
      email: user.email || '',
      createdAt: user.createdAt,
    }));
  }

  function createToken({ name, role, tenant = 'default' }) {
    if (typeof name !== 'string' || name.trim() === '') throw badRequest('name 不能为空');
    if (!ROLES.includes(role)) throw badRequest(`role 必须是 ${ROLES.join(' / ')} 之一`);
    if (state.users.some((user) => user.name === name.trim())) {
      throw badRequest(`用户名已存在：${name.trim()}`);
    }
    if (typeof tenant !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(tenant)) {
      throw badRequest('tenant 只能是小写字母/数字/下划线/连字符，最长 32 位');
    }
    const token = randomToken(24);
    const user = {
      id: `u_${randomToken(6)}`,
      name: name.trim(),
      role,
      tenant,
      auth: 'token',
      tokenHash: sha256(token),
      createdAt: nowIso(),
    };
    state.users.push(user);
    writeJsonAtomic(usersFile, state);
    return {
      user: { id: user.id, name: user.name, role: user.role, tenant: user.tenant, createdAt: user.createdAt },
      token,
    };
  }

  /** SSO 用户：按 OIDC sub / email 复用已有账号，否则自动创建（默认 role 由配置决定） */
  function provisionOidcUser({ subject, email = '', name = '', tenant = 'default', role = 'viewer' }) {
    const existing = state.users.find(
      (user) => (user.oidcSub && user.oidcSub === subject) || (email && user.email === email),
    );
    if (existing) {
      existing.oidcSub = existing.oidcSub || subject;
      if (email) existing.email = email;
      existing.lastLoginAt = nowIso();
      writeJsonAtomic(usersFile, state);
      return {
        id: existing.id,
        name: existing.name,
        role: existing.role,
        tenant: existing.tenant || 'default',
        email: existing.email || '',
        createdAt: existing.createdAt,
      };
    }
    let username = (name || email || subject || 'sso-user').slice(0, 64);
    if (state.users.some((user) => user.name === username)) {
      username = `${username}-${sha256(subject).slice(0, 4)}`;
    }
    const user = {
      id: `u_${randomToken(6)}`,
      name: username,
      role: ['viewer', 'publisher', 'reviewer', 'admin'].includes(role) ? role : 'viewer',
      tenant,
      auth: 'oidc',
      email,
      oidcSub: subject,
      tokenHash: null,
      keys: [],
      createdAt: nowIso(),
      lastLoginAt: nowIso(),
    };
    state.users.push(user);
    writeJsonAtomic(usersFile, state);
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      tenant: user.tenant,
      email,
      createdAt: user.createdAt,
    };
  }

  /* ------------------------------ 发布者签名密钥 ------------------------------ */

  const getUser = (userId) => state.users.find((user) => user.id === userId) || null;

  function publicKeyInfo(key) {
    return {
      keyId: key.keyId,
      name: key.name,
      algorithm: key.algorithm || 'ed25519',
      createdAt: key.createdAt,
      publicKey: key.publicKeyPem,
    };
  }

  function listKeys(userId) {
    const user = getUser(userId);
    return (user?.keys || []).map(publicKeyInfo);
  }

  /** 注册发布者公钥（TOFU：首次发布时由 CLI 自动提交公钥） */
  function registerKey(userId, { name, publicKeyPem } = {}) {
    const user = getUser(userId);
    if (!user) throw unauthorized('用户不存在');
    if (!user.keys) user.keys = [];
    if (typeof name !== 'string' || name.trim() === '') throw badRequest('密钥名称不能为空');
    const pem = typeof publicKeyPem === 'string' ? publicKeyPem.trim() : '';
    if (!isValidEd25519PublicKey(pem)) throw badRequest('publicKeyPem 必须是 ed25519 公钥 PEM');
    const keyId = keyIdFor(pem);
    const existing = user.keys.find((key) => key.keyId === keyId);
    if (existing) return publicKeyInfo(existing);
    if (user.keys.some((key) => key.name === name.trim())) {
      throw badRequest(`密钥名称已存在：${name.trim()}`);
    }
    const key = {
      keyId,
      name: name.trim(),
      algorithm: 'ed25519',
      publicKeyPem: pem,
      createdAt: nowIso(),
    };
    user.keys.push(key);
    writeJsonAtomic(usersFile, state);
    return publicKeyInfo(key);
  }

  function removeKey(userId, keyId) {
    const user = getUser(userId);
    if (!user || !Array.isArray(user.keys)) throw notFound('密钥不存在');
    const index = user.keys.findIndex((key) => key.keyId === keyId);
    if (index === -1) throw notFound('密钥不存在');
    user.keys.splice(index, 1);
    writeJsonAtomic(usersFile, state);
    return true;
  }

  function findKey(userId, keyId) {
    const user = getUser(userId);
    return (user?.keys || []).find((key) => key.keyId === keyId) || null;
  }

  function keysOf(userId) {
    const user = getUser(userId);
    return user?.keys || [];
  }

  function requireRole(user, role) {
    if (!user) throw unauthorized();
    if ((ROLE_RANK[user.role] ?? -1) < (ROLE_RANK[role] ?? 99)) throw forbidden();
    return user;
  }

  return {
    usersFile,
    bootstrapFile,
    bootstrap,
    authenticate,
    list,
    createToken,
    listKeys,
    registerKey,
    removeKey,
    findKey,
    keysOf,
    getUser,
    provisionOidcUser,
    requireRole,
    get count() {
      return state.users.length;
    },
  };
}

/** 从请求头提取 Bearer token */
export function tokenFromRequest(req) {
  const header = req.headers.authorization || req.headers['x-agentdock-token'];
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    if (!header.startsWith('Bearer')) return header.trim();
  }
  return null;
}
