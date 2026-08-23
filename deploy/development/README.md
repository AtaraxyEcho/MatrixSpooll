# Local PostgreSQL

This Compose project runs only PostgreSQL for local MatrixSpooll development.
Run the backend and frontend on the host to keep hot reload available.

From the repository root:

```bash
docker compose -f deploy/development/docker-compose.yml up -d
cp .env.example .env
uv run alembic upgrade head
```

The default application connection is:

```text
postgresql+asyncpg://matrixspooll:matrixspooll_dev@localhost:5432/matrixspooll
```

Copy `deploy/development/.env.example` to `deploy/development/.env` to change
the development password or host port. Keep the repository-root
`DATABASE_URL` in sync with those values.

Stop the database without deleting its data:

```bash
docker compose -f deploy/development/docker-compose.yml down
```

The local database is stored in `deploy/development/pgdata/` and is ignored by Git.
