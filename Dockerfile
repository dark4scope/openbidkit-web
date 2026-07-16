# 易标 Web 版：多阶段构建。
# builder 编译前端（vite web 版）；runtime 装 LibreOffice(.doc/.wps 转换) + 中文字体 +
# 上游运行时依赖（better-sqlite3 按容器 node ABI 重编）+ server。
# 显式清空 http_proxy/https_proxy —— 宿主 docker daemon 走 clash，容器内构建/运行必须去代理。

# ---------- Stage 1: 前端构建 ----------
FROM node:22-bookworm AS builder
ENV http_proxy="" https_proxy="" HTTP_PROXY="" HTTPS_PROXY=""
WORKDIR /app/client
COPY client/package.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm install --ignore-scripts --no-audit --no-fund
COPY client/ ./
RUN npx vite build --config ./vite.web.config.ts

# ---------- Stage 2: 运行时 ----------
FROM node:22-bookworm AS runtime
ENV http_proxy="" https_proxy="" HTTP_PROXY="" HTTPS_PROXY="" \
    NODE_ENV=production PORT=3000 HOST=0.0.0.0 YIBIAO_DATA_DIR=/app/data

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc \
      fonts-noto-cjk fonts-noto-cjk-extra \
      python3 build-essential ca-certificates; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 上游运行时依赖（含 better-sqlite3，按容器 node ABI 重新编译）
COPY client/package.json ./client/
RUN cd client \
    && npm config set registry https://registry.npmmirror.com \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3

# 上游主进程业务代码 + 前端产物
COPY client/electron ./client/electron
COPY --from=builder /app/client/dist ./client/dist

# server
COPY server/package.json ./server/
RUN cd server \
    && npm config set registry https://registry.npmmirror.com \
    && npm install --omit=dev --no-audit --no-fund
COPY server/ ./server/

# NOTICE / LICENSE 随镜像分发（AGPL 合规）
COPY LICENSE NOTICE ./

EXPOSE 3000
CMD ["node", "server/index.cjs"]
