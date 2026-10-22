import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createRateLimiter, requestIp } from './ratelimit.mjs';
import { checkCsrf, cookieValue, CSRF_COOKIE } from './security.mjs';
import { createUserDirectory, tokenFromRequest, ROLES, ROLE_LABEL } from './auth.mjs';
import { createAuditLog } from './audit.mjs';
import { createStore, VERSION_STATUS_LABEL } from './store.mjs';
import { planInstall, applyInstall, summarizePlan, listTargets } from './targets.mjs';
import { AppError, badRequest, unauthorized, forbidden, notFound, unprocessable, tooLarge } from './errors.mjs';
import { LIMITS } from './bundle.mjs';
import { describeBundle } from './validate.mjs';
import { diffBundles } from './diff.mjs';
import { qualityOf } from './quality.mjs';
import { createTransparencyLog } from './transparency.mjs';
import { buildMarketplaceCatalog, describeAdapters, importFromGitHub, importFromMcpRegistry, RegistryError } from './registry.mjs';
import { defaultPolicy, evaluateAutoApproval, loadPolicy, normalizePolicy, savePolicy, setPolicyFor, PolicyError } from './policy.mjs';
import { createSessionManager } from './session.mjs';
import { createOidcClient } from './oidc.mjs';

const MAX_BODY = Math.max(LIMITS.maxTotalBytes * 2, 6 * 1024 * 1024);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 创建 AgentDock HTTP 应用（不监听端口，便于测试）。
 */
export function createApp(config = loadConfig()) {
  const users = createUserDirectory(config);
  const audit = createAuditLog(config);
  const transparency = createTransparencyLog(config);
  const store = createStore(config, { audit, users, transparency });
  const policyState = loadPolicy(config);
  store.setPolicies(policyState.policies);
  const rateLimit = config.security?.rateLimit || { enabled: false };
  const apiLimiter = createRateLimiter({ windowMs: rateLimit.windowMs || 60_000, max: rateLimit.max || 300 });
  const loginLimiter = createRateLimiter({ windowMs: rateLimit.windowMs || 60_000, max: rateLimit.loginMax || 20 });
  const pruneTimer = setInterval(() => {
    apiLimiter.prune();
    loginLimiter.prune();
  }, 60_000);
  pruneTimer.unref?.();

  function enforceRate(limiter, key) {
    if (!rateLimit.enabled) return;
    const result = limiter.hit(key);
    if (!result.allowed) {
      throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', {
        retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
      });
    }
  }
  const sessions = createSessionManager(config);
  const oidc = createOidcClient(config);
  const oidcStates = new Map(); // state -> { verifier, redirectUri, expiresAt }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw badRequest('URL 编码非法');
    }
    const requestAddress = requestIp(req, rateLimit.trustProxy);
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/oidc')) {
      enforceRate(apiLimiter, `global:${requestAddress}`);
    }
    if (pathname === '/auth/oidc/login' || pathname === '/auth/oidc/callback') {
      enforceRate(loginLimiter, `login:${requestAddress}`);
    }
    let authVia = null;
    let auth = users.authenticate(tokenFromRequest(req));
    if (auth) authVia = 'bearer';
    if (!auth) {
      const cookieValue = sessions.cookieFrom(req);
      const payload = cookieValue ? sessions.verify(cookieValue) : null;
      if (payload) {
        const user = users.getUser(payload.uid);
        if (user) {
          authVia = 'session';
          auth = {
            id: user.id,
            name: user.name,
            role: user.role,
            tenant: user.tenant || 'default',
            createdAt: user.createdAt,
          };
        }
      }
    }
    const ctx = {
      auth,
      authVia,
      tenant: auth?.tenant || 'default',
      ip: requestAddress,
      method: req.method || 'GET',
    };

    if (pathname === '/auth/config') {
      return sendJson(res, 200, {
        ok: true,
        enabled: oidc.settings.enabled,
        issuer: oidc.settings.enabled ? oidc.settings.issuer : '',
        loginUrl: oidc.settings.enabled ? '/auth/oidc/login' : '',
      });
    }

    if (pathname === '/auth/oidc/login' && (req.method || 'GET') === 'GET') {
      if (!oidc.settings.enabled) throw notFound('未配置 SSO（OIDC）');
      const endpoints = await oidc.discover();
      const redirectUri = oidc.settings.redirectUrl || `${config.publicUrl}/auth/oidc/callback`;
      const state = oidc.createState();
      const { verifier, challenge } = oidc.createPkcePair();
      oidcStates.set(state, { verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 });
      for (const [key, value] of oidcStates) {
        if (value.expiresAt < Date.now()) oidcStates.delete(key);
      }
      const location = oidc.authorizeUrl(endpoints, { state, codeChallenge: challenge, redirectUri });
      res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (pathname === '/auth/oidc/callback' && (req.method || 'GET') === 'GET') {
      if (!oidc.settings.enabled) throw notFound('未配置 SSO（OIDC）');
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const pending = oidcStates.get(state);
      oidcStates.delete(state);
      if (!pending || pending.expiresAt < Date.now()) throw badRequest('SSO state 无效或已过期');
      if (!code) throw badRequest('SSO 回调缺少 code');
      const endpoints = await oidc.discover();
      const tokens = await oidc.exchangeCode(endpoints, {
        code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
      });
      if (!tokens.access_token) throw new AppError(502, 'OIDC_TOKEN_INVALID', 'OIDC token 响应缺少 access_token');
      const claims = await oidc.userinfo(endpoints, tokens.access_token);
      const identity = oidc.mapClaims(claims);
      const user = users.provisionOidcUser(identity);
      const secure = config.publicUrl.startsWith('https://');
      audit.append({
        actor: user.name,
        role: user.role,
        action: 'user.sso_login',
        target: user.name,
        meta: { tenant: user.tenant, issuer: oidc.settings.issuer },
        ip: ctx.ip,
      });
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': sessions.cookieHeader(user.id, { secure }),
        'Cache-Control': 'no-store',
      });
      return res.end();
    }

    if (pathname === '/auth/logout' && (req.method || 'GET') === 'POST') {
      const hasSession = Boolean(cookieValue(req.headers.cookie, 'agentdock_session'));
      const csrf = checkCsrf({ method: 'POST', authVia: hasSession ? 'session' : null, headers: req.headers });
      if (!csrf.ok) throw forbidden(`CSRF 校验失败：${csrf.reason}`);
      audit.append({ actor: auth?.name || 'anonymous', role: auth?.role || '', action: 'user.logout', target: auth?.name || '', meta: {}, ip: ctx.ip });
      res.writeHead(204, { 'Set-Cookie': sessions.clearCookie(), 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return handleApi(req, res, ctx, pathname, url);
    }
    return serveStatic(req, res, pathname);
  }

  /* ------------------------------ API 路由 ------------------------------ */

  async function handleApi(req, res, ctx, pathname, url) {
    const { auth, ip, method } = ctx;
    const csrf = checkCsrf({ method, authVia: ctx.authVia, headers: req.headers });
    if (!csrf.ok) throw forbidden(`CSRF 校验失败：${csrf.reason}`);
    const tenant = ctx.tenant || 'default';
    const route = pathname.replace(/^\/api\/v1\/?/, '');
    const requireAuth = () => {
      if (!auth) throw unauthorized('需要令牌，请提供 Authorization: Bearer <token>');
      return auth;
    };
    const requireRole = (role) => users.requireRole(auth, role);

    if (route === 'health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, name: 'agentdock', version: config.version, time: new Date().toISOString() });
    }

    // 平台签名公钥（公开，任何人可下载后离线验签）
    if (route === 'keys' && method === 'GET') {
      return sendJson(res, 200, { ok: true, keys: [store.signingKeyInfo()] });
    }

    if (route === 'stats' && method === 'GET') {
      return sendJson(res, 200, store.stats(tenant));
    }

    if (route === 'me' && method === 'GET') {
      requireAuth();
      return sendJson(res, 200, { user: auth, roles: ROLES, roleLabels: ROLE_LABEL });
    }

    // 当前用户的发布者签名密钥（公钥可公开）
    if (route === 'me/keys' && method === 'GET') {
      requireAuth();
      return sendJson(res, 200, { ok: true, keys: users.listKeys(auth.id) });
    }
    if (route === 'me/keys' && method === 'POST') {
      requireRole('publisher');
      const body = await readBody(req);
      if (!body || typeof body.name !== 'string' || typeof body.publicKeyPem !== 'string') {
        throw badRequest('需要 name 与 publicKeyPem');
      }
      const key = users.registerKey(auth.id, { name: body.name, publicKeyPem: body.publicKeyPem });
      audit.append({
        actor: auth.name,
        role: auth.role,
        action: 'user.register_key',
        target: key.keyId,
        meta: { name: key.name, algorithm: key.algorithm },
        ip,
      });
      return sendJson(res, 201, { ok: true, key });
    }
    const keyDeleteMatch = pathname.match(/^\/api\/v1\/me\/keys\/([A-Za-z0-9]+)$/);
    if (keyDeleteMatch && method === 'DELETE') {
      requireAuth();
      const removed = users.removeKey(auth.id, keyDeleteMatch[1]);
      return sendJson(res, 200, { ok: true, removed });
    }

    // 可验证透明日志（公开）
    if (route === 'transparency/head' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...transparency.head() });
    }
    if (route === 'transparency/entries' && method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      return sendJson(res, 200, { ok: true, head: transparency.head(), ...transparency.list({ limit, offset }) });
    }
    if (route === 'transparency/verify' && method === 'GET') {
      const result = transparency.verify();
      return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, ...result });
    }
    if (route === 'transparency/proof' && method === 'GET') {
      const kind = url.searchParams.get('kind') || '';
      const name = url.searchParams.get('name') || '';
      const version = url.searchParams.get('version') || '';
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      const versionDoc = store.getVersion(kind, name, version, tenant);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      const result = transparency.proof(kind, name, version);
      if (!result) throw notFound('透明日志中未找到该版本，请联系管理员检查日志');
      return sendJson(res, 200, { ok: true, kind, name, version, ...result });
    }

    if (route === 'targets' && method === 'GET') {
      requireAuth();
      return sendJson(res, 200, { items: listTargets({ home: config.home }) });
    }

    // 外部 registry 互操作：适配器与导出目录
    if (route === 'registry' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        adapters: describeAdapters(config),
        exportUrl: `${config.publicUrl}/api/v1/registry/export`,
        schema: 'agentdock-marketplace@1',
      });
    }
    if (route === 'registry/export' && method === 'GET') {
      return sendJson(res, 200, buildMarketplaceCatalog(store, { baseUrl: config.publicUrl }));
    }
    if (route === 'sync/import' && method === 'POST') {
      requireRole('publisher');
      const body = await readBody(req);
      const source = body && body.source;
      if (!source || typeof source !== 'object') throw badRequest('需要 source（{type:"github"|"mcp", ...}）');
      let imported;
      try {
        if (source.type === 'github') {
          imported = await importFromGitHub({
            repo: source.repo,
            path: source.path,
            ref: source.ref,
            apiBase: config.registries.githubApi,
            token: config.githubToken,
          });
        } else if (source.type === 'mcp') {
          imported = await importFromMcpRegistry({
            name: source.name,
            baseUrl: config.registries.mcpRegistry,
            version: source.version,
          });
        } else {
          throw badRequest(`不支持的 source.type：${source.type}`);
        }
      } catch (error) {
        if (error instanceof RegistryError) {
          throw new AppError(error.status || 502, 'REGISTRY_ERROR', error.message, error.details);
        }
        throw error;
      }
      if (!imported.kind) {
        throw unprocessable('无法识别能力包类型：需要根目录含 SKILL.md、agent.md 或 plugin.json');
      }
      const payload = {
        kind: imported.kind,
        name: imported.meta.name,
        version: body.version || imported.meta.version,
        description: body.description || imported.meta.description,
        tags: Array.isArray(body.tags) && body.tags.length ? body.tags : imported.meta.tags,
        files: imported.files,
      };
      const report = store.analyze(payload);
      if (body.dryRun) {
        return sendJson(res, 200, {
          ok: report.valid && !report.blocked,
          dryRun: true,
          source: imported.source,
          kind: payload.kind,
          name: payload.name,
          version: payload.version,
          valid: report.valid,
          blocked: report.blocked,
          errors: report.errors,
          warnings: [...imported.warnings, ...(report.warnings || [])],
          summary: report.summary,
          scan: report.scan,
          verdict: report.verdict,
        });
      }
      const result = store.publish(payload, { actor: auth.name, actorId: auth.id, role: auth.role, ip, tenant });
      audit.append({
        actor: auth.name,
        role: auth.role,
        action: 'sync.import',
        target: `${payload.kind}/${payload.name}@${payload.version}`,
        meta: { source: imported.source, warnings: imported.warnings.length },
        ip,
      });
      return sendJson(res, 201, {
        ok: true,
        source: imported.source,
        warnings: [...imported.warnings, ...(report.warnings || [])],
        autoApproved: Boolean(result.autoApproved),
        package: result.package,
        version: publicVersion(result.version),
        message: result.autoApproved ? '已从外部 registry 导入并通过策略自动审批' : '已从外部 registry 导入，等待审核',
      });
    }

    if (route === 'verify' && method === 'POST') {
      requireRole('publisher');
      const body = await readBody(req);
      const report = store.analyze(body);
      return sendJson(res, 200, {
        ok: report.valid && !report.blocked,
        valid: report.valid,
        blocked: report.blocked,
        errors: report.errors,
        warnings: report.warnings,
        scan: report.scan,
        verdict: report.verdict,
        summary: report.summary,
        manifestDescription: report.manifest ? describeBundle(report.manifest) : '',
      });
    }

    // 市场列表
    if (route === 'packages' && method === 'GET') {
      const status = url.searchParams.get('status') || 'published';
      if (status === 'pending' || status === 'rejected') requireRole('reviewer');
      const includePending = Boolean(
        auth && (auth.role === 'reviewer' || auth.role === 'admin') && url.searchParams.get('includePending') === '1',
      );
      const list = store.listPackages({
        q: url.searchParams.get('q') || '',
        kind: url.searchParams.get('kind') || '',
        status: status === 'all' ? '' : status,
        includePending,
        tenant,
      });
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '24', 10) || 24),
      );
      const start = (page - 1) * pageSize;
      return sendJson(res, 200, {
        total: list.total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(list.total / pageSize)),
        items: list.items.slice(start, start + pageSize),
      });
    }

    // 发布
    if (route === 'packages' && method === 'POST') {
      requireRole('publisher');
      const body = await readBody(req);
      const result = store.publish(body, { actor: auth.name, actorId: auth.id, role: auth.role, ip, tenant });
      return sendJson(res, 201, {
        ok: true,
        autoApproved: Boolean(result.autoApproved),
        package: result.package,
        version: publicVersion(result.version),
        message: result.autoApproved ? '已通过策略自动审批并上架' : '已提交，等待审核',
      });
    }

    const detailMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)$/);
    if (detailMatch && method === 'GET') {
      const [, kind, name] = detailMatch;
      const includePending = Boolean(
        auth && (auth.role === 'reviewer' || auth.role === 'admin'),
      );
      return sendJson(res, 200, store.packageDetail(kind, name, { includePending, tenant }));
    }

    const versionMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)$/);
    if (versionMatch && method === 'GET') {
      const [, kind, name, version] = versionMatch;
      const versionDoc = store.getVersion(kind, name, version, tenant);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      return sendJson(res, 200, publicVersion(versionDoc));
    }

    // 版本签名 / 验签（?verify=1 会重算磁盘内容）
    const signatureMatch = pathname.match(
      /^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/signature$/,
    );
    if (signatureMatch && method === 'GET') {
      const [, kind, name, version] = signatureMatch;
      const versionDoc = store.getVersion(kind, name, version, tenant);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      if (url.searchParams.get('verify') === '1') {
        const result = store.verifySignature(kind, name, versionDoc.version);
        return sendJson(res, 200, {
          ok: result.valid,
          ...result,
          publicKey: store.signingKeyInfo(),
          publisherSignature: versionDoc.publisherSignature ?? null,
        });
      }
      return sendJson(res, 200, {
        ok: true,
        kind,
        name,
        version: versionDoc.version,
        status: versionDoc.status,
        contentHash: versionDoc.contentHash,
        signature: versionDoc.signature ?? null,
        publisherSignature: versionDoc.publisherSignature ?? null,
        publicKey: store.signingKeyInfo(),
      });
    }

    // 版本 SBOM（软件物料清单）
    const sbomMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/sbom$/);
    if (sbomMatch && method === 'GET') {
      const [, kind, name, version] = sbomMatch;
      const versionDoc = store.getVersion(kind, name, version, tenant);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      const sbom = store.sbom(kind, name, versionDoc.version, tenant);
      if (!sbom) throw notFound('该版本没有 SBOM');
      return sendJson(res, 200, { ok: true, sbom });
    }

    // 下载完整能力包（CLI 安装用）
    const bundleMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/bundle$/);
    if (bundleMatch && method === 'GET') {
      const [, kind, name, version] = bundleMatch;
      let versionDoc = store.getVersion(kind, name, version, tenant);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布');
      const bundle = store.bundleContent(kind, name, versionDoc.version);
      return sendJson(res, 200, { ok: true, bundle });
    }

    // 单文件预览
    const fileMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/files$/);
    if (fileMatch && method === 'GET') {
      const [, kind, name, version] = fileMatch;
      const filePath = url.searchParams.get('path');
      if (!filePath) throw badRequest('缺少 path 查询参数');
      return sendJson(res, 200, { ok: true, file: store.fileContent(kind, name, version, filePath, tenant) });
    }

    // 版本差异（审核 diff 视图）：默认与上一个已发布版本对比
    const diffMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/diff$/);
    if (diffMatch && method === 'GET') {
      const [, kind, name] = diffMatch;
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      const detail = store.packageDetail(kind, name, { includePending: privileged, tenant });
      const requestedTo = url.searchParams.get('to');
      const toVersion = requestedTo || detail.versions[0]?.version || null;
      if (!toVersion) throw notFound('该包还没有可比对的版本');
      const toDoc = store.getVersion(kind, name, toVersion, tenant);
      if (!toDoc) throw notFound(`版本不存在：${kind}/${name}@${toVersion}`);
      if (toDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      let fromVersion = url.searchParams.get('from');
      if (!fromVersion) {
        const baseline = detail.versions.find(
          (item) => item.status === 'published' && item.version !== toDoc.version,
        );
        fromVersion = baseline?.version || null;
      }
      let fromDoc = null;
      if (fromVersion) {
        fromDoc = store.getVersion(kind, name, fromVersion, tenant);
        if (!fromDoc) throw notFound(`基线版本不存在：${fromVersion}`);
        if (fromDoc.status !== 'published' && !privileged) throw notFound('基线版本不可见');
      }
      const result = diffBundles(
        fromDoc ? store.rawBundle(kind, name, fromDoc.version, tenant) : { files: [] },
        store.rawBundle(kind, name, toDoc.version, tenant),
      );
      return sendJson(res, 200, {
        ok: true,
        kind,
        name,
        from: fromDoc ? { version: fromDoc.version, status: fromDoc.status } : null,
        to: { version: toDoc.version, status: toDoc.status },
        ...result,
      });
    }

    // 安装计数上报（CLI 安装成功后上报）
    const installEventMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/install-event$/);
    if (installEventMatch && method === 'POST') {
      requireRole('publisher');
      const [, kind, name, version] = installEventMatch;
      const body = await readBody(req).catch(() => ({}));
      const versionDoc = store.recordInstall(kind, name, version, {
        actor: auth.name,
        ip,
        target: typeof body?.target === 'string' ? body.target : '',
      });
      return sendJson(res, 201, { ok: true, installs: versionDoc.installs });
    }

    // 服务端直接安装（本地 Web UI / 远程 CLI 均可用）
    if (route === 'install' && method === 'POST') {
      requireRole('publisher');
      const body = await readBody(req);
      if (!body || typeof body.kind !== 'string' || typeof body.name !== 'string') {
        throw badRequest('需要 kind 与 name');
      }
      const versionDoc = store.requirePublished(body.kind, body.name, body.version || undefined, tenant);
      const bundle = store.bundleContent(body.kind, body.name, versionDoc.version, tenant);
      const plan = planInstall(bundle, {
        target: body.target || 'dsh',
        home: config.home,
        dir: body.dir,
        force: body.force === true,
      });
      const result = applyInstall(plan);
      store.recordInstall(body.kind, body.name, versionDoc.version, {
        actor: auth.name,
        ip,
        target: body.target || 'dsh',
      });
      return sendJson(res, 201, { ok: true, version: versionDoc.version, ...result });
    }

    // 审核队列
    if (route === 'review/queue' && method === 'GET') {
      requireRole('reviewer');
      return sendJson(res, 200, store.reviewQueue(tenant));
    }

    // 审核动作
    if (route === 'review' && method === 'POST') {
      requireRole('reviewer');
      const body = await readBody(req);
      if (!body || typeof body.kind !== 'string' || typeof body.name !== 'string' || typeof body.version !== 'string') {
        throw badRequest('需要 kind / name / version');
      }
      const existing = store.getVersion(body.kind, body.name, body.version);
      if (existing && (existing.tenant || 'default') !== tenant) {
        throw notFound(`版本不存在：${body.kind}/${body.name}@${body.version}`);
      }
      const versionDoc = store.review(body.kind, body.name, body.version, {
        decision: body.decision,
        note: body.note || '',
        actor: auth.name,
        role: auth.role,
        ip,
      });
      return sendJson(res, 200, { ok: true, version: publicVersion(versionDoc) });
    }

    // 自动审批策略（读取 reviewer；更新 admin）
    if (route === 'policy' && method === 'GET') {
      requireRole('reviewer');
      const tenantOverride = Boolean(policyState.policies.tenants[ctx.tenant]);
      return sendJson(res, 200, {
        ok: true,
        tenant: ctx.tenant,
        policy: store.getPolicy(ctx.tenant),
        source: policyState.source === 'default' ? 'default' : tenantOverride ? 'tenant' : 'default-tenant',
        file: policyState.file,
      });
    }

    if (route === 'policy' && method === 'PUT') {
      requireRole('admin');
      const body = await readBody(req);
      const input = body?.policy ?? body;
      const next = normalizePolicy(input, store.getPolicy(ctx.tenant));
      next.updatedAt = new Date().toISOString();
      next.updatedBy = auth.name;
      const nextPolicies = setPolicyFor(policyState.policies, ctx.tenant, next);
      savePolicy(config, nextPolicies);
      policyState.policies = nextPolicies;
      policyState.source = 'file';
      store.setPolicies(nextPolicies);
      audit.append({
        actor: auth.name,
        role: auth.role,
        action: 'policy.update',
        target: 'policy.json',
        meta: { tenant: ctx.tenant, autoApprove: next.autoApprove, quota: next.quota },
        ip,
      });
      return sendJson(res, 200, { ok: true, tenant: ctx.tenant, policy: next, message: '策略已更新' });
    }

    // 审计日志（哈希链 + 多维过滤）
    if (route === 'audit' && method === 'GET') {
      requireRole('reviewer');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      return sendJson(res, 200, audit.read({ limit, offset, ...auditFilters(url) }));
    }
    if (route === 'audit/verify' && method === 'GET') {
      requireRole('reviewer');
      const result = audit.verify({ all: url.searchParams.get('all') === '1' });
      return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, ...result });
    }
    if (route === 'audit/export' && method === 'GET') {
      requireRole('reviewer');
      const format = url.searchParams.get('format') || 'jsonl';
      if (format !== 'csv' && format !== 'jsonl') throw badRequest(`format 只能是 csv / jsonl：${format}`);
      const { contentType, body } = audit.exportLines({ format, ...auditFilters(url) });
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="audit-export.${format}"`,
      });
      return res.end(body);
    }

    // 用户与令牌管理
    if (route === 'admin/users' && method === 'GET') {
      requireRole('admin');
      return sendJson(res, 200, { items: users.list() });
    }

    if (route === 'admin/tokens' && method === 'POST') {
      requireRole('admin');
      const body = await readBody(req);
      if (!body || typeof body.name !== 'string' || typeof body.role !== 'string') {
        throw badRequest('需要 name 与 role');
      }
      const created = users.createToken({ name: body.name, role: body.role, tenant: body.tenant });
      audit.append({
        actor: auth.name,
        role: auth.role,
        action: 'user.create_token',
        target: body.name,
        meta: { role: body.role, tenant: created.user.tenant },
        ip,
      });
      return sendJson(res, 201, { ok: true, token: created.token, user: created.user, roleLabels: ROLE_LABEL });
    }

    throw notFound(`接口不存在：${ctx.method} ${pathname}`);
  }

  /* ------------------------------ 静态资源 ------------------------------ */

  async function serveStatic(req, res, pathname) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      throw new AppError(405, 'method_not_allowed', '静态资源只支持 GET/HEAD');
    }
    const webRoot = path.resolve(config.webDir);
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(webRoot, rel);
    if (!filePath.startsWith(`${webRoot}${path.sep}`)) throw notFound('页面不存在');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw notFound('页面不存在');
    const ext = path.extname(filePath).toLowerCase();
    const type = STATIC_TYPES[ext];
    if (!type) throw notFound('页面不存在');

    const headers = {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    if (method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (error instanceof PolicyError) {
        return sendJson(res, 400, {
          ok: false,
          error: { code: 'POLICY_ERROR', message: error.message, details: error.details ?? null },
        });
      }
      if (error instanceof AppError) {
        if (error.status === 429 && error.details?.retryAfterSeconds) {
          res.setHeader('Retry-After', String(error.details.retryAfterSeconds));
        }
        return sendJson(res, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
      }
      console.error('[agentdock] 未处理错误：', error);
      return sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    });
  });

  // 服务关闭时释放元数据后端（SQLite 需要 close 才能安全删除临时数据目录）
  server.on('close', () => {
    clearInterval(pruneTimer);
    try {
      store.close?.();
    } catch {
      /* 关闭失败不阻塞 */
    }
  });

  return { server, config, users, audit, store, transparency };
}

/* ------------------------------ 工具函数 ------------------------------ */

/** 从查询串提取审计过滤参数（action/actor 精确，target 子串，from/to ISO 范围） */
function auditFilters(url) {
  return {
    action: url.searchParams.get('action') || '',
    actor: url.searchParams.get('actor') || '',
    target: url.searchParams.get('target') || '',
    from: url.searchParams.get('from') || '',
    to: url.searchParams.get('to') || '',
  };
}

function publicVersion(versionDoc) {
  return {
    version: versionDoc.version,
    status: versionDoc.status,
    statusLabel: VERSION_STATUS_LABEL[versionDoc.status] || versionDoc.status,
    quality: qualityOf(versionDoc),
    description: versionDoc.description,
    tags: versionDoc.tags,
    contentHash: versionDoc.contentHash,
    signature: versionDoc.signature ?? null,
    publisherSignature: versionDoc.publisherSignature ?? null,
    fileCount: versionDoc.fileCount,
    totalBytes: versionDoc.totalBytes,
    files: versionDoc.files,
    manifest: versionDoc.manifest,
    scan: versionDoc.scan,
    submittedAt: versionDoc.submittedAt,
    submittedBy: versionDoc.submittedBy,
    review: versionDoc.review,
    installs: versionDoc.installs,
    sbom: versionDoc.sbom
      ? {
          schema: versionDoc.sbom.schema,
          digest: versionDoc.sbom.digest,
          components: versionDoc.sbom.summary?.componentCount ?? versionDoc.sbom.components?.length ?? 0,
          fileCount: versionDoc.sbom.summary?.fileCount ?? versionDoc.sbom.files?.length ?? 0,
          counts: versionDoc.sbom.summary?.counts ?? null,
        }
      : null,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooLarge(`请求体超过 ${Math.round((limit / 1024 / 1024) * 10) / 10}MB`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw badRequest('请求体不能为空');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw badRequest(`请求体不是合法 JSON：${error.message}`);
  }
}
