# AgentDock 架构设计

> 目标：跨 harness 的 AI 能力市场 + 治理。本文说明分层、数据模型、请求链路、扩展点与关键设计取舍。

## 1. 分层

```
┌─────────────────────────────────────────────────────────────┐
│ 接入层                                                        │
│   Web 市场（零依赖原生 JS）   CLI（agentdock）   HTTP API      │
├─────────────────────────────────────────────────────────────┤
│ 治理层（自研）                                                 │
│   审核状态机 · 角色/令牌 · 审计日志 · 高危阻断/覆盖 · 安装记录     │
├─────────────────────────────────────────────────────────────┤
│ 注册分发层（自研）                                             │
│   能力包归一化 · 版本库 · 市场索引 · 安装目标适配 · 导入器         │
├─────────────────────────────────────────────────────────────┤
│ 能力格式层（不自研，对齐生态事实标准）                            │
│   skill: SKILL.md + frontmatter                               │
│   agent: agent.md + frontmatter(tools/model/prompt)           │
│   plugin: plugin.json + skills/agents/mcp  容器                │
├─────────────────────────────────────────────────────────────┤
│ 运行层（不自研，交给现成 harness）                              │
│   DSH · Claude Code · Codex —— 通过安装目标把能力放进它们的发现路径 │
└─────────────────────────────────────────────────────────────┘
```

设计原则：

1. **不自研 runtime**：AgentDock 永远不执行能力包，只负责登记、审核、分发、安装。
2. **格式对齐生态**：skill 用 agentskills.io 的 `SKILL.md` 约定；agent 用 Claude Code subagent 的 frontmatter 约定（`tools/model` + 正文系统提示）；plugin 用 manifest 容器约定。不自造字段。
3. **治理即代码**：策略（扫描阈值、审核状态、安装权限）全部显式存储和审计，不依赖口头约定。

## 2. 请求生命周期

### 发布（CLI 或 Web 上传）

```
能力包目录
  │  readBundleFromDirectory()      跳过隐藏/.git/符号链接；识别文本/二进制；算 sha256
  ▼
normalizeBundle()                   路径消毒、名称/semver 校验、体积限制、contentHash
  ▼
validateBundle()                    按 kind 校验结构，产出 manifest（供市场/安装使用）
  ▼
scanBundle() + scanVerdict()        安全规则扫描，按阈值判定是否阻断
  ▼
store.publish()                     版本写入 pending 状态（meta.json + files/ 落盘）
  ▼
audit.append('package.publish')     审计
```

`analyzeInput()`（src/pipeline.mjs）把「归一化 → 校验 → 扫描」封装成纯函数：服务端发布、CLI `verify`、CLI 发布前预检、`import-claude` 共享同一套逻辑，保证线上线下判断一致。

### 审核

```
reviewer: POST /api/v1/review {kind,name,version,decision,note}
  ▼ 权限校验（role ≥ reviewer）+ 版本必须处于 pending
store.review()  ── approve → status=published（冻结，不可覆盖）
                └ reject  → status=rejected（可覆盖重提）
  ▼
audit.append('review.approve' | 'review.reject')
```

### 安装

```
CLI: install <kind/name[@version]> --target <dsh|claude|codex|shared|dir>
  ▼ 服务端解析版本（默认 latest 已发布）→ 返回文件清单 + 内容 + 安装清单
targets.planInstall()               目标路径 + 冲突检测 + 备份计划
targets.applyInstall()              原子写入（.tmp → rename）+ .agentdock-install.json
  ▼
POST /install-event                 installs 计数 + 审计
```

服务端也提供 `POST /install`：适合「平台方代为安装」的场景（安装发生在服务端所在机器上，受目标目录权限约束）。CLI 默认走「拉取内容 → 本地安装」，安装发生在用户机器。

## 3. 数据模型

### 目录布局

```
data/
├── db.json                      # 版本库元数据（唯一可变索引）
├── users.json                   # 用户与令牌哈希
├── BOOTSTRAP-TOKENS.txt         # 首次启动的明文令牌（600，可删）
├── audit.log                    # append-only JSONL 审计
└── packages/
    └── <kind>/<name>/<version>/
        ├── meta.json            # 版本元数据（状态、扫描、审核、文件清单、哈希）
        └── files/               # 能力包原始内容（按包内相对路径）
            └── SKILL.md
```

### db.json

```jsonc
{
  "schemaVersion": 1,
  "packages": {
    "skill/demo-skill": {
      "kind": "skill",
      "name": "demo-skill",
      "description": "……",
      "tags": ["demo"],
      "latestVersion": "0.1.0",
      "installs": 3,
      "createdAt": "…",
      "updatedAt": "…",
      "versions": {
        "0.1.0": {
          "version": "0.1.0",
          "status": "published",          // pending | published | rejected
          "contentHash": "sha256:…",
          "fileCount": 1,
          "totalBytes": 512,
          "manifest": { "title": "…", "description": "…", "capabilities": {} },
          "scan": { "summary": { "high": 0, "medium": 1, "low": 2, "total": 3 }, "findings": [] },
          "review": { "reviewer": "reviewer", "decision": "approve", "note": "LGTM", "at": "…" },
          "files": [{ "path": "SKILL.md", "encoding": "utf8", "bytes": 512, "sha256": "…" }],
          "createdAt": "…",
          "updatedAt": "…"
        }
      }
    }
  },
  "installs": { "total": 3 }
}
```

### users.json

```jsonc
{
  "schemaVersion": 1,
  "users": [
    { "id": "u_…", "name": "admin", "role": "admin", "tokenHash": "sha256(明文令牌)", "createdAt": "…" }
  ]
}
```

角色能力：

| 角色 | 权限 |
| --- | --- |
| `viewer` | 浏览市场、下载公开版本 |
| `publisher` | 发布、校验、安装、登记安装事件 |
| `reviewer` | 以上 + 审核、查看待审核版本与审计 |
| `admin` | 以上 + 创建令牌、覆盖扫描阻断 |

### audit.log（JSONL）

```jsonc
{"at":"2026-10-21T10:00:00.000Z","actor":"publisher","role":"publisher","action":"package.publish","target":"skill/demo-skill@0.1.0","meta":{"contentHash":"sha256:…"},"ip":"127.0.0.1"}
```

动作命名：`package.publish`、`package.install`（meta.target 区分安装目标）、`review.approve`、`review.reject`、`user.create_token`。

### meta.json 与 db.json 的关系

`db.json` 是热索引（市场列表、审核队列、安装计数直接读它），`meta.json` 是版本目录内的自描述副本（便于备份/迁移/人工检查）。写入时先落 meta + files，再原子更新 db.json。当前没有自动重建索引的接口：迁移时可从 `packages/<kind>/<name>/<version>/meta.json` 人工恢复（重建索引列入 roadmap）。

## 4. 模块职责

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `src/config.mjs` | 环境变量 → 配置对象、数据目录初始化 | `loadConfig`、`ensureDataLayout`、`resolveHome` |
| `src/yaml.mjs` | 零依赖 YAML 子集 + frontmatter 解析 | `parseYaml`、`parseFrontmatter`、`YamlError` |
| `src/bundle.mjs` | 输入归一化、路径消毒、哈希、目录读取 | `normalizeBundle`、`readBundleFromDirectory`、`sanitizePath`、`LIMITS` |
| `src/validate.mjs` | 三类 kind 结构校验 → manifest | `validateBundle`、`describeBundle`、`KNOWN_AGENT_TOOLS` |
| `src/scan.mjs` | 安全规则引擎 | `scanBundle`、`scanVerdict`、`SEVERITY_ORDER` |
| `src/pipeline.mjs` | 纯函数流水线 | `analyzeInput` |
| `src/store.mjs` | 版本库、状态机、安装计数 | `createStore`（`publish/review/getVersion/requirePublished/bundleContent/fileContent/listPackages/packageDetail/reviewQueue/recordInstall/stats/latestPublished`） |
| `src/targets.mjs` | 安装目标解析与落盘 | `planInstall`、`applyInstall`、`installDestination`、`listTargets` |
| `src/dsh-preset.mjs` | agent 包 → DSH agent-preset 片段；profile patch 合并 | `renderPresetPatch`、`writePresetFragment`、`upsertProfilePatch`、`presetIdFor`、`dshHome` |
| `src/auth.mjs` | 用户/令牌/角色 | `createUserDirectory`、`tokenFromRequest` |
| `src/audit.mjs` | append-only 审计 | `createAuditLog`（`append/read`） |
| `src/app.mjs` | 路由、鉴权、错误映射、静态文件 | `createApp` |
| `server.mjs` | 启动入口、连接信息输出 | `startServer` |
| `cli/agentdock.mjs` | 命令行、本地校验、导入器 | — |

依赖方向：`cli / server → app → store / targets / pipeline → bundle / validate / scan → yaml / util / errors`。`pipeline` 与 `targets` 之外不依赖 fs 全局状态，便于测试注入 `config`。

## 5. 安全模型

1. **路径消毒**（`sanitizePath`）：拒绝绝对路径、盘符、`..`、控制字符、隐藏文件、Windows 保留名、`node_modules`；空目录段与尾随空格也拒绝。安装与读取文件前再拼一次根目录并校验 `path.resolve(root, rel)` 前缀。
2. **体积限制**：文件数 200、单文件 512KB、总量 2MB，防止内存/磁盘 DoS。
3. **令牌**：32 字节随机数（base64url），仅存 `sha256`；比较用 `safeEqual`（`crypto.timingSafeEqual`）。首启明文令牌写 600 文件并提示删除。
4. **审计**：所有写操作（发布、审核、安装、令牌创建）均记录，append-only JSONL。
5. **扫描**：启发式规则，可配置阻断阈值；`overrideScan` 仅 admin、且事件写入审计。
6. **网络**：默认仅监听 `127.0.0.1`；无内置 TLS，生产部署应置于反向代理后。

## 6. 安装目标模型

`targets.mjs` 把「能力包 → 目标目录文件计划」拆成三步：

1. `resolveTargetBase(target, {home, dir})`：目标根目录（如 `~/.dsh`、`~/.claude`、自定义 dir）。
2. `installDestination(kind, name, {target, home, dir})`：最终落点布局：
   - `layout: 'dir'`：`<base>/skills|agents|plugins/<name>/`，包内相对路径平铺；
   - `layout: 'file'`：Claude agent 单文件 `<base>/agents/<name>.md`，其余文件进 `<name>.agentdock/` sidecar，额外写 `<name>.agentdock.json`；
   - `layout: 'dsh-preset'`：只接受 agent 包，渲染成单个 `<base>/agentdock/presets/<name>.patch.yml`（plan 里带 `preset` 元数据：presetId、插件行、告警），另写 `<name>.agentdock.json`。
3. `planInstall()`：生成 `{dest, files[{path, targetPath, content, encoding}], force, notes}`；`applyInstall()` 原子写入（`.tmp` → rename）并写清单。

冲突策略：目标已存在 → `AppError(409)`；`force` 时只覆盖同名文件，不清理旧目录中的多余文件。

## 7. 与 DSH 集成

| 能力类型 | DSH 现状 | AgentDock 的桥接 |
| --- | --- | --- |
| skill | `dsh-skill-filesystem` 扫描 `~/.dsh/skills`、`~/.agents/skills`、项目 `.dsh/skills` | 安装 target `dsh` / `shared`，落地即被发现 |
| agent | DSH 没有 `~/.claude/agents` 等价目录；角色由 **agent preset**（`@deepseek-ai/dsh-agent-preset` 的 `id + plugins` 组合）表达 | `dsh-agent` 安装目标把 agent 包转成 preset 片段（`- insert:` 条目）：`tools` → 插件行，正文 → `@deepseek-ai/dsh-persona` 的 `prefix`，`skills` → `skill-filesystem` + `tool-skill`。也支持 `import-claude --presets` 批量生成 |
| plugin | DSH 插件是 Cordis npm 包（`dsh plugin add <pkg>`） | AgentDock 的 plugin 是**一包多能力**的容器；真正给 DSH 用的插件需另行包成 Cordis 包，本平台负责登记与治理 |

### 7.1 agent 包 → DSH preset 的映射规则

DSH 的 profile 是插件 bundle 补丁层的有序堆叠，用户层是 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（顶层 YAML 数组，元素为 loader patch 条目；`insert` 追加条目，其余 patch 只替换给出的字段、不深合并）。因此 AgentDock 统一生成 `- insert:` 形式：

```yaml
- insert:
    - id: preset-agentdock-code-reviewer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: agentdock-code-reviewer
        name: "AgentDock · code-reviewer"
        description: "…"
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                <agent.md 正文>
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
```

| agent.md 输入 | 生成的插件行 |
| --- | --- |
| `tools` 含 Read/Write/Edit/ApplyPatch 等 | `@deepseek-ai/dsh-tool-fs` |
| `tools` 含 Grep/Glob/LS/Find | `@deepseek-ai/dsh-tool-fs-search`（`sampleOverCapGlobResults: false`） |
| `tools` 含 Bash/Shell | `@deepseek-ai/dsh-tool-bash` |
| `tools` 含 WebFetch/WebSearch | `@deepseek-ai/dsh-tool-web` |
| `tools` 含 TodoWrite | `@deepseek-ai/dsh-tool-todo` |
| `tools` 含 Skill 或 frontmatter `skills` | `@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill` |
| 正文 | `@deepseek-ai/dsh-persona` 的 `config.prefix`（YAML 块标量） |
| 固定前置 | `@deepseek-ai/dsh-agent-instructions`（maxBytes 65536）+ `@deepseek-ai/dsh-time-context` |

`model` 无法映射：DSH preset 不带模型，模型由会话或 `agent-default-model` 决定，渲染时给出告警。`tools` 里的 `Task`（子代理）等需要额外组合 provider 的工具只告警不生成，避免生成无法启动的 preset。

片段不会自动生效，两种启用方式：

1. 临时挂载：`dsh <profile> --patch <片段文件>`；
2. 永久合并：`--profile <name>` 让 AgentDock 以 `# >>> agentdock preset <id>` / `# <<<` 标记块追加进 `~/.dsh/profiles/<name>/cordis.patch.yml`，重复执行按标记替换（幂等），不碰文件里的其他内容。

**验证方式**：`DSH_HOME=/tmp/dshhome dsh <profile> --patch <片段> --dump-config`（退出码 0 且输出里出现 `preset-<id>` 即视为可组合）。

## 8. 关键取舍与演进

| 取舍 | 选择 | 理由 | 代价 / 后续 |
| --- | --- | --- | --- |
| 依赖 | 零第三方依赖 | 离线可跑、供应链小、安装即用 | YAML/路由等子集实现自维护 |
| 打包 | JSON bundle | 跨语言、可读、CLI/CI 友好 | 大包体积膨胀；后续可加 tar 流式上传 |
| 存储 | JSON + 文件系统 | 可备份、可审查、实现简单 | 全量索引常驻内存；>1 万包应换 SQLite |
| 前端 | 原生 JS | 无构建、无依赖 | markdown 渲染/diff 等复杂交互后补 |
| 审核 | 人工 + 规则 | 误报可控，责任可追溯 | 大规模需策略引擎/自动审批 |
| 安装 | 平台只产计划，CLI 执行 | 用户机器权限边界清晰 | 无法远程批量部署；可加受控 agent |

## 9. 测试策略

- **单元测试**：yaml / bundle / validate / scan / targets / dsh-preset——纯函数，覆盖正常与边界（路径穿越、体积、编码、frontmatter 字段、preset 渲染与 profile 合并幂等）。
- **接口测试**（`tests/api.test.mjs`）：真实启动 HTTP 服务（随机端口、临时数据目录），覆盖完整闭环：发布 → 待审核不可见 → 审核 → 上架 → 下载 → 安装 → 计数 → 审计 → 令牌管理 → 权限边界 → 阻断/覆盖。
- **端到端冒烟**（`scripts/smoke.mjs`）：真实 `server` + 真实 `cli` 子进程 + 真实落盘，验证 CLI 输出与文件系统结果。
- 测试全部用 `node:test`，无外部服务；`npm test` 与 `npm run smoke` 均可在 CI 中直接跑。

## 10. 部署形态

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 本地开发 | `node server.mjs` / `npm start` | 默认 `127.0.0.1:7788`，数据在仓库内 `data/`（git 忽略） |
| 单机容器 | `Dockerfile` + `docker-compose.yml` | `node:24-alpine` + tini，非 root `node` 用户；`/data` 为唯一持久化卷；HEALTHCHECK 打 `/api/v1/health` |
| CI | `.github/workflows/ci.yml` | Node 20/22/24 矩阵跑 `npm test` / `npm run smoke` / 示例校验 / `node --check`；独立 job 构建镜像并做容器健康检查 |

容器内配置全部走环境变量（`AGENTDOCK_HOST`、`AGENTDOCK_PORT`、`AGENTDOCK_DATA`、`AGENTDOCK_SCAN_BLOCK`、`AGENTDOCK_PUBLIC_URL`），与 CLI 的 `~/.agentdock/config.json` 互不依赖。生产部署应置于反向代理之后，由代理提供 TLS 与访问控制，并限制 `/api/v1/admin/*`。

存储侧只需要备份 `/data`：`db.json`（热索引）、`users.json`（令牌哈希）、`audit.log`（append-only）、`packages/`（版本内容与 meta.json）。迁移时只要有 `packages/` 即可重建版本内容，`db.json` 可用 `meta.json` 人工重建（自动重建列入 roadmap）。
