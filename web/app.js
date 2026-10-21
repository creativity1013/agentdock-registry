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

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
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
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
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
    slot.append(
      h(
        'span',
        { class: 'user-chip' },
        h('span', {}, state.user.name),
        h('span', { class: 'role' }, `${ROLE_LABEL[state.user.role] || state.user.role}`),
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

function logout() {
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
    if (view === 'tokens') disabled = !can('admin');
    button.disabled = disabled;
    button.title = disabled ? '需要更高角色权限' : '';
  }
  if (state.view === 'review' && !can('reviewer')) state.view = 'market';
  if (state.view === 'audit' && !can('reviewer')) state.view = 'market';
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
    else if (state.view === 'tokens') await renderTokens(main);
  } catch (error) {
    renderError(error);
  }
}

/* ------------------------------ 市场 ------------------------------ */

async function renderMarket(main) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.kind) params.set('kind', state.kind);

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
      clearTimeout(search._timer);
      search._timer = setTimeout(() => render(), 260);
    },
  });

  const kindSelect = h(
    'select',
    { onChange: () => (state.kind = kindSelect.value, render()) },
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
      ? h('button', { class: 'btn btn-primary', type: 'button', onClick: () => $('#publish-file').click() }, '导入 JSON 包')
      : null,
  );

  const grid = list.items.length
    ? h('div', { class: 'package-grid' }, ...list.items.map(packageCard))
    : h('div', { class: 'empty' }, h('p', {}, '还没有已发布的能力包'), can('publisher') ? h('p', { class: 'hint' }, '点击「导入 JSON 包」或使用 CLI：agentdock publish <目录>') : null);

  main.replaceChildren(
    statsGrid,
    toolbar,
    h('div', { class: 'section-title' }, h('h2', {}, '能力市场'), h('span', { class: 'muted' }, `共 ${list.total} 个`)),
    grid,
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
    h('div', { class: 'card-meta' }, kindChip(item.kind), statusChip(item.status, item.status === 'published' ? '已发布' : item.status), ...scanChips(item.scanSummary ? { summary: item.scanSummary } : null)),
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
        state.detail.preview ? h('pre', { class: 'code' }, state.detail.preview.content) : null,
      )
    : null;

  const scanPanel = selected?.scan
    ? h(
        'div',
        { class: 'panel' },
        h('h3', {}, '安全扫描'),
        h(
          'div',
          { class: 'findings' },
          ...(selected.scan.findings.length > 0
            ? selected.scan.findings.map((finding) =>
                h(
                  'div',
                  { class: 'finding' },
                  h('span', { class: `sev ${finding.severity}` }, finding.severity),
                  h('span', { class: 'mono' }, finding.ruleId),
                  h('span', {}, finding.title),
                  h('span', { class: 'muted' }, `${finding.file}${finding.line ? `#L${finding.line}` : ''}`),
                ),
              )
            : [h('span', { class: 'muted' }, '未发现问题')]),
        ),
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
    nodes.push(
      h('span', { class: 'hint' }, '安装到本机：'),
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
              toast(`已安装到 ${result.absolutePath}`, 'ok');
              refreshBadge();
            } catch (error) {
              toast(`安装失败：${error.message}`, 'error');
            } finally {
              event.target.disabled = false;
            }
          },
        },
        '安装',
      ),
      state.detail.installResult
        ? h('span', { class: 'hint' }, `✓ ${state.detail.installResult.absolutePath}（${state.detail.installResult.installedFiles} 个文件）`)
        : null,
    );
  }
  if (selected && selected.status === 'pending' && can('reviewer')) {
    const note = h('input', { placeholder: '审核备注（可选）' });
    nodes.push(
      h('span', { class: 'hint' }, '审核：'),
      note,
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
    state.detail.preview = { version, content: data.file.content };
    paintDetail();
  } catch (error) {
    toast(`读取文件失败：${error.message}`, 'error');
  }
}

/* ------------------------------ 待审核 ------------------------------ */

async function renderReview(main) {
  const data = await api('/review/queue');
  const rows = data.items.map((item) => {
    const note = h('input', { placeholder: '备注（可选）', class: 'mono' });
    return h(
      'div',
      { class: 'list-row' },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'mono' }, `${item.kind}/${item.name}@${item.version}`),
        h('div', { class: 'muted' }, `${item.manifestDescription || item.description || ''}`),
        h('div', { class: 'muted' }, `提交：${item.submittedBy} · ${fmtTime(item.submittedAt)} · ${item.fileCount} 文件`),
      ),
      ...scanChips({ summary: item.scanSummary || { high: 0, medium: 0, low: 0, total: 0 } }),
      h('span', { class: 'tag' }, `${item.scanSummary?.high || 0} 高危`),
      note,
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
    );
  });

  main.replaceChildren(
    h('div', { class: 'section-title' }, h('h2', {}, '待审核'), h('span', { class: 'muted' }, `共 ${data.total} 个版本`)),
    rows.length ? h('div', { class: 'list' }, ...rows) : h('div', { class: 'empty' }, '没有待审核的版本'),
  );
}

/* ------------------------------ 审计 ------------------------------ */

async function renderAudit(main) {
  const data = await api('/audit?limit=100');
  const rows = data.items.map((item) =>
    h(
      'div',
      { class: 'list-row' },
      h('span', { class: 'mono muted' }, fmtTime(item.ts)),
      h('span', { class: 'chip' }, item.actor || 'anonymous'),
      h('span', { class: 'chip' }, item.action),
      h('span', { class: 'grow mono' }, item.target || '-'),
      h('span', { class: 'muted mono' }, item.meta ? JSON.stringify(item.meta).slice(0, 80) : ''),
    ),
  );
  main.replaceChildren(
    h('div', { class: 'section-title' }, h('h2', {}, '审计日志'), h('span', { class: 'muted' }, `最近 ${data.items.length} / 共 ${data.total} 条`)),
    rows.length ? h('div', { class: 'list' }, ...rows) : h('div', { class: 'empty' }, '暂无审计记录'),
  );
}

/* ------------------------------ 令牌 ------------------------------ */

async function renderTokens(main) {
  const data = await api('/admin/users');
  const nameInput = h('input', { placeholder: '用户名' });
  const roleSelect = h('select', {}, ...['publisher', 'reviewer', 'admin'].map((role) => h('option', { value: role }, ROLE_LABEL[role])));
  const created = h('div');

  const rows = data.items.map((user) =>
    h(
      'div',
      { class: 'list-row' },
      h('span', { class: 'grow mono' }, user.name),
      h('span', { class: 'chip' }, ROLE_LABEL[user.role] || user.role),
      h('span', { class: 'muted' }, `创建于 ${fmtTime(user.createdAt)}`),
    ),
  );

  main.replaceChildren(
    h('div', { class: 'section-title' }, h('h2', {}, '用户与令牌'), h('span', { class: 'muted' }, `共 ${data.items.length} 个用户`)),
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, '创建令牌'),
      h(
        'div',
        { class: 'actions' },
        nameInput,
        roleSelect,
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onClick: async () => {
            try {
              const result = await api('/admin/tokens', {
                method: 'POST',
                body: { name: nameInput.value.trim(), role: roleSelect.value },
              });
              created.replaceChildren(
                h('p', { class: 'hint' }, `已创建 ${result.user.name}（${ROLE_LABEL[result.user.role]}），令牌只显示一次：`),
                h('pre', { class: 'code' }, result.token),
              );
              toast('令牌已创建', 'ok');
              render();
            } catch (error) {
              toast(`创建失败：${error.message}`, 'error');
            }
          },
        }, '创建'),
      ),
      created,
    ),
    rows.length ? h('div', { class: 'list' }, ...rows) : h('div', { class: 'empty' }, '暂无用户'),
  );
}

/* ------------------------------ 发布导入 ------------------------------ */

async function onPublishFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') throw new Error('JSON 必须是对象');
    const result = await api('/packages', { method: 'POST', body: payload });
    toast(`已提交 ${result.package.kind}/${result.package.name}@${result.version.version}，等待审核`, 'ok');
    state.view = 'market';
    render();
    refreshBadge();
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  document.querySelector('#publish-file').addEventListener('change', onPublishFile);

  if (state.token) {
    try {
      await loadMe();
    } catch {
      state.token = '';
      localStorage.removeItem('agentdock.token');
    }
  }
  renderAuth();
  updateTabs();
  render();
  refreshBadge();
}

init();
