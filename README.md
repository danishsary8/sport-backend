# Sport Castle API (`sport-backend`)

The commerce backend for Sport Castle, a Phnom Penh football / futsal / F1 store: catalog, cart, checkout, KHQR payments, orders and member accounts. The frontend lives in `sport-heaven`.

- Design: `docs/superpowers/specs/2026-11-25-backend-production-design.md`
- Plans: `docs/superpowers/plans/`
- Behaviour research: `sport-heaven/docs/research/zando-behavior-reference.md`

**Status:** phase 1 (foundation) done: config, logging, errors, security baseline, health probes, migrations, CI. Feature modules arrive in phases 2–6; the pre-split code waiting to be ported sits in `legacy/` (not built, not tested).

## Requirements

- Node 22+
- PostgreSQL 16 (local install or `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`)

## Setup

```bash
npm ci
cp .env.example .env            # then edit DATABASE_URL / COOKIE_SECRET
createdb sport_dev              # or: psql -c 'CREATE DATABASE sport_dev;'
npm run build && npm run db:migrate
npm run dev                     # http://localhost:3000/health
```

Tests need a separate database (`sport_test` by default, override with `TEST_DATABASE_URL`):

```bash
createdb sport_test
npm test
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with reload (tsx) |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check source and tests |
| `npm test` / `test:unit` / `test:int` | All tests / pure unit tests / tests against Postgres |
| `npm run db:generate` | Generate a SQL migration from schema changes into `drizzle/` (commit it) |
| `npm run db:migrate` | Apply migrations (run after `build`) |

## Configuration

All environment variables are validated at boot; the server refuses to start and lists every problem if any are wrong. See `.env.example` for the full list. In production, `CORS_ORIGINS` is required and Postgres SSL is on by default.

## HTTP conventions

- API routes live under `/v1`. Probes: `GET /health` (liveness) and `GET /ready` (database reachable → 200, otherwise 503).
- Errors always look like `{"error":{"code":"…","message":"…","details":…}}`. A 500 also carries `requestId`, which matches the `X-Request-Id` response header and the logs.
- Request bodies are limited to 1 MB; unknown JSON fields are stripped by validation.
- `/v1` is rate limited to 120 requests per minute per IP.

## Layout

```
src/
  server.ts            boot + graceful shutdown
  app.ts               express app factory (dependencies injected for tests)
  config/env.ts        environment validation
  lib/                 logger (pino, phone redaction), errors
  middleware/          request id, validation, rate limiting
  db/                  client, schema, migrator
  modules/<feature>/   routers + services + repositories (health today)
drizzle/               committed SQL migrations
test/unit, test/integration
legacy/                pre-split code awaiting port (excluded)
```

## Docker

```bash
docker build -t sport-backend .
docker run --env-file .env sport-backend node dist/db/migrate.js   # migrations
docker run --env-file .env -p 3000:3000 sport-backend
```
