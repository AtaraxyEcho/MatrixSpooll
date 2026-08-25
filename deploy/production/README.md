# MatrixSpooll 生产部署

生产 Compose 保持 FastAPI 承载 SPA、API、SSE 和媒体接口，由 Nginx 作为唯一公网入口：

```text
Internet :80/:443 -> nginx -> matrixspooll:1241 -> postgres:5432
```

宿主机不会发布应用 `1241` 或 PostgreSQL `5432`。应用与数据库分别加入内部网络，只有应用能访问数据库；应用仍可通过 `edge` 网络访问外部模型供应商。

## 首次部署

1. 将本目录的 `.env.example` 复制为 `.env`。
2. 设置以下必填值：

   - `POSTGRES_PASSWORD`
   - `AUTH_PASSWORD`
   - `AUTH_TOKEN_SECRET`
   - `PUBLIC_HOST`：不带协议、端口、路径的公网域名或 IPv4 地址
   - `PUBLIC_ORIGIN`：浏览器访问 origin，例如 `https://video.example.com`
   - `CERTBOT_EMAIL`

   `AUTH_TOKEN_SECRET` 与 `POSTGRES_PASSWORD` 应使用随机值，例如 `openssl rand -hex 32`。生产 Compose 不会自动生成或回写认证密钥，也不再把 `.env` 挂载进应用容器。

3. 确保防火墙和云安全组只放行 TCP `80`、`443`。域名模式下先将 DNS 指向服务器；IP 模式下必须使用公网 IPv4，不能使用内网地址。
4. 选择一种应用来源启动：

   ```bash
   # 在服务器本地构建 Dockerfile
   docker compose -f docker-compose.yml up -d --build

   # 使用远程应用镜像
   docker compose -f docker-compose-img.yml up -d
   ```

首次启动时 Nginx 先提供 ACME HTTP-01 校验路径，其他页面返回 `503`。Certbot 申请成功后会把证书原子发布到共享卷，Nginx 自动校验并热重载 HTTPS 配置。证书签发期间不需要、也不能启动第二个占用 `80` 的 Certbot standalone 服务。

## 证书续期

Certbot 每 6 小时检查一次续期，并通过 webroot 完成校验；Nginx 不需要重启。域名证书按 CA 的常规有效期续期，IPv4 证书自动使用 Let’s Encrypt `shortlived` 配置，证书有效期约 6 天，因此必须保持 Certbot 容器持续运行。

```bash
docker compose -f docker-compose-img.yml logs -f certbot nginx
docker compose -f docker-compose-img.yml ps
curl -I https://PUBLIC_HOST/health/live
```

如果 Certbot 反复重试，优先检查：公网 `80` 是否可达、`PUBLIC_HOST` 是否与 DNS/公网 IPv4 一致、防火墙是否允许 HTTP-01、`CERTBOT_EMAIL` 是否有效。不要删除 `letsencrypt` 卷，除非确认需要重新申请证书。

## 数据与备份

PostgreSQL 数据位于 `pgdata/`，项目媒体和生成结果位于 `projects/`。还需要备份 `projects/.credential-key`（如果未设置 `MATRIXSPOOLL_CREDENTIAL_KEY`），以及 `letsencrypt` 卷中的证书和账户状态。日志文件位于 `logs/`，容器日志启用了按服务的大小轮转。

升级镜像或源码前先备份 PostgreSQL、`projects/` 和证书卷；回滚时使用对应的镜像 tag，并保持数据库迁移版本匹配。

## 端口与安全边界

- 对外端口只有 Nginx 的 `80` 和 `443`。
- `1241` 只在 Docker `edge` 网络内可达，不能通过宿主机 IP 直接访问。
- `5432` 只在 Docker `database` 内部网络内可达。
- 应用的 `NET_ADMIN`、放宽 seccomp/apparmor 是 Agent bwrap 沙箱的现有运行约束；它们不等于公网端口暴露。
- Nginx 负责 TLS、HTTP 到 HTTPS 跳转、SSE 禁用代理缓冲、上传大小限制和基础安全响应头；应用仍负责认证、CSRF、项目权限和业务校验。
