# Sport Castle API

The backend for [Sport Castle](https://github.com/danishsary8/sport-heaven), a football and F1 kit store.
It serves the product catalog today; accounts, orders and admin arrive in the next stages (see the roadmap below).

[![CI](https://github.com/danishsary8/sport-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/danishsary8/sport-backend/actions/workflows/ci.yml)

**Live docs:** _add the deployed `/docs` link here_ · **Store:** [sport-heaven](https://github.com/danishsary8/sport-heaven)

> Portfolio project by Sary Danish. Payments run in demo mode; no real money moves.

## Try it

```bash
curl "http://localhost:8080/v1/products?league=premier-league,la-liga&kit=home&sort=price-asc&limit=3"
```

Response (trimmed to the main fields of each item):

```json
{
  "items": [
    { "slug": "atletico-madrid-2026-27-home-jersey", "name": "Atlético Madrid 2026/27 Home Jersey", "priceCents": 9400, "kitType": "home" },
    { "slug": "chelsea-2026-27-home-authentic-jersey", "name": "Chelsea 2026/27 Home Jersey", "priceCents": 9500, "kitType": "home" },
    { "slug": "manchester-united-2026-27-home-jersey", "name": "Manchester United 2026/27 Home Jersey", "priceCents": 9500, "kitType": "home" }
  ],
  "nextCursor": "WyJwcmljZS1hc2MiLDk1MDAsIm1hbmNoZXN0ZXItdW5pdGVkLTIwMjYtMjctaG9tZS1qZXJzZXkiXQ"
}
```

Open **http://localhost:8080/docs** for the interactive reference: every endpoint, every error, and a "Try it" button.

## Run it locally

### With Docker (recommended)

Needs Docker Desktop. One command starts Postgres, applies migrations, loads the 80-product catalog and starts the API:

```bash
docker compose up --build
```

Then open http://localhost:8080/docs. Stop with `Ctrl+C`; `docker compose down -v` also deletes the database.

### Without Docker (Windows cmd)

Needs Node 22 and a Postgres database (local, or a free Neon database).

```bash
copy .env.example .env
```

Edit `DATABASE_URL` in `.env`, then:

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload on save |
| `npm test` | Integration and unit tests against a real Postgres (`TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/sportcastle_test`) |
| `npm run lint` | ESLint and TypeScript type-check |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / load the catalog (safe to run again) |

## API conventions

- **Versioned paths:** everything under `/v1`; health at `/health` (alive) and `/ready` (database answers within 2 s).
- **Money in integer cents** (`priceCents: 9800` = $98.00), never floats.
- **Errors follow RFC 9457** (`application/problem+json`) with a stable `type` URI, a human `detail`, the `requestId`, and `errors[]` listing each invalid field.
- **Every response has `X-Request-Id`**; send your own to trace a request through the logs.
- **Cursor pagination:** pass `nextCursor` back as `cursor`. Keyset-based, so pages stay correct while data changes.
- **Filters** combine with AND across keys and OR within a key: `league=premier-league,la-liga&kit=home`.
- **Limits:** 100 kB request bodies, per-IP rate limit on `/v1` (`429` with `Retry-After`), CORS only for configured origins.

## How it is built

```
src/
  app.ts              builds the Express app (tests import it directly)
  server.ts           listen + graceful shutdown (finishes requests, closes the pool)
  config.ts           environment validated with Zod; bad config stops the process with a clear message
  lib/                errors (problem+json), logger (pino, secrets redacted), request ids, pagination, OpenAPI
  db/                 Drizzle schema, migrations, idempotent seed
  modules/<area>/     routes → service → repository, plus docs.ts registering the area's OpenAPI paths
test/                 Vitest + Supertest against a real Postgres database
drizzle/              SQL migrations (committed)
```

- **One schema, three jobs:** the same Zod schemas validate requests, type the code and generate the OpenAPI document. A test checks real responses against the published schemas, so the docs can't drift from the API.
- **Rules in the database:** prices must be positive, stock can't go negative, slugs are unique; Postgres enforces it even if code has a bug.
- **Fails clearly:** a lost database returns `503` within ~2 s instead of hanging, and the process stays up.

**Stack:** Node 22, TypeScript, Express, Zod 4, Drizzle ORM, PostgreSQL 17, pino, helmet, Scalar (docs), Vitest, Supertest, Docker, GitHub Actions.

## Roadmap

- [x] **Stage 1: Foundation**: config, logging, errors, health, catalog in Postgres, catalog endpoints, OpenAPI docs, Docker, CI
- [ ] **Stage 2: Sign-in and accounts**: register, login, rotating refresh tokens, password reset, profile, addresses, wishlist
- [ ] **Stage 3: Orders**: server-side pricing, stock reservation, idempotent checkout, order tracking, returns, product questions
- [ ] **Stage 4: Admin and integrations**: order management, stock edits, notifications, payment webhooks (demo mode)
- [ ] **Stage 5: Ship**: live deploy (Neon + Render) and the store switched over to this API

Design: [`docs/superpowers/specs/2026-11-25-sport-castle-api-design.md`](docs/superpowers/specs/2026-11-25-sport-castle-api-design.md)

## Credits

Built by Sary Danish. Product names and images belong to their brands and clubs and are used for a non-commercial demo.
