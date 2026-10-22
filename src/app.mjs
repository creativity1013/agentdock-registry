import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createUserDirectory, tokenFromRequest, ROLES, ROLE_LABEL } from './auth.mjs';
import { createAuditLog } from './audit.mjs';
import { createStore, VERSION_STATUS_LABEL } from './store.mjs';
import { planInstall, applyInstall, summarizePlan, listTargets } from './targets.mjs';
import { AppError, badRequest, unauthorized, forbidden, notFound, unprocessable, tooLarge } from './errors.mjs';
import { LIMITS } from './bundle.mjs';
import { describeBundle } from './validate.mjs';
import { diffBundles } from './diff.mjs';

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
  const store = createStore(config, { audit });

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw badRequest('URL 编码非法');
    }
    const auth = users.authenticate(tokenFromRequest(req));
    const ctx = {
      auth,
      ip: req.socket?.remoteAddress || '',
      method: req.method || 'GET',
    };

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
      return sendJson(res, 200, store.stats());
    }

    if (route === 'me' && method === 'GET') {
      requireAuth();
      return sendJson(res, 200, { user: auth, roles: ROLES, roleLabels: ROLE_LABEL });
    }

    if (route === 'targets' && method === 'GET') {
      requireAuth();
      return sendJson(res, 200, { items: listTargets({ home: config.home }) });
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
      const result = store.publish(body, { actor: auth.name, role: auth.role, ip });
      return sendJson(res, 201, {
        ok: true,
        package: result.package,
        version: publicVersion(result.version),
        message: '已提交，等待审核',
      });
    }

    const detailMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)$/);
    if (detailMatch && method === 'GET') {
      const [, kind, name] = detailMatch;
      const includePending = Boolean(
        auth && (auth.role === 'reviewer' || auth.role === 'admin'),
      );
      return sendJson(res, 200, store.packageDetail(kind, name, { includePending }));
    }

    const versionMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)$/);
    if (versionMatch && method === 'GET') {
      const [, kind, name, version] = versionMatch;
      const versionDoc = store.getVersion(kind, name, version);
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
      const versionDoc = store.getVersion(kind, name, version);
      if (!versionDoc) throw notFound(`版本不存在：${kind}/${name}@${version}`);
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      if (versionDoc.status !== 'published' && !privileged) throw notFound('该版本尚未发布或未通过审核');
      if (url.searchParams.get('verify') === '1') {
        const result = store.verifySignature(kind, name, versionDoc.version);
        return sendJson(res, 200, { ok: result.valid, ...result, publicKey: store.signingKeyInfo() });
      }
      return sendJson(res, 200, {
        ok: true,
        kind,
        name,
        version: versionDoc.version,
        status: versionDoc.status,
        contentHash: versionDoc.contentHash,
        signature: versionDoc.signature ?? null,
        publicKey: store.signingKeyInfo(),
      });
    }

    // 下载完整能力包（CLI 安装用）
    const bundleMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/versions\/([^/]+)\/bundle$/);
    if (bundleMatch && method === 'GET') {
      const [, kind, name, version] = bundleMatch;
      let versionDoc = store.getVersion(kind, name, version);
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
      return sendJson(res, 200, { ok: true, file: store.fileContent(kind, name, version, filePath) });
    }

    // 版本差异（审核 diff 视图）：默认与上一个已发布版本对比
    const diffMatch = pathname.match(/^\/api\/v1\/packages\/([a-z]+)\/([A-Za-z0-9._-]+)\/diff$/);
    if (diffMatch && method === 'GET') {
      const [, kind, name] = diffMatch;
      const privileged = Boolean(auth && (auth.role === 'reviewer' || auth.role === 'admin'));
      const detail = store.packageDetail(kind, name, { includePending: privileged });
      const requestedTo = url.searchParams.get('to');
      const toVersion = requestedTo || detail.versions[0]?.version || null;
      if (!toVersion) throw notFound('该包还没有可比对的版本');
      const toDoc = store.getVersion(kind, name, toVersion);
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
        fromDoc = store.getVersion(kind, name, fromVersion);
        if (!fromDoc) throw notFound(`基线版本不存在：${fromVersion}`);
        if (fromDoc.status !== 'published' && !privileged) throw notFound('基线版本不可见');
      }
      const result = diffBundles(
        fromDoc ? store.rawBundle(kind, name, fromDoc.version) : { files: [] },
        store.rawBundle(kind, name, toDoc.version),
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
      const versionDoc = store.requirePublished(body.kind, body.name, body.version || undefined);
      const bundle = store.bundleContent(body.kind, body.name, versionDoc.version);
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
      return sendJson(res, 200, store.reviewQueue());
    }

    // 审核动作
    if (route === 'review' && method === 'POST') {
      requireRole('reviewer');
      const body = await readBody(req);
      if (!body || typeof body.kind !== 'string' || typeof body.name !== 'string' || typeof body.version !== 'string') {
        throw badRequest('需要 kind / name / version');
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

    // 审计日志
    if (route === 'audit' && method === 'GET') {
      requireRole('reviewer');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const action = url.searchParams.get('action') || '';
      return sendJson(res, 200, audit.read({ limit, offset, action }));
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
      const created = users.createToken({ name: body.name, role: body.role });
      audit.append({
        actor: auth.name,
        role: auth.role,
        action: 'user.create_token',
        target: body.name,
        meta: { role: body.role },
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
      if (error instanceof AppError) {
        return sendJson(res, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
      }
      console.error('[agentdock] 未处理错误：', error);
      return sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    });
  });

  return { server, config, users, audit, store };
}

/* ------------------------------ 工具函数 ------------------------------ */

function publicVersion(versionDoc) {
  return {
    version: versionDoc.version,
    status: versionDoc.status,
    statusLabel: VERSION_STATUS_LABEL[versionDoc.status] || versionDoc.status,
    description: versionDoc.description,
    tags: versionDoc.tags,
    contentHash: versionDoc.contentHash,
    signature: versionDoc.signature ?? null,
    fileCount: versionDoc.fileCount,
    totalBytes: versionDoc.totalBytes,
    files: versionDoc.files,
    manifest: versionDoc.manifest,
    scan: versionDoc.scan,
    submittedAt: versionDoc.submittedAt,
    submittedBy: versionDoc.submittedBy,
    review: versionDoc.review,
    installs: versionDoc.installs,
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
