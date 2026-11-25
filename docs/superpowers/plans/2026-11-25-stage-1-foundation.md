# Sport Castle API · Stage 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `sport-backend` into a standalone, runnable API with config, logging, errors, health/readiness, a Postgres catalog (80 seeded products), catalog endpoints, OpenAPI docs, Docker and CI.

**Architecture:** Express app built by `createApp(deps)` (no `listen`) so tests import it; `server.ts` listens and shuts down gracefully. Code is grouped by area under `src/modules/<area>/` (routes → service → repository), shared pieces in `src/lib/`. Drizzle owns the schema and migrations; integration tests run against a real Postgres database.

**Tech Stack:** Node 22, TypeScript (strict), Express 4, Zod 4, Drizzle ORM + `pg`, pino, helmet, express-rate-limit, `@asteasolutions/zod-to-openapi`, `@scalar/express-api-reference`, Vitest + Supertest, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-25-sport-castle-api-design.md` (sections 7.1, 7.2, 7.3 Health/Docs/Catalog, 7.5 products + stock, 7.7).

## Global Constraints

- Node 22; TypeScript `strict: true`; ESM (`"type": "module"`).
- All versioned routes under **`/v1`**; health at `/health`, `/ready`; docs at `/docs`, spec at `/openapi.json`.
- Money is **integer cents** everywhere in the API and database (`priceCents`, `originalPriceCents`).
- Errors are **RFC 9457** `application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, `requestId`, and `errors[]` (`{ path, message }`) for validation.
- Every response has **`X-Request-Id`** (accept incoming if it matches `^[A-Za-z0-9-]{8,64}$`, else generate UUID).
- JSON body limit **100 kB** → `413` problem.
- Config is validated with Zod at boot; the process exits with a readable message on bad config. No secret has a working default in production.
- Logs: pino JSON with `requestId`, `method`, `path`, `status`, `durationMs`; redact `authorization`, `cookie`, `password*`, `*token*`.
- Seeding is idempotent (upsert by `slug`).
- Legacy code (current root `app.ts`, `routes/`, `repositories/`, …) moves to `legacy/` untouched, excluded from `tsconfig` and lint; later stages port from it.

## Review Focus

1. Junk query params on `GET /v1/products` (`limit=0`, `limit=1000`, `cursor=%%%`, `sort=cheapest`) → `400` problem with `errors[]`, never `500`. Test in Task 5.
2. Filters that match nothing (`league=atlantis`) → `200` with `items: []`, `nextCursor: null`. Test in Task 5.
3. Odd slugs on `GET /v1/products/{slug}` (very long, `..%2F`, uppercase) → `404` problem, never `500`. Test in Task 5.
4. Body over 100 kB on any route → `413` problem JSON, not Express's HTML page. Test in Task 2.
5. Database unreachable while running → `/ready` `503` and catalog `503` problem within ~3 s (pool `connectionTimeoutMillis: 2000`), process stays up. Test in Task 3 (ready) and Task 5 (catalog).

---

## File Structure

```
package.json · tsconfig.json · vitest.config.ts · eslint.config.js · .env.example
drizzle.config.ts · Dockerfile · docker-compose.yml · .dockerignore · .github/workflows/ci.yml
legacy/                       old code, moved as-is (excluded from build)
src/
  app.ts                      createApp(deps) → Express app
  server.ts                   listen + graceful shutdown
  config.ts                   loadConfig(env) → Config
  lib/errors.ts               ApiError, problem(), errorHandler, notFoundHandler
  lib/logger.ts               createLogger(config), httpLogger
  lib/request-id.ts           requestId middleware
  lib/openapi.ts              registry + buildOpenApiDocument()
  lib/pagination.ts           encodeCursor / decodeCursor
  db/schema.ts                products, product_stock
  db/client.ts                createDb(url) → { db, pool }
  db/migrate.ts               runs Drizzle migrations (CLI)
  db/seed.ts                  seedCatalog(db, items) + CLI
  db/seed/catalog.json        exported from sport-heaven
  modules/health/routes.ts
  modules/catalog/{schemas,repository,service,routes}.ts
drizzle/                      generated SQL migrations
test/
  setup/global-setup.ts       creates sportcastle_test DB, runs migrations
  setup/test-app.ts           buildTestApp(), resetDb(), seedFixture()
  *.test.ts
```

---

### Task 1: Standalone project scaffold

**Files:**
- Move: `app.ts components/ health/ lib/ middleware/ notifications/ payments/ repositories/ routes/ validators/` → `legacy/` (with `git mv`)
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.nvmrc` (`22`), `test/smoke.test.ts`

**Interfaces:**
- Produces: scripts `dev` (`tsx watch src/server.ts`), `build` (`tsc -p tsconfig.build.json`), `start` (`node dist/server.js`), `lint` (`eslint . && tsc --noEmit`), `test` (`vitest run`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`tsx src/db/migrate.ts`), `db:seed` (`tsx src/db/seed.ts`).

- [ ] **Step 1:** `git mv` the legacy folders/files into `legacy/`; add `legacy/README.md` ("Pre-stage-1 code, kept for porting; not built.").
- [ ] **Step 2:** Create `package.json` (name `sport-castle-api`, version `0.1.0`, `"type": "module"`, `"engines": { "node": ">=22" }`) and install runtime deps: `express@4 zod@4 drizzle-orm pg pino pino-http helmet express-rate-limit @asteasolutions/zod-to-openapi @scalar/express-api-reference dotenv`; dev deps: `typescript tsx vitest supertest @types/express @types/pg @types/supertest @types/node drizzle-kit eslint typescript-eslint @eslint/js`.
- [ ] **Step 3:** `tsconfig.json` (target ES2023, module/moduleResolution `NodeNext`, strict, `noUncheckedIndexedAccess`, include `src test`, exclude `legacy dist`); `tsconfig.build.json` extends it with include `src` only and `outDir dist`.
- [ ] **Step 4:** Write `test/smoke.test.ts`: `expect(1 + 1).toBe(2)`.
- [ ] **Step 5:** Run `npm run lint && npm test`. Expected: no errors, 1 test passed.
- [ ] **Step 6:** Commit `chore: standalone project scaffold, legacy code moved to legacy/`.

### Task 2: Config, logging, request IDs, errors, health

**Files:**
- Create: `src/config.ts`, `src/lib/logger.ts`, `src/lib/request-id.ts`, `src/lib/errors.ts`, `src/modules/health/routes.ts`, `src/app.ts`, `src/server.ts`, `.env.example`
- Test: `test/config.test.ts`, `test/app.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config` where `Config = { nodeEnv: 'development'|'test'|'production'; port: number; databaseUrl: string; corsOrigins: string[]; logLevel: string; rateLimitPerMinute: number; publicBaseUrl: string }` (defaults: port 8080, logLevel `info`, rateLimitPerMinute 300; `databaseUrl` required; in production `publicBaseUrl` required). Throws `ConfigError` listing every invalid key.
  - `class ApiError extends Error { status; title; detail?; errors?: {path: string; message: string}[]; type }` with helpers `ApiError.badRequest(detail, errors?)`, `.notFound(detail)`, `.conflict(detail)`, `.serviceUnavailable(detail)`.
  - `errorHandler` (maps `ApiError`, `ZodError` → 400 with `errors[]`, body-parser `entity.too.large` → 413, `entity.parse.failed` → 400, anything else → 500 with generic detail and the error logged) and `notFoundHandler` (404).
  - `createApp(deps: AppDeps): Express` where `AppDeps = { config: Config; logger: Logger; db?: Db; checkDb?: () => Promise<void> }` (extended by later tasks).
  - Problem `type` URIs: `https://api.sportcastle.dev/problems/<slug>` (`validation-error`, `not-found`, `conflict`, `payload-too-large`, `rate-limited`, `service-unavailable`, `internal-error`).

- [ ] **Step 1: Write failing tests**

```ts
// test/config.test.ts
it('rejects a missing DATABASE_URL with a readable message', () => {
  expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
});
it('requires PUBLIC_BASE_URL in production', () => {
  expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).toThrow(/PUBLIC_BASE_URL/);
});
it('parses CORS_ORIGINS as a list', () => {
  expect(loadConfig({ DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'http://a.test, http://b.test' }).corsOrigins)
    .toEqual(['http://a.test', 'http://b.test']);
});

// test/app.test.ts (app built with a silent logger, no db)
it('GET /health → 200 {status:"ok"} with X-Request-Id', ...);           // header matches /^[0-9a-f-]{36}$/
it('echoes a valid incoming X-Request-Id', ...);                         // send 'abc12345-req' → same back
it('unknown route → 404 problem+json', ...);                             // content-type /application\/problem\+json/, body.status 404, body.requestId set
it('malformed JSON → 400 problem', ...);                                 // POST /health with '{bad' and json content-type
it('body over 100 kB → 413 problem', ...);                               // 101 * 1024 chars
it('sets security headers', ...);                                        // x-content-type-options: nosniff
```

- [ ] **Step 2:** Run `npx vitest run test/config.test.ts test/app.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the files above. `server.ts`: `loadConfig(process.env)` (print `ConfigError` message and `process.exit(1)`), create db, `createApp`, `listen`; on `SIGTERM`/`SIGINT` call `server.close()`, then `pool.end()`, force-exit after 10 s.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: config, structured logging, request ids, problem+json errors, health`.

### Task 3: Database schema, migrations, readiness

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `drizzle/*` (generated), `test/setup/global-setup.ts`, `test/setup/test-app.ts`
- Modify: `src/app.ts` (mount `/ready`), `vitest.config.ts` (globalSetup, `fileParallelism: false`)
- Test: `test/ready.test.ts`

**Interfaces:**
- Produces:
  - Tables: `products` (`id uuid pk default gen_random_uuid()`, `slug text unique not null`, `name`, `short_name`, `brand`, `brand_slug`, `category` (enum `jerseys|boots|f1|balls|essentials`), `league`, `league_slug`, `team`, `team_slug`, `team_type` (`club|national` null), `season`, `season_slug` (`retro` for retro), `kit_type` (enum `home|away|third|goalkeeper|special` null), `versions text[]`, `fits text[]`, `sleeves text[]`, `price_cents int not null check > 0`, `original_price_cents int null check > price_cents`, `customizable bool`, `rating numeric(2,1)`, `review_count int`, `featured_rank int`, `released_at date`, `summary text`, `highlights text[]`, `specs jsonb`, `facts jsonb`, `media jsonb not null` (`{front, back?, gallery?, details?}`), `is_active bool default true`, `created_at`, `updated_at`); indexes on `(category, featured_rank)`, `league_slug`, `team_slug`, `brand_slug`, `price_cents`.
  - `product_stock` (`product_id uuid fk → products on delete cascade`, `branch` enum `sonthormuk|sensok|chomkadong`, `size text`, `quantity int not null check >= 0`, pk `(product_id, branch, size)`).
  - `createDb(url: string): { db: Db; pool: pg.Pool }` (pool `max: 10`, `connectionTimeoutMillis: 2000`, `idleTimeoutMillis: 30000`).
  - `buildTestApp(overrides?: Partial<AppDeps>): { app; db; pool }`, `resetDb(db): Promise<void>` (truncate all tables), test DB URL from `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/sportcastle_test`).

- [ ] **Step 1: Write failing tests**

```ts
// test/ready.test.ts
it('GET /ready → 200 {status:"ready"} when the database answers', ...);
it('GET /ready → 503 problem when the database check fails', ...);   // buildTestApp({ checkDb: async () => { throw new Error('down') } })
it('migrations created products and product_stock', ...);           // select to_regclass('public.products') is not null
it('rejects negative stock at the database level', ...);            // insert quantity -1 → rejects with /check/
```

- [ ] **Step 2:** Run `npx vitest run test/ready.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the schema, `npm run db:generate` (commit SQL in `drizzle/`), `migrate.ts` (uses `drizzle-orm/node-postgres/migrator`), global setup (create `sportcastle_test` if missing via the `postgres` DB, run migrations), `/ready` (runs `select 1` with 2 s timeout).
- [ ] **Step 4:** Run with Postgres up (`docker compose up -d db` once Task 8 exists; until then `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine`). Expected: PASS.
- [ ] **Step 5:** Commit `feat: products and stock schema, migrations, readiness check`.

### Task 4: Catalog export and idempotent seed

**Files:**
- Create in **sport-heaven** (branch `claude/cool-bardeen-bwpt70`): `scripts/export-catalog.ts`, `package.json` script `export:catalog`
- Create here: `src/db/seed/catalog.json`, `src/db/seed.ts`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes (sport-heaven): `PRODUCTS` (enriched) and `MOCK_STORE_CATALOG[i].variants[0].sizes[].byBranch` for per-size stock.
- Produces: `CatalogSeedItem` (Zod-validated): `{ slug, name, shortName, brand, category, league?, team?, teamType?, season?, isRetro, kitType?, versions, fits, sleeves, price (USD number), originalPrice?, customizable, rating, reviewCount, isFeatured, isNewArrival, summary, highlights, specs, facts?, media, stock: { branch, size, quantity }[] }`; `seedCatalog(db: Db, items: CatalogSeedItem[]): Promise<{ products: number; stockRows: number }>`.
- Mapping rules: cents = `Math.round(price * 100)`; slugs via the store's `slugify` rule (lowercase, accents stripped, non-alphanumerics → `-`); `season_slug = 'retro'` when `isRetro`; `kit_type` lowercased; `featured_rank` = index in a stable ordering (featured first, then best sellers, then catalog order); `released_at` = `2026-08-01` for new arrivals, `2026-06-01` otherwise (retro `2025-01-01`).

- [ ] **Step 1:** In sport-heaven, write `scripts/export-catalog.ts` printing JSON to the path given as argv[2]; run `npx tsx scripts/export-catalog.ts ../sport-backend/src/db/seed/catalog.json`. Expected: file with 80 items. Commit there: `chore: export catalog for the API seed`.
- [ ] **Step 2: Write failing tests**

```ts
// test/seed.test.ts
it('seeds all 80 products with stock', ...);                // result.products === 80, stockRows > 0
it('is idempotent: seeding twice keeps 80 products', ...);   // count(*) from products === 80 after two runs
it('stores money in cents', ...);                            // real-madrid-2026-27-home-authentic-jersey → price_cents 9800
it('marks retro kits with season_slug "retro"', ...);        // fc-barcelona-1998-99-centenary-retro-jersey
it('rejects a malformed seed item with the slug in the message', ...); // price: -1 → throws /slug/
```

- [ ] **Step 3:** Run `npx vitest run test/seed.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement `seed.ts` (validate all items first, then one transaction: upsert products `on conflict (slug) do update`, replace stock rows per product). CLI prints counts.
- [ ] **Step 5:** Run tests. Expected: PASS. Commit `feat: idempotent catalog seed from the store's data`.

### Task 5: Catalog endpoints

**Files:**
- Create: `src/modules/catalog/schemas.ts`, `repository.ts`, `service.ts`, `routes.ts`, `src/lib/pagination.ts`
- Modify: `src/app.ts` (mount `/v1/products`)
- Test: `test/catalog.test.ts`, `test/pagination.test.ts`

**Interfaces:**
- Produces:
  - `ProductListQuery` (Zod): `category?`, `league?`, `team?`, `season?`, `kit?`, `brand?` (each a comma list of slugs, max 20 values), `q?` (1–80 chars), `sort` (`featured|newest|price-asc|price-desc|rating`, default `featured`), `limit` (1–60, default 24), `cursor?`.
  - `ProductSummary`: `{ id, slug, name, brand, category, league, team, teamType, season, kitType, priceCents, originalPriceCents, image, imageBack, versions, fits, sleeves, customizable, rating, reviewCount }`; `ProductDetail` = summary + `{ shortName, summary, highlights, specs, facts, media, sizes: { size, quantity, inStock }[] }` (quantity summed over branches).
  - Response `GET /v1/products` → `{ items: ProductSummary[]; nextCursor: string | null }`; `GET /v1/products/{slug}` → `ProductDetail`.
  - `encodeCursor(values: (string|number)[]): string` / `decodeCursor(c: string): (string|number)[]` (base64url JSON; throws `ApiError.badRequest` on garbage). Keyset pagination on (sort column, slug).
- Semantics: OR within a filter, AND across filters (same as the store); `q` matches name, team or brand case-insensitively; inactive products never returned.

- [ ] **Step 1: Write failing tests** (seed with the real `catalog.json` once per file)

```ts
it('lists 24 products by default with a nextCursor', ...);
it('walks all pages with cursors without repeats', ...);          // collect slugs until nextCursor null → 80 unique
it('filters league=premier-league,la-liga&kit=home', ...);         // every item league ∈ {Premier League, La Liga}, kitType 'home'
it('sorts price-asc', ...);                                        // priceCents non-decreasing
it('q=madrid finds Real Madrid kits', ...);
it('unknown filter value → 200 empty list', ...);                  // league=atlantis → items [], nextCursor null
it.each(['limit=0', 'limit=1000', 'cursor=%25%25%25', 'sort=cheapest'])('%s → 400 problem with errors[]', ...);
it('GET /v1/products/real-madrid-2026-27-home-authentic-jersey → detail with sizes and priceCents 9800', ...);
it.each(['x'.repeat(300), '..%2Fetc', 'REAL-MADRID'])('slug %s → 404 problem', ...);
it('catalog → 503 problem when the database is down', ...);       // app with a pool pointing at port 1
```

- [ ] **Step 2:** Run `npx vitest run test/catalog.test.ts test/pagination.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Repository builds the Drizzle query (filters → `inArray`, `q` → `ilike` on three columns, keyset `where (col, slug) > (…)` with direction per sort, `limit + 1` to detect more). Service maps rows to response shapes. Route parses query with Zod. Connection errors (`ECONNREFUSED`, timeout) → `ApiError.serviceUnavailable`.
- [ ] **Step 4:** Run tests. Expected: PASS. Commit `feat: catalog list and detail endpoints with filters and cursor pagination`.

### Task 6: OpenAPI document and interactive docs

**Files:**
- Create: `src/lib/openapi.ts`
- Modify: catalog and health route files (register paths), `src/app.ts` (`/openapi.json`, `/docs`)
- Test: `test/openapi.test.ts`

**Interfaces:**
- Consumes: Zod schemas from Task 5 (extended with `extendZodWithOpenApi`).
- Produces: `buildOpenApiDocument(config: Config): OpenAPIObject` (OpenAPI `3.1.0`, `info.title` "Sport Castle API", `info.version` from package.json, `servers: [{ url: config.publicBaseUrl }]`, `components.securitySchemes.bearerAuth` (http bearer, JWT) for later stages, shared `Problem` schema used for 400/404/413/429/500/503 responses).

- [ ] **Step 1: Write failing tests**

```ts
it('GET /openapi.json is OpenAPI 3.1 with the catalog paths', ...);   // openapi '3.1.0'; paths has '/v1/products' and '/v1/products/{slug}', '/health', '/ready'
it('every operation documents a problem+json error response', ...);   // each op has a 4xx response with content 'application/problem+json'
it('GET /docs serves the interactive reference', ...);                // 200, text/html, body contains 'openapi.json'
it('documented ProductSummary matches a real response', ...);        // ajv-validate first item of GET /v1/products against components.schemas.ProductSummary (add `ajv` dev dep)
```

- [ ] **Step 2:** Run `npx vitest run test/openapi.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the registry and serve Scalar at `/docs` pointing at `/openapi.json`. Helmet CSP must allow Scalar's script on `/docs` only (route-level helmet override).
- [ ] **Step 4:** Run tests. Expected: PASS. Commit `feat: OpenAPI 3.1 spec from Zod schemas and interactive docs at /docs`.

### Task 7: Rate limiting and CORS

**Files:**
- Modify: `src/app.ts`
- Test: `test/security.test.ts`

**Interfaces:**
- Produces: general limiter on `/v1` using `config.rateLimitPerMinute` (per IP, standard `RateLimit` headers), returning a `429` problem (`rate-limited`); CORS for `config.corsOrigins` only (credentials allowed), no CORS headers for other origins; `app.set('trust proxy', 1)`.

- [ ] **Step 1: Write failing tests**

```ts
it('returns 429 problem after the limit', ...);              // buildTestApp with rateLimitPerMinute 3 → 4th GET /v1/products is 429 problem+json
it('allows a configured origin', ...);                         // Origin http://localhost:5173 → access-control-allow-origin echoes it
it('ignores an unknown origin', ...);                          // Origin http://evil.test → no access-control-allow-origin header
it('health is not rate limited', ...);                         // 5 × /health all 200 with limit 3
```

- [ ] **Step 2:** Run `npx vitest run test/security.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (`cors` package added as a dependency).
- [ ] **Step 4:** Run tests. Expected: PASS. Commit `feat: rate limiting and CORS allow-list`.

### Task 8: Docker and local one-command setup

**Files:**
- Create: `Dockerfile` (multi-stage: deps → build → `node:22-alpine` runtime as non-root user, `HEALTHCHECK` on `/health`), `.dockerignore`, `docker-compose.yml` (`db` postgres:17-alpine with volume and healthcheck; `migrate` one-shot running `db:migrate` then `db:seed`; `api` depending on `migrate` completing, port 8080), `.env.example` (every key with a comment, no real secrets).

- [ ] **Step 1:** `docker compose up -d --build`. Expected: `migrate` exits 0; `curl -s localhost:8080/ready` → `{"status":"ready"}`; `curl -s 'localhost:8080/v1/products?limit=1'` → one item.
- [ ] **Step 2:** `docker compose down -v`. Commit `chore: Dockerfile and docker compose for one-command local setup`.

### Task 9: CI and README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- CI on push and pull request: Postgres 17 service container; `npm ci`, `npm run lint`, `npm run build`, `npm test` (with `TEST_DATABASE_URL` pointing at the service), `docker build .`; upload `openapi.json` (generated by `npx tsx scripts/print-openapi.ts > openapi.json`, add that tiny script) as an artifact.
- README sections: what it is (link to the store), live docs link placeholder, quick start (Docker, and Windows cmd commands each in its own block), scripts table, project structure, API conventions (cents, problem+json, request ids, pagination), stage roadmap (1–5 with 1 ticked).

- [ ] **Step 1:** Write both files. Run the CI steps locally in a clean clone (`git clone . /tmp/...` then the same commands). Expected: all pass.
- [ ] **Step 2:** Commit `chore: CI with Postgres and README`; push branch `claude/gallant-bell-u6rj3d`.
