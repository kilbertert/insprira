# ===== Stage 1: builder =====
# 装编译工具链，编 better-sqlite3 等 native binding，编完丢弃
FROM node:22-slim AS builder

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
# Agent 改走 sbx / Daytona / 本地 spawn 三选一，见 lib/agent.js 的 adapter 接口
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    git \
    unzip \
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
