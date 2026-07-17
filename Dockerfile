# ===== Stage 1: builder =====
# 装编译工具链，编 better-sqlite3 等 native binding，编完丢弃
FROM node:24-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force && \
    rm -rf /root/.node-gyp /root/.npm


# ===== Stage 2: runtime =====
# 只留运行时依赖（python + git），不带编译器，也不内置 Agent CLI
# Agent 走三选一：
#   · 本地映射（docker-compose.local-agents.yaml 挂宿主 ~/.npm-global 等）
#   · sbx microVM（AGENT_ADAPTER=sbx + 装 sbx CLI）
#   · 容器内装（Dockerfile 末尾加 npm i -g ...）
FROM node:24-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    git \
    unzip \
    libstdc++6 \
  && pip3 install --no-cache-dir --break-system-packages requests \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/share/man /usr/share/doc /usr/share/locale

WORKDIR /app

# 从 builder 拷贝已编好的 node_modules（含 native .node 二进制）
COPY --from=builder /app/node_modules ./node_modules

# 应用代码
COPY . .

ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "server.js"]
