# syntax=docker/dockerfile:1.7

# ============================================================
# Stage 1: 构建前端
# ============================================================
FROM node:22-slim AS frontend-builder

WORKDIR /build/frontend

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=matrixspooll-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build

# ============================================================
# Stage 2: 生产镜像
# ============================================================
FROM python:3.12-slim AS production

ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    UV_LINK_MODE=copy

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    bubblewrap \
    socat \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Keep media post-production a build-time contract. Debian's ffmpeg package
# ships both ffmpeg and ffprobe, which are required by merge, voice, and subtitle jobs.
RUN ffmpeg -version >/dev/null 2>&1 && ffprobe -version >/dev/null 2>&1

# 升级 pip（清除安全告警）
RUN python -m pip install --no-cache-dir --upgrade pip

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/MockMine/MatrixSpooll" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.title="MatrixSpooll"

# 基础环境变量
ENV PYTHONUNBUFFERED=1
ENV TZ=Asia/Shanghai

# 复制依赖定义文件
COPY pyproject.toml uv.lock README.md LICENSE NOTICE ./

# 第三方依赖固化进镜像；应用源码稍后复制并从 /app 直接导入。
# --no-install-project 避免源码尚未复制时构建项目，也避免容器启动时再次同步依赖。
RUN --mount=type=cache,id=matrixspooll-uv,target=/root/.cache/uv \
    uv sync --no-dev --frozen --no-install-project

# 将虚拟环境加入 PATH，以便后续命令直接使用
ENV VIRTUAL_ENV=/app/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# 复制应用代码（在依赖安装之后，可更好利用 Docker 缓存层）
COPY lib/ lib/
COPY server/ server/
COPY alembic/ alembic/
COPY alembic.ini ./
COPY scripts/ scripts/
COPY agent_runtime_profile/ agent_runtime_profile/
COPY public/ public/

# 复制前端构建产物
COPY --from=frontend-builder /build/frontend/dist/ frontend/dist/

# 创建运行时目录
RUN mkdir -p projects vertex_keys

# 暴露端口
EXPOSE 1241

# 健康检查（沿用 curl）
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:1241/health/ready \
      && ffmpeg -version >/dev/null 2>&1 \
      && ffprobe -version >/dev/null 2>&1 || exit 1

# ---------- 直接使用虚拟环境中的 uvicorn，避免 uv run 的额外同步 ----------
CMD ["/app/.venv/bin/uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "1241"]
