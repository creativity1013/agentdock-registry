# AgentDock

跨 harness 的 **AI 能力市场 + 治理平台**：把 skill / agent / plugin 这类能力包统一收口，跑通「发布 → 校验 → 安全扫描 → 审核 → 安装 → 审计」闭环。

零第三方依赖（Node 标准库实现），离线可用，数据落在本地文件系统。

```
发布者                         平台                           使用者
──────                        ────                           ──────
skill / agent / plugin  ──▶  校验 + 扫描 + 版本不可变  ──▶  review 审核
                              pending → published          统一安装到 DSH / Claude Code / Codex
                                   │
                                   └──────────── 全链路审计（JSONL）────────────┘
```

## 为什么需要它

2026 年，Agent 能力生态已经分成三层：**skill**（怎么做事的 SOP）、**agent**（执行者/团队）、**plugin**（分发容器）。但三层的共享与治理仍然碎片化：skill 散落在 GitHub 与各种 skills 目录，subagent 定义格式各说各话，插件市场缺少版本、审核、扫描与安装审计。

AgentDock 不做 runtime、也不自研能力格式，只做生态里最缺的一层：**注册分发 + 治理**。

- 统一入口：skill / agent / plugin 三类能力包，同一套发布、版本、审核流程
- 安全基线：提示注入、数据外发、密钥泄漏、危险命令、隐藏指令扫描，高危默认阻断
- 不可篡改：版本一旦发布不可覆盖，内容哈希可校验
- 可落地：一条命令安装到 DSH、Claude Code、Codex 或任意目录
- 可追溯：谁发布、谁审核、谁安装、装到哪，全部写审计日志

## 快速开始

要求 Node.js ≥ 20.11（推荐 22/24），无需 `npm install`。

```bash
cd agentdock
npm start
# 或 node cli/agentdock.mjs serve
```

首次启动会：

1. 在 `data/` 下初始化数据目录；
2. 创建 `admin` / `reviewer` / `publisher` 三个角色令牌；
3. 把明文令牌写入 `data/BOOTSTRAP-TOKENS.txt`（权限 600），同时打印到终端；
4. 监听 `http://127.0.0.1:7788`，浏览器打开即是市场界面。

发布三个示例能力包（一条命令完成发布 + 审核 + 上架）：

```bash
node scripts/publish-examples.mjs --approve
```

然后刷新市场页面，或在 CLI 里查看：

```bash
node cli/agentdock.mjs list
```

## CLI

```bash
alias agentdock="node cli/agentdock.mjs"

# 连接服务端（令牌从 data/BOOTSTRAP-TOKENS.txt 取）
agentdock login --url http://127.0.0.1:7788 --token <token>

# 本地校验（不联网）：目录 → 归一化 → 结构校验 → 安全扫描
agentdock verify examples/skill-code-reviewer
agentdock verify examples/agent-code-reviewer --json

# 发布 / 审核 / 上架
agentdock publish examples/skill-code-reviewer --version 0.1.0
agentdock review queue
agentdock review approve skill/code-reviewer@0.1.0 --note "LGTM"
agentdock review reject  agent/code-reviewer@0.1.0 --note "提示词需要补充边界"

# 浏览与安装
agentdock list --kind skill
agentdock install skill/code-reviewer --target dsh
agentdock install agent/code-reviewer --target claude --force
agentdock install plugin/ops-kit --target dir --dir ./out
agentdock install agent/code-reviewer --target dsh-agent --profile web --force  # 生成 DSH preset 片段并并入 profile

# 审计与令牌
agentdock audit --limit 20
agentdock tokens create --name ci-bot --role publisher

# 把 ~/.claude/agents/*.md 批量导入为 agent 包（默认干跑，--publish 才提交）
agentdock import-claude
agentdock import-claude --publish
agentdock import-claude --presets                 # 同时生成 DSH agent-preset 片段
agentdock import-claude --presets --profile web   # 生成并自动并入 web profile
```

| 命令 | 说明 |
| --- | --- |
| `serve` | 启动 HTTP 服务 + Web 市场（`--port --host --data --home --scan-block`） |
| `login` / `whoami` | 保存/查看当前服务端与令牌（`~/.agentdock/config.json`） |
| `verify <dir>` | 本地校验能力包目录，输出错误、警告与扫描结果 |
| `publish <dir>` | 提交能力包，默认版本 `0.1.0`（`--version --tags`） |
| `list` | 列出已发布能力包（`--kind --json`） |
| `review queue` | 列出待审核版本 |
| `review approve\|reject <kind/name@version>` | 审核操作（`--note`） |
| `install <kind/name[@version]>` | 安装到目标（`--target --dir --force --profile`）；`--target dsh-agent` 生成 DSH preset 片段 |
| `audit` | 查看审计日志（`--limit --action --json`） |
| `tokens create\|list` | 令牌管理（需 admin） |
| `import-claude` | 读取 `~/.claude/agents/*.md`，转换为 agent 包；`--presets --presets-dir --profile` 同时生成/并入 DSH preset |

## 三个概念

| 概念 | 是什么 | 包内文件 | 安装到 |
| --- | --- | --- | --- |
| `skill` | 一份可复用的做事方法（渐进披露的指令集） | 根目录 `SKILL.md` | `~/.dsh/skills/<name>/`、`~/.claude/skills/<name>/`、`~/.agents/skills/<name>/` |
| `agent` | 一个可被派工的角色定义（tools + model + 系统提示） | 根目录 `agent.md` | `~/.claude/agents/<name>.md`（单文件 + sidecar）；或 `dsh-agent` 目标 → DSH preset 片段 |
| `plugin` | 能力分发容器，可同时含多个 skill/agent | 根目录 `plugin.json` + 子能力 | `~/.dsh/plugins/<name>/` 或目标目录 |

版本语义：`<kind>/<name>@<semver>`。发布后进入 `pending`，审核通过变 `published`（不可再覆盖）；被拒绝为 `rejected`，同一版本号可覆盖重提。

## 能力包格式

### skill

```
my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill
description: 一句话说明用途与触发场景（市场和模型路由都依赖它）
whenToUse: 用户要求做代码审查时
license: MIT
allowed-tools: Read, Grep, Glob
user-invocable: true
---

# 正文：具体步骤、约束、示例、检查清单
```

必填 `name`、`description`；`name` 必须与包名一致。支持的字段：`whenToUse`、`metadata`（键值标量）、`license`、`allowed-tools`、`user-invocable`、`disable-model-invocation`。未知字段与未知工具名只告警不阻断。

### agent

```
my-agent/
└── agent.md
```

```markdown
---
name: code-reviewer
description: 严格、务实的代码评审员（P0/P1/P2），只读，引用文件行号
tools: Read, Grep, Glob, Bash
model: sonnet
skills: [review-conventions]
mcp: [github]
---

你是代码评审员……（正文即系统提示）
```

`tools` 可写逗号分隔字符串或 YAML 数组；已知工具名包括 Claude Code 风格（`Read`/`Grep`/`Glob`/`Bash`/`Edit`/`Write`/`WebFetch`/`Task` 等）与 DSH 风格（`read`/`grep`/`glob`/`bash`/`write`/`edit` 等）。未知工具名会告警（运行时可能忽略）。

### plugin

```
my-plugin/
├── plugin.json
├── skills/
│   └── incident-checklist/SKILL.md
├── agents/
│   └── oncall.md
├── mcp/
└── commands/
```

```json
{
  "name": "ops-kit",
  "version": "0.1.0",
  "description": "值班与发布治理工具箱",
  "skills": ["skills/incident-checklist", "skills/release-checklist"],
  "agents": [],
  "mcp": [],
  "commands": [],
  "hooks": []
}
```

`plugin.json` 的 `name`/`version` 必须与包一致；`skills[]` 目录必须包含 `SKILL.md`；`agents[]` 必须是 `.md`；`mcp[]` 元素至少包含 `command` 或 `url`；`commands[]`/`hooks[]` 路径必须存在。

### 通用限制

| 项 | 限制 |
| --- | --- |
| 文件数 | ≤ 200 |
| 单文件 | ≤ 512 KB |
| 总大小 | ≤ 2 MB |
| 路径长度 | ≤ 180 |
| 名称 | `^[a-z0-9][a-z0-9._-]{0,62}$` |
| 路径安全 | 拒绝绝对路径、`..`、反斜杠、隐藏文件、Windows 保留名、`node_modules` |

## 审核与安全扫描

发布默认经过扫描，命中 `high` 级别规则时版本被**阻断**（可通过服务端 `AGENTDOCK_SCAN_BLOCK` 调整阈值）。管理员发布时传 `overrideScan: true` 可强制进入审核队列，扫描结果仍会保存并展示。

| 规则组 | 覆盖内容 |
| --- | --- |
| `PI-*` | 提示注入、越狱、要求隐瞒用户、绕过安全策略 |
| `EX-*` | 把本地数据/凭据外发到网络 |
| `SEC-*` | AWS/GitHub/API 密钥、私钥、凭据文件路径 |
| `SH-*` | `rm -rf /`、`curl \| sh`、fork bomb、`sudo`、`chmod 777`、危险跳过权限参数 |
| `HID-*` | HTML 注释隐藏指令、零宽字符、超长 base64 载荷 |
| `NET-*` | 读取 `process.env` 中的密钥并外发 |
| `BIN-*` | 二进制文件（不解析内容，仅提示） |

## 安装目标

| target | 安装位置 | 说明 |
| --- | --- | --- |
| `dsh` | `~/.dsh/skills/<name>/`；agent → `~/.dsh/agents/<name>/`；plugin → `~/.dsh/plugins/<name>/` | 技能直接被 DSH `dsh-skill-filesystem` 发现 |
| `dsh-agent` | `~/.dsh/agentdock/presets/<name>.patch.yml` | agent 专用：生成 DSH `@deepseek-ai/dsh-agent-preset` 片段（`- insert:` 条目），加 `--profile <name>` 自动并入 `~/.dsh/profiles/<name>/cordis.patch.yml` |
| `claude` | `~/.claude/skills/<name>/`；agent → `~/.claude/agents/<name>.md` | agent 单文件 + `<name>.agentdock/` sidecar（额外文件） |
| `codex` | `~/.codex/skills/<name>/` | OpenAI Codex 技能目录 |
| `shared` | `~/.agents/skills/<name>/` | 多 harness 共享目录 |
| `dir` | `<dir>/skills/<name>/` | 任意目录，需显式 `--dir` |

`dsh-agent` 目标把 agent 包转成 DSH 的 preset 条目：frontmatter 的 `tools` 映射成插件行（`tool-fs` / `tool-fs-search` / `tool-bash` / `tool-web` / `tool-todo` 等），正文成为 `@deepseek-ai/dsh-persona` 的 `prefix` 系统提示，`skills` 会加上 `skill-filesystem` + `tool-skill`。片段有两种启用方式：临时用 `dsh <profile> --patch <片段文件>` 挂载，或加 `--profile <name>` 由 AgentDock 以带标记的块（`# >>> agentdock preset <id>`）追加进 profile 的 `cordis.patch.yml`，重复执行会替换旧块而不是叠加。`DSH_HOME` 环境变量会覆盖 `~`（用于多 profile/测试）。注意 DSH 的 preset **不携带模型**：`model: sonnet` 这类字段无法映射，模型由会话或 `agent-default-model` 决定。启用后重启 DSH，在 Settings → Agent presets 中选择 `AgentDock · <name>`。

每次安装都会写入 `.agentdock-install.json` 清单（来源、版本、内容哈希、时间、目标）。目标已存在时默认冲突并拒绝覆盖，加 `--force` 覆盖同名文件；目录目标不会清理旧版本遗留的多余文件，需要干净安装时请先手动删除目标目录。

## HTTP API

所有接口前缀 `/api/v1`，认证方式 `Authorization: Bearer <token>`（也支持 `x-agentdock-token`）。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| GET | `/stats` | 公开 | 市场统计 |
| GET | `/me` | 登录 | 当前令牌身份 |
| GET | `/targets` | 公开 | 可用安装目标 |
| POST | `/verify` | publisher | 校验/扫描能力包，不入库 |
| GET | `/packages?status=&kind=` | 公开（pending 需审核权限） | 市场列表 |
| POST | `/packages` | publisher | 发布能力包 |
| GET | `/packages/:kind/:name` | 公开 | 能力详情（含版本、扫描摘要） |
| GET | `/packages/:kind/:name/versions/:version` | 公开（pending 需审核权限） | 版本详情 |
| GET | `/packages/:kind/:name/versions/:version/bundle` | 公开 | 下载完整内容 |
| GET | `/packages/:kind/:name/versions/:version/files?path=` | 公开 | 预览单个文件 |
| POST | `/packages/:kind/:name/versions/:version/install-event` | 登录 | 登记安装事件 |
| POST | `/install` | publisher | 安装到目标目录（服务端权限内） |
| GET | `/review/queue` | reviewer | 待审核队列 |
| POST | `/review` | reviewer | 审核 `{kind,name,version,decision,note}` |
| GET | `/audit` | reviewer | 审计日志（`limit/offset/action`） |
| GET | `/admin/users` | admin | 用户列表 |
| POST | `/admin/tokens` | admin | 创建令牌 `{name,role}` |

发布请求体即能力包 JSON：

```json
{
  "kind": "skill",
  "name": "demo-skill",
  "version": "0.1.0",
  "description": "演示技能",
  "tags": ["demo"],
  "files": [
    { "path": "SKILL.md", "content": "---\nname: demo-skill\ndescription: 演示\n---\n\n正文", "encoding": "utf8" }
  ]
}
```

`encoding` 为 `utf8` 或 `base64`（二进制文件）。

## 配置

全部通过环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENTDOCK_PORT` | `7788` | 监听端口 |
| `AGENTDOCK_HOST` | `127.0.0.1` | 监听地址 |
| `AGENTDOCK_DATA` | `./data` | 数据目录 |
| `AGENTDOCK_PUBLIC_URL` | `http://host:port` | 对外展示地址 |
| `AGENTDOCK_SCAN_BLOCK` | `high` | 阻断阈值：`low` / `medium` / `high` |
| `AGENTDOCK_URL` | `http://127.0.0.1:7788` | CLI 连接地址 |
| `AGENTDOCK_TOKEN` | — | CLI 令牌 |
| `AGENTDOCK_DEV` | — | 设为 `1` 开启调试日志 |

CLI 登录信息保存在 `~/.agentdock/config.json`（权限 600）。

## 导入 Claude Code agents

```bash
agentdock import-claude                 # 干跑：读取并校验 ~/.claude/agents/*.md
agentdock import-claude --publish       # 提交到平台，进入待审核
agentdock import-claude --dir <dir> --version 0.2.0
```

每个 `.md` 会被包装成 `agent` 包：frontmatter 的 `name`/`description` 成为包元信息，`tools`/`model` 保留在 `agent.md` 中；正文即系统提示。导入前会跑同一套结构校验与安全扫描。

导入时加 `--presets` 会顺带生成 DSH preset 片段（默认写入 `~/.dsh/agentdock/presets/`）：

```bash
agentdock import-claude --presets                    # 干跑 + 生成片段
agentdock import-claude --presets --profile web      # 生成并并入 web profile（带标记、可重复执行）
agentdock import-claude --presets-dir ./presets      # 片段写到自定义目录，交给配置管理分发
```

生成的片段可直接用 DSH 验证：`DSH_HOME=/tmp/dshhome dsh <profile> --patch <片段> --dump-config`。`name` 重复的 md 会被跳过并提示，避免多个文件映射到同一个 preset id。DSH 目前没有 `~/.claude/agents` 原生目录支持：安装到 `claude` 目标即还原为 Claude Code 可识别的 md；要在 DSH 中使用，用 `--target dsh-agent` 或 `import-claude --presets` 生成 preset 片段（原理见 `docs/ARCHITECTURE.md` 的「与 DSH 集成」）。

## 项目结构

```
agentdock/
├── cli/agentdock.mjs        # CLI（发布/审核/安装/导入/审计）
├── server.mjs               # HTTP 服务入口
├── src/
│   ├── app.mjs              # 路由 + 静态文件 + 鉴权编排
│   ├── pipeline.mjs         # 归一化 → 校验 → 扫描 纯函数流水线
│   ├── bundle.mjs           # 能力包归一化/路径消毒/哈希
│   ├── validate.mjs         # 三种 kind 的结构校验与 manifest
│   ├── scan.mjs             # 安全扫描规则引擎
│   ├── store.mjs            # 版本库（JSON 元数据 + 文件落盘 + 审核状态机）
│   ├── targets.mjs          # 安装目标解析与落盘计划
│   ├── dsh-preset.mjs       # agent 包 → DSH agent-preset 片段（tools 映射、profile 合并）
│   ├── auth.mjs             # 令牌/角色
│   ├── audit.mjs            # JSONL 审计
│   ├── config.mjs           # 配置与数据目录
│   ├── errors.mjs / util.mjs / yaml.mjs
├── web/                     # 零依赖市场 UI（原生 JS）
├── examples/                # 三类示例能力包
├── scripts/                 # smoke + 批量发布示例
├── tests/                   # node:test 测试（33 个用例）
└── data/                    # 运行时数据（git 忽略）
```

## 开发与测试

```bash
npm test                  # 单元 + HTTP 接口测试（node --test）
npm run smoke             # 端到端：真实启动服务 + CLI + 落盘安装
npm run examples:publish  # 把示例发布到已运行的服务（可加 -- --approve）
```

`npm run smoke` 会在临时目录启动一个隔离实例，覆盖完整闭环，最后输出 `SMOKE OK` 与统计信息，不污染本地 `data/`。

## 设计取舍

- **零依赖**：只用 Node 标准库（`node:http`、`node:test`、`fetch`），离线环境可直接跑；代价是 YAML 解析器、路由等需要自己维护子集实现。
- **JSON bundle 而非 multipart/tar/zip**：上传/下载都是普通 JSON，方便 CLI、CI、脚本复用；代价是大包体积略增。
- **文件系统存储而非数据库**：元数据 `db.json` + 内容按版本落盘，便于备份/审查/手工检查；代价是全量索引常驻内存（适合几千个包规模）。
- **静态市场前端**：原生 JS，无构建步骤；代价是复杂交互（markdown 渲染、diff）后续再补。

## 安全模型与已知限制

- 令牌只存 `sha256` 哈希；初始明文令牌仅出现在 `data/BOOTSTRAP-TOKENS.txt`（600 权限），建议首次登录后轮换并删除该文件。
- 审计日志 append-only JSONL，记录 actor/role/action/target/meta/ip。
- 服务默认只监听 `127.0.0.1`；面向团队部署时应置于反向代理/TLS 之后，并限制 `/api/v1/admin/*` 入口。
- 扫描是**启发式规则**，不是沙箱：绕过规则注入的能力包仍可能危险，审核环节不可省。
- 当前无分页搜索、无 SSO/多租户、无签名验证（内容哈希仅用于一致性校验）。

## Roadmap

- [ ] 市场分页、全文搜索、标签筛选
- [ ] markdown 安全渲染与审核 diff 视图
- [ ] 内容签名（ed25519）与 `verify --signature`
- [x] DSH agent preset 安装目标（`dsh-agent`，生成 preset 片段并可按 profile 合并）
- [ ] 与外部 registry（GitHub / skills.sh / MCP registry）双向同步
- [ ] 依赖清单与 SBOM、按策略自动审批
- [ ] SQLite 存储后端（>1 万包规模）

## License

MIT
