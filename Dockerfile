# AgentDock —— 可自托管的 skill / agent / plugin 能力市场与治理平台
# 零第三方依赖：镜像里只需要 Node 运行时 + 本仓库源码。
FROM node:24-alpine

# tini 负责信号转发与僵尸进程回收（容器里跑 HTTP 服务）
RUN apk add --no-cache tini

WORKDIR /app

# 只拷运行所需内容（测试、脚本、示例不进入运行时镜像）
COPY package.json ./
COPY src ./src
COPY web ./web
COPY cli ./cli
COPY server.mjs README.md LICENSE ./

# 数据目录（db/users/audit/packages）持久化到 /data；以非 root 用户运行
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    AGENTDOCK_HOST=0.0.0.0 \
    AGENTDOCK_PORT=7788 \
    AGENTDOCK_DATA=/data

USER node
VOLUME ["/data"]
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7788/api/v1/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
