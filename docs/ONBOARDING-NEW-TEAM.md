# 新团队从零部署 AgentDock 完整流程（Runbook）

> 场景：一个新团队（示例 `acme-platform`，5 人）目前**什么都没有**——没有能力市场、没有安装 DSH/Claude Code/Codex 的共享能力、也没有统一的发布流程。
> 目标：从一台内网机器开始，30 分钟内把 AgentDock 跑起来，发布第一个能力包，并让成员在各自 harness 里装上使用。
>
> 本文所有命令和输出都是在临时环境实测的（`HOME`、数据目录均为隔离目录），可原样复制。

---

## 0. 规划（先花 5 分钟定下来）

| 项目 | 示例值 | 说明 |
|---|---|---|
| 部署机器 | `agentdock.internal`（一台内网 Linux/macOS） | 4C8G 足够；需要 Node 24 或 Docker |
| 端口 | `7788`（反向代理 443） | 生产必须 HTTPS |
| 数据目录 | `/var/lib/agentdock`（Docker：`/data` 卷） | 备份对象，含密钥与审计 |
| 团队角色 | admin ×1、reviewer ×1~2、publisher ×N、viewer | 令牌即身份 |
| 首批能力 | 团队高频 skill（发版检查、代码评审等） | 先冷启动内容 |
| 备份 | 每日 `data/` 打包，保留 30 天 | 含 `signing-key.json`，务必安全保存 |

角色权限：`viewer < publisher < reviewer < admin`。发布/安装需要 publisher；审核/审计需要 reviewer；策略与令牌管理需要 admin。

---

## 1. 准备机器

```bash
node -v        # 需要 >= 20.11；SQLite 后端需要 24+
git -v

# 假设代码已经在机器上（git clone 或拷贝）
cd /opt && git clone <你的仓库> agentdock && cd agentdock
ls    # cli/ src/ web/ server.mjs Dockerfile docker-compose.yml ...
```

国内网络环境没有 npm 依赖要装（零第三方依赖），**不需要 `npm install`**。

---

## 2. 启动平台

### 方式 A：直接跑 Node（内网临时/先验证）

```bash
cd /opt/agentdock
AGENTDOCK_DATA=/var/lib/agentdock AGENTDOCK_HOST=0.0.0.0 AGENTDOCK_PORT=7788 \
  node server.mjs
```

输出（实测）：

```
  AgentDock 已启动
  市场地址   http://0.0.0.0:7788
  API 前缀   http://0.0.0.0:7788/api/v1
  数据目录   /var/lib/agentdock
  初始化令牌 /var/lib/agentdock/BOOTSTRAP-TOKENS.txt
  元数据后端 json（db.json）
```

健康检查与首页：

```bash
curl -s http://127.0.0.1:7788/api/v1/health
# {"ok":true,"name":"agentdock","version":"0.1.0","time":"..."}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/   # 200
```

### 方式 B：Docker（推荐正式部署）

```bash
docker compose up -d --build
docker exec agentdock cat /data/BOOTSTRAP-TOKENS.txt
```

### 方式 C：systemd 常驻（方式 A 的托管版）

```ini
# /etc/systemd/system/agentdock.service
[Unit]
Description=AgentDock registry
After=network.target

[Service]
WorkingDirectory=/opt/agentdock
Environment=AGENTDOCK_DATA=/var/lib/agentdock
Environment=AGENTDOCK_HOST=127.0.0.1
Environment=AGENTDOCK_PORT=7788
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
User=agentdock

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now agentdock
```

> 生产建议：`AGENTDOCK_HOST=127.0.0.1` + Nginx/Caddy 反代提供 HTTPS；`/data` 与 `signing-key.json` 进备份；`BOOTSTRAP-TOKENS.txt` 权限 600，读完即转存密码器并删除。

---

## 3. 初始化团队（token 即账号）

首次启动会生成 3 个头像令牌（admin / reviewer / publisher），只写一次：

```bash
cat /var/lib/agentdock/BOOTSTRAP-TOKENS.txt
#  admin     <token>  # admin
#  reviewer  <token>  # reviewer
#  publisher <token>  # publisher
```

用 admin 给每个成员建**个人令牌**（不共享 bootstrap 令牌）：

```bash
export ADM=$(grep '^admin' /var/lib/agentdock/BOOTSTRAP-TOKENS.txt | awk '{print $2}')
export AGENTDOCK_URL=http://127.0.0.1:7788

node cli/agentdock.mjs tokens create alice --role admin    --token "$ADM"
node cli/agentdock.mjs tokens create bob   --role reviewer --token "$ADM"
node cli/agentdock.mjs tokens create carol --role publisher --token "$ADM"
```

实测输出：

```
✓ 已创建用户 alice（admin）
  令牌（只显示一次）：<token>
✓ 已创建用户 bob（reviewer）
✓ 已创建用户 carol（publisher）
```

每个成员在自己的机器上登录（写入 `~/.agentdock/config.json`）：

```bash
node cli/agentdock.mjs login --url http://agentdock.internal:7788 --token <自己的 token>
node cli/agentdock.mjs whoami
# alice（admin） @ http://agentdock.internal:7788
```

浏览器打开 `http://agentdock.internal`，粘贴令牌即可看到市场、审核、审计、令牌页（按角色显示）。

---

## 4. 发布第一个能力包

推荐先在团队机器上建一个 skill 目录（Codex/Claude/DSH 都认 `SKILL.md`）：

```
release-checklist/
└── SKILL.md
```

```markdown
---
name: release-checklist
description: 发版前按顺序检查构建、测试、变更说明与回滚方案，输出可执行的发布清单。
---

# Release Checklist

当用户要求"准备发版 / 发布检查 / release"时使用本技能。

1. 确认版本号与 CHANGELOG，列出本次变更摘要。
2. 检查 CI 是否全绿：构建、单测、端到端。
3. 确认数据库迁移可回滚，列出回滚步骤。
4. 生成发布清单：发布前 / 发布中 / 发布后 三段，每项标注负责人。
5. 输出一条可直接贴到发布群的消息。

限制：不要执行发布命令，只生成清单；不要把密钥写进清单。
```

### 4.1 本地预检（扫描 + 结构校验）

```bash
node cli/agentdock.mjs verify ./release-checklist
```

实测：

```
包        skill/release-checklist@0.1.0
文件      1 个，659 B
内容哈希  55b1217314e8e6f3…
能力      入口 SKILL.md

安全扫描  高危 0 / 中危 0 / 低危 0

✓ 校验通过，可以发布
```

### 4.2 发布（carol / publisher）

```bash
node cli/agentdock.mjs publish ./release-checklist --token <carol-token>
# ✓ 已提交 skill/release-checklist@0.1.0，等待审核
```

### 4.3 审核上架（bob / reviewer）

```bash
node cli/agentdock.mjs review list   --token <bob-token>
node cli/agentdock.mjs review approve skill/release-checklist@0.1.0 \
  --note "首个团队 skill" --token <bob-token>
# ✓ 已通过 skill/release-checklist@0.1.0
```

市场列表：

```bash
node cli/agentdock.mjs list --token <carol-token>
# skill/release-checklist  0.1.0  published  技能  0  发版前按顺序检查构建、测试…
```

---

## 5. 成员安装并使用

每个成员按下表选自己的 harness（AgentDock 不要求机器上先有 DSH；换 harness 只改 `--target`）：

| 成员用的 harness | 安装命令 | 内容落到 |
|---|---|---|
| DSH | `agentdock install skill/release-checklist --target dsh` | `~/.dsh/skills/release-checklist/` |
| Claude Code | `--target claude` | `~/.claude/skills/release-checklist/` |
| Codex CLI | `--target codex` | `~/.codex/skills/release-checklist/` |
| 多个 harness 共用 | `--target shared` | `~/.agents/skills/release-checklist/` |

实测安装输出（四种目标都成功）：

```
✓ 已安装 skill/release-checklist@0.1.0 → DeepSeek Harness (~/.dsh)
  目标目录：~/.dsh/skills/release-checklist
  - SKILL.md
  - release-checklist/.agentdock-install.json
...
✓ 已安装 skill/release-checklist@0.1.0 → Codex CLI (~/.codex)
  目标目录：~/.codex/skills/release-checklist
```

安装后内容（全团队一致、带版本和安装清单）：

```
~/.dsh/skills/release-checklist/SKILL.md
~/.dsh/skills/release-checklist/.agentdock-install.json
~/.claude/skills/release-checklist/SKILL.md
~/.codex/skills/release-checklist/SKILL.md
~/.agents/skills/release-checklist/SKILL.md
```

`.agentdock-install.json` 记录 `package{kind,name,version}`、安装时间与来源；`verify-signature` 可复核：

```bash
node cli/agentdock.mjs verify-signature skill/release-checklist@0.1.0
# 状态：已发布（已签名）
# keyId：e5e4c0bf…（ed25519）
# ✓ 签名有效，内容完整性校验通过
```

### 在 harness 里怎么"用起来"

- **DSH**：`~/.dsh/skills` 就是内置 skill-filesystem 的扫描根，重启/新会话后该 skill 出现在技能目录中，模型按 description 判断何时加载；对 Agent 说"按 release-checklist 帮我准备发版"即可。
- **Claude Code / Codex**：`~/.claude/skills`、`~/.codex/skills` 是各自的 Agent Skills 目录（目录名 + `SKILL.md`），同样按需加载；若该版本某个 harness 还不支持 skills 目录，先用 `--target shared` 放进 `~/.agents/skills`，或把内容当 prompt/command 使用。
- 升级：`agentdock install skill/release-checklist --target dsh`（默认最新已发布版）会自动覆盖文件；看得到装了哪个版本就看 `.agentdock-install.json`。

---

## 6. 治理闭环（第二周再做也可以）

### 6.1 自动审批（低风险包不再人工排队）

```bash
cat > policy.json <<'EOF'
{
  "autoApprove": {
    "enabled": true,
    "kinds": ["skill"],
    "trustedPublishers": ["publisher"],
    "maxMedium": 0
  }
}
EOF
node cli/agentdock.mjs policy set --file policy.json --token <admin-token>
node cli/agentdock.mjs policy show --token <reviewer-token>
```

之后内部可信发布者提交的、扫描高危=0/中危=0 的 skill 自动上架（同样平台签名 + 透明日志，审计里 `auto=true`）。实测：

```
✓ 已提交 skill/release-checklist@0.2.0，已通过策略自动审批并上架
```

### 6.2 发布者签名（可选，强信任场景必开）

```bash
# 发布者一次性生成密钥
node cli/agentdock.mjs keygen --out ~/.agentdock/keys --name carol
# 发布时附加签名（首次自动 TOFU 注册公钥）
node cli/agentdock.mjs publish ./release-checklist --version 0.2.0 \
  --key ~/.agentdock/keys/carol-private.pem --key-name carol
# 审核者/任何人可查：公钥、透明日志、包含证明
node cli/agentdock.mjs keys
node cli/agentdock.mjs transparency verify
```

### 6.3 从已有资产迁移（团队里有人已经攒了 skill/agent）

```bash
# 把现有 Claude Code agents 批量导入为 agent 包（--publish 直接提交审核）
node cli/agentdock.mjs import-claude --dir ~/.claude/agents --publish
# 也可以顺便生成 DSH agent-preset 片段
node cli/agentdock.mjs import-claude --presets --profile web

# 从 GitHub / MCP registry 导入（必须人工审核）
node cli/agentdock.mjs sync import github openai/skills --path skills/review --dry-run
node cli/agentdock.mjs sync import mcp weather --dry-run
```

### 6.4 审计与备份

```bash
node cli/agentdock.mjs audit --limit 20 --token <reviewer-token>
```

每日备份（停服或 SQLite `.backup` 更稳）：

```bash
tar czf /backup/agentdock-$(date +%F).tgz -C /var/lib/agentdock .
```

恢复：停服 → 解包覆盖 `data/` → 启动。`signing-key.json` 丢失会导致历史版本验签失败，务必单独备份。

---

## 7. 日常运营节奏

| 频率 | 动作 |
|---|---|
| 每周 | 清审核队列（pending 超 24h 报警）、看 `/stats` Top 包、抽检 1 个包、更新推荐位 |
| 每月 | 清理 0 安装/过期包、检查备份恢复演练、看签名/透明日志覆盖率 |
| 每次发版 | `publish` → 审核/自动审批 → 通知频道；成员 `install` 升级 |
| 每季度 | 升级平台（`git pull && systemctl restart agentdock` 或 `docker compose up -d --build`） |

周报数据来源：`GET /api/v1/stats`、`GET /api/v1/audit?from=&to=`、`GET /api/v1/registry/export`。

---

## 8. 验收清单（部署完逐项打勾）

- [ ] `curl /api/v1/health` 返回 `ok:true`
- [ ] 浏览器市场页 200，能用个人令牌登录
- [ ] admin 创建了 alice/bob/carol 个人令牌并分发给本人
- [ ] 第一个 skill：`verify` 通过、`publish` 成功、`review approve` 成功
- [ ] 三种 harness（或 shared）安装成功，`SKILL.md` 与 `.agentdock-install.json` 均在位
- [ ] `verify-signature` 显示"签名有效"
- [ ] `audit` 能看到 publish / review / install 记录
- [ ] `data/` 备份任务已配置，`signing-key.json` 单独安全保存
- [ ] （可选）policy 自动审批、发布者密钥、透明日志验证通过

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `缺少或无效的访问令牌` | 令牌不是该实例的（换了 data/ 后旧令牌失效）；重新 `login` |
| 端口被占用 | 上一个实例没退：`lsof -ti tcp:7788 \| xargs -r kill -9`，或换端口 |
| 安装提示"目标已存在" | 加 `--force` 覆盖（只覆盖同名文件，不清理旧目录多余文件） |
| `node:sqlite` ExperimentalWarning | Node 24 内置模块仍标记 experimental；不影响使用，默认 json 后端可避开 |
| 发布被阻断 | 扫描高危命中；看 `agentdock verify` 输出，修复后重发；确实要放行由 admin `--override-scan`（留审计） |
| 自动审批没生效 | 检查 policy：kind/发布者白名单、高危/中危阈值、是否要求发布者签名 |
| SQLite 模式升级 | 先停服备份；删 `agentdock.sqlite*` 并保留 `db.json` 可回退 json 后端 |

---

## 10. 一页命令卡

```bash
# 平台
node server.mjs                                    # 或 docker compose up -d
curl /api/v1/health
# 用户
agentdock login --url <url> --token <token>
agentdock whoami
agentdock tokens create <name> --role <role>       # admin
# 发布
agentdock verify ./pkg
agentdock publish ./pkg [--version x.y.z] [--key <pem>]
agentdock review list | review approve|reject <kind/name@ver> --note "..."
# 使用
agentdock list [--q 关键词]
agentdock install <kind/name[@ver]> --target dsh|dsh-agent|claude|codex|shared|dir [--force]
agentdock verify-signature <kind/name[@ver]>
# 治理
agentdock policy show|set --file policy.json
agentdock transparency head|verify|entries|proof <spec>
agentdock audit --limit 20
agentdock sync sources|import|export ...
```

> 需要的话，下一步我可以把这份 runbook 做成一个 `scripts/team-demo.mjs` 一键脚本（自动起临时实例、建三个角色、发布示例、装到三种目标、打印验收结果），方便你在新机器上 30 秒复现。
