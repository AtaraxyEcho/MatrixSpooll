---
id: deployment
title: Deployment and Operations
sidebar_position: 1
---

# Deployment and Operations {#deployment}

This document covers MatrixSpooll's single PostgreSQL runtime, environment variables, data persistence, upgrades, backups, restoration, reverse proxies, and troubleshooting. The support boundary is in `SECURITY.md` in the delivery package; the full trust boundary is in `docs/security/threat-model.md`.

## Choosing a Deployment Mode {#choose-deployment-mode}

| Scenario | Recommended Method | Database | Notes |
|---|---|---|---|
| Local Docker build | `deploy/production/docker-compose.yml` | PostgreSQL | Builds the complete image from the current source |
| Local development | Docker PostgreSQL + source | PostgreSQL | Containerized database with application hot reload; see the [Contributing Guide](../dev/contributing.md) |

Regardless of the method you choose, project images, videos, and other generated assets must be stored persistently.

MatrixSpooll supports administrators, members, and project owner/editor/viewer roles, but remains a single-instance, single-tenant deployment without organization-level tenant isolation.

SQLite is no longer a runtime fallback. Outside isolated tests that explicitly set `TESTING=true`, a missing `DATABASE_URL` prevents startup so local and Docker environments cannot silently use different databases.

## Local Development PostgreSQL {#local-development-postgresql}

In development, Docker runs only PostgreSQL while the backend and frontend continue to run on the host:

```bash
docker compose -f deploy/development/docker-compose.yml up -d
cp .env.example .env
uv run alembic upgrade head
uv run uvicorn server.app:app --reload --reload-dir server --reload-dir lib --port 1241 \
  --loop server.event_loop:subprocess_capable_event_loop_factory
```

The default development connection is
`postgresql+asyncpg://matrixspooll:matrixspooll_dev@localhost:5432/matrixspooll`. Database files are stored in
`deploy/development/pgdata/`. To change the port or password, copy `deploy/development/.env.example` to `.env`
in the same directory and update `DATABASE_URL` in the repository-root `.env` to match.

Inspect or stop the development database with:

```bash
docker compose -f deploy/development/docker-compose.yml exec postgres \
  psql -U matrixspooll -d matrixspooll -c "SELECT current_database(), current_user;"
docker compose -f deploy/development/docker-compose.yml down
```

## 1. Deployment: PostgreSQL {#postgresql-deployment}

### 1.1 Start {#postgresql-start}

```bash
# This guide assumes the delivered source package is in /srv/matrixspooll.
cd /srv/matrixspooll/deploy/production
cp .env.example .env
```

Edit `.env`:

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD=set a strong password
AUTH_TOKEN_SECRET=set a long-lived random secret
POSTGRES_PASSWORD=set a database password
PUBLIC_HOST=video.example.com
PUBLIC_ORIGIN=https://video.example.com
CERTBOT_EMAIL=admin@example.com
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

Build locally with the Dockerfile included in the delivery package and start the service:

```bash
docker compose -f docker-compose.yml up -d --build
```

Verify it:

```bash
docker compose ps
docker compose logs --tail=100 postgres
docker compose logs --tail=100 matrixspooll
curl -fsS https://<PUBLIC_HOST>/health/live
```

### 1.2 Migrate an Existing PostgreSQL Identity {#rename-postgresql-identity}

This section applies only to an existing PostgreSQL data volume whose role or database is not yet named
`matrixspooll`. `POSTGRES_USER` and `POSTGRES_DB` are used only when PostgreSQL initializes an empty data directory;
changing Compose does not rename existing data. Read the actual names from the old deployment's `.env` or Compose
file and set them explicitly in the current shell:

```bash
old_pg_role="<old-role-name>"
old_pg_database="<old-database-name>"
test "$old_pg_role" != "matrixspooll"
test "$old_pg_database" != "matrixspooll"
case "$old_pg_role:$old_pg_database" in
  (*[!A-Za-z0-9_:]*) echo "Old names may contain only letters, digits, and underscores" >&2; exit 1 ;;
esac
```

Stop the application and create a database backup:

```bash
cd /srv/matrixspooll/deploy/production

docker compose stop matrixspooll || true
docker compose up -d --no-deps postgres
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U "$old_pg_role" -d "$old_pg_database" > backups/matrixspooll-before-identity-rename.sql
```

The container may report `unhealthy` until the rename is complete because the updated health check queries
`matrixspooll`, but `docker compose exec` remains available. Use the old superuser to terminate old database
connections and perform the rename:

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$old_pg_role" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$old_pg_database' AND pid <> pg_backend_pid()"

docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$old_pg_role" -d postgres \
  -c "ALTER DATABASE \"$old_pg_database\" RENAME TO matrixspooll"

docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$old_pg_role" -d postgres \
  -c "ALTER ROLE \"$old_pg_role\" RENAME TO matrixspooll"

docker compose up -d
curl -fsS https://<PUBLIC_HOST>/health/live
```

Renaming a role preserves its internal OID, so ownership of existing tables, sequences, and other objects remains
intact. If a command is interrupted, inspect `pg_roles` and `pg_database`, then resume at the first incomplete step.

### 1.2 PostgreSQL Persistent Directories {#postgresql-volumes}

| Host Path | Contents |
|---|---|
| `deploy/production/pgdata/` | PostgreSQL data directory |
| `deploy/production/projects/` | Projects and media assets |
| `deploy/production/logs/` | Application logs |
| `deploy/production/vertex_keys/` | Vertex AI credentials |
| `deploy/production/claude_data/` | Agent runtime data |
| `deploy/production/.env` | Authentication and database configuration |

`pgdata/` stores only the PostgreSQL cluster, while `projects/` stores project metadata and media assets. Both directories must be persisted and backed up together. The production deployment uses PostgreSQL through `DATABASE_URL` and does not use `deploy/production/projects/.matrixspooll.db`. Do not copy SQLite files into `pgdata/`, and do not treat these two directories as interchangeable database backups.

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
| `MATRIXSPOOLL_DATA_DIR` | `projects` | Use this to customize the application's root data directory |

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

The application container readiness check uses:

```text
GET /health/ready
```

From the host or external monitoring, check the Nginx public entry point:

```bash
curl -fsS https://<PUBLIC_HOST>/health/live
```

To distinguish gateway and application failures, check application readiness inside the container network:

```bash
docker compose exec matrixspooll curl -f http://localhost:1241/health/ready
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

Before sharing complete logs with delivery support or the customer internal operations team, remove:

- API keys;
- Tokens;
- Credentials embedded in Base URLs;
- User input;
- Private information in local file paths.

## 5. Upgrades {#upgrade}

### 5.1 Before Upgrading {#before-upgrade}

1. Read `CHANGELOG.md` in the delivery package and the upgrade notes;
2. Check for breaking changes;
3. Back up the database and project directory;
4. Record the current delivery version identifier;
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
curl -fsS https://<PUBLIC_HOST>/health/live
```

The application runs database migrations when it starts. Do not skip multiple versions and upgrade directly without a backup.

### 5.3 Project Schema Migrations {#project-schema-migrations}

In addition to database migrations, application startup upgrades each project under `projects/`. When upgrading to a version that introduces artifact-state records, MatrixSpooll fully validates the project and its formal scripts, writes the complete artifact records atomically, and updates the schema version in `project.json` only after those steps succeed.

Before committing a migration, MatrixSpooll creates adjacent backups with a `.bak.v7-<timestamp>` suffix for:

- `project.json`;
- Formal script files registered in `project.json`;
- An existing `.matrixspooll_artifacts.json`.

Project migration is safe to retry. If a previous startup was interrupted while creating backups or committing changes, the next startup validates the project again and ensures that at least one backup exactly matches the pre-migration content before continuing. These automatically generated project-level backups exist only for migration recovery; they do not replace deployment-level backups of the database and the entire `projects/` directory.

One class of migration first copies the whole project next to its directory, rewrites the copy, and then swaps the directories. What that means for disk space and recovery:

- Free space is checked before the migration starts. If it cannot hold the copy, that project fails with a "disk space is insufficient" error and its directory is left untouched; free up space and restart to continue.
- If the process is killed during the swap (power loss, `kill -9`, an OOM-killed container), the project directory can be missing for a moment and a hidden directory starting with `.<project-name>.v6-` is left alongside it. The next startup reclaims it and brings the project back, so do not delete these directories by hand, and do not rush to recreate a project that disappeared from the list.
- Once the project is back in place, those hidden directories are cleaned up automatically under the same retention window as the backups above.

If a project migration fails, preserve the files and inspect the startup logs. Do not manually change the schema version or delete backup files. Repair the damaged project references or permissions, then restart the service.

### 5.4 Build Locally {#local-build}

The production Compose file builds the application image from the delivered source root and does not depend on a public image registry. Rebuild the application service after updating the source:

```bash
docker compose build matrixspooll
docker compose up -d
```

## 6. Backup and Restore {#backup-and-restore}

### 6.1 Back Up a PostgreSQL Deployment {#backup-postgresql}

Stop the MatrixSpooll application first, but leave PostgreSQL running, so no new writes occur while you back up the database and project files:

```bash
cd /srv/matrixspooll/deploy/production
umask 077
mkdir -p backups
chmod 700 backups
docker compose stop matrixspooll

backup_stamp="$(date +%Y%m%d-%H%M%S)"

docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -h 127.0.0.1 -U matrixspooll -d matrixspooll' \
  > "backups/matrixspooll-db-${backup_stamp}.sql"

tar -czf "backups/matrixspooll-files-${backup_stamp}.tar.gz" \
  .env docker-compose.yml projects vertex_keys claude_data

docker compose start matrixspooll
```

The database and file backups use the same timestamp and must be stored and restored together. The file backup includes the active `docker-compose.yml`, so any `DATABASE_URL` customization required by a special-character password is restored together with `.env`. `umask 077` and backup directory mode `0700` ensure that the host-created SQL file and file archive are readable and writable only by the current user.

`pg_dump` reads `PGPASSWORD` through libpq. The command above sets it only for that `pg_dump` process inside the PostgreSQL container, allowing `docker compose exec -T` to run non-interactively without expanding the password into the host command line. For long-running host-side backup automation, use a PostgreSQL password file with `0600` permissions instead. Never put the password in a script or backup filename.

If `tar` reports `Permission denied`, the mounted directory contains files created by the container's root user that the current host user cannot read. Rerun the corresponding `tar` command with `sudo`, then restrict read access to the backup file when finished.

### 6.2 Restore PostgreSQL {#restore-postgresql}

Before restoring, stop MatrixSpooll but leave PostgreSQL running:

```bash
cd /srv/matrixspooll/deploy/production
docker compose stop matrixspooll

backup_stamp=YYYYMMDD-HHMMSS
tar -xzf "backups/matrixspooll-files-${backup_stamp}.tar.gz"
```

The file archive restores `.env`, `docker-compose.yml`, `projects/`, and the runtime directories. The following procedure also deletes the existing data in the target `matrixspooll` database. First verify that the database and file backups with the same `backup_stamp` are complete, and rehearse the restoration procedure in an isolated environment.

Recreate an empty database before importing to avoid conflicts with existing schemas or data:

```bash
docker compose exec -T postgres \
  dropdb -U matrixspooll --maintenance-db=postgres --if-exists --force matrixspooll

docker compose exec -T postgres \
  createdb -U matrixspooll --maintenance-db=postgres -O matrixspooll matrixspooll

cat "backups/matrixspooll-db-${backup_stamp}.sql" | \
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U matrixspooll -d matrixspooll
```

After the database import succeeds, restart the application:

```bash
docker compose start matrixspooll
curl -fsS https://<PUBLIC_HOST>/health/live
```

> The restoration strategy depends on whether you are overwriting an existing database, restoring across versions, and whether the service was still accepting writes when the backup was created. Production environments should regularly perform real restoration drills, not merely verify that backup files exist.

## 7. Nginx, Certbot, and HTTPS {#reverse-proxy-and-https}

Production Compose includes Nginx and Certbot with this topology:

```text
Internet :80/:443 -> nginx -> matrixspooll:1241 -> postgres:5432
```

- Only Nginx ports `80/443` are published on the host.
- Application port `1241` is reachable only on the `edge` network.
- PostgreSQL port `5432` is reachable only on the internal `database` network.
- Nginx disables proxy buffering for Agent and project-event SSE and configures long connections and upload limits.
- Certbot uses an HTTP-01 webroot challenge and reloads Nginx after renewal.

The first certificate issuance requires public reachability on port `80`; `PUBLIC_HOST` must match either the domain DNS record or public IPv4 address. Domains use standard certificates. A public IPv4 uses the configured Let's Encrypt short-lived profile and Certbot renewal. Do not start a standalone Certbot that occupies port `80`, and do not republish application port `1241` to the public Internet.

If an organization already operates a cloud load balancer or central gateway, validate it as an alternate deployment design, especially SSE, upload limits, real client addresses, and the HTTPS origin. Do not create a second route that bypasses the authentication boundary while the built-in Nginx public ports remain active.

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
- Whether ports `80/443` are already in use and public port `80` can complete certificate validation;
- Whether the mounted directories are writable;
- Whether production authentication, PostgreSQL, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, and `CERTBOT_EMAIL` values are complete.

### Health Check Fails {#health-check-fails}

```bash
curl -fsv https://<PUBLIC_HOST>/health/live
docker compose logs --tail=300 matrixspooll
docker compose logs --tail=300 nginx certbot
```

If the container has just started, check whether database migrations are still running.

### Cannot Log In {#cannot-log-in}

- Check `AUTH_USERNAME`;
- Check `AUTH_PASSWORD` in `.env`;
- Production Compose rejects an empty password and does not write one back automatically;
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
