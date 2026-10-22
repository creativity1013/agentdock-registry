import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_CONFIG_FILE = path.join(os.homedir(), '.agentdock', 'config.json');

export function resolveHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * 读取运行时配置。所有项都可用环境变量覆盖，方便测试与部署。
 */
export function loadConfig(env = process.env, overrides = {}) {
  const port = Number(overrides.port ?? env.AGENTDOCK_PORT ?? 7788);
  const host = overrides.host ?? env.AGENTDOCK_HOST ?? '127.0.0.1';
  const dataDir = path.resolve(overrides.dataDir ?? env.AGENTDOCK_DATA ?? path.join(PKG_ROOT, 'data'));
  const home = overrides.home ?? resolveHome(env);
  const installHome = overrides.installHome ?? env.AGENTDOCK_INSTALL_HOME ?? '';
  const webDir = overrides.webDir ?? path.join(PKG_ROOT, 'web');

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENTDOCK_PORT 不合法：${port}`);
  }

  const registries = {
    githubApi: 'https://api.github.com',
    mcpRegistry: 'https://registry.modelcontextprotocol.io',
    ...(overrides.registries || {}),
  };
  if (!overrides.registries?.githubApi && env.AGENTDOCK_GITHUB_API) {
    registries.githubApi = String(env.AGENTDOCK_GITHUB_API);
  }
  if (!overrides.registries?.mcpRegistry && env.AGENTDOCK_MCP_REGISTRY) {
    registries.mcpRegistry = String(env.AGENTDOCK_MCP_REGISTRY);
  }
  registries.githubApi = registries.githubApi.replace(/\/+$/, '');
  registries.mcpRegistry = registries.mcpRegistry.replace(/\/+$/, '');

  const backend = String(overrides.store?.backend ?? env.AGENTDOCK_STORE ?? 'json').toLowerCase();
  if (backend !== 'json' && backend !== 'sqlite') {
    throw new Error(`AGENTDOCK_STORE 只能是 json / sqlite：${backend}`);
  }

  // 审计日志轮转：超过 maxBytes 轮转归档，保留 keep 份归档（0 = 不轮转 / 归档不限量）
  const auditMaxBytes = Number(overrides.audit?.maxBytes ?? env.AGENTDOCK_AUDIT_MAX_BYTES ?? 8 * 1024 * 1024);
  if (!Number.isFinite(auditMaxBytes) || auditMaxBytes < 0) {
    throw new Error(`AGENTDOCK_AUDIT_MAX_BYTES 不合法：${env.AGENTDOCK_AUDIT_MAX_BYTES}`);
  }
  const auditKeep = Number(overrides.audit?.keep ?? env.AGENTDOCK_AUDIT_KEEP ?? 24);
  if (!Number.isInteger(auditKeep) || auditKeep < 0) {
    throw new Error(`AGENTDOCK_AUDIT_KEEP 不合法：${env.AGENTDOCK_AUDIT_KEEP}`);
  }

  const oidcIssuer = String(overrides.oidc?.issuer ?? env.AGENTDOCK_OIDC_ISSUER ?? '').trim();
  const oidcClientId = String(overrides.oidc?.clientId ?? env.AGENTDOCK_OIDC_CLIENT_ID ?? '').trim();
  const oidcClientSecret = String(overrides.oidc?.clientSecret ?? env.AGENTDOCK_OIDC_CLIENT_SECRET ?? '').trim();
  const oidcRedirect = String(
    overrides.oidc?.redirectUrl ?? env.AGENTDOCK_OIDC_REDIRECT ?? '',
  ).trim();
  const oidcDefaultRole = String(
    overrides.oidc?.defaultRole ?? env.AGENTDOCK_OIDC_DEFAULT_ROLE ?? 'viewer',
  ).trim();
  if (!['viewer', 'publisher', 'reviewer', 'admin'].includes(oidcDefaultRole)) {
    throw new Error(`AGENTDOCK_OIDC_DEFAULT_ROLE 不合法：${oidcDefaultRole}`);
  }

  const rateLimitEnabled = (overrides.security?.rateLimit?.enabled ?? env.AGENTDOCK_RATE_LIMIT !== '0') === true;
  const rateWindowMs = Number(
    overrides.security?.rateLimit?.windowMs ?? env.AGENTDOCK_RATE_LIMIT_WINDOW_MS ?? 60_000,
  );
  const rateMax = Number(overrides.security?.rateLimit?.max ?? env.AGENTDOCK_RATE_LIMIT_MAX ?? 300);
  const rateLoginMax = Number(
    overrides.security?.rateLimit?.loginMax ?? env.AGENTDOCK_RATE_LIMIT_LOGIN_MAX ?? 20,
  );
  if (!Number.isFinite(rateWindowMs) || rateWindowMs <= 0) {
    throw new Error(`AGENTDOCK_RATE_LIMIT_WINDOW_MS 不合法：${env.AGENTDOCK_RATE_LIMIT_WINDOW_MS}`);
  }
  if (!Number.isFinite(rateMax) || rateMax <= 0) {
    throw new Error(`AGENTDOCK_RATE_LIMIT_MAX 不合法：${env.AGENTDOCK_RATE_LIMIT_MAX}`);
  }
  if (!Number.isFinite(rateLoginMax) || rateLoginMax <= 0) {
    throw new Error(`AGENTDOCK_RATE_LIMIT_LOGIN_MAX 不合法：${env.AGENTDOCK_RATE_LIMIT_LOGIN_MAX}`);
  }
  const security = {
    rateLimit: {
      enabled: rateLimitEnabled,
      windowMs: rateWindowMs,
      max: rateMax,
      loginMax: rateLoginMax,
      trustProxy: Boolean(overrides.security?.rateLimit?.trustProxy ?? env.AGENTDOCK_TRUST_PROXY === '1'),
    },
  };

  const config = {
    host,
    port,
    dataDir,
    home,
    installHome,
    webDir,
    publicUrl: overrides.publicUrl ?? env.AGENTDOCK_PUBLIC_URL ?? `http://${host}:${port}`,
    scanBlock: overrides.scanBlock ?? env.AGENTDOCK_SCAN_BLOCK ?? 'high',
    dev: overrides.dev ?? env.AGENTDOCK_DEV === '1',
    version: readOwnVersion(),
    registries,
    security,
    githubToken: overrides.githubToken ?? env.GITHUB_TOKEN ?? '',
    store: {
      backend,
      sqliteFile: path.join(dataDir, 'agentdock.sqlite'),
    },
    oidc: {
      enabled: Boolean(oidcIssuer && oidcClientId),
      issuer: oidcIssuer.replace(/\/+$/, ''),
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      redirectUrl: oidcRedirect,
      scopes: String(overrides.oidc?.scopes ?? env.AGENTDOCK_OIDC_SCOPES ?? 'openid profile email'),
      tenantClaim: String(overrides.oidc?.tenantClaim ?? env.AGENTDOCK_OIDC_TENANT_CLAIM ?? 'tenant'),
      roleClaim: String(overrides.oidc?.roleClaim ?? env.AGENTDOCK_OIDC_ROLE_CLAIM ?? 'role'),
      defaultRole: oidcDefaultRole,
      groupsClaim: String(overrides.oidc?.groupsClaim ?? env.AGENTDOCK_OIDC_GROUPS_CLAIM ?? 'groups'),
      groupRoleMap: parseGroupRoleMap(overrides.oidc?.groupRoleMap, env.AGENTDOCK_OIDC_GROUP_ROLES),
      mfaRequired: Boolean(overrides.oidc?.mfaRequired ?? env.AGENTDOCK_OIDC_MFA_REQUIRED === '1'),
      amrClaim: String(overrides.oidc?.amrClaim ?? env.AGENTDOCK_OIDC_AMR_CLAIM ?? 'amr'),
    },
    audit: {
      maxBytes: auditMaxBytes,
      keep: auditKeep,
    },
    files: {
      db: path.join(dataDir, 'db.json'),
      sqlite: path.join(dataDir, 'agentdock.sqlite'),
      users: path.join(dataDir, 'users.json'),
      bootstrapTokens: path.join(dataDir, 'BOOTSTRAP-TOKENS.txt'),
      audit: path.join(dataDir, 'audit.log'),
      auditArchive: path.join(dataDir, 'audit', 'archive'),
      packages: path.join(dataDir, 'packages'),
      signingKey: path.join(dataDir, 'signing-key.json'),
      transparency: path.join(dataDir, 'transparency.log'),
      sessions: path.join(dataDir, 'sessions.json'),
      policy: path.join(dataDir, 'policy.json'),
      sessionSecret: path.join(dataDir, 'session-secret.json'),
      notify: path.join(dataDir, 'notify.json'),
    },
  };
  return config;
}

export function ensureDataLayout(config) {
  for (const dir of [config.dataDir, config.files.packages]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 环境变量 AGENTDOCK_OIDC_GROUP_ROLES 形如 "agents-admins=admin,reviewers=reviewer" */
function parseGroupRoleMap(raw, envValue) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw)
        .map(([group, role]) => [String(group).trim(), String(role).trim()])
        .filter(([group, role]) => group && ['viewer', 'publisher', 'reviewer', 'admin'].includes(role)),
    );
  }
  const text = String(envValue ?? '').trim();
  if (!text) return {};
  const map = {};
  for (const part of text.split(',')) {
    const [group, role] = part.split('=').map((value) => value.trim());
    if (!group || !role) continue;
    if (!['viewer', 'publisher', 'reviewer', 'admin'].includes(role)) {
      throw new Error(`AGENTDOCK_OIDC_GROUP_ROLES 中的角色只能是 viewer/publisher/reviewer/admin：${part}`);
    }
    map[group] = role;
  }
  return map;
}

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
