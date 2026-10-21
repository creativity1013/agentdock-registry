import fs from 'node:fs';
import { readJson, writeJsonAtomic, sha256, randomToken, nowIso, safeEqual } from './util.mjs';
import { ensureDataLayout } from './config.mjs';
import { unauthorized, forbidden, badRequest, notFound } from './errors.mjs';

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
    state.users = state.users.map((user) => ({ role: 'viewer', ...user }));
  }

  function authenticate(token) {
    if (!token || typeof token !== 'string') return null;
    const hash = sha256(token);
    for (const user of state.users) {
      if (safeEqual(hash, user.tokenHash)) {
        return { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt };
      }
    }
    return null;
  }

  function list() {
    return state.users.map((user) => ({ id: user.id, name: user.name, role: user.role, createdAt: user.createdAt }));
  }

  function createToken({ name, role }) {
    if (typeof name !== 'string' || name.trim() === '') throw badRequest('name 不能为空');
    if (!ROLES.includes(role)) throw badRequest(`role 必须是 ${ROLES.join(' / ')} 之一`);
    if (state.users.some((user) => user.name === name.trim())) {
      throw badRequest(`用户名已存在：${name.trim()}`);
    }
    const token = randomToken(24);
    const user = {
      id: `u_${randomToken(6)}`,
      name: name.trim(),
      role,
      tokenHash: sha256(token),
      createdAt: nowIso(),
    };
    state.users.push(user);
    writeJsonAtomic(usersFile, state);
    return { user: { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt }, token };
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
