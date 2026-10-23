[English](README.md) | 中文

[![CI](https://github.com/creativity1013/agentdock-registry/actions/workflows/ci.yml/badge.svg)](https://github.com/creativity1013/agentdock-registry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# AgentDock

**私有化的 AI 编码能力市场**——集中管理 Claude Code / Codex / DSH 的 skill、agent、plugin，提供审核、安全扫描、签名与审计，一键装回成员机器，数据不出内网。

`self-hosted` · `skill registry` · `Claude Code` · `Codex` · `governance`

<!-- TODO: screenshot --> ![AgentDock 市场界面](docs/screenshots/market.png)

## 整体架构

![AgentDock 发布 → 审核 → 安装流程](docs/flow-overview.png)

<!-- TODO: screenshot --> ![审核队列与 diff 视图](docs/screenshots/review.png)

<!-- TODO: screenshot --> ![待审核版本逐行 diff](docs/screenshots/diff.png)

## 30 秒上手

需要一个已运行的服务端（见下文）和 CLI。令牌在首次启动后位于 `data/BOOTSTRAP-TOKENS.txt`。

```bash
agentdock login --url http://127.0.0.1:7788 --token <publisher-token>

# 发布
agentdock publish examples/skill-code-reviewer --version 0.1.0

# 审核
agentdock review queue
agentdock review approve skill/code-reviewer@0.1.0 --note "LGTM"

# 安装
agentdock install skill/code-reviewer --target claude

# 验签 + 内容哈希校验
agentdock verify-signature skill/code-reviewer@0.1.0
```

## 3 分钟 Docker 启动

```bash
git clone https://github.com/creativity1013/agentdock-registry
cd agentdock
docker compose up -d --build
docker exec agentdock cat /data/BOOTSTRAP-TOKENS.txt   # 首次启动生成的 admin / reviewer / publisher 令牌
```

浏览器打开 `http://localhost:7788` 即是市场界面。容器监听 `0.0.0.0:7788`，数据全部持久化在 `agentdock-data` 卷（挂载于 `/data`），自带针对 `/api/v1/health` 的健康检查。不用 Docker 也可以直接用 Node 启动，见[快速开始（Node.js）](#快速开始)。

## 对比：手工共享 vs AgentDock

在用 Claude Code / Codex 的团队，通常靠群文件、网盘或聊天记录共享 skill。能用，但问题很快出现：

| | 手工共享（群文件 / 网盘） | AgentDock |
| --- | --- | --- |
| 版本管理 | 靠文件名约定，无历史 | 版本不可变，semver + 内容哈希 |
| 审核 | 无——任何人可覆盖任何文件 | 审核队列，带与上一已发布版本的逐行 diff |
| 安全扫描 | 靠人眼，甚至没有 | 发布时 47 条静态规则 + 供应链检查，高危默认阻断 |
| 签名 | 无 | ed25519 平台签名（审核通过即签）+ 可选发布者签名 |
| 审计 | 无 | append-only JSONL，带防篡改哈希链 |
| 安装 | 手工拷贝文件 | 一条命令装到任意目标（`dsh` / `claude` / `codex` / `shared` / `dir`） |
| 回滚 | 翻旧聊天记录找 zip | 按本地安装清单 `rollback`（保留最近 5 个版本） |

## 安全模型摘要

- **47 条静态扫描规则**，覆盖十组：提示注入、数据外发、密钥泄漏、危险命令、动态执行、持久化与 harness 配置篡改、隐藏指令（零宽字符、Trojan Source、同形字）、env 密钥外发、结构检查（description 投毒、npm 生命周期脚本、shell+网络工具组合）、二进制标记。命中高危默认阻断发布（`AGENTDOCK_SCAN_BLOCK` 调整阈值）。供应链检查识别包名仿冒，并对增量更新单独做 diff 扫描。
- **ed25519 双重签名**：版本审核通过时平台签名（载荷 `agentdock-v1`，公钥经 `GET /api/v1/keys` 公开，可离线验签）；发布者可用自己的私钥追加签名（`publish --key`，TOFU 自动注册）。验签同时重算磁盘内容哈希，发布后的篡改可被发现。
- **可验证透明日志**：每次审核通过追加哈希链事件，按 RFC 6962 风格构造 Merkle 树；任何人可校验整条链或获取版本的包含证明（`transparency verify` / `transparency proof`）。
- **审计哈希链 + 轮转**：append-only JSONL，每条记录以 `sha256(seq, prevHash, …)` 链接，`audit verify` 可定位断链，超 8MB 轮转并保留 24 份归档。
- **可选 LLM 语义研判**（默认关闭，纯建议性）：静态扫描命中的 pending 版本会自动送 OpenAI 兼容模型做第二次语义研判，结论仅供人工复核，不参与阻断判定；干净版本不消耗模型调用。
- **四级令牌 + SSO**：`admin` / `reviewer` / `publisher` / `viewer`（令牌只存 sha256 哈希），支持 OIDC 登录（Authorization Code + PKCE）、组→角色映射、可选 MFA 强制、多租户隔离与限流。

扫描是启发式规则 + 结构检查，不是沙箱——人工审核始终是流程的一部分。

## Enterprise / Support

<!-- TODO: 发布前确认实际服务内容、定价模式与联系邮箱 -->
面向需要在生产环境落地 AgentDock 的团队，提供：

- **部署实施**——协助搭建、SSO/IdP 对接、反代与 TLS 配置
- **年维护**——优先修复、升级指导、安全补丁回移
- **团队培训**——管理员的发布/审核流程、开发者的 CLI 上手

联系方式：**enterprise@example.com** <!-- TODO: 替换为真实联系邮箱 -->

## 文档

- [架构设计](docs/ARCHITECTURE.md)——分层、请求生命周期、数据模型、设计取舍
- [产品流程](docs/PRODUCT-FLOW.md)
- [新团队上手](docs/ONBOARDING-NEW-TEAM.md)

## 参与贡献

欢迎 Issue 与 PR。项目零第三方依赖（仅 Node 标准库），无需 `npm install`，也没有 lockfile 要维护。

```bash
npm test          # 单元 + HTTP 接口测试（node --test）
npm run smoke     # 端到端：临时目录里真实启动服务 + CLI + 落盘安装
```

## License

[MIT](LICENSE)

---

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
- 市场体验：Web 界面分页浏览 + 服务端搜索、markdown 安全渲染、待审核版本的 diff 视图（文件级 + 逐行差异）；待审核队列按扫描风险分组（高危 / 中危 / 低危 / 干净）并支持类型与风险筛选，支持勾选后批量删除或逐条删除待审核版本（仅 `pending`，已发布/已拒绝不可删）
- 策略可视化：管理员可在 Web「策略」页直接编辑自动审批规则（类型/受信发布者/签名要求/扫描阈值/体积上限），保存即生效并留审计

## 安装 CLI（可选但推荐）

源码目录内的 `bin/agentdock` 可直接用，或把 CLI 链接为全局命令 `agentdock`：

```bash
cd agentdock
npm link                       # 之后在任意目录可直接执行 agentdock
# 或：把本仓库 bin 加入 PATH
# echo 'export PATH="$HOME/code/agentdock/bin:$PATH"' >> ~/.zshrc
```

> Web「成员本机安装」的复制按钮会生成带 `--url` / `--token` 的完整命令，粘贴即可执行；前提是 `agentdock` 已可用（`npm link` 或 PATH）。

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
agentdock verify examples/bundles/skill-code-reviewer.zip      # zip / tar.gz / 单文件 md 同样可校验
agentdock publish examples/bundles/plugin-ops-kit.zip --version 0.1.0
agentdock publish examples/bundles/agent-code-reviewer.md

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

# 审计与令牌（审计日志带防篡改哈希链）
agentdock audit --limit 20                          # 查询：--actor/--action/--target/--from/--to
agentdock audit verify --all                        # 校验哈希链（--all 含归档；断链 exit 1）
agentdock audit --tenant acme                       # 只查看某租户的审计（admin）
agentdock audit export --format csv --out audit.csv # 导出（csv / jsonl）
agentdock tokens create --name ci-bot --role publisher

# 把 ~/.claude/agents/*.md 批量导入为 agent 包（默认干跑，--publish 才提交）
agentdock import-claude
agentdock import-claude --publish
agentdock import-claude --presets                 # 同时生成 DSH agent-preset 片段
agentdock import-claude --presets --profile web   # 生成并自动并入 web profile

# 发布者签名 + 透明日志
agentdock keygen --out ~/.agentdock/keys --name alice   # 生成 ed25519 密钥对（私钥 600）
agentdock register-key --key ~/.agentdock/keys/alice-public.pem --name alice
agentdock publish ./my-skill --key ~/.agentdock/keys/alice-private.pem --key-name alice
agentdock transparency verify                           # 校验透明日志哈希链
agentdock transparency proof skill/my-skill@0.1.0       # 版本包含证明（本地校验 Merkle）

# SBOM 与自动审批策略
agentdock sbom skill/code-reviewer@0.1.0                # 文件哈希 + 工具/MCP 组件
agentdock policy show                                   # 查看自动审批策略（reviewer）
agentdock policy set --file policy.json                 # 更新策略（admin）

# 外部 registry 同步（GitHub / MCP registry）
agentdock sync sources
agentdock sync import github acme/skills --path skills/review --dry-run
agentdock sync import github acme/skills --path skills/review
agentdock sync import mcp weather
agentdock sync export --out marketplace.json            # 中立市场目录（agentdock-marketplace@1）
```

| 命令 | 说明 |
| --- | --- |
| `serve` | 启动 HTTP 服务 + Web 市场（`--port --host --data --home --scan-block`） |
| `login` / `whoami` | 保存/查看当前服务端与令牌（`~/.agentdock/config.json`） |
| `verify <dir>` | 本地校验能力包目录，输出错误、警告与扫描结果 |
| `publish <dir>` | 提交能力包，默认版本 `0.1.0`（`--version --tags`）；`--key <私钥 PEM>` 附加发布者签名（TOFU 自动注册公钥） |
| `list` | 列出已发布能力包（`--kind --json`） |
| `review queue` | 列出待审核版本 |
| `review approve\|reject <kind/name@version>` | 审核操作（`--note`） |
| `install <kind/name[@version]>` | 安装到目标（`--target --dir --force --profile`）；`--target dsh-agent` 生成 DSH preset 片段；**默认安装前扫描 + 验签**（`--no-verify` 跳过，`--allow-risk` 允许高危继续） |
| `outdated` | 扫描本地安装清单，对比服务端最新已发布版本（`--target --dir --json`）；有更新时 exit 0 |
| `upgrade <kind/name[@version]>` | 升级本地安装到最新/指定版本（`--target --dir --force --profile`），默认覆盖同名文件并上报安装计数；安装清单保留最近 5 个版本历史 |
| `rollback <kind/name>` | 按安装清单历史回滚到上一个安装过的版本（`--target --dir`），同样做扫描/验签 |
| `uninstall <kind/name>` | 按安装清单卸载（`--target --dir`；省略 `--target` 时扫描全部已知目标），删除包文件/目录与清单 |
| `audit` | 审计日志查询/校验/导出：`audit [--limit --offset --tenant --action --actor --target --from --to --json]`；`audit verify [--all]` 校验哈希链（断链 exit 1）；`audit export --format csv\|jsonl [--out 文件]`（需 reviewer） |
| `verify-signature <kind/name[@version]>` | 验证内容签名（ed25519）；同时重算磁盘内容哈希发现篡改（`--json`） |
| `keys [--mine]` | 导出平台签名公钥（可离线验签）；`--mine` 查看自己的发布者公钥 |
| `keygen` | 生成发布者 ed25519 密钥对（`--out --name --force`；私钥 600、公钥可公开） |
| `register-key` | 注册发布者公钥（`--key <公钥 PEM> --name`） |
| `transparency [head\|verify\|entries\|proof <kind/name[@version]>]` | 可验证透明日志：头部 / 验链 / 列表 / 版本 Merkle 包含证明（本地校验） |
| `sbom <kind/name[@version]>` | 查看版本 SBOM：文件哈希、工具/MCP/技能组件与 digest（`--json`） |
| `policy show\|set` | 自动审批策略：`show` 读取（reviewer），`set --file <policy.json>` 更新（admin） |
| `tokens create\|list` | 令牌管理（需 admin） |
| `users disable\|enable\|revoke <id或名字>` | 禁用/启用用户、强制其会话下线（需 admin） |
| `sessions revoke-all` | 强制全员会话下线（需 admin） |
| `notify show\|set <配置.json>\|test` | 查看/设置 webhook 通知、发送测试通知（需 admin） |
| `import-claude` | 读取 `~/.claude/agents/*.md`，转换为 agent 包；`--presets --presets-dir --profile` 同时生成/并入 DSH preset |
| `sync sources` | 查看已配置的外部 registry 适配器（GitHub / MCP registry） |
| `sync import github <owner/repo>` | 从 GitHub 目录导入 skill/agent/plugin（`--path --ref --version --dry-run`），进入待审核 |
| `sync import mcp <server-name>` | 从 MCP registry 导入 server，转换为带 `mcp` 声明的 plugin 能力包 |
| `sync push github <kind/name[@version]>` | 把已上架能力包推成 GitHub 单次 commit（`--repo --path --branch --message --dry-run`，需 `GITHUB_TOKEN`） |
| `sync export [--out <文件>]` | 导出中立市场目录（`agentdock-marketplace@1`，含 bundleUrl/内容哈希/签名摘要） |

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
| `PI-*`（8 条） | 提示注入、越狱、要求隐瞒用户、绕过安全策略；中英文双语措辞（`忽略之前的指令` 等）、条件触发型注入（`当用户……时`）与伪装系统提示 |
| `EX-*`（4 条） | 把本地数据/凭据外发到网络；webhook 收集端点（webhook.site/requestbin 等）、curl/nc 数据外流、已知遥测上报域名 |
| `SEC-*`（10 条） | AWS/GitHub/API 密钥、私钥、数据库连接串、JWT、Bot token、现代 key 格式（`sk-`/`xox`/`AKIA`/Google AI 等）；凭据类文件名（`.env`、`credentials*`，结构检查） |
| `SH-*`（8 条） | `rm -rf /`、`curl \| sh`、fork bomb、`sudo`、`chmod 777`、危险跳过权限参数；磁盘擦除（`mkfs`/`dd if=/dev/zero`）与计划任务植入（crontab/launchd） |
| `EXEC-*`（2 条） | 动态执行：`eval`/`new Function`/`execSync` 拼接、混淆后解码执行（base64 → shell） |
| `PER-*`（4 条） | 持久化与 harness 配置篡改：写入 shell rc / crontab / launchd / systemd、改 `CLAUDE.md`/`settings.json` 等 harness 配置、`authorized_keys`、`.ssh` 植入 |
| `HID-*`（6 条） | HTML 注释隐藏指令、零宽字符、超长 base64 载荷；Trojan Source 双向控制符、西里尔同形字混淆、高熵 blob |
| `NET-*` | 读取 `process.env` 中的密钥并外发 |
| `MET-*`（3 条，结构检查） | `MET-001` description 字段投毒（模型会读到的简介含指令/外发措辞）；`MET-002` 插件 `package.json` 含 npm 生命周期脚本（preinstall/postinstall = 任意代码执行）；`MET-003` agent 同时持有 shell + 网络工具（组合风险） |
| `BIN-*` | 二进制文件（不解析内容，仅提示） |

除内容规则外，服务端在发布时还做两层**供应链检查**（`SUP-*`，需要数据库上下文，不在 `verify` 离线扫描里）：

- `SUP-001`（中危）：新包名与同租户已有包名编辑距离 ≤ 2（≥5 字符才比对）——**抢注/仿冒嫌疑**，仅提示不阻断，交人工审核
- `SUP-002`：与该包最近一个非拒绝版本的 **diff 增量** 单独扫描——旧版本干净、更新里夹带高危内容（典型供应链投毒手法）时按高危阻断；结果里的 `scan.diff.base` 记录比对基准版本

### AI 研判（可选，默认关闭）

配置方式二选一：**Web「策略」页的「AI 研判」面板**（admin，保存到 `data/llm.json`，即时生效，Key 只写不回显）或环境变量 `AGENTDOCK_LLM_URL` + `AGENTDOCK_LLM_MODEL`（页面配置优先于环境变量）。配置后，进入人工审核的 pending 版本若**静态扫描命中任一规则**（低/中/高危），会自动（fire-and-forget，不阻塞发布）把内容与静态扫描结果送给大模型；干净版本（零命中）不消耗模型调用，直接等人工复核。送审时做**第二次、语义级的安全研判**——针对静态正则抓不住的条件触发注入、伪装指令等；也可以在版本详情页点「AI 研判」手动触发（reviewer 及以上）。结论是**纯建议性**的：存入 `version.llmReview`（风险等级 + 发现 + 理由），在扫描面板「AI 研判」区块展示，**不参与阻断判定**——待扫内容本身就是对抗性的，模型结论只辅助人工复核。模型输出的 JSON 结构不合法或接口超时也会照实落盘为失败记录，不影响发布与审核流程。

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

安装前默认本地复检：落盘前重新跑安全扫描并调用服务端 `signature?verify=1` 做签名/内容哈希复验，任何一项失败都会中止（确认可信时加 `--allow-risk`；`--no-verify` 完全跳过）。`upgrade`、`rollback` 同样适用。

> **Web 端「安装」的边界**：Web 市场运行在服务端，浏览器无法直接写成员电脑的磁盘，所以页面上的「安装到平台主机」只写入**运行 AgentDock 的那台机器**（适合单机/all-in-one 演示、或管理员代装）。面向团队时请让成员在**自己的机器**上执行 CLI：版本的「成员本机安装」区会生成 `agentdock install <kind>/<name>@<version> --target …` 命令（可一键复制）并支持「下载 JSON 包」，成员配好自己的 `AGENTDOCK_URL` 与令牌后执行即可。

### 推送发布（GitHub / skills.sh）

导入是 pull，推送是 push：`sync push` 把已上架版本的全部文件写到目标 GitHub 仓库的一个目录里，用 Git Data API 生成**单次 commit**（blobs → tree → commit → 更新 ref），适合把 AgentDock 作为内部审核网关、对外发布到公开技能仓库。

```bash
# 前置：在发布者机器上设置 GitHub 令牌（要求 repo 写权限）
export GITHUB_TOKEN=ghp_xxx

agentdock sync push github skill/code-reviewer@0.2.0 \
  --repo acme/ai-skills --path skills/code-reviewer \
  --branch main --message "sync reviewer skill"
```

- `--dry-run` 只打印将要写入的文件清单，不调用 GitHub API（可在无 token 环境做发布预检）。
- 推送内容来自服务端已审核版本（自动带内容签名校验语义，但推送本身只搬运文件）；目标仓库的分支保护/PR 流程仍由 GitHub 决定。
- 与 skills.sh 的配合：skills.sh 的技能目录以 GitHub 上的 `SKILL.md` 为来源，用同一命令把 skill 推到对应公开仓库（路径/分支按目标仓库约定），再走它自己的目录收录/PR 流程；无需 AgentDock 侧额外适配器。
- 需要从平台内一键推送时，应作为独立的管理端插件/CLI 扩展，而不是把 GitHub 令牌放进服务端。

## 质量分级

每个版本都会从元数据推导出质量等级（不新增存储，随版本详情/市场列表一起返回）：

| 等级 | 条件 |
|---|---|
| 社区 `community` | 仅已上架（无平台签名或未审核） |
| 已验证 `verified` | 平台签名 + 审核通过（人工或策略自动）+ 无高危 |
| 官方 `official` | 已验证 + 发布者签名 + 人工审核 + 无高危/中危 |

- Web 市场卡片/详情、`agentdock list` 的「质量」列、`agentdock quality <kind>/<name>[@version]`、API 的 `quality` 字段均可查看；自动审批策略的信任分流（`trustedPublishers` + `requirePublisherSignature`）与质量分级共同构成「信任等级」。
- 质量等级是**展示与分流的辅助信号**，不替代签名/透明日志校验：安装与验签始终以内容哈希和签名为准。

## 版本检查与升级

每次安装都会写一份安装清单（`<目标目录>/.agentdock-install.json`；Claude Code 的 agent 为 `<name>.agentdock.json`；`dsh-agent` 为 `<name>.agentdock.json`），记录包名、版本、contentHash、安装目标与最近 5 个版本历史；`uninstall` 直接按清单删除，`rollback` 取历史末尾版本重新安装。`outdated` 扫描这些清单并与服务端 `latestVersion` 比较；`upgrade` 重新下载最新（或指定）版本、`--force` 覆盖同名文件、重新上报安装计数。

```bash
agentdock outdated                              # 扫描 ~/.dsh / ~/.claude / ~/.codex / ~/.agents 的安装记录
agentdock outdated --target dir --dir /opt/skills
agentdock upgrade skill/code-reviewer --target dsh
agentdock upgrade agent/code-reviewer --target claude
agentdock upgrade agent/code-reviewer --target dsh-agent --profile web   # 顺带刷新 profile 里的 preset 片段
```

注意：`dir` 目标需要显式 `--dir`；`dsh-agent` 升级时若带 `--profile` 会重写该 profile 的标记块（幂等）。团队场景建议成员在自己机器上跑 `outdated`，发现新版本后自行 `upgrade`（与「安装」相同的权限边界）。

## HTTP API

所有接口前缀 `/api/v1`，认证方式 `Authorization: Bearer <token>`（也支持 `x-agentdock-token`）；启用 SSO 时也可使用登录后的会话 Cookie（`agentdock_session`，见下文「SSO 登录与多租户」）。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| GET | `/keys` | 公开 | 平台签名公钥（ed25519，`keyId` + PEM）及各版本签名可离线验证 |
| GET | `/stats` | 公开 | 市场统计 |
| GET | `/me` | 登录 | 当前令牌身份 |
| GET | `/me/keys` | 登录 | 当前账号的发布者公钥 |
| POST | `/me/keys` | publisher | 注册发布者公钥 `{name,publicKeyPem}`（ed25519 PEM） |
| DELETE | `/me/keys/:keyId` | 登录 | 删除发布者公钥 |
| GET | `/targets` | 公开 | 可用安装目标 |
| POST | `/verify` | publisher | 校验/扫描能力包，不入库 |
| GET | `/packages?q=&kind=&status=&page=&pageSize=` | 公开（pending 需审核权限） | 市场列表（分页，`pageSize` 默认 24、最大 100） |
| POST | `/packages` | publisher | 发布能力包 |
| GET | `/packages/:kind/:name` | 公开 | 能力详情（含版本、扫描摘要） |
| GET | `/packages/:kind/:name/versions/:version` | 公开（pending 需审核权限） | 版本详情 |
| GET | `/packages/:kind/:name/versions/:version/bundle` | 公开 | 下载完整内容 |
| GET | `/packages/:kind/:name/versions/:version/files?path=` | 公开 | 预览单个文件 |
| GET | `/packages/:kind/:name/versions/:version/signature?verify=1` | 公开（pending 需审核权限） | 版本签名；`verify=1` 会重算磁盘内容哈希并验签 |
| GET | `/packages/:kind/:name/versions/:version/sbom` | 公开（pending 需审核权限） | 版本 SBOM（`agentdock-sbom@1`：文件哈希、组件、digest） |
| POST | `/packages/:kind/:name/versions/:version/llm-review` | reviewer | 手动触发一次模型研判（建议性结论，写入 `version.llmReview`） |
| GET | `/packages/:kind/:name/diff?to=&from=` | 公开（pending 需审核权限） | 版本差异（行级 diff；`from` 缺省为上一个已发布版本） |
| POST | `/packages/:kind/:name/versions/:version/install-event` | 登录 | 登记安装事件 |
| POST | `/install` | publisher | 安装到目标目录（服务端权限内） |
| GET | `/review/queue` | reviewer | 待审核队列 |
| POST | `/review` | reviewer | 审核 `{kind,name,version,decision,note}` |
| POST | `/review/delete` | reviewer | 删除待审核版本：`{entries:[{kind,name,version}]}`（单个或批量），仅 `pending` 可删，磁盘文件与队列记录一并清除，逐条返回成败 |
| GET | `/policy` | reviewer | 自动审批策略与来源（default / policy.json） |
| PUT | `/policy` | admin | 更新自动审批策略（整体替换，校验后持久化到 `data/policy.json`） |
| GET | `/transparency/head` | 公开 | 透明日志头部：事件数、headHash、Merkle 根 |
| GET | `/transparency/entries?limit=&offset=` | 公开 | 透明日志事件（最新在前） |
| GET | `/transparency/verify` | 公开 | 校验整条哈希链（篡改返回 409） |
| GET | `/transparency/proof?kind=&name=&version=` | 公开（pending 需审核权限） | 版本在 Merkle 树中的包含证明 |
| GET | `/registry` | 公开 | 外部 registry 适配器信息与导出地址 |
| GET | `/registry/export` | 公开 | 中立市场目录（`agentdock-marketplace@1`：bundleUrl、contentHash、签名摘要、digest） |
| POST | `/sync/import` | publisher | 从外部 registry 导入 `{source:{type:"github",repo,path,ref}}` 或 `{source:{type:"mcp",name}}`；`dryRun:true` 只预检 |
| GET | `/audit` | reviewer | 审计日志（`limit/offset/action/actor/target/from/to/tenant`，最新在前；非 admin 强制本租户） |
| GET | `/audit/verify` | reviewer | 校验审计哈希链（`?all=1` 含归档；断链返回 409 与断链位置） |
| GET | `/audit/export` | reviewer | 导出审计（`format=csv\|jsonl`，过滤参数同 `/audit`（含 `tenant`），时间正序） |
| GET | `/admin/users` | admin | 用户列表 |
| POST | `/admin/tokens` | admin | 创建令牌 `{name,role,tenant}`（`tenant` 缺省为 `default`） |
| PATCH | `/admin/users/:id` | admin | 禁用/启用用户 `{disabled}`；禁用即刻踢下线 |
| POST | `/admin/users/:id/revoke-sessions` | admin | 强制该用户所有会话下线（sessionEpoch +1） |
| POST | `/admin/sessions/revoke-all` | admin | 强制全员会话下线（globalEpoch +1） |
| GET | `/notify` | admin | 查看 webhook 通知配置 |
| PUT | `/notify` | admin | 更新通知配置 `{notify:{enabled,webhooks:[{name,url,format,events,secret}]}}` |
| POST | `/notify/test` | admin | 发送一条测试通知 |

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
| `AGENTDOCK_LLM_URL` | — | 模型研判（AI 第二次安全研判）：OpenAI 兼容 `chat/completions` 基地址（如 `https://api.deepseek.com/v1`、Ollama `http://127.0.0.1:11434/v1`）；也可在 Web「策略」页配置（存 `data/llm.json`，优先于环境变量） |
| `AGENTDOCK_LLM_MODEL` | — | 模型名；与 `AGENTDOCK_LLM_URL` 齐全才启用 |
| `AGENTDOCK_LLM_KEY` | — | 模型 API Key（本地 Ollama 等可省略） |
| `AGENTDOCK_LLM_TIMEOUT_MS` | `60000` | 模型研判超时 |
| `AGENTDOCK_URL` | `http://127.0.0.1:7788` | CLI 连接地址 |
| `AGENTDOCK_TOKEN` | — | CLI 令牌 |
| `AGENTDOCK_DEV` | — | 设为 `1` 开启调试日志 |
| `AGENTDOCK_GITHUB_API` | `https://api.github.com` | 外部同步使用的 GitHub API 基地址（可指向内网镜像） |
| `AGENTDOCK_MCP_REGISTRY` | `https://registry.modelcontextprotocol.io` | 外部同步使用的 MCP registry 基地址 |
| `GITHUB_TOKEN` | — | 可选，提高 GitHub API 速率上限并访问私有仓库 |
| `AGENTDOCK_STORE` | `json` | 元数据后端：`json`（`data/db.json`）或 `sqlite`（`data/agentdock.sqlite`，需 Node 24+ 的 `node:sqlite`） |
| `AGENTDOCK_OIDC_ISSUER` | — | 启用 SSO 时必填：OIDC Issuer（如 `https://idp.example.com`），用于发现端点 |
| `AGENTDOCK_OIDC_CLIENT_ID` | — | OIDC Client ID |
| `AGENTDOCK_OIDC_CLIENT_SECRET` | — | OIDC Client Secret（可选，公开客户端可留空） |
| `AGENTDOCK_OIDC_REDIRECT` | `<PUBLIC_URL>/auth/oidc/callback` | OIDC 回调地址（需在 IdP 注册一致） |
| `AGENTDOCK_OIDC_DEFAULT_ROLE` | `viewer` | 新账号默认角色：`viewer/publisher/reviewer/admin` |
| `AGENTDOCK_OIDC_TENANT_CLAIM` | `tenant` | 用户信息中表示租户的 claim 名 |
| `AGENTDOCK_OIDC_ROLE_CLAIM` | `role` | 用户信息中表示角色的 claim 名（须为合法角色） |
| `AGENTDOCK_OIDC_GROUPS_CLAIM` | `groups` | 用户信息中表示组的 claim 名（数组或以空格/逗号分隔的字符串） |
| `AGENTDOCK_OIDC_GROUP_ROLES` | — | 组→角色映射，如 `agents-admins=admin,agents-reviewers=reviewer`（role claim 缺失时生效，取最高权限组） |
| `AGENTDOCK_OIDC_MFA_REQUIRED` | — | 设为 `1` 时要求 IdP 在 `amr` 中声明多因素（`mfa/totp/hwk/swk/otp`），否则拒绝登录 |
| `AGENTDOCK_OIDC_AMR_CLAIM` | `amr` | 表示认证方式（多因素）的 claim 名 |
| `AGENTDOCK_RATE_LIMIT` | 启用 | 设为 `0` 关闭单机限流 |
| `AGENTDOCK_RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `AGENTDOCK_RATE_LIMIT_MAX` | `300` | 每窗口每 IP 的 API 请求上限 |
| `AGENTDOCK_RATE_LIMIT_LOGIN_MAX` | `20` | 每窗口每 IP 的 OIDC 登录端点上限 |
| `AGENTDOCK_TRUST_PROXY` | — | 设为 `1` 时信任 `X-Forwarded-For`（必须置于可信反代之后） |
| `AGENTDOCK_INSTALL_HOME` | 当前用户 home | 服务端「安装到平台主机」时的根目录；容器/沙箱内没有 `~/.dsh` 写权限时改为可写目录（成员本机安装不受影响） |

CLI 登录信息保存在 `~/.agentdock/config.json`（权限 600）。

自动审批策略持久化在 `data/policy.json`（`PUT /api/v1/policy` 或 `agentdock policy set` 写入，重启后仍生效）；**策略按租户隔离**：文件结构为 `{ "tenants": { "<租户>": { autoApprove, quota } } }`，未配置的租户回落到 `default` 租户策略；`GET/PUT /api/v1/policy` 读写当前令牌所属租户的策略（兼容旧的单策略文件，加载时自动归入 `default`）。每个版本的 SBOM 随发布写盘到 `data/packages/<kind>/<name>/<version>/sbom.json`。

## 多样化导入格式

除了 AgentDock 自己的 JSON bundle，导入入口（Web「导入能力包 / 导入文件夹」、`agentdock publish <文件>`、`POST /api/v1/import`）还接受市场上常见的分发格式：

| 格式 | 说明 | 类型/名称来源 |
|---|---|---|
| 目录 | 直接发布一个本地目录（传统方式） | 根目录 `SKILL.md` / `agent.md` / `plugin.json` |
| JSON bundle | `{kind,name,version,files:[…]}` | JSON 自带字段 |
| 文件夹上传 | Web 选择整个文件夹（`webkitdirectory`），浏览器打包成 `{files:[…]}`；单次建议 ≤100MB | 同上，服务端自动识别；`.DS_Store`、`.git/`、`node_modules/`、`__MACOSX/` 等自动忽略；多套一层目录自动剥离；选中多个包时批量导入；文件夹里直接放多个 `.zip`/`.tar.gz` 会逐个解压导入（仅一层） |
| `.zip` | Agent Skills 市场、GitHub「Download ZIP」等常见打包 | 自动剥离 GitHub 的单层根目录；识别根目录清单 |
| `.tar.gz` / `.tgz` / `.tar` | npm/脚本发布物常用格式 | 同上 |
| 单文件 `.md` | Agent Skills / Claude Code agent 的裸文件 | frontmatter 有 `tools`/`model` 判定为 agent，否则 skill |
| 单文件 `plugin.json` | 只有清单的 plugin | manifest 字段 |
| GitHub 仓库 | Web「从远端仓库导入」或 CLI `sync import github` | 仓库内目录内容 |
| MCP registry | CLI `sync import mcp <name>` | registry 的 server 元数据 |

```bash
# 生成演示用的归档与单文件（zip / tar.gz / md）
node scripts/make-example-archives.mjs

agentdock publish examples/bundles/skill-code-reviewer.zip
agentdock publish examples/bundles/plugin-ops-kit.tar.gz --version 0.1.1
agentdock publish examples/bundles/agent-code-reviewer.md --dry-run
```

安全与限制：单个包（含折叠上传）总量上限 **100MB**、单文件 50MB、最多 2000 个条目；原始上传请求上限 150MB（为 base64 JSON 留出膨胀空间）。归档解压全程检查压缩比防 zip bomb；隐藏目录（`.git`/`.github`/`__MACOSX` 等）、`node_modules`、`..` 与绝对路径一律丢弃；gz 解压使用 `maxOutputLength` 限流。解析失败返回 422，其余校验/扫描/审核流程与普通发布完全一致。原始文件不落盘，只在内存中转换为 bundle 后走统一 pipeline。

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

## 外部 registry 同步（GitHub / MCP registry）

导入语义是 **pull → 统一流水线 → 待审核**：外部内容不会被直接信任，而是先经过本地 normalize → 结构校验 → 安全扫描，再作为 `pending` 版本进入审核队列。审核通过后与本地发布的能力包完全同权（平台签名、透明日志、安装、导出均可用）。

```bash
agentdock sync sources                                    # 查看适配器与配置的 base URL
agentdock sync import github acme/skills --path skills/review --dry-run
agentdock sync import github acme/skills --path skills/review   # → 待审核
agentdock sync import mcp weather                          # MCP server → plugin 包
agentdock review approve skill/review@0.1.0
agentdock sync export --out marketplace.json               # 中立市场目录
```

转换规则：

- **GitHub**：读取仓库中指定目录（或单文件）的内容，目录相对路径即包内路径；隐藏文件、`node_modules`/`dist` 等目录会被跳过。根目录含 `SKILL.md` / `agent.md` / `plugin.json` 分别识别为三种 kind；名称/版本/描述优先取 frontmatter 或 `plugin.json`。
- **MCP registry**：server 的 `remotes[].url` 与 `packages[].identifier` 转换为 `plugin.json` 的 `mcp[]` 声明（`url` / `command`），原始 server 元数据保留为 `registry-source.json` 供追溯。
- **skills.sh**：技能本体就是标准 `SKILL.md`，可直接用 GitHub 导入其对应仓库目录；平台不伪造非公开 API。

安全边界（避免把服务变成 SSRF 跳板）：外部 base URL 只能来自服务端环境变量 `AGENTDOCK_GITHUB_API` / `AGENTDOCK_MCP_REGISTRY`，请求体只接受 `repo` / `path` / `ref` / `name` 等标识符，不接受任意 URL；远端仓库导入仍保持保守上限（单次 200 文件、单文件 512KB、总量 2MB；本地/文件夹导入则为 100MB 总量），网络请求 15s 超时；导入需要 publisher 权限，并写审计 `sync.import`。

导出格式（`GET /api/v1/registry/export`）是中立目录 `agentdock-marketplace@1`：每个已发布能力包的最新版本包含 `bundleUrl`、`contentHash`、平台签名与发布者签名摘要，`digest` 为整体哈希；其他 harness 可按需映射到自己的 marketplace 清单。

## SBOM 与自动审批策略

### SBOM（软件物料清单）

每次发布都会生成 `agentdock-sbom@1`，随版本落盘（`sbom.json`）并对外可查：

- `subject`：kind / name / version / contentHash
- `files[]`：路径、字节数、sha256
- `components[]`：能力包声明的外部依赖——`tool`（agent/skill 的工具）、`mcp-server`（plugin/agent 声明的 MCP server，含 command/url）、`skill`（引用的技能）
- `summary`：文件数/总体积/组件计数
- `digest`：对上述规范内容做 sha256（可复现，不含生成时间）

```bash
agentdock sbom skill/code-reviewer@0.1.0
curl http://127.0.0.1:7788/api/v1/packages/skill/code-reviewer/versions/0.1.0/sbom
```

SBOM 记录的是**声明**（能力包声称依赖什么），不等同于对依赖真实性的验证；它用于审核、归档和供应链比对。

### 按策略自动审批

默认关闭。开启后，满足全部条件的版本在发布时直接上架（仍会写平台签名、透明日志与审计），其余进入人工审核队列。

```json
{
  "autoApprove": {
    "enabled": true,
    "kinds": ["skill"],
    "trustedPublishers": ["ci-bot"],
    "requirePublisherSignature": true,
    "maxMedium": 0,
    "maxFiles": 100,
    "maxTotalBytes": 2097152
  }
}
```

```bash
agentdock policy set --file policy.json   # admin
agentdock policy show                     # reviewer
```

也可以在 Web 端操作：admin 登录后顶部「策略」标签页提供表单化编辑（启用开关、类型多选、受信发布者列表、是否要求发布者签名、中危阈值、文件数/体积上限），保存即调用 `PUT /api/v1/policy`，重启后从 `data/policy.json` 恢复；reviewer 可在 CLI 用 `policy show` 查看（Web 页仅 admin 可进）。

**租户级策略与配额**：SSO/多租户模式下，每个租户可各自启用自动审批与设置配额，互不影响（`GET/PUT /api/v1/policy` 以令牌的 `tenant` 为作用域）。配额字段位于策略的 `quota` 对象：

| 字段 | 默认 | 说明 |
|---|---|---|
| `quota.maxPackages` | `0` | 该租户允许的能力包数量，`0` 不限制 |
| `quota.maxVersionsPerPackage` | `0` | 单个包允许的版本数上限，`0` 不限制 |
| `quota.maxStorageBytes` | `0` | 该租户所有版本的总字节数上限，`0` 不限制 |

超过配额时发布返回 `422`，错误 `details.quota` 标明命中的配额项（`maxPackages` / `maxVersionsPerPackage` / `maxStorageBytes`）。

规则：`kinds` 白名单、`trustedPublishers` 白名单（空数组表示不限制发布者）、`requirePublisherSignature`、高危必须为 0、中危不超过 `maxMedium`、文件数/总体积上限、扫描未命中阻断阈值、且已生成 SBOM。未通过自动审批的版本会记录 `review.auto_skipped` 审计事件（含失败规则）；自动通过的版本记录 `review.auto_approve`，透明日志事件带 `review.auto: true`。

## SQLite 存储后端（可选）

默认元数据存 `data/db.json`（单文件，零依赖）。规模上来后可切到内置 `node:sqlite`：

```bash
AGENTDOCK_STORE=sqlite npm start
# 或 docker： -e AGENTDOCK_STORE=sqlite
```

- 使用 Node 24+ 内置 `node:sqlite`（仍标记 experimental，启动会打印一条 ExperimentalWarning），Docker 镜像已是 node:24-alpine；Node 20/22 上不可用。
- 关系表 `packages` / `versions` 存可查询的键（kind/name/version/status）与完整版本 JSON payload；包内容仍落盘在 `data/packages/...`，与 JSON 后端一致。
- 开启 WAL、按包/按版本增量写（不再每次重写整个索引）。
- **列表/搜索/统计下推到 SQL**：市场列表的 kind/status/关键词过滤与统计计数走 `queryPackages` / `queryStats`，不再遍历全量 JSON；版本排序仍用 JS 比较 semver（避免字符串排序把 `0.10.0` 排到 `0.9.0` 前）。
- 首次以 sqlite 启动时，如果存在旧的 `db.json` 且 sqlite 为空，会自动迁移（记录 `meta.migrated_from=db.json`，原文件保留，可回退）。
- 备份：`data/` 目录（含 `agentdock.sqlite` 及其 `-wal`/`-shm`）整体备份；SQLite 模式下建议停服或用 `sqlite3 .backup`。
- 测试：`npm run test:sqlite`、`npm run smoke:sqlite`（CI 在 Node 24 矩阵上执行）。

## SSO 登录与多租户

AgentDock 支持用外部 OIDC（Keycloak / Okta / Entra ID / Auth0 / Google 等）登录 Web 控制台，并按租户隔离能力包。

**启用方式**：配置 `AGENTDOCK_OIDC_ISSUER` 与 `AGENTDOCK_OIDC_CLIENT_ID` 后重启，桌面端右上角出现「SSO 登录」按钮；登录成功后写入 `agentdock_session`（HttpOnly、SameSite=Lax、HMAC 签名，8 小时有效）。

**流程**：OIDC Authorization Code + PKCE（零依赖实现，不做本地 JWT 验签，身份以 userinfo 端点为准）→ 用 `sub/email/name` 自动建号或复用已有账号 → 角色取 `role` claim；缺失时按 `groups` × `AGENTDOCK_OIDC_GROUP_ROLES` 映射（多组命中取最高权限），再缺省为 `viewer` → 租户取 `tenant` claim（缺省 `default`）。SSO 用户每次登录都会按 IdP 声明同步角色与租户（IdP 是权威来源；管理员应通过 IdP 组调整权限）。

**组映射示例**（Keycloak/Entra 组名任意）：
```bash
AGENTDOCK_OIDC_GROUP_ROLES="agents-admins=admin,agents-reviewers=reviewer,agents-publishers=publisher"
```

**MFA**：AgentDock 不自建第二因素，而是要求 IdP 完成 MFA 并在 userinfo 的 `amr` 中回传（如 `["pwd","totp"]`）。设置 `AGENTDOCK_OIDC_MFA_REQUIRED=1` 后，未声明多因素的登录会被拒绝（`403 OIDC_MFA_REQUIRED`）；同时建议在 IdP 侧强制 MFA 策略。

**多租户语义**（版本 `tenant` 字段在发布时从令牌继承）：

- 市场列表、统计、详情、审核队列、diff、SBOM、透明证明查询都按请求身份所属租户过滤；跨租户一律 404。
- 同一租户内名称唯一；**不同租户可用同名包**（`kind/name` 共享，靠 `tenant` 列区分；JSON 后端存 `packages.<kind>/<name>.tenant`）。
- 令牌/用户带 `tenant` 字段（`POST /api/v1/admin/tokens` 可指定）；审计与透明日志是全局视图（每条记录含操作者，后续可再按租户分区）。
- 未启用 SSO 时行为不变：单租户 `default`，原有 Bearer 令牌继续可用。

已知边界：OIDC discovery 与 token 交换要求 IdP 通过 HTTPS 可达；本服务自身不做 TLS，公网部署请用反向代理终结 TLS（见「部署」）。会话 Cookie 为 HMAC 签名，但携带用户级 `sessionEpoch` 与全局 `globalEpoch`：禁用用户会立即失效其会话、`revoke-sessions` 可踢单个用户、`revoke-all` 可强制全员重新登录（8h 过期是兜底，不是唯一手段）。

## 备份与恢复

`data/` 是唯一需要备份的目录（元数据库、包文件、用户/令牌、签名私钥、审计与透明日志、策略）。CLI 提供带校验和的零依赖归档：

```bash
# 备份（建议先停服；SQLite 运行中可能处于 WAL 未 checkpoint 状态）
agentdock backup                          # 输出 ./agentdock-backup-<时间>.agentdock-backup.json.gz
agentdock backup --data /srv/agentdock/data --out /backups/daily.json.gz
agentdock backup --no-bootstrap           # 不包含初始化令牌明文文件

# 恢复（必须停服；目标目录非空需 --force）
agentdock restore /backups/daily.json.gz --data /srv/agentdock/data --dry-run
agentdock restore /backups/daily.json.gz --data /srv/agentdock/data --force
```

归档格式：`gzip(JSON)`，`schema=agentdock-backup@1`，每个文件记录相对路径、字节数、sha256 与 base64 内容；恢复时逐文件校验路径安全（拒绝 `..`/绝对路径）与内容哈希，任何一项不符立即中止。签名私钥 `signing-key.json` 也在归档内，请把备份文件当作机密保管（写出权限 600）。

## 部署（Docker / CI）

### Docker

```bash
docker build -t agentdock:0.1.0 .
docker run -d --name agentdock -p 7788:7788 -v agentdock-data:/data agentdock:0.1.0
docker exec agentdock cat /data/BOOTSTRAP-TOKENS.txt   # 首次启动生成的 admin/reviewer/publisher 令牌
```

或直接 `docker compose up -d --build`（见 `docker-compose.yml`）。镜像要点：

- `node:24-alpine` + `tini`，以非 root 用户 `node` 运行；
- 数据全部落在 `/data`（声明为 VOLUME），内置 `AGENTDOCK_HOST=0.0.0.0`、`AGENTDOCK_DATA=/data`；
- 自带 `HEALTHCHECK`，命中 `/api/v1/health`；
- 运行时镜像只含 `src/ web/ cli/ server.mjs package.json`，不含 tests/scripts/examples/docs。

生产注意：默认没有 TLS 与 SSO，请放在反向代理（HTTPS + 认证）之后，并限制 `/api/v1/admin/*` 入口；`/data` 需持久化并备份（`db.json`、`packages/`、`audit.log`、`users.json`）。

### 生产部署：Caddy 自动 HTTPS（`docker-compose.prod.yml`）

仓库自带一套生产部署示例：Caddy 容器负责自动申请/续期证书与终止 TLS，AgentDock 只监听容器内部网络的 `7788`，宿主机不暴露该端口。

```bash
cp deploy/.env.example .env          # 填 AGENTDOCK_DOMAIN（已解析到本机的域名）与 ACME_EMAIL
docker compose -f docker-compose.prod.yml up -d --build
docker exec agentdock cat /data/BOOTSTRAP-TOKENS.txt
# 浏览器访问 https://<AGENTDOCK_DOMAIN>
```

要点：

- **网络边界**：只发布 `80/443`（HTTP 用于 ACME 校验并跳转 HTTPS）；`7788` 不对宿主暴露，避免绕过 TLS。
- **代理信任**：容器内设置 `AGENTDOCK_TRUST_PROXY=1`，限流与审计才能取到真实来源 IP（`X-Forwarded-For`）；只应在可信反代之后开启。
- **对外地址**：`AGENTDOCK_PUBLIC_URL=https://${AGENTDOCK_DOMAIN}` 用于 OIDC 回调地址、市场目录导出等；启用 SSO 时 IdP 侧回调填 `https://<域名>/auth/oidc/callback`。
- **安全头**：Caddy 层统一加 HSTS / `X-Content-Type-Options` / `X-Frame-Options` / Referrer-Policy，应用自身也会下发。
- **证书状态**：`docker compose -f docker-compose.prod.yml logs caddy` 查看 ACME 过程；证书存于 `caddy-data` 卷，请与 `agentdock-data` 一起备份。
- 没有公网域名时可用 Cloudflare Tunnel / Tailscale / frp 暴露本地服务（TLS 由隧道提供），此时把 `AGENTDOCK_PUBLIC_URL` 设为隧道地址即可。
- 本机 Docker daemon 未启动时无法验证镜像构建；`docker compose -f docker-compose.prod.yml config` 可离线校验配置，镜像构建由 CI 的 docker job 验证。

### GitHub Actions CI

`.github/workflows/ci.yml` 在 push / pull request 时跑两个 job：

1. **test**：Node 20 / 22 / 24 矩阵，依次执行 `npm test`、`npm run smoke`、逐个校验 `examples/*`、对所有 `.mjs` 做 `node --check`；
2. **docker**：`docker build` 后启动容器并轮询 `/api/v1/health`，失败时打印容器日志。

项目零第三方依赖，因此 CI 不需要 `npm install`，也没有 lockfile 需要维护。

## 事件通知（Webhook / IM）

发布、审核结果可推送到 Slack / Discord / 飞书 / 钉钉 / 企业微信，或任意自定义 JSON webhook。配置由 admin 写入 `data/notify.json`（也可用 `notify set`）：

```json
{
  "schema": "agentdock-notify@1",
  "enabled": true,
  "webhooks": [
    { "name": "team-feishu", "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx", "format": "feishu" },
    { "name": "review-bot", "url": "https://example.com/hook", "format": "json", "events": ["review.approved", "review.rejected"], "secret": "hmac-secret" }
  ]
}
```

- 事件：`package.published`、`review.approved`、`review.rejected`、`review.auto_approved`；`events` 为空表示全部订阅。
- 格式：`json`（`{event,text,data,at}`，适合自建机器人）、`slack`/`discord`（`{text}`）、`feishu`、`dingtalk`、`wecom`（平台文本消息结构）。
- 安全：webhook URL 只能由 admin 通过 API/CLI/配置文件设置（不接受请求体里的任意 URL），出站请求固定 5 秒超时，失败只写审计（`notify.failed`）不影响发布/审核。
- 签名：配置 `secret` 时，请求头带 `x-agentdock-signature: sha256=<hex>`（HMAC-SHA256 请求体），接收方应校验。

```bash
agentdock notify show
agentdock notify set deploy/notify.json   # 用自己的 JSON 覆盖
agentdock notify test                     # 发一条测试消息
```

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
│   ├── diff.mjs             # 行级/文件级 diff（LCS + 规模上限降级）
│   ├── dsh-preset.mjs       # agent 包 → DSH agent-preset 片段（tools 映射、profile 合并）
│   ├── signing.mjs          # ed25519 内容签名/验签（审核通过即签名，公钥公开）+ 发布者签名
│   ├── transparency.mjs     # 可验证透明日志（哈希链 + Merkle 树 + 包含证明）
│   ├── archive.mjs          # 零依赖 ZIP / TAR(.gz) 读取与安全限制
│   ├── import.mjs           # 多样化导入：格式识别 → 文件清单/元数据推断 → bundle payload
│   ├── registry.mjs         # 外部 registry 互操作（GitHub / MCP registry 导入 + 市场目录导出）
│   ├── sbom.mjs             # SBOM 生成（文件哈希 + 工具/MCP/技能组件 + digest）
│   ├── policy.mjs           # 多租户策略容器 + 配额（归一化/校验/规则求值）
│   ├── backend.mjs          # 元数据后端选择（json / sqlite 统一接口）
│   ├── sqlite.mjs           # node:sqlite 后端（关系表 + WAL + db.json 自动迁移）
│   ├── auth.mjs             # 令牌/角色/发布者密钥/OIDC 账号
│   ├── session.mjs          # 会话 Cookie（HMAC 签名 + 用户/全局世代吊销，8h）
│   ├── notify.mjs           # 事件通知（webhook / Slack / 飞书 / 钉钉 / 企微，HMAC 签名）
│   ├── oidc.mjs             # OIDC discovery + PKCE 授权码流程
│   ├── security.mjs         # CSRF 双提交校验（Cookie 会话）
│   ├── ratelimit.mjs        # 内存滑动窗口限流 / 来源 IP 解析
│   ├── backup.mjs           # 备份归档（gzip + sha256）与恢复校验
│   ├── audit.mjs            # JSONL 审计（哈希链 + 多维过滤 + 校验 + 导出 + 轮转）
│   ├── config.mjs           # 配置与数据目录
│   ├── errors.mjs / util.mjs / yaml.mjs
├── web/                     # 零依赖市场 UI（原生 JS）
├── Dockerfile               # 生产镜像（node:24-alpine + tini，非 root）
├── docker-compose.yml       # 单机部署（端口 7788 + /data 卷）
├── .github/workflows/ci.yml # CI：Node 20/22/24 测试矩阵 + Docker 健康检查
├── examples/                # 三类示例能力包 + examples/bundles（zip/tar.gz/md 导入示例）
├── scripts/                 # smoke + 批量发布示例 + 生成导入示例归档
├── tests/                   # node:test 测试（177 个用例）
└── data/                    # 运行时数据（git 忽略）
```

## 开发与测试

```bash
npm test                  # 单元 + HTTP 接口测试（node --test）
npm run smoke             # 端到端：真实启动服务 + CLI + 落盘安装
npm run examples:publish  # 把示例发布到已运行的服务（可加 -- --approve）
```

`npm run smoke` 会在临时目录启动一个隔离实例，覆盖完整闭环，最后输出 `SMOKE OK` 与统计信息，不污染本地 `data/`。CI 配置见 `.github/workflows/ci.yml`，本地等价命令即上面三条。

## 设计取舍

- **零依赖**：只用 Node 标准库（`node:http`、`node:test`、`fetch`），离线环境可直接跑；代价是 YAML 解析器、路由等需要自己维护子集实现。
- **JSON bundle 而非 multipart/tar/zip**：上传/下载都是普通 JSON，方便 CLI、CI、脚本复用；代价是大包体积略增。
- **文件系统为主 + 可选 SQLite 元数据后端**：内容始终按版本落盘（便于备份/审查/手工检查），元数据默认 `db.json` 单文件、可切 `node:sqlite` 关系表（WAL、增量写、自动迁移）；两种后端都保留内存索引，代价是启动时全量加载元数据。
- **外部同步只做拉取 + 中立导出**：不对第三方 registry 做写操作（避免各平台 API/鉴权差异与误写风险），导入内容一律走同一条校验/扫描/审核流水线；导出采用 `agentdock-marketplace@1` 中立格式，由其他 harness 映射。
- **静态市场前端**：原生 JS，无构建步骤；markdown 渲染与 diff 视图都是轻量子集实现（渲染只创建文本节点防 XSS，diff 用 LCS 并对超大输入降级），代价是语法支持有限（不支持表格/脚注等扩展）。

## 安全模型与已知限制

- 令牌只存 `sha256` 哈希；初始明文令牌仅出现在 `data/BOOTSTRAP-TOKENS.txt`（600 权限），建议首次登录后轮换并删除该文件。
- 审计日志 append-only JSONL，记录 actor/role/action/target/meta/ip；发布/审核/安装/令牌等条目在 `meta.tenant` 写入租户，`GET /audit?tenant=` 可按租户过滤（admin 可看全部或任意租户，reviewer 强制本租户），导出同样支持。每条记录带 `seq`/`prevHash`/`hash` 哈希链（`hash = sha256([seq, prevHash, ts, actor, role, action, target, meta, ip])`），篡改/删除/插入可被 `agentdock audit verify`（或 `GET /audit/verify`）定位；超过 `AGENTDOCK_AUDIT_MAX_BYTES`（默认 8MB）轮转到 `data/audit/archive/`，保留 `AGENTDOCK_AUDIT_KEEP`（默认 24）份归档，链跨文件连续。
- 服务默认只监听 `127.0.0.1`；面向团队部署时应置于反向代理/TLS 之后，并限制 `/api/v1/admin/*` 入口。
- **限流**：`/api/*` 与 OIDC 登录端点按 IP 滑动窗口限流（默认 300/分钟、登录 20/分钟），超限返回 429 + `Retry-After`；`AGENTDOCK_RATE_LIMIT=0` 可关闭。进程内计数，多实例部署需在网关层再做全局限流。
- **CSRF**：SSO Cookie 会话的写操作（POST/PUT/PATCH/DELETE）必须携带双提交令牌 `x-agentdock-csrf`（值等于非 HttpOnly 的 `agentdock_csrf` Cookie），并校验 `Origin` 与 `Host` 一致；Bearer 令牌客户端不受影响。
- 扫描是**启发式规则 + 结构检查 + 供应链比对**（规则组见「审核与安全扫描」），不是沙箱：静态规则抓不住语义级/条件触发注入的全部变体，审核环节不可省。
- **内容签名**：版本审核通过时，平台用 ed25519 私钥对规范化载荷 `agentdock-v1\n<kind>\n<name>\n<version>\n<contentHash>` 签名；私钥存于 `data/signing-key.json`（600 权限，务必备份），公钥通过 `GET /api/v1/keys` 公开，任何人可离线验签。`verify-signature` / `?verify=1` 会同时重算磁盘内容哈希，能发现发布后对存储内容的替换或篡改。
- 平台签名证明「内容经本平台审核且未被替换」，**不**等价于发布者身份或供应链来源。
- **发布者签名（可选）**：`publish --key` 用发布者自己持有的 ed25519 私钥对载荷 `agentdock-publisher-v1\n<kind>\n<name>\n<version>\n<contentHash>` 签名，服务端校验后写入 `version.publisherSignature`；首次携带公钥发布时自动 TOFU 注册（等价于 `POST /api/v1/me/keys`）。签名覆盖内容哈希，因此可证明「该版本由持有对应私钥的人提交」。
- **可验证透明日志**：每个版本审核通过时向 `data/transparency.log` 追加一条哈希链事件（contentHash、发布者、平台 keyId、发布者 keyId、审核人），事件哈希按 RFC 6962 风格构造 Merkle 树；任何人可通过 `GET /api/v1/transparency/verify` 校验整条链、通过 `GET .../proof` 获取某个版本的包含证明，并用 CLI `transparency verify|proof` 本地校验。日志 append-only，与平台签名交叉印证上架历史。
- **SBOM 与自动审批**：每个版本生成 `agentdock-sbom@1` 清单，记录文件哈希与声明的工具/MCP/技能组件；自动审批默认关闭，开启后只对策略白名单内、无高危、体积达标的版本生效，自动通过的版本同样有平台签名、透明日志与审计，可事后完整追溯。
- 外部 registry 导入受服务端出口白名单限制（见上节），导入内容一律走同一校验/扫描流程，只有命中自动审批策略时才会跳过人工审核；审计与透明日志为全局视图（不按租户分区），当前无租户级策略与配额。
- diff 视图只做行级对比：二进制文件仅标记变化，超大文件（>512KB 或 >2000 行）退化为整文件标记。

## Roadmap

- [x] 市场分页、服务端搜索与类型筛选
- [x] markdown 安全渲染与审核 diff 视图
- [x] 内容签名（ed25519）与 `verify-signature` 验签接口
- [x] 发布者密钥签名 / 可验证透明日志（透明日志记录所有上架事件）
- [x] DSH agent preset 安装目标（`dsh-agent`，生成 preset 片段并可按 profile 合并）
- [x] 外部 registry 互操作：GitHub / MCP registry 导入 + 中立市场目录导出（skills.sh 的 `SKILL.md` 可经 GitHub 导入）
- [x] 依赖清单与 SBOM、按策略自动审批（`data/policy.json` + `review.auto_approve`）
- [x] SQLite 存储后端（`AGENTDOCK_STORE=sqlite`，node:sqlite + WAL + db.json 自动迁移）
- [x] 自动审批策略 Web 编辑页（admin 表单化编辑，CLI 等价保留）
- [x] 审计日志哈希链（`audit verify` 校验断链、轮转归档、CSV/JSONL 导出）
- [x] 版本检查与升级（`outdated` / `upgrade`，基于安装清单对比服务端最新版本）
- [x] SSO 登录（OIDC + PKCE）与多租户隔离（市场/详情/审核/统计按 `tenant` 过滤）

## License

MIT
