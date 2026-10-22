# AgentDock 全景流程图

> 产品现状 · 架构 · 你要走的流程 · 后续对用户可用的功能
> 配套一页图：[flow-overview.png](flow-overview.png)（1800×1320）

![AgentDock 全景图](flow-overview.png)

- 定位：跨 harness 的 AI 能力（skill / agent / plugin）注册与治理平台
- 现状：v0.1.0，Roadmap ①–④ 全部完成（发布者签名、透明日志、外部同步、SBOM + 自动审批、SQLite 后端），87 个测试通过，JSON / SQLite 两种后端 smoke 均 OK
- 仓库：`agentdock/`（零第三方依赖，Node ≥ 20.11；`node:sqlite` 后端需 Node 24+）

---

## 1. 你要走的整个流程

从「代码交付」到「团队可用」再到「规模化运营」的执行路线。

```mermaid
flowchart TD
    A["验收并发改动<br/>审计哈希链 / 全量测试 / commit"] --> B["内网部署<br/>docker compose + TLS + 备份"]
    B --> C["种子内容<br/>import-claude 7 角色 + 团队高频 skill"]
    C --> D["两周试点<br/>1 团队 × 5 人 × DSH/Claude/Codex"]
    D --> E{"试点 KPI 达标？<br/>分享时效 / 复用率 / 审核 SLA"}
    E -- 否 --> F["收窄范围 / 补内容 / 调策略"]
    F --> D
    E -- 是 --> G["度量与纪律<br/>周报看板 / 审核轮值 / 自动审批分流"]
    G --> H["规模化<br/>质量分级 / 兼容矩阵 / 更新与回滚"]
    H --> I["对外（可选）<br/>公开目录 / push 同步 / SSO / 企业版"]
```

| 步骤 | 关键动作 | 产出 / 验收 | 用到的能力 |
|---|---|---|---|
| 0 收尾 | 验收并发审计改动、跑测试、补文档、commit | git 干净、`node --test` 全绿 | `/audit`、审计导出 |
| 1 部署 | `docker compose up -d`、反向代理 + TLS、备份 `data/` | 内网地址可访问、令牌交接 | Docker、`/api/v1/health` |
| 2 种子内容 | `import-claude` 导入 7 个角色、发布团队高频 skill | 首批 official 包 ≥ 10 个 | `import-claude`、`publish` |
| 3 试点 | 1 个团队、2 周、三种 harness 全量安装 | KPI 报告 + 5 个可演示故事 | install targets、scan、verify |
| 4 度量与纪律 | 周报、审核轮值、自动审批分流 | 审核 SLA < 4h、签名覆盖率 100% | `/stats`、`/audit`、policy |
| 5 规模化 | 质量分级、兼容矩阵、更新通知/回滚 | 月活发布者/安装者增长 | 版本不可变、透明日志 |
| 6 对外 | 只读目录导出、push 发布、SSO | 对外目录/企业版试点 | `/registry/export` |

---

## 2. 现在做的产品（端到端能力）

```mermaid
flowchart LR
    subgraph 发布
        P1["skill：SKILL.md"] --> P4["pipeline<br/>normalize → validate → scan"]
        P2["agent：agent.md<br/>工具 + 系统提示"] --> P4
        P3["plugin：plugin.json<br/>一包多能力"] --> P4
        P5["外部导入<br/>GitHub / MCP registry"] --> P4
    end
    P4 --> S1["版本 pending<br/>meta.json + files/ 落盘"]
    S1 --> R{"审核"}
    R -- "人工 approve" --> PUB["published<br/>平台签名 + 透明日志"]
    R -- "策略自动审批" --> PUB
    R -- "reject" --> REJ["rejected<br/>可覆盖重提"]
    PUB --> M["市场 / CLI / HTTP API<br/>搜索 / 分页 / preview / diff"]
    M --> T["5 个安装目标<br/>dsh / dsh-agent / claude / codex / shared / dir"]
    T --> U["DSH · Claude Code · Codex<br/>~/.agents 共享"]
    PUB --> E["导出中立目录<br/>agentdock-marketplace@1"]
    PUB --> V["verify-signature<br/>SBOM / 透明证明"]
```

| 层 | 已实现能力 |
|---|---|
| 能力格式 | `skill`（SKILL.md）、`agent`（agent.md：tools/model/skills/mcp + 系统提示）、`plugin`（plugin.json 一包多能力） |
| 治理 | 结构校验、路径消毒、体积限制、安全扫描（注入/外泄/密钥/危险命令/隐藏指令）、高危阻断、人工审核、策略自动审批、版本不可变 |
| 信任 | 平台 ed25519 签名、发布者 ed25519 签名（TOFU 公钥注册）、内容哈希重算防篡改、透明日志哈希链 + Merkle 包含证明、SBOM（`agentdock-sbom@1`） |
| 分发 | Web 市场（登录/搜索/分页/文件预览/diff 视图/安装）、CLI 15+ 命令、HTTP API 30+ 路由、5 个安装目标、Claude agent 单文件还原 |
| 同步 | GitHub / MCP registry pull 导入（dry-run + 统一安检）、中立市场目录导出、外部 base URL 服务端白名单防 SSRF |
| 存储 | 零依赖：内容按版本落盘、元数据 `db.json` 或 `node:sqlite`（WAL、增量写、自动迁移）、审计 JSONL、透明日志 append-only |

---

## 3. 架构

```mermaid
flowchart TB
    subgraph 接入层
        W["Web 市场<br/>原生 JS + CSP"]; C["CLI<br/>agentdock"]; H["HTTP API<br/>/api/v1"]
    end
    subgraph 应用层
        PL["pipeline<br/>校验 + 扫描"]; ST["store<br/>版本状态机"]; RV["review<br/>人工/自动"]
        SG["signing<br/>平台/发布者签名"]; TR["transparency<br/>哈希链 + Merkle"]; SB["sbom"]
        PO["policy<br/>自动审批规则"]; DF["diff"]; RG["registry<br/>外部同步"]; TG["targets<br/>安装目标"]
    end
    subgraph 存储层
        DB["db.json / agentdock.sqlite"]; FS["data/packages 文件"]
        US["users.json + signing-key.json"]; LG["audit.log / transparency.log / policy.json"]
    end
    subgraph 集成层
        D1["DSH ~/.dsh"]; D2["Claude Code ~/.claude"]; D3["Codex ~/.codex"]
        D4["shared ~/.agents"]; D5["GitHub API"]; D6["MCP Registry"]
    end
    W --> PL; C --> PL; H --> PL
    PL --> ST; ST --> RV; RV --> SG; SG --> TR; ST --> SB; RV --> PO; ST --> DF; ST --> RG; ST --> TG
    ST --> DB; ST --> FS; SG --> US; TR --> LG; PO --> LG
    TG --> D1; TG --> D2; TG --> D3; TG --> D4; RG --> D5; RG --> D6
```

模块职责见 [ARCHITECTURE.md](ARCHITECTURE.md)。数据目录：

```
data/
├── db.json | agentdock.sqlite   # 元数据（二选一，AGENTDOCK_STORE）
├── users.json                   # 用户 / 令牌哈希 / 发布者公钥
├── signing-key.json             # 平台签名私钥（600，务必备份）
├── policy.json                  # 自动审批策略（缺省=关闭）
├── audit.log                    # 运维审计（JSONL）
├── transparency.log             # 发布透明日志（哈希链）
└── packages/<kind>/<name>/<version>/
    ├── meta.json / sbom.json
    └── files/                   # 能力包原始内容
```

---

## 4. 一个版本从发布到安装（时序）

```mermaid
sequenceDiagram
    autonumber
    participant U as 发布者
    participant CLI as CLI
    participant API as HTTP API
    participant S as store
    participant SC as scan / validate
    participant R as 审核者或 policy
    participant T as transparency
    participant M as 市场使用者

    U->>CLI: agentdock publish ./pkg --key
    CLI->>SC: 本地预检（normalize/validate/scan）
    CLI->>API: POST /packages（含发布者签名）
    API->>S: publish()
    S->>SC: 服务端复检
    S->>S: 生成 SBOM + 写 pending
    alt 策略自动审批规则全部通过
        S->>S: 平台签名 + published
        S->>T: append(auto=true)
    else 需要人工
        R->>API: POST /review {approve/reject}
        API->>S: review()
        S->>S: 平台签名 + published
        S->>T: append(auto=false)
    end
    M->>API: GET /packages（搜索/分页）
    M->>CLI: agentdock install skill/x --target dsh
    CLI->>API: 下载 bundle + 记录 install
    CLI->>CLI: 校验 contentHash / 写入目标目录
```

---

## 5. 四类用户旅程

```mermaid
flowchart LR
    subgraph 发布者
        A1["准备能力包目录"] --> A2["agentdock verify<br/>本地预检"] --> A3["publish<br/>（可选 --key 签名）"] --> A4["等待审核 / 自动上架"]
    end
    subgraph 审核者
        B1["待审核队列"] --> B2["查看 diff / 扫描 / 发布者签名"] --> B3["approve 或 reject<br/>（写审计 / 透明日志）"]
    end
    subgraph 使用者
        C1["市场搜索 / CLI list"] --> C2["查看版本 / 扫描结果 / SBOM"] --> C3["install 到目标 harness"] --> C4["verify-signature 验签"]
    end
    subgraph 管理员
        D1["令牌 / 角色"] --> D2["policy 自动审批"] --> D3["/audit 审计 + 导出"] --> D4["备份 / 升级 / 同步"]
    end
```

---

## 6. 版本状态机

```mermaid
stateDiagram-v2
    [*] --> pending: publish（校验 + 扫描 + SBOM）
    pending --> published: 人工 approve / 策略自动审批
    pending --> rejected: reject
    rejected --> pending: 修复后覆盖重提
    published --> published: 不可覆盖（新版本另发）
    note right of published
        平台签名 + 透明日志 + SBOM
        可安装 / 可导出 / 可验签
    end note
```

---

## 7. 后续对用户可用的功能（路线图）

```mermaid
flowchart LR
    P0["阶段 0 · 收尾（本周）<br/>审计哈希链验收<br/>CI 跑绿（Node 20/22/24 + Docker）<br/>内网 Docker 部署"] -->
    P1["阶段 1 · 冷启动（1 个月）<br/>自动审批策略 Web 编辑页<br/>周报看板<br/>import-claude 一键导入<br/>官方模板包"] -->
    P2["阶段 2 · 规模化（1–3 月）<br/>质量分级 official/verified<br/>兼容矩阵<br/>更新通知 + 一键回滚<br/>信任分级自动审批"] -->
    P3["阶段 3 · 对外（3 月+）<br/>公开只读市场<br/>push 发布 GitHub/skills.sh<br/>SSO / 多租户 / 企业版"]
```

| 阶段 | 对用户的新能力 | 依赖现状 | 验收 |
|---|---|---|---|
| 0 | 审计日志哈希链 + 校验/导出接口、CI/Docker 交付 | 已有审计日志，改动待验收 | 测试全绿、镜像可启动 |
| 1 | 浏览器里编辑自动审批策略、周报看板、一键导入 Claude agents | policy API、`/stats`、`/audit` 已有 | 试点团队零 CLI 操作完成上架/安装 |
| 2 | 质量标签、兼容矩阵、更新通知与回滚、信任分级审批 | 版本不可变、签名、透明日志已有 | 包数量/安装量增长、审核吞吐不下降 |
| 3 | 对外只读目录、反向发布、企业身份集成 | `/registry/export`、签名、policy 已有 | 外部可见的可信包目录 + 企业试点 |

---

## 8. 运营度量（周节奏）

| 指标 | 定义 | 目标（试点期） |
|---|---|---|
| 分享时效 | 从提交到可安装的中位耗时 | < 10 分钟（自动审批）/ < 4 小时（人工） |
| 复用率 | 被 ≥2 人安装的包占比 / Top10 周安装 | 逐月上升 |
| 治理 | 高危拦截数、签名覆盖率、pending 超时数 | 签名 100%，超时 0 |
| 覆盖 | 3 种 harness 安装成功率 | > 99% |
| 活跃 | 周发布者 / 周安装者 | 试点团队全员 |

周节奏：清审核队列 → 看 `/stats` 与 Top 包 → 抽检 1 个包 → 更新推荐位 → 生成周报。
