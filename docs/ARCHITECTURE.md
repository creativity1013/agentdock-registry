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
store.publish()                     归一化后的内容落盘（files/ + meta.json）
  ├ 生成 SBOM（sbom.json + version.sbom，含文件哈希与组件清单）
  ├ 按策略评估（data/policy.json，默认关闭）
  │   ├ 通过 → approveVersion()：平台签名 → status=published
  │   └ 不通过 → status=pending（进入人工审核队列）
  ▼
audit.append('package.publish')
  └ 自动审批另有 review.auto_approve（通过）/ review.auto_skipped（含失败规则）
```

`analyzeInput()`（src/pipeline.mjs）把「归一化 → 校验 → 扫描」封装成纯函数：服务端发布、CLI `verify`、CLI 发布前预检、`import-claude` 共享同一套逻辑，保证线上线下判断一致。

### 审核

```
reviewer: POST /api/v1/review {kind,name,version,decision,note}
  ▼ 权限校验（role ≥ reviewer）+ 版本必须处于 pending
store.review()  ── approve → approveVersion()：签名后 status=published（冻结）
                └ reject  → status=rejected（可覆盖重提）
approveVersion() 同时被自动审批复用（reviewer 记为 policy:auto，review.auto=true）
  ▼
audit.append('review.approve' | 'review.auto_approve' | 'review.reject')

审核界面另调 GET /api/v1/packages/:kind/:name/diff?to=<version>
  └ 默认基线为「上一个已发布版本」；pending 版本仅 reviewer/admin 可见；
    返回文件级增删改 + 文本文件逐行 diff（超出规模上限时整文件标记）
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
├── signing-key.json             # 平台 ed25519 签名私钥（600，务必备份）
├── BOOTSTRAP-TOKENS.txt         # 首次启动的明文令牌（600，可删）
├── audit.log                    # append-only JSONL 审计（带哈希链，超限轮转）
├── audit/archive/               # 审计归档 audit-<yyyyMMdd-HHmmss>-<ms>.log（保留 AGENTDOCK_AUDIT_KEEP 份）
├── transparency.log             # 可验证透明日志（哈希链，append-only，审核通过时追加）
├── policy.json                  # 自动审批策略（可缺省；缺省等同关闭）
├── agentdock.sqlite             # 可选 SQLite 元数据后端（AGENTDOCK_STORE=sqlite，含 -wal/-shm）
└── packages/
    └── <kind>/<name>/<version>/
        ├── meta.json            # 版本元数据（状态、扫描、审核、文件清单、哈希、签名、SBOM 摘要）
        ├── sbom.json            # 该版本 SBOM（agentdock-sbom@1，随发布生成）
        └── files/               # 能力包原始内容（按包内相对路径）
            └── SKILL.md
```

### metadata（db.json 或 agentdock.sqlite）

元数据由 `src/backend.mjs` 抽象：默认 `db.json` 单文件；`AGENTDOCK_STORE=sqlite` 时改用内置 `node:sqlite`（关系表 `packages`/`versions`，版本完整 JSON 存 `payload` 列，WAL + 按包/版本增量写，首次启动可从 `db.json` 自动迁移）。下面以 db.json 的逻辑结构说明；SQLite 后端对外暴露同样的内存状态。

### db.json

```jsonc
{
  "schemaVersion": 1,
  "packages": {
    "skill/demo-skill": {
      "kind": "skill",
      "name": "demo-skill",
      "tenant": "default",            // 发布者所属租户；不同租户可同名
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
          "review": { "reviewer": "reviewer", "decision": "approve", "note": "LGTM", "at": "…", "auto": false },
          "sbom": { "schema": "agentdock-sbom@1", "digest": "sha256:…", "fileCount": 1, "componentCount": 0 },
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
    {
      "id": "u_…",
      "name": "admin",
      "role": "admin",
      "tenant": "default",         // 多租户归属（默认 default）
      "tokenHash": "sha256(明文令牌)", // OIDC 账号为 null
      "auth": "token",             // token | oidc
      "email": "…",                // OIDC 账号可选
      "createdAt": "…",
      "keys": []                   // 发布者公钥（TOFU 注册）
    }
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

### audit.log（JSONL，哈希链防篡改）

```jsonc
{"ts":"2026-10-21T10:00:00.000Z","actor":"publisher","role":"publisher","action":"package.publish","target":"skill/demo-skill@0.1.0","meta":{"contentHash":"sha256:…"},"ip":"127.0.0.1","seq":1,"prevHash":"000…000","hash":"a77a…"}
```

动作命名：`package.publish`、`package.install`（meta.target 区分安装目标）、`review.approve`、`review.reject`、`user.create_token`。

每条记录的三个链字段：

- `seq`：全局递增序号（跨轮转连续；升级前的旧格式记录无链字段，跳过校验、只计数）
- `prevHash`：上一条记录的 hash（首条为全零 genesis；轮转后新文件首条接续旧文件链头，链跨文件连续）
- `hash = sha256(JSON.stringify([seq, prevHash, ts, actor, role, action, target, meta, ip]))`（固定字段顺序数组，避免序列化歧义）

校验：`GET /api/v1/audit/verify`（或 CLI `audit verify`）读磁盘重算全链，报告篡改/删除/插入/损坏行的位置（断链返回 409）；`?all=1` 遍历 `data/audit/archive/` 归档并校验文件间衔接，手动删除中间归档会报 gap（删最老归档不可检测——链起点之前没有锚）。轮转由写入侧自动执行：超过 `AGENTDOCK_AUDIT_MAX_BYTES`（默认 8MB，0=关闭）把 `audit.log` 改名归档，保留 `AGENTDOCK_AUDIT_KEEP`（默认 24，0=不限）份；归档文件名含毫秒且进程内保证单调递增，字典序即创建顺序。导出：`GET /audit/export?format=jsonl|csv`（csv 按 RFC 4180 转义，列 `ts,actor,role,action,target,ip,seq,hash,meta`）。

查询：`GET /audit` 支持 `action`/`actor` 精确匹配、`target` 子串（忽略大小写）、`from`/`to` ISO 时间范围，`limit/offset` 分页，最新在前。

### 发布者签名（users.json keys[] + version.publisherSignature）

- `POST /api/v1/me/keys` 或发布时携带 `publisherSignature.publicKey`（TOFU）注册 ed25519 公钥，`users.json` 的用户对象存 `keys: [{keyId, name, algorithm, publicKeyPem, createdAt}]`，`keyId = sha256(publicKeyPem).slice(0, 32)`。
- 发布请求可选附带 `publisherSignature = {signature, publicKey?, keyId?, keyName?}`；服务端定位/注册公钥后，对 `publisherSignaturePayload({kind,name,version,contentHash})` 验签，失败返回 422。
- 审核通过时透明日志记录 `publisherKeyId`，便于公开核对「哪个密钥提交了哪个版本」。

### 平台签名（signing-key.json + version.signature）

- 首次需要签名时自动生成 ed25519 密钥对：私钥只落盘 `data/signing-key.json`（600），公钥由 `GET /api/v1/keys` 公开。
- 审核通过（`published`）时对规范化载荷签名并写入版本元数据：

  ```
  payload   = "agentdock-v1\n<kind>\n<name>\n<version>\n<contentHash>"
  signature = ed25519_sign(privateKey, payload)   // {algorithm, keyId, payload, signature, signedAt}
  ```

  `contentHash = sha256(JSON.stringify(sorted [[path, sha256(file), encoding], ...]))`，由 `bundle.computeContentHash` 统一定义。
- 验签分两步：① 重新读取 `packages/.../files/` 计算 `diskContentHash` 与发布记录比对（防存储篡改）；② 用平台公钥校验 ed25519 签名与载荷。`store.verifySignature`、`GET .../signature?verify=1`、CLI `verify-signature` 共用该逻辑。
- 签名只覆盖已发布版本；被拒绝版本不签名，重新发布会生成新的 contentHash，旧签名不再对应。

### 透明日志（transparency.log）

- 每次审核通过（`decision=approve`）追加一条事件：`{seq, at, kind, name, version, contentHash, publisher, platformKeyId, publisherKeyId, review, prevHash, hash}`；`hash = sha256(JSON.stringify([context, seq, at, kind, name, version, contentHash, publisher, platformKeyId, publisherKeyId, review, prevHash]))`，`prevHash` 首条为 `GENESIS_HASH`。
- `GET /api/v1/transparency/verify` 重算每条事件哈希与链关系，返回 `{ok,size,headHash,brokenAt,reasons}`；`GET .../proof?kind&name&version` 返回 `{entry,index,size,root,proof}`（Merkle 树叶子为事件 `hash`，叶/节点前缀 0x00/0x01）。
- CLI `transparency verify` 验链、`transparency proof <kind/name[@version]>` 用 `verifyInclusionProof` 本地校验包含证明。

### SBOM（sbom.json + version.sbom）

每个版本发布时生成 `agentdock-sbom@1`：

- `files[]`：`{path,bytes,sha256}`
- `components[]`：声明的外部依赖，`type` 为 `tool` / `mcp-server` / `skill`（来自 manifest 的 tools、capabilities.mcpConfigs/mcp、capabilities.skills）
- `summary`：文件数、总体积、各类型组件计数
- `digest`：`sha256(JSON({schema,subject,files,components,summary}))`，可复现（不含 generatedAt）

落盘为 `sbom.json`，并在 `db.json` 的版本记录里保留摘要（`version.sbom`）；接口 `GET .../versions/:version/sbom`。SBOM 记录的是**声明**，只用于审核/归档/供应链比对，不代表依赖真实性已验证。

### 自动审批策略（policy.json）

`data/policy.json` 由 admin 通过 `PUT /api/v1/policy` 或 `agentdock policy set` 写入，启动时 `loadPolicy()` 读取（缺省 `source=default`，即关闭）。规则求值在 `policy.evaluateAutoApproval()` 中完成，全部通过才自动上架：`enabled`、kind 白名单、发布者白名单（空=不限）、是否要求发布者签名、高危=0、中危 ≤ maxMedium、文件数/体积上限、扫描未达阻断阈值、SBOM 已生成。自动通过的版本仍会：平台签名、写透明日志（`review.auto=true`）、写审计 `review.auto_approve`；未通过记录 `review.auto_skipped` 及失败规则，便于事后解释。

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
| `src/diff.mjs` | 行级/文件级差异（LCS + 规模上限降级） | `diffLines`、`diffBundles` |
| `src/store.mjs` | 版本库、状态机、安装计数（元数据经 backend 持久化） | `createStore`（`publish/review/approveVersion/getVersion/requirePublished/bundleContent/fileContent/listPackages/packageDetail/reviewQueue/recordInstall/stats/latestPublished/signingKeyInfo/verifySignature/setPolicy/getPolicy/sbom`） |
| `src/targets.mjs` | 安装目标解析与落盘、安装清单扫描 | `planInstall`、`applyInstall`、`installDestination`、`listTargets`、`listInstalls`（供 `outdated` / `upgrade`） |
| `src/dsh-preset.mjs` | agent 包 → DSH agent-preset 片段；profile patch 合并 | `renderPresetPatch`、`writePresetFragment`、`upsertProfilePatch`、`presetIdFor`、`dshHome` |
| `src/signing.mjs` | ed25519 内容签名/验签（平台密钥 + 发布者 detached 签名） | `loadOrCreateSigningKey`、`signVersion`、`verifyVersionSignature`、`signaturePayload`、`publisherSignaturePayload`、`verifyDetachedSignature`、`keyIdFor` |
| `src/transparency.mjs` | 可验证透明日志：哈希链 + RFC 6962 风格 Merkle 树 + 包含证明 | `createTransparencyLog`、`entryHash`、`merkleRoot`、`inclusionProof`、`verifyInclusionProof` |
| `src/registry.mjs` | 外部 registry 互操作：GitHub / MCP registry 导入、GitHub 推送、中立市场目录导出 | `importFromGitHub`、`importFromMcpRegistry`、`mcpServerToPlugin`、`pushToGitHub`、`buildMarketplaceCatalog`、`describeAdapters`、`slugifyName`、`detectKind` |
| `src/quality.mjs` | 质量分级推导：community / verified / official（由签名、审核与扫描元数据计算，不落库） | `qualityOf`、`QUALITY_LABEL`、`QUALITY_LEVELS` |
| `src/sbom.mjs` | 版本 SBOM 生成与 digest（文件哈希 + 工具/MCP/技能组件） | `buildSbom`、`sbomDigest`、`SBOM_SCHEMA` |
| `src/policy.mjs` | 自动审批策略：归一化/校验/规则求值/读写 | `normalizePolicy`、`evaluateAutoApproval`、`loadPolicy`、`savePolicy`、`defaultPolicy` |
| `src/backend.mjs` | 元数据后端选择与统一接口（json / sqlite） | `createBackend`、`describeBackends`、`BACKEND_KINDS` |
| `src/sqlite.mjs` | `node:sqlite` 后端：关系表 + WAL + db.json 自动迁移 | `createSqliteBackend`、`sqliteAvailable`、`SQLITE_SCHEMA_VERSION` |
| `src/auth.mjs` | 用户/令牌/角色 + 发布者公钥目录 + OIDC 账号开通 | `createUserDirectory`（`authenticate/listKeys/registerKey/removeKey/findKey/keysOf/getUser/provisionOidcUser`）、`tokenFromRequest` |
| `src/session.mjs` | 会话 Cookie：HMAC-SHA256 签名、8h 过期、安全属性集中定义 | `createSessionManager`（`sign/verify/cookieFrom/cookieHeader/clearCookie`）、`SESSION_COOKIE` |
| `src/oidc.mjs` | OIDC discovery + PKCE 授权码流程（零依赖，身份以 userinfo 为准） | `createOidcClient`（`discover/createPkcePair/createState/authorizeUrl/exchangeCode/userinfo/mapClaims/loginUrl`） |
| `src/security.mjs` | Cookie 会话 CSRF 防护（双提交 Cookie + Origin 校验） | `checkCsrf`、`cookieValue`、`CSRF_COOKIE` |
| `src/ratelimit.mjs` | 单机内存滑动窗口限流与来源 IP 解析 | `createRateLimiter`、`requestIp` |
| `src/audit.mjs` | 审计日志（哈希链 + 过滤 + 校验 + 导出 + 轮转） | `createAuditLog`（`append/read/verify/exportLines`） |
| `src/app.mjs` | 路由、鉴权、错误映射、静态文件 | `createApp` |
| `server.mjs` | 启动入口、连接信息输出 | `startServer` |
| `cli/agentdock.mjs` | 命令行、本地校验、导入器 | — |

依赖方向：`cli / server → app → store / targets / pipeline / diff / registry / policy / sbom / session / oidc → bundle / validate / scan → backend（json / sqlite）→ yaml / util / errors`。`pipeline` 与 `targets` 之外不依赖 fs 全局状态，便于测试注入 `config`。

## 5. 安全模型

1. **路径消毒**（`sanitizePath`）：拒绝绝对路径、盘符、`..`、控制字符、隐藏文件、Windows 保留名、`node_modules`；空目录段与尾随空格也拒绝。安装与读取文件前再拼一次根目录并校验 `path.resolve(root, rel)` 前缀。
2. **体积限制**：文件数 200、单文件 512KB、总量 2MB，防止内存/磁盘 DoS。
3. **令牌**：32 字节随机数（base64url），仅存 `sha256`；比较用 `safeEqual`（`crypto.timingSafeEqual`）。首启明文令牌写 600 文件并提示删除。
4. **审计**：所有写操作（发布、审核、安装、令牌创建）均记录，append-only JSONL 且带 `seq/prevHash/hash` 哈希链，`/audit/verify` 读磁盘重算可发现篡改；查询支持 action/actor/target/时间范围过滤，可导出 jsonl/csv，超限自动轮转归档（链跨文件连续）。
5. **扫描**：启发式规则，可配置阻断阈值；`overrideScan` 仅 admin、且事件写入审计。
6. **网络**：默认仅监听 `127.0.0.1`；无内置 TLS，生产部署应置于反向代理后。
7. **内容签名与完整性**：审核通过即用平台 ed25519 私钥签名（绑定 kind/name/version/contentHash）；公钥公开、可离线验签；验签时重算磁盘内容哈希，可发现发布后对 `packages/` 内容的替换。
8. **发布者签名（可选）**：发布者用自有 ed25519 私钥对 `agentdock-publisher-v1\n<kind>\n<name>\n<version>\n<contentHash>` 签名，服务端校验后写入 `version.publisherSignature`；首次携带公钥时 TOFU 注册到 `users.json` 的 `keys[]`（等价 `POST /me/keys`）。平台签名证明「审过且未被替换」，发布者签名证明「谁提交的」。
9. **可验证透明日志**：审核通过时向 `transparency.log` 追加哈希链事件（contentHash、发布者、平台/发布者 keyId、审核人），事件哈希构造 RFC 6962 风格 Merkle 树；`/transparency/verify` 校验整链，`/transparency/proof` 返回包含证明，CLI 使用 `verifyInclusionProof` 本地校验。`audit.log` 面向运维（含 IP/角色；自己的哈希链只用于内部防篡改校验，无 Merkle/公开证明），`transparency.log` 面向外部可复核（不含敏感字段）。
10. **外部 registry 导入**（`registry.mjs`）：只从服务端配置的 `AGENTDOCK_GITHUB_API` / `AGENTDOCK_MCP_REGISTRY` 读取，请求体不接受任意 URL（防 SSRF）；单次 200 文件 / 单文件 512KB / 总量 2MB、15s 超时；外部内容一律走同一 normalize → validate → scan 流水线，导入后为 `pending`，必须审核才能上架；导入操作需 publisher 权限并记录审计 `sync.import`。
11. **SBOM 与自动审批**：每个版本生成 `agentdock-sbom@1`（文件哈希 + 声明的工具/MCP/技能组件 + 可复现 digest），供审核与供应链比对；自动审批默认关闭，开启后仅对策略白名单内、无高危、体积达标且（可选）带发布者签名的版本生效，自动通过的版本同样有平台签名、透明日志与审计，未通过记录失败规则，保证「放宽人工审核」不牺牲可追溯性。
12. **SSO 与多租户**：OIDC Authorization Code + PKCE，无本地 JWT 验签（信任 userinfo 端点，需 HTTPS 可达）；登录后发 HMAC 签名 Cookie（8h），不落服务端会话表。租户由令牌/`tenant` claim 绑定，发布时写入版本 `tenant`；市场列表/统计/详情/审核队列/diff/SBOM/透明证明查询按租户过滤，跨租户一律 404，同名包允许跨租户并存（`kind/name` + `tenant` 区分）。审计与透明日志保持全局视图，会话失效依赖过期/重启。
13. **限流与 CSRF**：`/api/*` 与 OIDC 登录端点按 IP 做内存滑动窗口限流（默认 300/分钟、登录 20/分钟，可配置/关闭），超限返回 429 + `Retry-After`；SSO Cookie 会话的写操作强制双提交 CSRF 令牌（`x-agentdock-csrf` = `agentdock_csrf` Cookie）并校验 `Origin`/`Host`，Bearer 客户端不受影响。进程内计数，多实例需网关层限流。

## 6. 安装目标模型

`targets.mjs` 把「能力包 → 目标目录文件计划」拆成三步：

1. `resolveTargetBase(target, {home, dir})`：目标根目录（如 `~/.dsh`、`~/.claude`、自定义 dir）。
2. `installDestination(kind, name, {target, home, dir})`：最终落点布局：
   - `layout: 'dir'`：`<base>/skills|agents|plugins/<name>/`，包内相对路径平铺；
   - `layout: 'file'`：Claude agent 单文件 `<base>/agents/<name>.md`，其余文件进 `<name>.agentdock/` sidecar，额外写 `<name>.agentdock.json`；
   - `layout: 'dsh-preset'`：只接受 agent 包，渲染成单个 `<base>/agentdock/presets/<name>.patch.yml`（plan 里带 `preset` 元数据：presetId、插件行、告警），另写 `<name>.agentdock.json`。
3. `planInstall()`：生成 `{dest, files[{path, targetPath, content, encoding}], force, notes}`；`applyInstall()` 原子写入（`.tmp` → rename）并写清单。

冲突策略：目标已存在 → `AppError(409)`；`force` 时只覆盖同名文件，不清理旧目录中的多余文件。

安装器可在落盘前做本地复检（`install/upgrade --scan` 复用 `analyzeInput` 的扫描，`--verify` 调签名验签接口）；高危命中默认中止，`--allow-risk` 显式跳过。

`listInstalls({home, dir, targets})` 反向读取这些清单（dir 布局读 `<dir>/.agentdock-install.json`，Claude agent / dsh-agent 读 `<name>.agentdock.json`），供 CLI `outdated` 与 `upgrade` 使用：`outdated` 对比服务端 `latestVersion`，`upgrade` 复用 `planInstall(force: true)` 覆盖安装。清单只含包名/版本/时间，不记录文件哈希，因此升级检查不会发现本地文件被手工修改（完整性校验请用 `verify-signature`）。

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
| 前端 | 原生 JS | 无构建、无依赖 | markdown/表格等扩展受限；diff 为轻量 LCS |
| 策略管理 | CLI + Web 表单双入口 | 运维脚本化与管理员可视化兼顾 | 复杂策略树仍需手写 JSON |
| 审核 | 人工 + 规则 | 误报可控，责任可追溯 | 大规模需策略引擎/自动审批 |
| 安装 | 平台只产计划，CLI 执行 | 用户机器权限边界清晰 | 无法远程批量部署；可加受控 agent |

## 9. 测试策略

- **单元测试**：yaml / bundle / validate / scan / targets / dsh-preset / diff / signing / transparency / registry / sbom / policy——纯函数，覆盖正常与边界（路径穿越、体积、编码、frontmatter 字段、preset 渲染与 profile 合并幂等、diff 行号与降级、签名载荷篡改/换钥/密钥持久化、Merkle 包含证明任意大小/位置、日志篡改定位）。
- **接口测试**（`tests/api.test.mjs`）：真实启动 HTTP 服务（随机端口、临时数据目录），覆盖完整闭环：发布 → 待审核不可见 → 审核 → 上架 → 下载 → 安装 → 计数 → 审计 → 令牌管理 → 权限边界 → 阻断/覆盖；另覆盖策略更新权限、自动审批上架、SBOM 接口与版本详情 SBOM 摘要。外部 registry 测试用本地 mock HTTP 服务（GitHub contents API / MCP registry 响应）注入 `fetchImpl` 或配置，验证导入 → 待审核 → 审核 → 导出目录闭环，无需访问公网。
- **存储后端测试**（`tests/sqlite.test.mjs`）：Node 24 上验证 SQLite 后端的发布/审核/安装持久化、重启恢复、db.json → sqlite 自动迁移与后端选择；Node 20/22 自动 skip。
- **安全测试**（`tests/security.test.mjs`）：限流滑动窗口与恢复、CSRF 校验矩阵、接口 429 + `Retry-After`。
- **认证与多租户测试**（`tests/sso.test.mjs` / `tests/tenant.test.mjs`）：本地 mock OIDC（discovery/token/userinfo）验证 PKCE 登录、Cookie 会话与自动建号；多租户验证列表/详情/审核队列/统计隔离、跨租户 404 与同名冲突、非法租户名拒绝。CI 额外跑 `npm run smoke:sqlite`（`AGENTDOCK_STORE=sqlite` 的真实端到端）。
- **端到端冒烟**（`scripts/smoke.mjs`）：真实 `server` + 真实 `cli` 子进程 + 真实落盘，验证 CLI 输出与文件系统结果；`smoke:sqlite` 用 SQLite 后端跑同一套。
- 测试全部用 `node:test`，无外部服务；`npm test` 与 `npm run smoke` 均可在 CI 中直接跑。

## 10. 外部 registry 同步（导入 / 导出）

**目标**：让 AgentDock 与生态现有 registry 互通，同时保持「外部内容不可信」的前提。

**导入（pull）**：

1. `POST /api/v1/sync/import`（publisher）携带 `source`（`github` 或 `mcp`）；服务端从配置的 base URL 拉取内容（白名单，见安全模型第 10 条）。
2. `registry.mjs` 的适配器把外部内容转成 `{kind, files}`：GitHub 按目录识别 `SKILL.md` / `agent.md` / `plugin.json`；MCP server 转成带 `mcp[]` 声明的 `plugin` 包（原始元数据留 `registry-source.json`）。
3. 同一 `analyzeInput` 流水线归一化/校验/扫描；`dryRun:true` 只返回预检报告。
4. 通过校验后 `store.publish` 落库为 `pending`，进入审核队列；审核通过后获得平台签名与透明日志事件。
5. 审计记录 `sync.import`（含 source 与告警数）。

**推送（push，CLI 本地执行）**：

`sync push github <kind/name[@version]> --repo <owner/repo> [--path <目录>]` 由发布者/运维在本地运行：先从 AgentDock 拉取已上架版本的 bundle，再用 GitHub Git Data API 生成单次 commit（blobs → tree（base_tree=分支当前树）→ commit → 更新 ref）。令牌只来自本地环境（`GITHUB_TOKEN`），服务端不保存外部写凭据；`--dry-run` 仅打印文件清单，不调用 GitHub。skills.sh 等以 GitHub 目录为来源的目录可复用同一路径。

**导出（中立目录）**：

`GET /api/v1/registry/export` 输出 `agentdock-marketplace@1`：

```json
{
  "schema": "agentdock-marketplace@1",
  "generatedAt": "…",
  "baseUrl": "https://dock.example",
  "count": 1,
  "items": [{
    "kind": "skill", "name": "review", "latestVersion": "1.2.0",
    "contentHash": "…64 hex…",
    "bundleUrl": "https://dock.example/api/v1/packages/skill/review/versions/1.2.0/bundle",
    "signature": { "algorithm": "ed25519", "keyId": "…" },
    "publisherSignature": { "keyId": "…", "keyName": "alice" }
  }],
  "digest": "…sha256(JSON(items))…"
}
```

导出不带内容本体（只给 `bundleUrl` 与哈希/签名摘要），由订阅方自行拉取并验签；这样平台不需要对外写权限，也不会把第三方 registry 的凭据引入服务端。

**不做双向推送**：向 GitHub / skills.sh / MCP registry 主动发布需要各自平台 API、鉴权与审核政策，风险与维护成本高；当前导出中立目录 + 订阅方拉取已能满足「同步」，后续若需要可基于同一适配器接口扩展 push。

## 11. SBOM 与自动审批策略

**SBOM**（`src/sbom.mjs`）：`buildSbom(bundle, manifest)` 在发布时同步生成，纯函数、可复现（`digest` 不含时间戳），落 `sbom.json` 并把摘要写进 `version.sbom`。组件来源：agent/skill 的 `tools`、agent 的 `mcp[]`、plugin 的 `capabilities.mcpConfigs`、agent/skill 的 `skills[]` 或 skill 包自身。`GET /api/v1/packages/:kind/:name/versions/:version/sbom` 与 `agentdock sbom <kind/name[@version]>` 对外暴露。

**自动审批**（`src/policy.mjs`）：策略文件 `data/policy.json`，默认关闭。

```jsonc
{
  "schema": "agentdock-policy@1",
  "updatedAt": "…", "updatedBy": "admin",
  "autoApprove": {
    "enabled": true,
    "kinds": ["skill"],
    "trustedPublishers": ["ci-bot"],   // 空数组 = 不限制发布者
    "requirePublisherSignature": true,
    "maxMedium": 0,
    "maxFiles": 100,
    "maxTotalBytes": 2097152
  }
}
```

求值发生在 `store.publish()` 内、写完 SBOM 之后：`evaluateAutoApproval(policy, ctx)` 返回 `{approve, reasons, failed[]}`；通过则调用与人工审核相同的 `approveVersion()`（平台签名 + 透明日志 `review.auto=true` + 审计 `review.auto_approve`），否则保持 pending 并记录 `review.auto_skipped`（含每条失败规则）。策略变更写审计 `policy.update`；读取需 reviewer，修改需 admin。这样「无人值守上架」与「人工审核」共用同一状态机与可验证记录，不存在旁路。

## 12. 元数据存储后端（JSON / SQLite）

`store.mjs` 不再直接读写 `db.json`，而是通过 `backend.mjs` 的统一接口：

```
load() -> state | savePackage(pkgKey, pkg) | saveVersion(pkgKey, versionDoc) | close() | info()
```

- **json**（默认）：进程内持有完整状态，每次写入用 `writeJsonAtomic` 重写单文件。简单、可读、适合小规模。
- **sqlite**（`AGENTDOCK_STORE=sqlite`）：`node:sqlite` 的 `DatabaseSync`，WAL 模式；表 `packages(kind,name,description,tags,created_at,created_by,updated_at)` 与 `versions(kind,name,version,status,payload JSON)`，`status` 建索引。包内容仍是 `data/packages/<kind>/<name>/<version>/files/`（两种后端一致，安装/下载/验签逻辑不变）。
- **迁移**：以 sqlite 启动且表为空、同时存在 `db.json` 时，自动把包与版本导入 SQLite 并写 `meta.migrated_from=db.json`；原 `db.json` 保留以便回退。
- **写入粒度**：发布写整包（含版本）、审核/安装写单版本，不再整库重写；`server.on('close')` 会 `store.close()` 释放 SQLite 句柄并 checkpoint。
- **列表/搜索/统计下推**：SQLite 模式下列表用 `queryPackages()`（SQL 过滤 kind/status/关键词）、统计用 `queryStats()`（SQL 聚合），`store.listPackages/stats` 优先走这些方法；版本 semver 排序与分页仍在 JS 完成。JSON 后端保持原内存实现，两条路径有对照测试保证语义一致。
- **取舍**：启动时仍把全部元数据读入内存（详情、写入、审核需要随机访问）；SQLite 解决持久化可靠性、写入成本与规模上限，列表/搜索已下推。若要百万级包再考虑详情/审核也改为按需查询或换外部数据库。`node:sqlite` 在 Node 24 仍标记 experimental（启动有警告），因此默认后端保持 json，CI 在 Node 24 上单独验证 sqlite。

## 13. 认证与多租户（OIDC SSO）

```
浏览器 ──GET /auth/oidc/login──▶ 302 IdP authorize（state + code_challenge=PKCE-S256）
IdP ──redirect /auth/oidc/callback?code=&state=──▶ 服务端
服务端 ──POST token（code + code_verifier）──▶ IdP
      ──GET userinfo（Bearer access_token）──▶ IdP
      ──provisionOidcUser(sub/email/name + tenant/role claim)──▶ users.json
      ──Set-Cookie: agentdock_session=<HMAC 签名>（HttpOnly/SameSite=Lax/8h）──▶ 302 /
```

- **配置**：`AGENTDOCK_OIDC_ISSUER` + `AGENTDOCK_OIDC_CLIENT_ID` 即启用（可选 secret、redirect、defaultRole、tenantClaim、roleClaim）；未配置时 `/auth/*` 返回 404，仅 Bearer 令牌可用。
- **会话**：`session-secret.json` 首次启动生成（600）；Cookie 载荷 `{uid, exp}` + HMAC-SHA256，`verify` 用 `crypto.timingSafeEqual`；服务端无会话表，改密/禁用账号需等过期或重启。
- **账号开通**：按 `sub`（或 email）匹配已有用户，否则以默认角色创建 `auth:'oidc'` 账号；已存在用户的角色/租户由 admin 在 `users.json` / `POST /admin/tokens` 管理，登录不覆盖。
- **多租户**：`publish` 从 `ctx.tenant` 写入 `pkg.tenant` 与 `version.tenant`；读路径统一传 `tenant`（存储层过滤），JSON 与 SQLite 后端语义一致（`packages.tenant` 列 + `ALTER TABLE` 迁移旧库）；跨租户读写 404，跨租户同名发布 409。统计 SQL 通过 `versions JOIN packages` 按租户聚合。
- **边界**：不隔离审计/透明日志（全局只读）；不做租户配额；OIDC 依赖外部 IdP 可用性；无内置 TLS。

## 14. 部署形态

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 本地开发 | `node server.mjs` / `npm start` | 默认 `127.0.0.1:7788`，数据在仓库内 `data/`（git 忽略） |
| 单机容器 | `Dockerfile` + `docker-compose.yml` | `node:24-alpine` + tini，非 root `node` 用户；`/data` 为唯一持久化卷；HEALTHCHECK 打 `/api/v1/health` |
| CI | `.github/workflows/ci.yml` | Node 20/22/24 矩阵跑 `npm test` / `npm run smoke` / 示例校验 / `node --check`；独立 job 构建镜像并做容器健康检查 |

容器内配置全部走环境变量（`AGENTDOCK_HOST`、`AGENTDOCK_PORT`、`AGENTDOCK_DATA`、`AGENTDOCK_SCAN_BLOCK`、`AGENTDOCK_PUBLIC_URL`），与 CLI 的 `~/.agentdock/config.json` 互不依赖。生产部署应置于反向代理之后，由代理提供 TLS 与访问控制，并限制 `/api/v1/admin/*`。

存储侧只需要备份 `/data`：`db.json`（热索引）、`users.json`（令牌哈希与发布者公钥）、`audit.log`、`transparency.log`（append-only）、`packages/`（版本内容与 meta.json）。迁移时只要有 `packages/` 即可重建版本内容，`db.json` 可用 `meta.json` 人工重建（自动重建列入 roadmap）。
