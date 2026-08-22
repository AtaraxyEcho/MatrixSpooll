---
id: deployment
title: Deployment and Operations
sidebar_position: 1
---

# Deployment and Operations {#deployment}

This document covers MatrixSpooll's single PostgreSQL runtime, environment variables, data persistence, upgrades, backups, restoration, reverse proxies, and troubleshooting. See the [Security Policy](https://github.com/MockMine/MatrixSpooll/blob/main/SECURITY.md) for the official support boundaries and the [Security Threat Model](https://github.com/MockMine/MatrixSpooll/blob/main/docs/security/threat-model.md) for the complete trust boundaries.

## Choosing a Deployment Mode {#choose-deployment-mode}

| Scenario | Recommended Method | Database | Notes |
|---|---|---|---|
| Local Docker build | `deploy/production/docker-compose.yml` | PostgreSQL | Builds the complete image from the current source |
| Published image deployment | `deploy/production/docker-compose-img.yml` | PostgreSQL | Pulls a prebuilt complete image |
| Local development | Run from source | PostgreSQL | Requires an explicit `DATABASE_URL`; see the [Contributing Guide](../dev/contributing.md) |

Regardless of the method you choose, project images, videos, and other generated assets must be stored persistently.

MatrixSpooll supports administrators, members, and project owner/editor/viewer roles, but remains a single-instance, single-tenant deployment without organization-level tenant isolation.

SQLite is no longer a runtime fallback. Outside isolated tests that explicitly set `TESTING=true`, a missing `DATABASE_URL` prevents startup so local and Docker environments cannot silently use different databases.

## 1. Deployment: PostgreSQL {#postgresql-deployment}

### 1.1 Start {#postgresql-start}

```bash
cd "$(git rev-parse --show-toplevel)/deploy/production"
cp .env.example .env
```

Edit `.env`:

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD=set a strong password
AUTH_TOKEN_SECRET=set a long-lived random secret
POSTGRES_PASSWORD=set a database password
# LOG_LEVEL=INFO
```

Generate a password containing only hexadecimal characters where possible:

```bash
openssl rand -hex 16
```

The default Compose configuration passes the raw `POSTGRES_PASSWORD` to PostgreSQL and also interpolates it into the password segment of `DATABASE_URL`. If the password contains URL-reserved characters such as `@`, `:`, `/`, `?`, `#`, or `%`, the password in the connection URI must be percent-encoded. Do not put the encoded value directly in `POSTGRES_PASSWORD`: PostgreSQL needs the raw password, while only the URI needs the encoded form.

When special characters are required, keep the raw and encoded values separate in `.env`:

```dotenv
POSTGRES_PASSWORD='p@ss/word'
POSTGRES_PASSWORD_URLENCODED=p%40ss%2Fword
```

Then change only the password segment of `DATABASE_URL` in `deploy/production/docker-compose.yml` to `${POSTGRES_PASSWORD_URLENCODED}`; leave the PostgreSQL container's `POSTGRES_PASSWORD` unchanged. You can generate the encoded value with `urllib.parse.quote(raw_password, safe="")`. If you do not want to maintain this Compose customization, use the hexadecimal password described above.

Start the service:

```bash
docker compose up -d
```

Verify it:

```bash
docker compose ps
docker compose logs --tail=100 postgres
docker compose logs --tail=100 matrixspooll
curl -f http://localhost:1241/health/ready
```

### 1.2 PostgreSQL Persistent Directories {#postgresql-volumes}

| Host Path | Contents |
|---|---|
| `deploy/production/pgdata/` | PostgreSQL data directory |
| `deploy/production/projects/` | Projects and media assets |
| `deploy/production/logs/` | Application logs |
| `deploy/production/vertex_keys/` | Vertex AI credentials |
| `deploy/production/claude_data/` | Agent runtime data |
| `deploy/production/.env` | Authentication and database configuration |

`pgdata/` stores only the PostgreSQL cluster, while `projects/` stores project metadata and media assets. Both directories must be persisted and backed up together. The production deployment uses PostgreSQL through `DATABASE_URL` and does not use `deploy/production/projects/.arcreel.db`. Do not copy SQLite files into `pgdata/`, and do not treat these two directories as interchangeable database backups.

### 1.3 Database Migrations {#database-migrations}

MatrixSpooll runs Alembic migrations at application startup to upgrade the database schema to the current version.

You must still create a backup before upgrading. Automatic migration handles schema upgrades; it does not replace a rollback-capable data backup.

## 3. Environment Variables {#environment-variables}

The default deployment examples currently include these core variables:

| Variable | Default | Recommendation |
|---|---|---|
| `AUTH_USERNAME` | `admin` | Change the administrator username if needed |
| `AUTH_PASSWORD` | Empty | Explicitly set a strong password for production deployments |
| `AUTH_TOKEN_SECRET` | Empty | Set a fixed, long-lived random value for production deployments |
| `LOG_LEVEL` | `INFO` | Temporarily change to `DEBUG` while troubleshooting, then restore it |
| `POSTGRES_PASSWORD` | None | Required for the bundled PostgreSQL deployment |
| `TZ` | `Asia/Shanghai` | Can be overridden in the Compose environment |
| `DATABASE_URL` | None | Required; production Compose constructs the PostgreSQL URL |
| `ARCREEL_DATA_DIR` | `projects` | Use this to customize the application's root data directory |

Notes:

- Changing `AUTH_TOKEN_SECRET` invalidates existing login tokens.
- `.env` may contain secrets. Do not commit it to version control.
- Vertex credential files should be readable only by the user who runs MatrixSpooll.
- Third-party model API keys are normally managed on the MatrixSpooll Settings page. Do not include them in public documentation.

MatrixSpooll's sandbox requires provider secrets to be absent from the parent process environment. If any of the following credential environment variables has a non-empty value, the service refuses to start and prompts you to move the credential to the Web UI Settings page:

- `ANTHROPIC_API_KEY`
- `ARK_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` / `VIDU_API_KEY`
- `DASHSCOPE_API_KEY` / `MINIMAX_API_KEY` / `AGNES_API_KEY` / `OPENAI_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS` (continue storing Vertex credentials in the `vertex_keys/` directory)

Non-secret configuration such as `ANTHROPIC_BASE_URL` and model names does not independently cause startup to be rejected, but it is still best managed in the Web UI together with the corresponding credentials.

## 4. Health Checks and Logs {#health-and-logs}

### 4.1 Health Check {#health-check}

Compose uses:

```text
GET /health/ready
```

To check manually:

```bash
curl -f http://localhost:1241/health/ready
```

### 4.2 View Logs {#view-logs}

```bash
# Last 200 lines
docker compose logs --tail=200 matrixspooll

# Follow continuously
docker compose logs -f matrixspooll

# Production database logs
docker compose logs -f postgres
```

Do not paste complete logs directly into a public issue. Remove the following before submitting them:

- API keys;
- Tokens;
- Credentials embedded in Base URLs;
- User input;
- Private information in local file paths.

## 5. Upgrades {#upgrade}

### 5.1 Before Upgrading {#before-upgrade}

1. Read the [CHANGELOG](https://github.com/MockMine/MatrixSpooll/blob/main/CHANGELOG.md) and the target release notes;
2. Check for breaking changes;
3. Back up the database and project directory;
4. Record the current source commit;
5. Perform the upgrade during an acceptable maintenance window.

### 5.2 Upgrade the Production Deployment {#upgrade-postgresql-deployment}

From `deploy/production/`:

```bash
# Back up the database and projects/ first
docker compose build matrixspooll
docker compose up -d

docker compose ps
docker compose logs --tail=100 postgres
docker compose logs --tail=200 matrixspooll
curl -f http://localhost:1241/health/ready
```

The application runs database migrations when it starts. Do not skip multiple versions and upgrade directly without a backup.

### 5.3 Project Schema Migrations {#project-schema-migrations}

In addition to database migrations, application startup upgrades each project under `projects/`. When upgrading to a version that introduces artifact-state records, MatrixSpooll fully validates the project and its formal scripts, writes the complete artifact records atomically, and updates the schema version in `project.json` only after those steps succeed.

Before committing a migration, MatrixSpooll creates adjacent backups with a `.bak.v7-<timestamp>` suffix for:

- `project.json`;
- Formal script files registered in `project.json`;
- An existing `.arcreel_artifacts.json`.

Project migration is safe to retry. If a previous startup was interrupted while creating backups or committing changes, the next startup validates the project again and ensures that at least one backup exactly matches the pre-migration content before continuing. These automatically generated project-level backups exist only for migration recovery; they do not replace deployment-level backups of the database and the entire `projects/` directory.

One class of migration first copies the whole project next to its directory, rewrites the copy, and then swaps the directories. What that means for disk space and recovery:

- Free space is checked before the migration starts. If it cannot hold the copy, that project fails with a "disk space is insufficient" error and its directory is left untouched; free up space and restart to continue.
- If the process is killed during the swap (power loss, `kill -9`, an OOM-killed container), the project directory can be missing for a moment and a hidden directory starting with `.<project-name>.v6-` is left alongside it. The next startup reclaims it and brings the project back, so do not delete these directories by hand, and do not rush to recreate a project that disappeared from the list.
- Once the project is back in place, those hidden directories are cleaned up automatically under the same retention window as the backups above.

If a project migration fails, preserve the files and inspect the startup logs. Do not manually change the schema version or delete backup files. Repair the damaged project references or permissions, then restart the service.

### 5.4 Build Locally {#local-build}

The production Compose file builds the application image from the repository root and does not depend on a public image registry. Rebuild the application service after updating the source:

```bash
docker compose build matrixspooll
docker compose up -d
```

## 6. Backup and Restore {#backup-and-restore}

### 6.1 Back Up a PostgreSQL Deployment {#backup-postgresql}

Stop the MatrixSpooll application first, but leave PostgreSQL running, so no new writes occur while you back up the database and project files:

```bash
cd "$(git rev-parse --show-toplevel)/deploy/production"
umask 077
mkdir -p backups
chmod 700 backups
docker compose stop matrixspooll

backup_stamp="$(date +%Y%m%d-%H%M%S)"

docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -h 127.0.0.1 -U arcreel -d arcreel' \
  > "backups/arcreel-db-${backup_stamp}.sql"

tar -czf "backups/arcreel-files-${backup_stamp}.tar.gz" \
  .env docker-compose.yml projects vertex_keys claude_data

docker compose start matrixspooll
```

The database and file backups use the same timestamp and must be stored and restored together. The file backup includes the active `docker-compose.yml`, so any `DATABASE_URL` customization required by a special-character password is restored together with `.env`. `umask 077` and backup directory mode `0700` ensure that the host-created SQL file and file archive are readable and writable only by the current user.

`pg_dump` reads `PGPASSWORD` through libpq. The command above sets it only for that `pg_dump` process inside the PostgreSQL container, allowing `docker compose exec -T` to run non-interactively without expanding the password into the host command line. For long-running host-side backup automation, use a PostgreSQL password file with `0600` permissions instead. Never put the password in a script or backup filename.

If `tar` reports `Permission denied`, the mounted directory contains files created by the container's root user that the current host user cannot read. Rerun the corresponding `tar` command with `sudo`, then restrict read access to the backup file when finished.

### 6.2 Restore PostgreSQL {#restore-postgresql}

Before restoring, stop MatrixSpooll but leave PostgreSQL running:

```bash
cd "$(git rev-parse --show-toplevel)/deploy/production"
docker compose stop matrixspooll

backup_stamp=YYYYMMDD-HHMMSS
tar -xzf "backups/arcreel-files-${backup_stamp}.tar.gz"
```

The file archive restores `.env`, `docker-compose.yml`, `projects/`, and the runtime directories. The following procedure also deletes the existing data in the target `arcreel` database. First verify that the database and file backups with the same `backup_stamp` are complete, and rehearse the restoration procedure in an isolated environment.

Recreate an empty database before importing to avoid conflicts with existing schemas or data:

```bash
docker compose exec -T postgres \
  dropdb -U arcreel --maintenance-db=postgres --if-exists --force arcreel

docker compose exec -T postgres \
  createdb -U arcreel --maintenance-db=postgres -O arcreel arcreel

cat "backups/arcreel-db-${backup_stamp}.sql" | \
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U arcreel -d arcreel
```

After the database import succeeds, restart the application:

```bash
docker compose start matrixspooll
curl -f http://localhost:1241/health/ready
```

> The restoration strategy depends on whether you are overwriting an existing database, restoring across versions, and whether the service was still accepting writes when the backup was created. Production environments should regularly perform real restoration drills, not merely verify that backup files exist.

## 7. Reverse Proxy and HTTPS {#reverse-proxy-and-https}

MatrixSpooll does not currently support direct exposure to the public Internet. Private remote deployments must enable authentication and protect traffic with TLS, a VPN, or a secure tunnel. Do not publish port `1241` directly to an untrusted network. Recommended practices:

- Use Nginx, Caddy, Traefik, or a cloud load balancer;
- Configure HTTPS;
- Allow only the proxy server to access the MatrixSpooll container port;
- Preserve long-lived SSE connections;
- Set sufficiently large upload limits and read timeouts.

The official Compose files use `1241:1241` by default, which publishes the backend port on every host network interface. Adding a reverse proxy alone does not close this direct access path. When the reverse proxy runs on the same host, change the `matrixspooll` service's port mapping before startup so it listens only on loopback:

```yaml
ports:
  - "127.0.0.1:1241:1241"
```

If the reverse proxy runs on a container network or another host, remove any unnecessary host port publishing and use the container network, host firewall, or an equivalent network policy to ensure only the proxy can access the MatrixSpooll backend.

Nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name arcreel.example.com;

    ssl_certificate /etc/letsencrypt/live/arcreel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arcreel.example.com/privkey.pem;

    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:1241;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # MatrixSpooll uses SSE to push Agent replies and project events
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Certificate configuration depends on your infrastructure. You can use ACME/Let's Encrypt or certificates managed by your cloud platform.

## 8. Container Permissions and the Agent Sandbox {#container-permissions-and-sandbox}

MatrixSpooll strictly checks the Agent sandbox at startup on Linux and macOS and refuses to start if the required tools are missing or unavailable. Native Windows does not provide `bwrap`, so MatrixSpooll automatically falls back to a restricted Bash command allowlist. This mode supports only project creation and basic workflows; use WSL2 or Docker Desktop for production deployments.

| Environment | Tool | Installation |
|---|---|---|
| macOS | `sandbox-exec` | Included with the operating system; no additional installation required |
| Local development on Linux | `bwrap` + `socat` | Ubuntu/Debian: `sudo apt install bubblewrap socat`; Fedora: `sudo dnf install bubblewrap socat`; Arch: `sudo pacman -S bubblewrap socat` |
| Docker | `bwrap` + `socat` | Included in the official image |
| Native Windows | No `bwrap` sandbox | Automatically falls back to a Bash command allowlist; WSL2 / Docker Desktop recommended |

The official Compose configuration gives the Agent Bash sandbox:

- `seccomp:unconfined`
- `apparmor:unconfined`
- `NET_ADMIN`

These settings support `bwrap` isolation and nested network namespaces inside the container, but also give the container more privileges than a typical web application.

Production recommendations:

- Use a dedicated host or, at minimum, a well-isolated runtime environment;
- Do not mount the Docker socket into the container;
- Do not mount any additional, unnecessary host directories;
- Restrict access to administrative pages;
- Keep MatrixSpooll and the base image up to date;
- Give the Agent only the network and file access it needs;
- Treat project input from unknown sources with caution.

Although the Docker image includes `bwrap` and `socat`, user namespace or AppArmor policies on the host may still prevent the sandbox from starting. If startup fails, resolve the `SANDBOX_*` diagnostics shown in the service output. Do not bypass the checks by switching to privileged mode, and do not remove the official Compose sandbox configuration without understanding the consequences.

## 9. Monitoring Recommendations {#monitoring}

At minimum, monitor:

- Whether `/health/ready` is available;
- Whether containers restart frequently;
- Available disk space;
- The growth rate of `projects/`;
- The size of the PostgreSQL data directory;
- Task failure rates;
- Provider rate limits and insufficient quotas;
- The most recent successful backup time.

Media assets usually grow faster than the database. Prioritize capacity alerts for the project directory.

## 10. Common Problems {#troubleshooting}

### Service Fails to Start {#service-wont-start}

```bash
docker compose ps
docker compose logs --tail=300 matrixspooll
```

Check:

- Whether `.env` exists;
- Whether port `1241` is already in use;
- Whether the image was pulled successfully;
- Whether the mounted directories are writable;
- Whether `POSTGRES_PASSWORD` is set for production deployments.

### Health Check Fails {#health-check-fails}

```bash
curl -v http://localhost:1241/health/ready
docker compose logs --tail=300 matrixspooll
```

If the container has just started, check whether database migrations are still running.

### Cannot Log In {#cannot-log-in}

- Check `AUTH_USERNAME`;
- Check `AUTH_PASSWORD` in `.env`;
- If the password was left empty on first startup, check whether it was written back to the file;
- Log in again after changing `AUTH_TOKEN_SECRET`.

### Agent Requests Fail {#agent-request-fails}

- Verify the AI assistant credentials;
- Check the Base URL and model name;
- Check the network and proxy;
- Check whether the provider is rate-limiting requests;
- Use a small amount of content for verification. Do not use a complete novel for a connection test.

### Tasks Remain Queued {#tasks-stuck-in-queue}

- Review the image, video, and audio concurrency settings;
- Check for abnormal tasks that have remained running or canceling for an extended period;
- Check the provider's RPM quota;
- Check whether a preceding task is still incomplete.

### Rapid Disk Growth {#disk-growth}

Focus on:

```bash
du -sh projects logs
find projects -type f -size +500M
```

Do not directly delete files referenced by current projects. Prefer archiving projects, removing unused projects, and retaining only the necessary space for version history.

## 11. Go-Live Checklist {#go-live-checklist}

- [ ] Use PostgreSQL;
- [ ] Pin the release image version;
- [ ] Set a strong `AUTH_PASSWORD`;
- [ ] Set a fixed `AUTH_TOKEN_SECRET`;
- [ ] Configure HTTPS;
- [ ] Do not expose `1241` directly;
- [ ] Verify that SSE works correctly;
- [ ] Back up the database and project directory;
- [ ] Complete a restoration drill;
- [ ] Configure disk space and health-check alerts;
- [ ] Confirm that model API keys do not appear in logs or the repository;
- [ ] Read the license and `NOTICE`.
