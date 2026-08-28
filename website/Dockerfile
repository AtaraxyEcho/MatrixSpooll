# syntax=docker/dockerfile:1.7

FROM node:24-slim AS builder

WORKDIR /build/website
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY website/package.json website/pnpm-lock.yaml ./
RUN --mount=type=cache,id=matrixspooll-website-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY NOTICE CONTRIBUTING.md /build/
COPY website/ ./

ARG DOCS_SITE_URL=http://localhost:3000
ARG DOCS_BASE_URL=/docs/
ENV DOCS_SITE_URL=${DOCS_SITE_URL}
ENV DOCS_BASE_URL=${DOCS_BASE_URL}
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.30.4-alpine AS production

COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/website/build/ /usr/share/nginx/html/docs/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1
