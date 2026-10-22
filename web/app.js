/* AgentDock Web UI —— 零依赖原生 JS */
'use strict';

const API = '/api/v1';
const ROLE_RANK = { viewer: 0, publisher: 1, reviewer: 2, admin: 3 };
const ROLE_LABEL = { viewer: '只读', publisher: '发布者', reviewer: '审核者', admin: '管理员' };
const KIND_LABEL = { skill: '技能', agent: '智能体', plugin: '插件' };
const TARGETS = [
  ['dsh', 'DSH (~/.dsh)'],
  ['dsh-agent', 'DSH Agent Preset (~/.dsh/agentdock/presets)'],
  ['claude', 'Claude Code (~/.claude)'],
  ['codex', 'Codex CLI (~/.codex)'],
  ['shared', '共享目录 (~/.agents)'],
  ['dir', '自定义目录'],
];

const state = {
  token: localStorage.getItem('agentdock.token') || '',
  user: null,
  view: 'market',
  q: '',
  kind: '',
  detail: null,
  reviewCount: 0,
  reviewKind: '',
  reviewRisk: 'all',
  auditTenant: '',
  page: 1,
};

const $ = (selector) => document.querySelector(selector);

/* ------------------------------ 工具函数 ------------------------------ */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function can(role) {
  if (!state.user) return false;
  return (ROLE_RANK[state.user.role] ?? -1) >= (ROLE_RANK[role] ?? 99);
}

function kb(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(value) {
  if (!value) return '-';
  return value.slice(0, 19).replace('T', ' ');
}

function kindChip(kind) {
  return h('span', { class: `chip ${kind}` }, KIND_LABEL[kind] || kind);
}

function statusChip(status, label) {
  return h('span', { class: `chip ${status}` }, label || status);
}

const QUALITY_LABEL = { community: '社区', verified: '已验证', official: '官方' };

function qualityChip(quality) {
  if (!quality || !quality.level || quality.level === 'community') return null;
  return h('span', { class: `chip quality-${quality.level}` }, QUALITY_LABEL[quality.level] || quality.label || quality.level);
}

function scanChips(scan) {
  if (!scan || !scan.summary || scan.summary.total === 0) {
    return [h('span', { class: 'chip' }, '扫描 · 无问题')];
  }
  const { high, medium, low } = scan.summary;
  const chips = [];
  if (high > 0) chips.push(h('span', { class: 'chip warn' }, `高危 ${high}`));
  if (medium > 0) chips.push(h('span', { class: 'chip' }, `中危 ${medium}`));
  if (low > 0) chips.push(h('span', { class: 'chip' }, `低危 ${low}`));
  return chips;
}

const RULE_GROUPS = {
  PI: '提示注入',
  EX: '数据外发',
  SEC: '密钥泄漏',
  SH: '危险命令',
  EXEC: '动态执行',
  PER: '持久化/配置篡改',
  HID: '隐藏内容',
  NET: '环境密钥',
  MET: '结构检查',
  BIN: '二进制',
  SUP: '供应链',
};

function ruleGroup(ruleId) {
  return RULE_GROUPS[String(ruleId || '').split('-')[0]] || '其他';
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

/** 扫描发现列表（按严重度排序，含规则组与命中片段）；详情页与审核队列共用 */
const SEV_CN = { high: '高危', medium: '中危', low: '低危' };

/** 当前版本的判定结论：具体触发了哪些条件，从而判定为高/中/低危 */
function scanVerdictBlock(scan) {
  const findings = scan?.findings || [];
  if (findings.length === 0) return null;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] || 0) + 1;
  const level = counts.high ? 'high' : counts.medium ? 'medium' : 'low';
  const rows = [];
  for (const sev of ['high', 'medium', 'low']) {
    if (counts[sev] === 0) {
      rows.push(h('div', { class: 'verdict-row muted' }, `未触发${SEV_CN[sev]}条件`));
      continue;
    }
    rows.push(h('div', { class: 'verdict-row' }, `触发 ${counts[sev]} 条${SEV_CN[sev]}条件：`));
    for (const item of findings.filter((x) => x.severity === sev)) {
      rows.push(h('div', { class: 'verdict-cond' }, `· ${item.ruleId} ${item.condition || item.title}`, h('span', { class: 'muted' }, `（${item.file}${item.line ? `#L${item.line}` : ''}）`)));
    }
  }
  return h('div', { class: 'scan-verdict' },
    h('div', { class: 'verdict-head' }, `当前版本判定：`, h('span', { class: `sev ${level}` }, SEV_CN[level]), h('span', { class: 'muted' }, '（取命中条件中的最高等级）')),
    ...rows);
}

function scanLegend() {
  return h('div', { class: 'scan-legend' },
    h('div', { class: 'legend-item' }, h('span', { class: 'sev high' }, '高危'), '可能导致凭据泄漏、命令执行或劫持 agent 行为；默认阻止发布，必须人工确认'),
    h('div', { class: 'legend-item' }, h('span', { class: 'sev medium' }, '中危'), '可疑信号，需结合能力用途与上下文判断；不默认阻断'),
    h('div', { class: 'legend-item' }, h('span', { class: 'sev low' }, '低危'), '编码不规范或轻微风险提示；通常不阻断'));
}

function findingsList(scan) {
  const findings = [...(scan?.findings || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  if (findings.length === 0) return [h('span', { class: 'muted' }, '未发现问题（静态规则级扫描，不代表绝对安全）')];
  return [
    scanLegend(),
    scanVerdictBlock(scan),
    ...findings.map((finding) =>
      h(
        'div',
        { class: 'finding' },
        h(
          'div',
          { class: 'finding-head' },
          h('span', { class: `sev ${finding.severity}` }, finding.severity),
          h('span', { class: 'mono' }, finding.ruleId),
          h('span', { class: 'tag' }, ruleGroup(finding.ruleId)),
          h('span', {}, finding.title),
          h('span', { class: 'muted' }, `${finding.file}${finding.line ? `#L${finding.line}` : ''}`),
        ),
        finding.snippet ? h('div', { class: 'snippet mono' }, finding.snippet) : null,
        h('div', { class: 'finding-reason' }, `触发条件：${finding.condition || finding.title}`),
      ),
    ),
  ];
}

/** 增量扫描说明（SUP-002：与哪个基准版本比对） */
function diffNote(scan, onOpenDiff) {
  if (!scan?.diff?.base) return null;
  return h(
    'div',
    { class: 'diff-note' },
    h('span', { class: 'chip' }, `增量扫描 · 对比 ${scan.diff.base}`),
    onOpenDiff ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: onOpenDiff }, '查看差异') : null,
  );
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const csrf = cookieValue(CSRF_COOKIE);
  if (csrf) headers['x-agentdock-csrf'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const firstError = data?.error?.details?.errors?.[0];
    const suffix = firstError?.message ? `：${firstError.field ? `${firstError.field} ` : ''}${firstError.message}` : '';
    const error = new Error((data?.error?.message || `HTTP ${response.status}`) + suffix);
    error.status = response.status;
    error.details = data?.error?.details ?? null;
    throw error;
  }
  return data;
}

let toastTimer = null;
function toast(message, type = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3600);
}

const CSRF_COOKIE = 'agentdock_csrf';

function cookieValue(name) {
  for (const part of (document.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return '';
}

function renderError(error) {
  const main = $('#main');
  main.replaceChildren(
    h(
      'div',
      { class: 'empty' },
      h('p', {}, `加载失败：${error.message}`),
      error.status === 401 ? h('p', { class: 'hint' }, '需要登录：右上角粘贴令牌（初始化令牌见 data/BOOTSTRAP-TOKENS.txt）') : null,
    ),
  );
}

/* ------------------------------ 登录态 ------------------------------ */

function renderAuth() {
  const slot = $('#auth-slot');
  slot.replaceChildren();
  if (state.user) {
    const roleText = ROLE_LABEL[state.user.role] || state.user.role;
    const tenantText = state.user.tenant && state.user.tenant !== 'default' ? ` · ${state.user.tenant}` : '';
    slot.append(
      h(
        'span',
        { class: 'user-chip' },
        h('span', {}, state.user.name),
        h('span', { class: 'role' }, `${roleText}${tenantText}`),
      ),
      h('button', { class: 'btn', type: 'button', onClick: logout }, '退出'),
    );
    return;
  }
  const input = h('input', {
    id: 'token-input',
    type: 'password',
    placeholder: '粘贴令牌后登录（publisher / reviewer / admin）',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  input.value = state.token || '';
  slot.append(input, h('button', { class: 'btn btn-primary', type: 'button', onClick: login }, '登录'));
  if (state.oidcEnabled) {
    slot.append(
      h('a', { class: 'btn', href: '/auth/oidc/login' }, 'SSO 登录'),
      h('span', { class: 'hint' }, '使用组织账号登录（OIDC）'),
    );
  }
}

async function login() {
  const input = $('#token-input');
  const token = (input?.value || '').trim();
  if (!token) return toast('请先粘贴令牌', 'error');
  state.token = token;
  try {
    await loadMe();
    localStorage.setItem('agentdock.token', token);
    renderAuth();
    updateTabs();
    toast(`已登录：${state.user.name}（${ROLE_LABEL[state.user.role]}）`, 'ok');
    render();
  } catch (error) {
    state.token = '';
    renderAuth();
    toast(`登录失败：${error.message}`, 'error');
  }
}

async function logout() {
  if (!state.token) {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'x-agentdock-csrf': cookieValue(CSRF_COOKIE) },
      });
    } catch {
      /* 忽略 */
    }
  }
  state.token = '';
  state.user = null;
  localStorage.removeItem('agentdock.token');
  renderAuth();
  updateTabs();
  render();
  toast('已退出登录');
}

async function loadMe() {
  const data = await api('/me');
  state.user = data.user;
}

/* ------------------------------ 标签页 ------------------------------ */

function updateTabs() {
  for (const button of document.querySelectorAll('.tab')) {
    const view = button.dataset.view;
    let disabled = false;
    if (view === 'review' || view === 'audit') disabled = !can('reviewer');
    if (view === 'policy') disabled = !can('admin');
    if (view === 'tokens') disabled = !can('admin');
    button.disabled = disabled;
    button.title = disabled ? '需要更高角色权限' : '';
  }
  if (state.view === 'review' && !can('reviewer')) state.view = 'market';
  if (state.view === 'audit' && !can('reviewer')) state.view = 'market';
  if (state.view === 'policy' && !can('admin')) state.view = 'market';
  if (state.view === 'tokens' && !can('admin')) state.view = 'market';
}

function markTab() {
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.dataset.view === state.view);
  }
}

async function refreshBadge() {
  const badge = $('#review-badge');
  if (!can('reviewer')) {
    badge.classList.add('hidden');
    return;
  }
  try {
    const queue = await api('/review/queue');
    state.reviewCount = queue.total;
    badge.textContent = String(queue.total);
    badge.classList.toggle('hidden', queue.total === 0);
  } catch {
    badge.classList.add('hidden');
  }
}

/* ------------------------------ 视图调度 ------------------------------ */

async function render() {
  markTab();
  updateTabs();
  const main = $('#main');
  try {
    if (state.view === 'market') await renderMarket(main);
    else if (state.view === 'review') await renderReview(main);
    else if (state.view === 'audit') await renderAudit(main);
    else if (state.view === 'policy') await renderPolicy(main);
    else if (state.view === 'tokens') await renderTokens(main);
  } catch (error) {
    renderError(error);
  }
}

/* ------------------------------ 市场 ------------------------------ */

async function renderMarket(main) {
  const pageSize = 12;
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.kind) params.set('kind', state.kind);
  params.set('page', String(state.page));
  params.set('pageSize', String(pageSize));

  const [stats, list] = await Promise.all([
    api('/stats'),
    api(`/packages?${params.toString()}`),
  ]);

  const statsGrid = h(
    'div',
    { class: 'stats' },
    statCard('能力包', stats.packages),
    statCard('技能', stats.byKind.skill || 0),
    statCard('智能体', stats.byKind.agent || 0),
    statCard('插件', stats.byKind.plugin || 0),
    statCard('待审核', stats.pending),
    statCard('累计安装', stats.installs),
  );

  const search = h('input', {
    type: 'search',
    placeholder: '搜索名称 / 描述 / 标签…',
    value: state.q,
    onInput: () => {
      state.q = search.value.trim();
      state.page = 1;
      clearTimeout(search._timer);
      search._timer = setTimeout(() => render(), 260);
    },
  });

  const kindSelect = h(
    'select',
    { onChange: () => (state.kind = kindSelect.value, state.page = 1, render()) },
    h('option', { value: '' }, '全部类型'),
    ...Object.entries(KIND_LABEL).map(([value, label]) => h('option', { value }, label)),
  );
  kindSelect.value = state.kind;

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    search,
    kindSelect,
    h('button', { class: 'btn', type: 'button', onClick: () => render() }, '刷新'),
    can('publisher')
      ? h('button', { class: 'btn btn-primary', type: 'button', onClick: () => $('#publish-file').click() }, '导入能力包')
      : null,
    can('publisher') ? h('button', { class: 'btn', type: 'button', onClick: () => $('#publish-folder').click() }, '导入文件夹') : null,
    can('publisher') ? h('button', { class: 'btn', type: 'button', onClick: importFromRegistry }, '从远端仓库导入') : null,
    h('a', { class: 'btn btn-ghost', href: '/api/v1/registry/export', target: '_blank', rel: 'noreferrer' }, '导出目录'),
  );

  const grid = list.items.length
    ? h('div', { class: 'package-grid' }, ...list.items.map(packageCard))
    : h('div', { class: 'empty' }, h('p', {}, '还没有已发布的能力包'), can('publisher') ? h('p', { class: 'hint' }, '支持 JSON / ZIP / tar.gz / 单文件 MD / 文件夹；也可用 CLI：agentdock publish <文件或目录>') : null);

  const pager = list.totalPages > 1
    ? h(
        'div',
        { class: 'pager' },
        h('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          disabled: list.page <= 1,
          onClick: () => {
            state.page = list.page - 1;
            render();
          },
        }, '上一页'),
        h('span', { class: 'muted' }, `第 ${list.page} / ${list.totalPages} 页`),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          disabled: list.page >= list.totalPages,
          onClick: () => {
            state.page = list.page + 1;
            render();
          },
        }, '下一页'),
      )
    : null;

  main.replaceChildren(
    statsGrid,
    toolbar,
    h('div', { class: 'section-title' }, h('h2', {}, '能力市场'), h('span', { class: 'muted' }, `共 ${list.total} 个`)),
    grid,
    pager,
  );
}

function statCard(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, String(value)));
}

function packageCard(item) {
  return h(
    'div',
    { class: 'package-card', tab: '0', role: 'button', onClick: () => openDetail(item.kind, item.name) },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'package-name' }, item.name),
      h('span', { class: 'version' }, `v${item.latestVersion}`),
    ),
    h('div', { class: 'card-meta' }, kindChip(item.kind), statusChip(item.status, item.status === 'published' ? '已发布' : item.status), qualityChip(item.quality), ...scanChips(item.scanSummary ? { summary: item.scanSummary } : null)),
    h('p', { class: 'package-desc' }, item.description || '(无描述)'),
    item.manifest?.capabilities ? h('div', { class: 'capabilities' }, describeCapabilities(item.manifest.capabilities)) : null,
    h(
      'div',
      { class: 'card-meta' },
      h('span', {}, `安装 ${item.installs}`),
      h('span', {}, `${item.fileCount} 个文件 · ${kb(item.totalBytes)}`),
      h('span', {}, `更新 ${fmtTime(item.updatedAt)}`),
    ),
    item.tags?.length > 0 ? h('div', { class: 'tags' }, ...item.tags.slice(0, 6).map((tag) => h('span', { class: 'tag' }, tag))) : null,
  );
}

function describeCapabilities(capabilities) {
  if (!capabilities) return '';
  const parts = [];
  if (capabilities.entry) parts.push(`入口 ${capabilities.entry}`);
  if (capabilities.tools?.length) parts.push(`${capabilities.tools.length} 个工具`);
  if (capabilities.model) parts.push(`模型 ${capabilities.model}`);
  if (capabilities.skills?.length) parts.push(`${capabilities.skills.length} 个技能`);
  if (capabilities.agents?.length) parts.push(`${capabilities.agents.length} 个 agent`);
  if (capabilities.mcp?.length) parts.push(`${capabilities.mcp.length} 个 MCP`);
  return parts.join(' · ');
}

/* ------------------------------ Markdown 渲染（安全子集） ------------------------------ */

function inlineNodes(text) {
  const nodes = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(h('code', {}, token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      nodes.push(h('strong', {}, token.slice(2, -2)));
    } else if (token.startsWith('*')) {
      nodes.push(h('em', {}, token.slice(1, -1)));
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      nodes.push(h('a', { href: link[2], target: '_blank', rel: 'noopener noreferrer' }, link[1]));
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 把 markdown 文本渲染为 DOM（先转文本节点，天然防 XSS；只放行 http(s) 链接） */
function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const fragment = document.createDocumentFragment();
  const paragraph = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    fragment.append(h('p', {}, ...inlineNodes(paragraph.join(' '))));
    paragraph.length = 0;
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      fragment.append(
        h('pre', { class: 'code' }, h('code', { class: fence[1] ? `lang-${fence[1]}` : null }, code.join('\n'))),
      );
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      fragment.append(h(`h${Math.min(heading[1].length + 1, 5)}`, {}, ...inlineNodes(heading[2])));
      index += 1;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flush();
      fragment.append(h('hr'));
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      fragment.append(h('blockquote', {}, ...inlineNodes(quote.join(' '))));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(h('li', {}, ...inlineNodes(lines[index].replace(/^[-*]\s+/, ''))));
        index += 1;
      }
      fragment.append(h('ul', {}, ...items));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flush();
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(h('li', {}, ...inlineNodes(lines[index].replace(/^\d+\.\s+/, ''))));
        index += 1;
      }
      fragment.append(h('ol', {}, ...items));
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return fragment;
}

/* ------------------------------ 审核差异视图 ------------------------------ */

async function openDiff(pkg, version) {
  const modal = $('#diff-modal');
  const body = $('#diff-body');
  body.replaceChildren(h('p', { class: 'muted' }, '加载差异中…'));
  modal.classList.remove('hidden');
  try {
    const data = await api(
      `/packages/${encodeURIComponent(pkg.kind)}/${encodeURIComponent(pkg.name)}/diff?to=${encodeURIComponent(version)}`,
    );
    paintDiff(pkg, data);
  } catch (error) {
    body.replaceChildren(h('div', { class: 'empty' }, `无法加载差异：${error.message}`));
  }
}

function closeDiff() {
  $('#diff-modal').classList.add('hidden');
}

function diffLineNode(line) {
  return h(
    'div',
    { class: `diff-line ${line.type}` },
    h('span', { class: 'gutter' }, line.type === 'add' ? '' : String(line.oldLine ?? '')),
    h('span', { class: 'gutter' }, line.type === 'del' ? '' : String(line.newLine ?? '')),
    h('span', { class: 'sign' }, line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '),
    h('span', { class: 'text' }, line.text || ' '),
  );
}

function paintDiff(pkg, data) {
  const body = $('#diff-body');
  const head = h(
    'div',
    { class: 'detail-head' },
    kindChip(pkg.kind),
    h('h2', {}, pkg.name),
    h('span', { class: 'version' }, data.from ? `v${data.from.version} → v${data.to.version}` : `新增 v${data.to.version}`),
  );
  const stats = h(
    'div',
    { class: 'diff-stats' },
    h('span', { class: 'chip add' }, `+${data.stats.added} 新增`),
    h('span', { class: 'chip del' }, `−${data.stats.removed} 删除`),
    h('span', { class: 'chip' }, `~${data.stats.modified} 修改`),
    h('span', { class: 'chip' }, `${data.stats.addedLines} 行新增 / ${data.stats.removedLines} 行删除`),
    data.to.status !== 'published' ? h('span', { class: 'chip warn' }, '待审核版本') : null,
  );
  const files = data.files.length
    ? data.files.map((file) =>
        h(
          'div',
          { class: 'diff-file' },
          h(
            'div',
            { class: 'diff-file-head' },
            h('span', { class: 'mono' }, file.path),
            h('span', { class: `status ${file.status}` }, file.status === 'added' ? '新增' : file.status === 'removed' ? '删除' : '修改'),
            file.binary ? h('span', { class: 'muted' }, '二进制文件') : null,
            file.tooLarge ? h('span', { class: 'muted' }, '文件较大，未逐行对比') : null,
          ),
          file.lines ? h('div', { class: 'diff-lines' }, ...file.lines.map(diffLineNode)) : null,
        ),
      )
    : [h('div', { class: 'empty' }, '两个版本内容一致')];
  body.replaceChildren(
    head,
    stats,
    data.truncated ? h('p', { class: 'hint' }, '文件较多，仅展示前 100 个有变化的文件。') : null,
    h('div', { class: 'diff-body' }, ...files),
  );
}

/* ------------------------------ SBOM 视图 ------------------------------ */

async function openSbom(pkg, version) {
  const modal = $('#diff-modal');
  const body = $('#diff-body');
  body.replaceChildren(h('p', { class: 'muted' }, '加载 SBOM 中…'));
  modal.classList.remove('hidden');
  try {
    const data = await api(
      `/packages/${encodeURIComponent(pkg.kind)}/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version)}/sbom`,
    );
    paintSbom(pkg, data.sbom);
  } catch (error) {
    body.replaceChildren(h('div', { class: 'empty' }, `无法加载 SBOM：${error.message}`));
  }
}

function paintSbom(pkg, sbom) {
  const body = $('#diff-body');
  const head = h(
    'div',
    { class: 'detail-head' },
    kindChip(pkg.kind),
    h('h2', {}, pkg.name),
    h('span', { class: 'version' }, `v${sbom.subject.version} · SBOM`),
  );
  const stats = h(
    'div',
    { class: 'diff-stats' },
    h('span', { class: 'chip' }, sbom.schema),
    h('span', { class: 'chip' }, `文件 ${sbom.summary.fileCount}`),
    h('span', { class: 'chip' }, `组件 ${sbom.summary.componentCount}`),
    h('span', { class: 'chip' }, `总计 ${kb(sbom.summary.totalBytes)}`),
  );
  const digest = h('p', { class: 'hint mono' }, `digest ${sbom.digest}`);
  const componentRows = sbom.components.length
    ? sbom.components.map((component) =>
        h(
          'div',
          { class: 'file-row' },
          h('span', { class: 'mono' }, `[${component.type}]`),
          h('span', {}, component.name),
          h('span', { class: 'size mono' }, component.command || component.url || ''),
        ),
      )
    : [h('div', { class: 'empty' }, '没有外部依赖声明')];
  const fileRows = sbom.files.map((file) =>
    h(
      'div',
      { class: 'file-row' },
      h('span', { class: 'mono' }, file.path),
      h('span', { class: 'size mono' }, `${kb(file.bytes)} · ${file.sha256.slice(0, 16)}…`),
    ),
  );
  body.replaceChildren(
    head,
    stats,
    digest,
    h('div', { class: 'panel' }, h('h3', {}, '组件（依赖声明）'), h('div', { class: 'file-list' }, ...componentRows)),
    h('div', { class: 'panel' }, h('h3', {}, '文件清单'), h('div', { class: 'file-list' }, ...fileRows)),
  );
}

/* ------------------------------ 详情弹窗 ------------------------------ */

async function openDetail(kind, name) {
  try {
    const pkg = await api(`/packages/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
    state.detail = { pkg, selectedVersion: pkg.versions[0]?.version || null, preview: null, installResult: null };
    paintDetail();
    $('#modal').classList.remove('hidden');
  } catch (error) {
    toast(`打开失败：${error.message}`, 'error');
  }
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.detail = null;
}

function paintPreview() {
  const preview = state.detail.preview;
  if (!preview) return null;
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(preview.path || '');
  const rendered = isMarkdown && !preview.raw;
  return h(
    'div',
    { class: 'preview' },
    h(
      'div',
      { class: 'preview-bar' },
      h('span', { class: 'mono muted' }, preview.path || ''),
      isMarkdown
        ? h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            onClick: () => {
              preview.raw = !preview.raw;
              paintDetail();
            },
          }, rendered ? '查看原文' : '渲染 markdown')
        : null,
    ),
    rendered ? h('div', { class: 'md' }, renderMarkdown(preview.content)) : h('pre', { class: 'code' }, preview.content),
  );
}

async function verifySignature(pkg, version) {
  try {
    const data = await api(
      `/packages/${encodeURIComponent(pkg.kind)}/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version)}/signature?verify=1`,
    );
    if (data.valid) {
      toast(`签名有效 · ${data.keyId.slice(0, 16)}… · 内容完整性校验通过`, 'ok');
    } else {
      toast(`验签未通过：${(data.reasons || []).join('；')}`, 'error');
    }
  } catch (error) {
    toast(`验签失败：${error.message}`, 'error');
  }
}

async function showProof(pkg, version) {
  try {
    const query = new URLSearchParams({ kind: pkg.kind, name: pkg.name, version });
    const data = await api(`/transparency/proof?${query.toString()}`);
    toast(
      `透明日志包含证明：#${data.entry.seq}（index ${data.index} / size ${data.size}），Merkle 根 ${data.root.slice(0, 16)}… 可用 CLI 离线校验`,
      'ok',
    );
  } catch (error) {
    toast(`获取包含证明失败：${error.message}`, 'error');
  }
}

function paintDetail() {
  const body = $('#modal-body');
  const { pkg } = state.detail;
  const selected = pkg.versions.find((item) => item.version === state.detail.selectedVersion) || pkg.versions[0] || null;

  const head = h(
    'div',
    { class: 'detail-head' },
    kindChip(pkg.kind),
    h('h2', {}, pkg.name),
    selected ? h('span', { class: 'version' }, `v${selected.version}`) : null,
    selected ? statusChip(selected.status, selected.statusLabel) : null,
    selected ? qualityChip(selected.quality) : null,
  );

  const sub = h('p', { class: 'detail-sub' }, pkg.description || '(无描述)');

  const kv = h(
    'div',
    { class: 'panel' },
    h('h3', {}, '概览'),
    h(
      'div',
      { class: 'kv' },
      h('span', { class: 'k' }, '类型'),
      h('span', { class: 'v' }, KIND_LABEL[pkg.kind] || pkg.kind),
      h('span', { class: 'k' }, '质量分级'),
      h('span', { class: 'v' }, selected?.quality ? `${QUALITY_LABEL[selected.quality.level] || selected.quality.level}（${selected.quality.level}）` : '-'),
      h('span', { class: 'k' }, '最新版本'),
      h('span', { class: 'v' }, pkg.latestVersion ? `v${pkg.latestVersion}` : '-'),
      h('span', { class: 'k' }, '累计安装'),
      h('span', { class: 'v' }, String(pkg.installs)),
      h('span', { class: 'k' }, '创建者'),
      h('span', { class: 'v' }, pkg.createdBy || '-'),
      h('span', { class: 'k' }, '创建时间'),
      h('span', { class: 'v' }, fmtTime(pkg.createdAt)),
      selected ? h('span', { class: 'k' }, '内容哈希') : null,
      selected ? h('span', { class: 'v' }, selected.contentHash.slice(0, 24) + '…') : null,
      selected?.manifest?.capabilities ? h('span', { class: 'k' }, '能力') : null,
      selected?.manifest?.capabilities ? h('span', { class: 'v' }, describeCapabilities(selected.manifest.capabilities) || '-') : null,
      selected?.signature ? h('span', { class: 'k' }, '内容签名') : null,
      selected?.signature
        ? h(
            'span',
            { class: 'v' },
            h('span', { class: 'mono' }, `ed25519 · ${selected.signature.keyId.slice(0, 16)}…`),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onClick: () => verifySignature(pkg, selected.version),
            }, '验签'),
          )
        : null,
      selected?.publisherSignature ? h('span', { class: 'k' }, '发布者签名') : null,
      selected?.publisherSignature
        ? h(
            'span',
            { class: 'v' },
            h(
              'span',
              { class: 'mono' },
              `ed25519 · ${selected.publisherSignature.keyId.slice(0, 16)}…` +
                (selected.publisherSignature.keyName ? ` · ${selected.publisherSignature.keyName}` : ''),
            ),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onClick: () => showProof(pkg, selected.version),
            }, '透明证明'),
          )
        : null,
    ),
  );

  const versionList = pkg.versions.length
    ? h(
        'div',
        { class: 'panel' },
        h('h3', {}, `版本（${pkg.versions.length}）`),
        h(
          'div',
          { class: 'version-list' },
          ...pkg.versions.map((version) =>
            h(
              'div',
              { class: 'version-row' },
              h('button', {
                class: 'btn btn-ghost btn-sm mono',
                type: 'button',
                onClick: () => {
                  state.detail.selectedVersion = version.version;
                  state.detail.preview = null;
                  state.detail.installResult = null;
                  paintDetail();
                },
              }, `v${version.version}`),
              statusChip(version.status, version.statusLabel),
              version.review?.auto ? h('span', { class: 'chip auto' }, '自动审批') : null,
              h('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                onClick: () => openDiff(pkg, version.version),
              }, '差异'),
              h('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                onClick: () => openSbom(pkg, version.version),
              }, 'SBOM'),
              h('span', { class: 'grow muted' }, `${version.fileCount} 文件 · ${kb(version.totalBytes)} · ${fmtTime(version.submittedAt)} · ${version.submittedBy}`),
              ...scanChips(version.scan),
            ),
          ),
        ),
      )
    : h('div', { class: 'panel' }, h('h3', {}, '版本'), h('p', { class: 'hint' }, '暂无可见版本（未发布版本仅审核者可见）'));

  const files = selected
    ? h(
        'div',
        { class: 'panel' },
        h('h3', {}, '文件'),
        h(
          'div',
          { class: 'file-list' },
          ...(selected.files || []).map((file) =>
            h(
              'div',
              { class: 'file-row', onClick: () => previewFile(pkg, selected.version, file.path) },
              h('span', {}, file.path),
              h('span', { class: 'size' }, kb(file.bytes)),
            ),
          ),
        ),
        paintPreview(),
      )
    : null;

  const scanPanel = selected?.scan
    ? h(
        'div',
        { class: 'panel' },
        h('h3', {}, '安全扫描'),
        diffNote(selected.scan, () => openDiff(pkg, selected.version)),
        h('div', { class: 'findings' }, ...findingsList(selected.scan)),
      )
    : null;

  const actions = h('div', { class: 'actions' }, ...actionControls(pkg, selected));

  body.replaceChildren(head, sub, kv, versionList, files, scanPanel, actions);
}

function actionControls(pkg, selected) {
  const nodes = [];
  if (!state.user) {
    nodes.push(h('span', { class: 'hint' }, '登录后可安装与审核（右上角粘贴令牌）'));
    return nodes;
  }
  if (selected && selected.status === 'published') {
    const availableTargets = TARGETS.filter(([value]) => value !== 'dsh-agent' || pkg.kind === 'agent');
    const targetSelect = h('select', {}, ...availableTargets.map(([value, label]) => h('option', { value }, label)));
    const dirInput = h('input', { placeholder: '自定义安装目录，例如 ~/.agents', style: 'display:none' });
    targetSelect.addEventListener('change', () => {
      dirInput.style.display = targetSelect.value === 'dir' ? '' : 'none';
    });
    const force = h('input', { type: 'checkbox', id: 'install-force' });
    const localCommand = `agentdock install ${pkg.kind}/${pkg.name}@${selected.version} --target <dsh|dsh-agent|claude|codex|shared|dir>`;
    nodes.push(
      h('span', { class: 'hint' }, '成员本机安装（把命令复制到成员自己的机器执行）：'),
      h('div', { class: 'cmd-row' },
        h('code', { class: 'cmd' }, localCommand),
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(localCommand);
              toast('命令已复制', 'ok');
            } catch {
              toast('复制失败，请手动选择命令文本', 'error');
            }
          },
        }, '复制'),
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onClick: async () => {
            try {
              const data = await api(`/packages/${pkg.kind}/${pkg.name}/versions/${selected.version}/bundle`);
              const blob = new Blob([JSON.stringify(data.bundle ?? data, null, 2)], { type: 'application/json' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = `${pkg.kind}-${pkg.name}-${selected.version}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            } catch (error) {
              toast(`下载失败：${error.message}`, 'error');
            }
          },
        }, '下载 JSON 包')),
      h('span', { class: 'hint' }, '安装到平台主机（仅单机/演示用；写入的是运行 AgentDock 的这台机器）：'),
      targetSelect,
      dirInput,
      h('label', { class: 'hint' }, force, ' 覆盖已有文件'),
      pkg.kind === 'agent'
        ? h('span', { class: 'hint' }, 'dsh-agent 会生成 DSH preset 片段；要自动并入 profile，请用 CLI：agentdock install … --profile <名字>')
        : null,
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onClick: async (event) => {
            event.target.disabled = true;
            try {
              const result = await api('/install', {
                method: 'POST',
                body: {
                  kind: pkg.kind,
                  name: pkg.name,
                  version: selected.version,
                  target: targetSelect.value,
                  dir: dirInput.value.trim() || undefined,
                  force: force.checked,
                },
              });
              state.detail.installResult = result;
              paintDetail();
              toast(`已安装到平台主机 ${result.absolutePath}`, 'ok');
              refreshBadge();
            } catch (error) {
              toast(`安装失败：${error.message}`, 'error');
            } finally {
              event.target.disabled = false;
            }
          },
        },
        '安装到平台主机',
      ),
      state.detail.installResult
        ? h('span', { class: 'hint' }, `✓ 平台主机：${state.detail.installResult.absolutePath}（${state.detail.installResult.installedFiles} 个文件）`)
        : null,
    );
  }
  if (selected && selected.status === 'pending' && can('reviewer')) {
    const note = h('input', { placeholder: '审核备注（可选）' });
    nodes.push(
      h('span', { class: 'hint' }, '审核：'),
      note,
      h('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onClick: () => openDiff(pkg, selected.version),
      }, '查看差异'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onClick: () => reviewAction(pkg, selected, 'approve', note.value),
        },
        '通过',
      ),
      h(
        'button',
        { class: 'btn btn-danger', type: 'button', onClick: () => reviewAction(pkg, selected, 'reject', note.value) },
        '拒绝',
      ),
    );
  }
  return nodes;
}

async function reviewAction(pkg, selected, decision, note) {
  try {
    await api('/review', {
      method: 'POST',
      body: { kind: pkg.kind, name: pkg.name, version: selected.version, decision, note: note || '' },
    });
    toast(`已${decision === 'approve' ? '通过' : '拒绝'} ${pkg.name}@${selected.version}`, 'ok');
    closeModal();
    refreshBadge();
    render();
  } catch (error) {
    toast(`操作失败：${error.message}`, 'error');
  }
}

async function previewFile(pkg, version, filePath) {
  try {
    const data = await api(`/packages/${encodeURIComponent(pkg.kind)}/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version)}/files?path=${encodeURIComponent(filePath)}`);
    state.detail.preview = { version, path: filePath, content: data.file.content, raw: false };
    paintDetail();
  } catch (error) {
    toast(`读取文件失败：${error.message}`, 'error');
  }
}

/* ------------------------------ 待审核 ------------------------------ */

const REVIEW_BUCKETS = [
  { id: 'high', title: '需重点审查（高危）', hint: '命中高危规则，请先展开扫描详情确认' },
  { id: 'medium', title: '建议关注（中危）', hint: '有中危命中，确认用途与权限后再通过' },
  { id: 'low', title: '低危提醒', hint: '仅有低危命中，通常可快速通过' },
  { id: 'clean', title: '扫描干净', hint: '未命中任何规则，可快速通过' },
];

function riskBucketOf(item) {
  const summary = item.scanSummary || (item.scan && item.scan.summary) || {};
  if ((summary.high || 0) > 0) return 'high';
  if ((summary.medium || 0) > 0) return 'medium';
  if ((summary.low || 0) > 0) return 'low';
  return 'clean';
}

function reviewRow(item) {
  const note = h('input', { placeholder: '备注（可选）', class: 'mono' });
  const findings = (item.scan && item.scan.findings) || [];
  const findingsBox = h('div', { class: 'findings review-findings', hidden: true }, ...findingsList(item.scan));
  const scanLabel = findings.length ? `扫描 ${findings.length}` : '扫描';
  const scanToggle = h('button', {
    class: `btn btn-ghost btn-sm${findings.length ? ' has-findings' : ''}`,
    type: 'button',
    onClick: () => {
      findingsBox.hidden = !findingsBox.hidden;
      scanToggle.textContent = findingsBox.hidden ? scanLabel : '收起';
    },
  }, scanLabel);
  return h(
    'div',
    { class: `review-item risk-${riskBucketOf(item)}` },
    h(
      'div',
      { class: 'list-row' },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'mono' }, `${item.kind}/${item.name}@${item.version}`),
        h('div', { class: 'muted' }, `${item.manifestDescription || item.description || ''}`),
        h('div', { class: 'muted' }, `提交：${item.submittedBy} · ${fmtTime(item.submittedAt)} · ${item.fileCount} 文件`),
      ),
      h('span', { class: `chip ${item.kind}` }, KIND_LABEL[item.kind] || item.kind),
      ...scanChips({ summary: item.scanSummary || { high: 0, medium: 0, low: 0, total: 0 } }),
      note,
      scanToggle,
      h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onClick: () => openDiff({ kind: item.kind, name: item.name }, item.version),
      }, '差异'),
      h('button', {
        class: 'btn btn-primary btn-sm',
        type: 'button',
        onClick: async () => {
          try {
            await api('/review', {
              method: 'POST',
              body: { kind: item.kind, name: item.name, version: item.version, decision: 'approve', note: note.value },
            });
            toast(`已通过 ${item.name}@${item.version}`, 'ok');
            render();
            refreshBadge();
          } catch (error) {
            toast(`操作失败：${error.message}`, 'error');
          }
        },
      }, '通过'),
      h('button', {
        class: 'btn btn-danger btn-sm',
        type: 'button',
        onClick: async () => {
          try {
            await api('/review', {
              method: 'POST',
              body: { kind: item.kind, name: item.name, version: item.version, decision: 'reject', note: note.value },
            });
            toast(`已拒绝 ${item.name}@${item.version}`, 'ok');
            render();
            refreshBadge();
          } catch (error) {
            toast(`操作失败：${error.message}`, 'error');
          }
        },
      }, '拒绝'),
    ),
    findingsBox,
  );
}

async function renderReview(main) {
  const data = await api('/review/queue');
  const items = data.items || [];
  const kindSelect = h('select', {
    onChange: () => {
      state.reviewKind = kindSelect.value;
      render();
    },
  }, h('option', { value: '' }, '全部类型'), ...Object.entries(KIND_LABEL).map(([value, label]) => h('option', { value }, label)));
  kindSelect.value = state.reviewKind;

  const kindItems = items.filter((item) => !state.reviewKind || item.kind === state.reviewKind);
  const counts = { all: kindItems.length, high: 0, medium: 0, low: 0, clean: 0 };
  for (const item of kindItems) counts[riskBucketOf(item)] += 1;
  const active = state.reviewRisk || 'all';
  const bucketLabel = (id) => (id === 'all' ? '全部' : REVIEW_BUCKETS.find((bucket) => bucket.id === id).title);

  const tabs = h('div', { class: 'toolbar risk-tabs' },
    ...['all', ...REVIEW_BUCKETS.map((bucket) => bucket.id)].map((id) => h('button', {
      class: `btn btn-sm risk-tab risk-${id}${active === id ? ' active' : ''}`,
      type: 'button',
      onClick: () => {
        state.reviewRisk = id;
        render();
      },
    }, `${bucketLabel(id)} ${counts[id]}`)),
    kindSelect,
    h('button', { class: 'btn btn-sm', type: 'button', onClick: () => render() }, '刷新'));

  const filtered = kindItems.filter((item) => active === 'all' || riskBucketOf(item) === active);

  const groups = REVIEW_BUCKETS.map((bucket) => {
    const bucketItems = filtered.filter((item) => riskBucketOf(item) === bucket.id);
    if (bucketItems.length === 0) return null;
    return h('section', { class: 'review-group' },
      h('div', {
        class: 'group-title clickable',
        title: `只看「${bucket.title}」`,
        onClick: () => {
          state.reviewRisk = active === bucket.id ? 'all' : bucket.id;
          render();
        },
      },
        h('span', { class: `chip risk-${bucket.id}` }, `${bucket.title} ${bucketItems.length}`),
        h('span', { class: 'muted' }, bucket.hint)),
      h('div', { class: 'list' }, ...bucketItems.map(reviewRow)));
  }).filter(Boolean);

  main.replaceChildren(
    h('div', { class: 'section-title' },
      h('h2', {}, '待审核'),
      h('span', { class: 'muted' }, `共 ${data.total} 个版本 · 当前显示 ${filtered.length} 个 · 按扫描结果分类`)),
    tabs,
    groups.length ? h('div', { class: 'review-groups' }, ...groups) : h('div', { class: 'empty' }, items.length ? '该分类下没有版本' : '没有待审核的版本'),
  );
}

/* ------------------------------ 审计 ------------------------------ */

async function renderAudit(main) {
  const admin = can('admin');
  const data = await api(`/audit?limit=100${state.auditTenant ? `&tenant=${encodeURIComponent(state.auditTenant)}` : ''}`);
  const tenantInput = admin
    ? h('input', { placeholder: '租户（留空看全部，admin）', value: state.auditTenant || '' })
    : null;
  const apply = admin
    ? h('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onClick: () => {
          state.auditTenant = tenantInput.value.trim();
          render();
        },
      }, '按租户筛选')
    : null;
  const rows = data.items.map((item) =>
    h(
      'div',
      { class: 'list-row' },
      h('span', { class: 'mono muted' }, fmtTime(item.ts)),
      h('span', { class: 'chip' }, item.actor || 'anonymous'),
      h('span', { class: 'chip' }, item.action),
      h('span', { class: 'chip' }, `租户 ${item.meta?.tenant || 'default'}`),
      h('span', { class: 'grow mono' }, item.target || '-'),
      h('span', { class: 'muted mono' }, item.meta ? JSON.stringify(item.meta).slice(0, 80) : ''),
    ),
  );
  main.replaceChildren(
    h('div', { class: 'section-title' },
      h('h2', {}, '审计日志'),
      h('span', { class: 'muted' }, `最近 ${data.items.length} / 共 ${data.total} 条${data.tenant && data.tenant !== '*' ? ` · 租户 ${data.tenant}` : ''}`)),
    admin ? h('div', { class: 'panel' }, h('div', { class: 'actions' }, tenantInput, apply)) : null,
    rows.length ? h('div', { class: 'list' }, ...rows) : h('div', { class: 'empty' }, '暂无审计记录'),
  );
}

/* ------------------------------ 策略 ------------------------------ */

async function renderPolicy(main) {
  const data = await api('/policy');
  const auto = data.policy?.autoApprove || {};

  const enabled = h('input', { type: 'checkbox', checked: Boolean(auto.enabled) });
  const kindInputs = ['skill', 'agent', 'plugin'].map((kind) =>
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: kind, checked: (auto.kinds || []).includes(kind) }),
      `${KIND_LABEL[kind] || kind}（${kind}）`),
  );
  const publishers = h('textarea', {
    rows: 3,
    placeholder: '受信发布者，每行一个；留空 = 不限制发布者',
  }, (auto.trustedPublishers || []).join('\n'));
  const requireSignature = h('input', { type: 'checkbox', checked: Boolean(auto.requirePublisherSignature) });
  const maxMedium = h('input', { type: 'number', min: '0', step: '1', value: String(auto.maxMedium ?? 0) });
  const maxFiles = h('input', { type: 'number', min: '1', max: '200', step: '1', value: String(auto.maxFiles ?? 100) });
  const maxTotalBytes = h('input', {
    type: 'number', min: '1', max: String(2 * 1024 * 1024), step: '1024',
    value: String(auto.maxTotalBytes ?? 2 * 1024 * 1024),
  });

  const save = h('button', {
    class: 'btn btn-primary',
    type: 'button',
    onClick: async () => {
      const policy = {
        autoApprove: {
          enabled: enabled.checked,
          kinds: kindInputs
            .filter((label) => label.querySelector('input').checked)
            .map((label) => label.querySelector('input').value),
          trustedPublishers: publishers.value.split('\n').map((line) => line.trim()).filter(Boolean),
          requirePublisherSignature: requireSignature.checked,
          maxMedium: Number(maxMedium.value),
          maxFiles: Number(maxFiles.value),
          maxTotalBytes: Number(maxTotalBytes.value),
        },
      };
      save.disabled = true;
      try {
        await api('/policy', { method: 'PUT', body: { policy } });
        toast('策略已保存', 'ok');
        render();
      } catch (error) {
        toast(`保存失败：${error.message}`, 'error');
        save.disabled = false;
      }
    },
  }, '保存策略');

  const row = (label, control, hint) =>
    h('div', { class: 'form-row' },
      h('span', { class: 'form-label' }, label),
      h('div', {}, control, hint ? h('p', { class: 'hint' }, hint) : null));

  main.replaceChildren(
    h('div', { class: 'section-title' },
      h('h2', {}, '自动审批策略'),
      h('span', { class: 'muted' }, `来源：${data.source === 'file' ? 'policy.json（已自定义）' : '默认值（未自定义）'}`)),
    h('div', { class: 'panel' },
      h('p', { class: 'hint' },
        '开启后，发布时若同时满足以下全部规则，版本将自动通过审核并上架（仍会平台签名 + 写入透明日志）；不满足的版本保持 pending，并记录 review.auto_skipped 审计。'),
      row('自动审批', h('label', { class: 'check' }, enabled, '启用'), '关闭时所有版本都需要人工审核'),
      row('适用类型', h('span', {}, ...kindInputs), '至少选择一类'),
      row('受信发布者', publishers, '留空 = 不限制发布者；填写后仅这些用户发布的内容可自动通过'),
      row('要求发布者签名', h('label', { class: 'check' }, requireSignature, '启用'), '发布时必须携带发布者 ed25519 签名'),
      row('允许的最大中危数', maxMedium, '0 = 不允许中危；高危始终阻断'),
      row('最大文件数', maxFiles, '1 ~ 200'),
      row('最大总字节数', maxTotalBytes, '1 ~ 2097152（2 MB）'),
      h('div', { class: 'actions' }, save)),
    h('div', { class: 'panel' },
      h('h3', {}, '说明'),
      h('ul', { class: 'hint' },
        h('li', {}, '策略对之后发布的版本生效，已上架版本不受影响。'),
        h('li', {}, '开启后低风险内部包免排队；外部导入、非受信发布者仍走人工审核。'),
        h('li', {}, '策略修改会写入审计日志（action=policy.update）；CLI 等价命令：agentdock policy show / policy set --file policy.json。'))),
  );
}

/* ------------------------------ 令牌 ------------------------------ */

async function renderTokens(main) {
  const data = await api('/admin/users');
  const users = data.items || [];
  const tenants = [...new Set(users.map((user) => user.tenant || 'default'))].sort();

  const nameInput = h('input', { placeholder: '用户名（唯一）' });
  const roleSelect = h('select', {}, ...['viewer', 'publisher', 'reviewer', 'admin'].map((role) => h('option', { value: role }, ROLE_LABEL[role] || role)));
  const tenantInput = h('input', { placeholder: '租户（默认 default，小写字母/数字/_/-）', value: 'default' });
  const created = h('div');

  const create = h('div', { class: 'actions' },
    nameInput,
    roleSelect,
    tenantInput,
    h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onClick: async () => {
        try {
          const result = await api('/admin/tokens', {
            method: 'POST',
            body: { name: nameInput.value.trim(), role: roleSelect.value, tenant: tenantInput.value.trim() || 'default' },
          });
          created.replaceChildren(
            h('p', { class: 'hint' }, `已创建 ${result.user.name}（${ROLE_LABEL[result.user.role] || result.user.role} · 租户 ${result.user.tenant}），令牌只显示一次：`),
            h('pre', { class: 'code' }, result.token),
          );
          toast('令牌已创建', 'ok');
          render();
        } catch (error) {
          toast(`创建失败：${error.message}`, 'error');
        }
      },
    }, '创建用户令牌'),
  );

  const revokeAll = h('button', {
    class: 'btn btn-danger',
    type: 'button',
    onClick: async () => {
      if (!confirm('强制所有用户重新登录？现有会话 Cookie 会立即失效。')) return;
      try {
        const result = await api('/admin/sessions/revoke-all', { method: 'POST', body: {} });
        toast(`已强制全员下线（globalEpoch=${result.globalEpoch}）`, 'ok');
        render();
      } catch (error) {
        toast(`操作失败：${error.message}`, 'error');
      }
    },
  }, '全员强制下线');

  const rows = users.map((user) => {
    const disabled = Boolean(user.disabled);
    const toggle = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      onClick: async () => {
        try {
          await api(`/admin/users/${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            body: { disabled: !disabled },
          });
          toast(disabled ? `已启用 ${user.name}` : `已禁用 ${user.name}（会话已失效）`, 'ok');
          render();
        } catch (error) {
          toast(`操作失败：${error.message}`, 'error');
        }
      },
    }, disabled ? '启用' : '禁用');
    const revoke = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      onClick: async () => {
        try {
          await api(`/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`, { method: 'POST', body: {} });
          toast(`已强制 ${user.name} 下线`, 'ok');
        } catch (error) {
          toast(`操作失败：${error.message}`, 'error');
        }
      },
    }, '强制下线');
    return h('div', { class: 'list-row' },
      h('span', { class: 'grow mono' }, user.name),
      h('span', { class: 'chip' }, ROLE_LABEL[user.role] || user.role),
      h('span', { class: 'chip' }, `租户 ${user.tenant || 'default'}`),
      h('span', { class: 'muted' }, user.auth === 'oidc' ? 'SSO' : '令牌'),
      h('span', { class: disabled ? 'chip chip-danger' : 'chip chip-ok' }, disabled ? '已禁用' : '正常'),
      h('span', { class: 'muted' }, `创建于 ${fmtTime(user.createdAt)}`),
      h('span', { class: 'row-actions' }, revoke, toggle),
    );
  });

  main.replaceChildren(
    h('div', { class: 'section-title' },
      h('h2', {}, '用户与令牌'),
      h('span', { class: 'muted' }, `${users.length} 个用户 · ${tenants.length} 个租户（${tenants.join('、')}）`)),
    h('div', { class: 'panel' },
      h('h3', {}, '创建用户令牌'),
      create,
      created,
      h('p', { class: 'hint' }, '禁用用户会立即失效其所有会话；「强制下线」只影响该用户的 SSO 会话，不影响长期令牌。')),
    h('div', { class: 'panel' },
      h('div', { class: 'actions' }, revokeAll),
      h('p', { class: 'hint' }, '全员强制下线的会让所有已登录成员需要重新 SSO 登录。')),
    rows.length ? h('div', { class: 'list' }, ...rows) : h('div', { class: 'empty' }, '暂无用户'),
  );
}

/* ------------------------------ 发布导入 ------------------------------ */

const IMPORT_MIME = {
  zip: 'application/zip',
  'tar.gz': 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

function bytesToBase64(bytes) {
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(text);
}

async function readBundleFile(file, filePath) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!decoded.includes('\u0000')) return { path: filePath, content: decoded, encoding: 'utf8' };
  } catch {
    /* 二进制文件 */
  }
  return { path: filePath, content: bytesToBase64(bytes), encoding: 'base64' };
}

async function rawImport(file) {
  const lower = file.name.toLowerCase();
  const extension = lower.endsWith('.tar.gz') ? 'tar.gz' : lower.split('.').pop();
  if (extension === 'json') {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') throw new Error('JSON 必须是对象');
    return api('/packages', { method: 'POST', body: payload });
  }
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const csrf = cookieValue(CSRF_COOKIE);
  if (csrf) headers['x-agentdock-csrf'] = csrf;
  headers['Content-Type'] = IMPORT_MIME[extension] || 'application/octet-stream';
  const response = await fetch(`${API}/import?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers,
    body: await file.arrayBuffer(),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text.trim() ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function onPublishFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const result = await rawImport(file);
    const warnings = (result.warnings || []).length;
    toast(
      `已导入 ${result.package.kind}/${result.package.name}@${result.version.version}${warnings ? `（${warnings} 条告警）` : ''}，等待审核`,
      'ok',
    );
    state.view = 'market';
    render();
    refreshBadge();
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
  }
}

const IGNORED_FOLDER_SEGMENTS = new Set(['node_modules', '__macosx', 'thumbs.db', 'desktop.ini']);
function isIgnoredFolderPath(relative) {
  return relative.split('/').some((segment) => segment.startsWith('.') || IGNORED_FOLDER_SEGMENTS.has(segment.toLowerCase()));
}

async function onPublishFolder(event) {
  const allFiles = [...(event.target.files || [])];
  event.target.value = '';
  if (allFiles.length === 0) return;
  const skipped = [];
  const files = allFiles.filter((file) => {
    const relative = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
    if (isIgnoredFolderPath(relative)) {
      skipped.push(relative);
      return false;
    }
    return true;
  });
  if (files.length === 0) {
    toast('文件夹里没有可导入的文件（.DS_Store、.git、node_modules 等会被忽略）', 'error');
    return;
  }
  const rootSegment = files[0].webkitRelativePath.split('/')[0] || 'imported-package';
  try {
    const entries = await Promise.all(
      files.map((file) => {
        const relative = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
        return readBundleFile(file, relative);
      }),
    );
    const result = await api(`/import?filename=${encodeURIComponent(rootSegment)}.json`, {
      method: 'POST',
      body: { files: entries },
    });
    if (result.batch) {
      const okCount = result.results.filter((item) => item.ok).length;
      toast(`已批量导入 ${okCount}/${result.results.length} 个能力包${skipped.length ? `（已忽略 ${skipped.length} 个隐藏/系统文件）` : ''}`, okCount === result.results.length ? 'ok' : 'error');
    } else {
      toast(`已导入 ${result.package.kind}/${result.package.name}@${result.version.version}，等待审核${skipped.length ? `（已忽略 ${skipped.length} 个隐藏/系统文件）` : ''}`, 'ok');
    }
    state.view = 'market';
    render();
    refreshBadge();
  } catch (error) {
    toast(`文件夹导入失败：${error.message}`, 'error');
  }
}

async function importFromRegistry() {
  const repo = window.prompt('从 GitHub 导入：输入 owner/repo', '');
  if (!repo || !repo.trim()) return;
  const subPath = window.prompt('仓库内目录（留空表示仓库根目录；例如 skills/my-skill）', '') || '';
  try {
    const result = await api('/sync/import', {
      method: 'POST',
      body: { source: { type: 'github', repo: repo.trim(), path: subPath.trim() } },
    });
    const warnings = (result.warnings || []).length;
    toast(
      `已导入 ${result.package.kind}/${result.package.name}@${result.version.version}${warnings ? `（${warnings} 条告警）` : ''}，等待审核`,
      'ok',
    );
    state.view = 'market';
    render();
    refreshBadge();
  } catch (error) {
    toast(`外部导入失败：${error.message}`, 'error');
  }
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  document.querySelector('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button || button.disabled) return;
    state.view = button.dataset.view;
    render();
  });
  document.querySelector('#modal-close').addEventListener('click', closeModal);
  document.querySelector('#modal').addEventListener('click', (event) => {
    if (event.target.dataset.close) closeModal();
  });
  document.querySelector('#diff-close').addEventListener('click', closeDiff);
  document.querySelector('#diff-modal').addEventListener('click', (event) => {
    if (event.target.dataset.diffClose) closeDiff();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDiff();
      closeModal();
    }
  });
  document.querySelector('#publish-file').addEventListener('change', onPublishFile);
  document.querySelector('#publish-folder').addEventListener('change', onPublishFolder);

  if (state.token) {
    try {
      await loadMe();
    } catch {
      state.token = '';
      localStorage.removeItem('agentdock.token');
    }
  } else {
    // 无 Bearer 令牌时尝试复用 SSO 会话 Cookie
    try {
      await loadMe();
    } catch {
      /* 未登录 */
    }
  }
  try {
    const config = await (await fetch('/auth/config')).json();
    state.oidcEnabled = Boolean(config.enabled);
  } catch {
    state.oidcEnabled = false;
  }
  renderAuth();
  updateTabs();
  render();
  refreshBadge();
}

init();
