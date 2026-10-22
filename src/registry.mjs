/**
 * 外部 registry 互操作（Roadmap：GitHub / MCP registry）。
 *
 * 设计原则：
 * - **拉取而非推送**：导入时从外部 registry 读取能力包内容，经统一
 *   normalize → validate → scan 流水线后进入待审核队列；不把外部内容当可信输入。
 * - **网络出口白名单**：外部 base URL 只能来自服务端配置（环境变量），
 *   请求体只能给 repo / name 等标识符，避免把服务变成 SSRF 跳板。
 * - **零依赖**：只用全局 fetch；所有网络函数都接受注入的 fetchImpl 便于离线测试。
 * - **导出采用中立目录格式**：`agentdock-marketplace@1`，包含下载地址、内容哈希、
 *   平台/发布者签名摘要，其他 harness 可按需映射。
 */
import { isProbablyText } from './bundle.mjs';
import { parseFrontmatter } from './yaml.mjs';
import { sha256, nowIso } from './util.mjs';

export const SYNC_SOURCE_TYPES = ['github', 'mcp'];

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

export class RegistryError extends Error {
  constructor(message, { status = 502, details = null } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.details = details;
  }
}

function fetchImplOrDefault(fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') throw new RegistryError('当前运行时不支持 fetch');
  return impl;
}

async function request(url, { fetchImpl, token = '', headers = {} } = {}) {
  let response;
  try {
    response = await fetchImplOrDefault(fetchImpl)(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'agentdock-sync/1.0',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new RegistryError(
      timedOut ? `外部 registry 请求超时（${FETCH_TIMEOUT_MS}ms）：${url}` : `无法访问外部 registry：${url}（${error?.cause?.code || error?.message || '网络错误'}）`,
      { status: timedOut ? 504 : 502 },
    );
  }
  if (!response.ok) {
    throw new RegistryError(`外部 registry 返回 ${response.status}：${url}`, { details: await safeText(response) });
  }
  return response;
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}

function withQuery(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** 把任意字符串清洗成合法的能力包名（[a-z0-9._-]） */
export function slugifyName(input, fallback = 'imported-package') {
  const sanitized = String(input || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 63);
  return sanitized || fallback;
}

/** 从一组文件里识别能力包类型 */
export function detectKind(files) {
  const paths = new Set((files || []).map((file) => file.path));
  if (paths.has('plugin.json')) return 'plugin';
  if (paths.has('agent.md')) return 'agent';
  if (paths.has('SKILL.md')) return 'skill';
  return null;
}

/* ------------------------------ GitHub ------------------------------ */

/**
 * 导入 GitHub 仓库中的一个目录（或单文件）。
 * 目录内的相对路径会成为能力包内路径；隐藏文件、node_modules、超限内容会被跳过并告警。
 */
export async function importFromGitHub({
  repo,
  path: subPath = '',
  ref = '',
  apiBase,
  token = '',
  fetchImpl,
  maxFiles = MAX_FILES,
} = {}) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new RegistryError('repo 必须是 owner/repo 形式', { status: 400 });
  }
  if (!apiBase) throw new RegistryError('服务端未配置 GitHub API 地址', { status: 500 });
  const base = apiBase.replace(/\/+$/, '');
  const cleanPath = String(subPath || '').replace(/^\/+|\/+$/g, '');
  const apiUrl = `${base}/repos/${repo}/contents/${cleanPath ? cleanPath.split('/').map(encodeURIComponent).join('/') : ''}`;
  const listingUrl = ref
    ? `${apiUrl}?${new URLSearchParams({ ref }).toString()}`
    : apiUrl;
  const listingResponse = await request(listingUrl, { fetchImpl, token });
  let listing;
  try {
    listing = await listingResponse.json();
  } catch {
    throw new RegistryError('GitHub contents API 返回的不是合法 JSON');
  }
  const items = Array.isArray(listing) ? listing : [{ ...listing, __single: true }];
  const files = [];
  const warnings = [];
  let totalBytes = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'file') {
      warnings.push(`跳过非文件条目：${item.path || item.name}`);
      continue;
    }
    if (item.size > MAX_FILE_BYTES) {
      warnings.push(`跳过超大文件：${item.path}（${item.size} 字节）`);
      continue;
    }
    if (files.length >= maxFiles) {
      warnings.push(`文件数超过上限 ${maxFiles}，剩余内容已跳过`);
      break;
    }
    if (totalBytes + (item.size || 0) > MAX_TOTAL_BYTES) {
      warnings.push('内容总量超过上限，剩余文件已跳过');
      break;
    }
    const relativePath = item.__single
      ? String(item.name || cleanPath.split('/').pop() || 'file')
      : cleanRelativePath(item.path, cleanPath);
    if (!relativePath) {
      warnings.push(`跳过非法路径：${item.path || item.name}`);
      continue;
    }
    const content = await readGitHubFile(item, { fetchImpl, token });
    if (content === null) {
      warnings.push(`跳过无法读取的文件：${relativePath}`);
      continue;
    }
    const { buffer, text } = content;
    if (buffer.length > MAX_FILE_BYTES) {
      warnings.push(`跳过超大文件：${relativePath}`);
      continue;
    }
    totalBytes += buffer.length;
    files.push(
      isProbablyText(buffer)
        ? { path: relativePath, content: text, encoding: 'utf8' }
        : { path: relativePath, content: buffer.toString('base64'), encoding: 'base64' },
    );
  }

  if (files.length === 0) throw new RegistryError('GitHub 内容为空或全部被跳过');
  const kind = detectKind(files);
  return {
    source: { type: 'github', repo, path: cleanPath, ref, url: `https://github.com/${repo}` },
    kind,
    files,
    warnings,
    meta: await describeImportedFiles(files, { kind, fallbackName: slugifyName(cleanPath.split('/').pop() || repo) }),
  };
}

function cleanRelativePath(filePath, prefix) {
  let relative = String(filePath || '').replace(/\\/g, '/');
  if (prefix && relative.startsWith(`${prefix}/`)) relative = relative.slice(prefix.length + 1);
  const segments = relative.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const lowered = segments.map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment.startsWith('.'))) return '';
  if (lowered.some((segment) => ['node_modules', 'dist', 'build', 'coverage'].includes(segment))) return '';
  if (segments.length > 12) return '';
  return segments.join('/');
}

async function readGitHubFile(item, { fetchImpl, token }) {
  if (item.download_url) {
    const response = await request(item.download_url, { fetchImpl, token });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, text: buffer.toString('utf8') };
  }
  if (item.url) {
    const response = await request(item.url, { fetchImpl, token });
    const data = await response.json();
    if (data.encoding === 'base64' && typeof data.content === 'string') {
      const buffer = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
      return { buffer, text: buffer.toString('utf8') };
    }
    if (typeof data.content === 'string') {
      return { buffer: Buffer.from(data.content, 'utf8'), text: data.content };
    }
  }
  return null;
}

/* ------------------------------ MCP Registry ------------------------------ */

/**
 * 从 MCP registry 导入一个 server，转换为 AgentDock 的 plugin 能力包。
 * 已兼容 MCP registry 的 `{servers:[{server:{...}}]}` 与 `{server:{...}}` 响应形状。
 */
export async function importFromMcpRegistry({ name, baseUrl, fetchImpl, version = '' } = {}) {
  if (!name || typeof name !== 'string') throw new RegistryError('name 不能为空', { status: 400 });
  if (!baseUrl) throw new RegistryError('服务端未配置 MCP registry 地址', { status: 500 });
  const base = baseUrl.replace(/\/+$/, '');
  const listingUrl = withQuery(`${base}/v0/servers`, { search: name, ...(version ? { version } : {}) });
  const response = await request(listingUrl, { fetchImpl });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new RegistryError('MCP registry 返回的不是合法 JSON');
  }
  const candidates = Array.isArray(data.servers)
    ? data.servers.map((entry) => entry.server || entry)
    : data.server
      ? [data.server]
      : [];
  if (candidates.length === 0) throw new RegistryError(`MCP registry 未找到 server：${name}`, { status: 404 });
  const needle = name.toLowerCase();
  const server =
    candidates.find((entry) => String(entry.name || '').toLowerCase() === needle) ||
    candidates.find((entry) => String(entry.name || '').toLowerCase().includes(needle)) ||
    candidates[0];

  const plugin = mcpServerToPlugin(server);
  const files = [
    { path: 'plugin.json', content: `${JSON.stringify(plugin.manifest, null, 2)}\n`, encoding: 'utf8' },
    {
      path: 'registry-source.json',
      content: `${JSON.stringify({ source: 'mcp-registry', baseUrl, importedAt: nowIso(), server }, null, 2)}\n`,
      encoding: 'utf8',
    },
  ];
  return {
    source: { type: 'mcp', name: server.name || name, registry: base },
    kind: 'plugin',
    files,
    warnings: [],
    meta: {
      kind: 'plugin',
      name: plugin.name,
      version: plugin.version,
      description: plugin.manifest.description,
      tags: ['mcp', 'imported'],
    },
  };
}

export function mcpServerToPlugin(server = {}) {
  const rawName = String(server.name || 'mcp-server');
  const name = slugifyName(rawName.split('/').pop() || rawName, 'mcp-server');
  const version = normalizeSemver(server.version) || '0.1.0';
  const description = String(server.description || `MCP server ${rawName}`).slice(0, 512);
  const mcp = [];
  for (const remote of Array.isArray(server.remotes) ? server.remotes : []) {
    if (!remote || typeof remote !== 'object' || !remote.url) continue;
    mcp.push({ name: rawName, url: String(remote.url), ...(remote.type ? { transport: String(remote.type) } : {}) });
  }
  for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
    if (!pkg || typeof pkg !== 'object') continue;
    const command = pkg.identifier || pkg.name || pkg.registryType;
    if (!command) continue;
    const args = Array.isArray(pkg.packageArguments)
      ? pkg.packageArguments.map((argument) => argument.value || argument.name).filter(Boolean)
      : [];
    mcp.push({ name: rawName, command: String(command), ...(args.length ? { args } : {}) });
  }
  const manifest = {
    name,
    version,
    description,
    tags: ['mcp', 'imported'],
    mcp,
  };
  if (Array.isArray(server.repository) || typeof server.repository === 'string') {
    manifest.repository = typeof server.repository === 'string' ? server.repository : server.repository.url;
  }
  if (server.websiteUrl) manifest.homepage = String(server.websiteUrl);
  return { name, version, manifest };
}

function normalizeSemver(version) {
  const match = String(version || '').trim().match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : '';
}

/* ------------------------------ 导入元数据 ------------------------------ */

/** 从文件内容提取 name/version/description/tags（best-effort，最终仍由 validate 把关） */
export async function describeImportedFiles(files, { kind, fallbackName } = {}) {
  const find = (filePath) => files.find((file) => file.path === filePath);
  const textOf = (file) => (file && file.encoding === 'utf8' ? file.content : '');
  let name = fallbackName || 'imported-package';
  let version = '0.1.0';
  let description = '';
  let tags = ['imported'];

  if (kind === 'plugin') {
    const file = find('plugin.json');
    if (file) {
      try {
        const manifest = JSON.parse(textOf(file));
        if (manifest.name) name = slugifyName(manifest.name, name);
        if (manifest.version) version = String(manifest.version);
        if (manifest.description) description = String(manifest.description);
        if (Array.isArray(manifest.tags)) tags = ['imported', ...manifest.tags.map(String)];
      } catch {
        // validate 阶段会给出更准确的错误
      }
    }
  } else {
    const manifestFile = find(kind === 'agent' ? 'agent.md' : 'SKILL.md');
    if (manifestFile) {
      try {
        const { data } = parseFrontmatter(textOf(manifestFile));
        if (data.name) name = slugifyName(data.name, name);
        if (data.version) version = String(data.version);
        if (data.description) description = String(data.description);
      } catch {
        // 同上
      }
    }
  }
  return {
    kind: kind || null,
    name,
    version: normalizeSemver(version) || '0.1.0',
    description: description.slice(0, 1024),
    tags: [...new Set(tags.map((tag) => String(tag).slice(0, 32)))].slice(0, 10),
  };
}

export function describeAdapters(config) {
  return SYNC_SOURCE_TYPES.map((type) => ({
    type,
    label: type === 'github' ? 'GitHub 仓库' : 'MCP registry',
    baseUrl: type === 'github' ? config.registries?.githubApi : config.registries?.mcpRegistry,
    tokenConfigured: type === 'github' ? Boolean(config.githubToken) : false,
    description:
      type === 'github'
        ? '从 GitHub 仓库目录导入 skill（SKILL.md）/ agent（agent.md）/ plugin（plugin.json）'
        : '从 MCP registry 导入 server，转换为含 mcp 声明的 plugin 能力包',
  }));
}

/* ------------------------------ 导出目录 ------------------------------ */

/**
 * 生成中立的市场目录（schema: agentdock-marketplace@1）。
 * 其他 harness 可据此映射到自己的 marketplace 清单。
 */
export function buildMarketplaceCatalog(store, { baseUrl = '', generatedAt = nowIso() } = {}) {
  const listed = store.listPackages({});
  const items = [];
  for (const summary of listed.items) {
    if (!summary.latestVersion) continue;
    const versionDoc = store.getVersion(summary.kind, summary.name, summary.latestVersion);
    if (!versionDoc || versionDoc.status !== 'published') continue;
    const bundleUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/packages/${summary.kind}/${summary.name}/versions/${summary.latestVersion}/bundle`;
    items.push({
      kind: summary.kind,
      name: summary.name,
      description: summary.description || '',
      tags: summary.tags || [],
      latestVersion: summary.latestVersion,
      contentHash: versionDoc.contentHash || '',
      bundleUrl,
      signature: versionDoc.signature
        ? { algorithm: versionDoc.signature.algorithm, keyId: versionDoc.signature.keyId, signedAt: versionDoc.signature.signedAt }
        : null,
      publisherSignature: versionDoc.publisherSignature
        ? {
            algorithm: versionDoc.publisherSignature.algorithm,
            keyId: versionDoc.publisherSignature.keyId,
            keyName: versionDoc.publisherSignature.keyName,
            signedAt: versionDoc.publisherSignature.signedAt,
          }
        : null,
      installs: summary.installs || 0,
    });
  }
  return {
    schema: 'agentdock-marketplace@1',
    name: 'AgentDock',
    generatedAt,
    baseUrl,
    count: items.length,
    items,
    digest: sha256(JSON.stringify(items)),
  };
}
