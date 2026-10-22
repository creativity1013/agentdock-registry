/**
 * SBOM（软件物料清单）生成。
 *
 * AgentDock 的能力包不执行代码，但会声明「依赖的外部资源」：agent 可用的工具、
 * plugin 引用的 MCP server / 命令、skill 的 allowed-tools。把这些声明与文件清单
 * 一起固化成 SBOM，随版本一起签名与上架，便于审计与供应链追踪。
 *
 * 格式 `agentdock-sbom@1`：subject + files[] + components[] + digest。
 * digest 对除 generatedAt 外的规范化内容做 sha256，保证可复现。
 */
import { sha256 } from './util.mjs';

export const SBOM_SCHEMA = 'agentdock-sbom@1';

function sortedFiles(bundle) {
  return [...bundle.manifestFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function toolComponents(manifest) {
  const components = [];
  const declared = Array.isArray(manifest?.tools)
    ? manifest.tools
    : Array.isArray(manifest?.capabilities?.tools)
      ? manifest.capabilities.tools
      : [];
  const tools = declared;
  for (const tool of tools) {
    const name = String(tool).trim();
    if (name) components.push({ type: 'tool', name });
  }
  const allowed = Array.isArray(manifest?.allowedTools) ? manifest.allowedTools : [];
  for (const tool of allowed) {
    const name = String(tool).trim();
    if (name) components.push({ type: 'tool', name });
  }
  return components;
}

function mcpComponents(manifest) {
  const components = [];
  const entries = Array.isArray(manifest?.capabilities?.mcpConfigs)
    ? manifest.capabilities.mcpConfigs
    : Array.isArray(manifest?.mcp)
      ? manifest.mcp
      : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const component = { type: 'mcp-server', name: String(entry.name || 'mcp-server') };
    if (entry.command) component.command = String(entry.command);
    if (entry.url) component.url = String(entry.url);
    components.push(component);
  }
  // agent frontmatter 的 mcp 是 server 名称列表（无 command/url）
  const declaredNames = Array.isArray(manifest?.capabilities?.mcp) ? manifest.capabilities.mcp : [];
  for (const name of declaredNames) {
    if (!components.some((component) => component.name === String(name))) {
      components.push({ type: 'mcp-server', name: String(name) });
    }
  }
  return components;
}

function skillComponents(bundle, manifest) {
  const components = [];
  const declared = manifest?.capabilities?.skills;
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (name) components.push({ type: 'skill', name: String(name) });
    }
  }
  if (components.length === 0 && bundle.kind === 'skill') {
    components.push({ type: 'skill', name: bundle.name });
  }
  return components;
}

/**
 * 生成 SBOM。
 * @param {object} bundle normalizeBundle 的产物
 * @param {object} manifest validateBundle 的产物（描述性 manifest）
 * @param {{generatedAt?:string}} [options]
 */
export function buildSbom(bundle, manifest, { generatedAt = null } = {}) {
  const files = sortedFiles(bundle).map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  const components = [...toolComponents(manifest), ...mcpComponents(manifest), ...skillComponents(bundle, manifest)];
  const counts = components.reduce((acc, component) => {
    acc[component.type] = (acc[component.type] || 0) + 1;
    return acc;
  }, {});
  const sbom = {
    schema: SBOM_SCHEMA,
    subject: {
      kind: bundle.kind,
      name: bundle.name,
      version: bundle.version,
      contentHash: bundle.contentHash,
    },
    files,
    components,
    summary: {
      fileCount: files.length,
      totalBytes: bundle.totalBytes,
      componentCount: components.length,
      counts,
    },
    generatedAt,
  };
  sbom.digest = sbomDigest(sbom);
  return sbom;
}

/** 对 generation 无关字段做规范化哈希（可复现） */
export function sbomDigest(sbom) {
  const payload = {
    schema: sbom.schema,
    subject: sbom.subject,
    files: sbom.files,
    components: sbom.components,
    summary: sbom.summary,
  };
  return sha256(JSON.stringify(payload));
}
