# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sport-backend` installs, typechecks, tests, builds and runs on its own (`npm ci && npm test && npm run build && npm start`), with no imports from the frontend repo, a validated config, structured logging, consistent JSON errors, a security baseline, `/health` + `/ready`, a migration pipeline and CI.

**Architecture:** Express 4 app built by a factory (`createApp(deps)`) so tests inject fakes; `server.ts` only boots. Source in `src/`, compiled to `dist/` by `tsc`. Drizzle + `pg` for the database, with SQL migrations generated into `drizzle/` and committed. The old feature code moves to `legacy/` (excluded from build and tests) and is ported module by module in phases 2–6.

**Tech Stack:** Node 22, TypeScript (NodeNext modules, `.js` import suffixes), Express 4, Zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, `pg`, pino, helmet, cors, Vitest + supertest, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` (§6 Architecture, §16 Security & operations, §18 Testing, §19 phase 1).

## Global Constraints

- Node `>=22`; `"type": "module"`; every relative import ends in `.js`.
- No import may reach outside the repo (no `../../src/...` into sport-heaven).
- Money is integer **cents** in every new table (spec §8). (Phase 1 creates only `settings`.)
- Error body shape is always `{ "error": { "code": string, "message": string, "details"?: unknown, "requestId"?: string } }` (spec §16; `requestId` on 5xx); never a stack trace.
- Every response carries `X-Request-Id`; logs are pino JSON with phone numbers redacted to the last 3 digits.
- Public probes: `GET /health` (liveness, body `{status:"ok"}` only) and `GET /ready` (DB ping → 200 `{status:"ready"}` / 503 `{status:"unavailable"}`), no other details.
- CORS: only origins listed in `CORS_ORIGINS` (comma-separated). `trust proxy` = 1.
- Config is validated at boot; an invalid config exits with code 1 and a message naming each bad variable.
- Commits end with the session's attribution lines.

## Review Focus

1. **Missing/empty env var in production** (e.g. `DATABASE_URL` unset, `COOKIE_SECRET` shorter than 32 chars) → the process refuses to start with a clear message, rather than starting and failing on the first request. Pinned in Task 2.
2. **Database down when the server starts or mid-run** → the server still starts and `/health` stays 200, `/ready` returns 503, and no request hangs longer than the 3s ping timeout. Pinned in Task 5.
3. **Malformed or oversized JSON body** (`{bad`, body > 1 MB) → 400 `invalid_json` / 413 `payload_too_large` in the standard error shape, not an HTML page or 500. Pinned in Task 3.
4. **Browser request from an unlisted origin** → no `Access-Control-Allow-Origin` header; listed origin → header echoes it with credentials allowed (the cart cookie needs it). Pinned in Task 4.
5. **Unknown route under the API** → 404 `not_found` JSON; a thrown non-AppError → 500 `internal_error` with the request id, and the error logged once. Pinned in Task 3.

---

## File structure (end of phase 1)

```
package.json  package-lock.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
drizzle.config.ts  Dockerfile  .dockerignore  .env.example  .gitignore  README.md
.github/workflows/ci.yml
drizzle/0000_*.sql + meta/            # generated
legacy/                               # old code, untouched, excluded (ported in phases 2–6)
src/
  server.ts                           # boot + graceful shutdown
  app.ts                              # createApp(deps)
  config/env.ts                       # loadConfig(env) → Config
  lib/logger.ts                       # createLogger(config) → pino logger
  lib/errors.ts                       # AppError, errorHandler, notFoundHandler
  db/client.ts                        # createDb(url) → { db, pool, ping }
  db/schema/index.ts                  # re-exports tables
  db/schema/settings.ts               # settings table
  middleware/requestId.ts
  middleware/validate.ts              # validate({ body?, query?, params? })
  middleware/rateLimit.ts             # ported from old middleware/rateLimit.ts
  modules/health/router.ts            # /health, /ready
test/
  unit/config.test.ts  unit/errors.test.ts  unit/validate.test.ts  unit/rateLimit.test.ts
  integration/app.test.ts  integration/db.test.ts
  helpers/testConfig.ts
```

---

### Task 1: Standalone project scaffold, legacy quarantine

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `test/unit/smoke.test.ts`
- Move: `app.ts components/ health/ lib/ middleware/ notifications/ payments/ repositories/ routes/ validators/` → `legacy/` (with `git mv`)

**Interfaces:**
- Produces: scripts `dev`, `build`, `start`, `typecheck`, `test`, `test:unit`, `test:int`, `db:generate`, `db:migrate`.

- [ ] **Step 1:** `git mv` all existing source folders and `app.ts` into `legacy/`. Add `legacy/README.md`: "Pre-split code. Not built or tested. Each module is ported in its phase (see the spec §19), then deleted from here."
- [ ] **Step 2:** Create `package.json`: name `sport-backend`, `private: true`, `type: module`, `engines.node: ">=22"`.
  - Dependencies: `express@^4.21`, `zod@^4.6`, `drizzle-orm@^0.45`, `pg@^8`, `pino@^10`, `helmet@^8`, `cors@^2`, `firebase-admin@^14`, `dotenv@^17`.
  - Dev dependencies: `typescript`, `tsx`, `vitest`, `supertest`, `drizzle-kit@^0.31`, `pino-pretty`, and `@types/{express,cors,pg,supertest,node}`.
  - Scripts:
    - `dev`: `tsx watch src/server.ts`
    - `build`: `tsc -p tsconfig.build.json`
    - `start`: `node dist/server.js`
    - `typecheck`: `tsc --noEmit`
    - `test`: `vitest run`
    - `test:unit`: `vitest run test/unit`
    - `test:int`: `vitest run test/integration`
    - `db:generate`: `drizzle-kit generate`
    - `db:migrate`: `node dist/db/migrate.js`
- [ ] **Step 3:** `tsconfig.json`: `target ES2023`, `module/moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `outDir dist`, `rootDir .`, include `src test *.ts`, exclude `legacy dist`. `tsconfig.build.json` extends it with `rootDir src`, include `src` only.
- [ ] **Step 4:** `vitest.config.ts`: environment node, `include: ['test/**/*.test.ts']`, `exclude: ['legacy/**']`, `fileParallelism: false` for `test/integration` (shared DB).
- [ ] **Step 5:** Write `test/unit/smoke.test.ts` asserting `1 + 1 === 2`, then run `npm install`, `npm run typecheck`, `npm test`. Expected: typecheck clean (legacy excluded), 1 test passes.
- [ ] **Step 6:** Commit `chore: standalone project scaffold, move old code to legacy/`.

### Task 2: Validated configuration

**Files:**
- Create: `src/config/env.ts`, `test/unit/config.test.ts`, `test/helpers/testConfig.ts`, `.env.example`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    nodeEnv: 'development' | 'test' | 'production';
    port: number;                       // PORT, default 3000
    databaseUrl: string;                // DATABASE_URL, required
    databaseSsl: boolean;               // DATABASE_SSL, default true in production else false
    corsOrigins: string[];              // CORS_ORIGINS, comma list, ≥1 in production
    cookieSecret: string;               // COOKIE_SECRET, ≥32 chars
    logLevel: 'fatal'|'error'|'warn'|'info'|'debug'|'trace'; // LOG_LEVEL, default info
    firebaseProjectId: string | undefined;        // FIREBASE_PROJECT_ID (required from phase 2)
  }
  export class ConfigError extends Error { readonly issues: string[] }
  export function loadConfig(env: NodeJS.ProcessEnv): Config;   // throws ConfigError
  ```
  `test/helpers/testConfig.ts` exports `testConfig(overrides?: Partial<Config>): Config` (uses `TEST_DATABASE_URL` or `postgres://postgres:postgres@localhost:5432/sport_test`).

- [ ] **Step 1: Write failing tests** in `test/unit/config.test.ts`:
  - `loadConfig({DATABASE_URL:'postgres://x', COOKIE_SECRET:'a'.repeat(32)})` → `port === 3000`, `nodeEnv === 'development'`, `corsOrigins` equals `[]`, `databaseSsl === false`.
  - `CORS_ORIGINS: 'https://a.com, https://b.com '` → `['https://a.com','https://b.com']`.
  - Missing `DATABASE_URL` → throws `ConfigError` whose `issues` contains a string including `DATABASE_URL`.
  - `COOKIE_SECRET: 'short'` → `issues` includes `COOKIE_SECRET`.
  - `NODE_ENV:'production'` with no `CORS_ORIGINS` → `issues` includes `CORS_ORIGINS`; with origins → `databaseSsl === true`.
  - `PORT:'abc'` → `issues` includes `PORT`.
  - Several bad vars at once → all reported in one error (≥2 issues).
- [ ] **Step 2:** Run `npm run test:unit -- config` → FAIL (module missing).
- [ ] **Step 3:** Implement with a Zod schema over `env`, mapping each issue to `"<VAR>: <message>"`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `.env.example` lists every variable above with comments, plus a `# Phase 2+` block (FIREBASE_*, PAYWAY_*, TELEGRAM_*, RESEND_*, BOOTSTRAP_ADMIN_*) left empty. Commit `feat: validated configuration`.

### Task 3: Logger, errors, request id, validation middleware

**Files:**
- Create: `src/lib/logger.ts`, `src/lib/errors.ts`, `src/middleware/requestId.ts`, `src/middleware/validate.ts`, `test/unit/errors.test.ts`, `test/unit/validate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/logger.ts
  export type Logger = import('pino').Logger;
  export function createLogger(cfg: Pick<Config,'logLevel'|'nodeEnv'>): Logger;
  export function redactPhone(value: string): string;        // '+85512345678' → '***678'
  // lib/errors.ts
  export class AppError extends Error {
    constructor(public code: string, public status: number, message: string, public details?: unknown);
  }
  export const notFoundHandler: RequestHandler;              // → 404 {error:{code:'not_found'}}
  export function errorHandler(logger: Logger): ErrorRequestHandler;
  // middleware/requestId.ts
  export const requestId: RequestHandler;  // reuses inbound X-Request-Id if /^[\w-]{8,64}$/, else crypto.randomUUID(); sets res header + req.id
  // middleware/validate.ts
  export function validate<B,Q,P>(s: { body?: ZodType<B>; query?: ZodType<Q>; params?: ZodType<P> }): RequestHandler;
  // on failure → AppError('validation_failed', 400, 'Validation failed', [{path, message}]); parsed values replace req.body/query/params
  ```
  `Request` is augmented with `id: string` in `src/types/express.d.ts`.

- [ ] **Step 1: Write failing tests.**
  - `errors.test.ts`, using a tiny express app + supertest:
    - A route throwing `new AppError('out_of_stock', 409, 'Only 1 left')` → status 409, body `{error:{code:'out_of_stock',message:'Only 1 left'}}`.
    - A route throwing `new Error('boom')` → 500, body `{error:{code:'internal_error', message:'Internal server error', requestId: <the X-Request-Id header>}}`, and the body does not contain `boom`.
    - A POST with `{bad` and `content-type: application/json` → 400 `invalid_json`.
    - A body of 1.1 MB → 413 `payload_too_large`.
    - An unknown path → 404 `not_found`.
    - Every response has `x-request-id`; an inbound `X-Request-Id: abcdefgh-1234` is echoed back.
    - `redactPhone('+85512345678') === '***678'`.
  - `validate.test.ts`:
    - With `body: z.object({qty: z.number().int().min(1)})`, `{qty:0}` → 400 `validation_failed` with `details[0].path === 'qty'`.
    - Unknown keys are stripped from `req.body`.
    - Query coercion with `z.coerce.number()` works.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
  - `errorHandler` maps body-parser errors (`type === 'entity.parse.failed'` → `invalid_json`, `entity.too.large` → `payload_too_large`).
  - It logs 5xx at `error` level with `req.id` and 4xx at `debug`.
  - Pino `redact` paths: `req.headers.authorization`, `req.headers.cookie`, `*.phone`, `*.phoneE164`, `*.contact_phone_e164`, with a censor function using `redactPhone`.
- [ ] **Step 4:** Run → PASS. Commit `feat: logging, error model, request id, validation`.

### Task 4: App factory with security baseline and ported rate limiter

**Files:**
- Create: `src/app.ts`, `src/middleware/rateLimit.ts` (port of `legacy/middleware/rateLimit.ts`, unchanged logic), `test/unit/rateLimit.test.ts`, `test/integration/app.test.ts`

**Interfaces:**
- Consumes: `Config`, `Logger`, `requestId`, `errorHandler`, `notFoundHandler`.
- Produces:
  ```ts
  export interface AppDeps {
    config: Config;
    logger: Logger;
    db: { ping(): Promise<void> };          // from Task 5; tests pass a fake
    rateLimit?: { enabled: boolean };        // default true
  }
  export function createApp(deps: AppDeps): express.Express;
  ```
  Order: `disable('x-powered-by')` → `trust proxy 1` → requestId → pino-http (request logging) → helmet() → cors (allowlist, `credentials: true`) → `express.json({limit:'1mb', verify: keep rawBody as Buffer})` → rate limit (`/v1` general 120/min) → health router at `/` → `/v1` router (empty in phase 1) → notFound → errorHandler.
  `rateLimit.ts` keeps the exports `createRateLimitMiddleware`, `InMemoryRateLimitStore` and `DEFAULT_*`. The 429 body changes to the standard error shape, code `rate_limited`, with `details: {retryAfterSeconds}`.

- [ ] **Step 1: Write failing tests.**
  - `rateLimit.test.ts`: port the relevant legacy assertions from `sport-heaven/src/utils/commerce.test.ts` (fixed window, `Retry-After`, eviction at `maxEntries`) using an injected `nowMs`. Add: the 429 body is `{error:{code:'rate_limited', ...}}`.
  - `app.test.ts`, with a fake db:
    - `GET /v1/nope` → 404 `not_found`.
    - Helmet header `x-content-type-options: nosniff` is present and `x-powered-by` is absent.
    - `Origin: https://shop.example` (listed) → `access-control-allow-origin: https://shop.example` and `access-control-allow-credentials: true`.
    - `Origin: https://evil.example` → no `access-control-allow-origin`.
    - With `rateLimit.generalMax: 3`, 4 requests to `/v1/nope` within one window → the 4th is 429 `rate_limited`; `/health` is not rate limited.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. AppDeps gets an optional `rateLimit.generalMax` (default 120) so the test can lower it.
- [ ] **Step 4:** Run → PASS. Commit `feat: app factory with helmet, cors allowlist, rate limiting`.

### Task 5: Database client, settings table, migrations, health/ready

**Files:**
- Create: `src/db/client.ts`, `src/db/schema/settings.ts`, `src/db/schema/index.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `src/modules/health/router.ts`, `drizzle/` (generated), `test/integration/db.test.ts`; extend `test/integration/app.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // db/client.ts
  export interface Database { db: NodePgDatabase<typeof schema>; pool: pg.Pool; ping(): Promise<void>; close(): Promise<void>; }
  export function createDb(cfg: Pick<Config,'databaseUrl'|'databaseSsl'>): Database;
  // pool max 10, connectionTimeoutMillis 3000, idleTimeoutMillis 30000; ping = 'select 1' with a 3000 ms timeout; pool 'error' events logged, never crash
  // db/schema/settings.ts
  export const settings = pgTable('settings', { key: text('key').primaryKey(), value: jsonb('value').notNull(), updatedAt: timestamp('updated_at',{withTimezone:true}).defaultNow().notNull() });
  // db/migrate.ts — runs drizzle-orm/node-postgres/migrator against ./drizzle, exits 0/1
  // modules/health/router.ts
  export function healthRouter(db: { ping(): Promise<void> }): Router;
  ```
- [ ] **Step 1: Write failing tests.**
  - `app.test.ts` (fake db):
    - `GET /health` → 200 `{status:'ok'}`.
    - `GET /ready` with `ping` resolving → 200 `{status:'ready'}`.
    - With `ping` rejecting → 503 `{status:'unavailable'}`.
    - With `ping` never resolving → the response arrives within 3.5 s with 503 (the router races the ping against a 3 s timeout).
    - Health responses have `cache-control: no-store`.
  - `db.test.ts` (real Postgres via `testConfig().databaseUrl`; `beforeAll` runs the migrator):
    - `ping()` resolves.
    - Insert then select a `settings` row round-trips `{ khr_rate: 4100 }` as jsonb.
    - `createDb` with a wrong port → `ping()` rejects within 3.5 s.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `drizzle.config.ts` reads `DATABASE_URL`, has schema `./src/db/schema/index.ts` and out `./drizzle`. Run `npm run db:generate` to produce `drizzle/0000_*.sql` (`CREATE TABLE settings`).
- [ ] **Step 4:** Start local Postgres, create `sport_test`, run `npm run test:int` → PASS. Commit `feat: postgres client, settings table, migrations, health and readiness probes`.

### Task 6: Server boot and graceful shutdown

**Files:**
- Create: `src/server.ts`, `test/integration/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `createLogger`, `createDb`, `createApp`.
- Produces: `export async function start(env = process.env): Promise<{ url: string; stop(): Promise<void> }>`. When run as the main module: `import 'dotenv/config'`, call `start()`, and on `SIGTERM`/`SIGINT` call `stop()` (stop accepting connections, wait up to 10 s for in-flight requests, `db.close()`, exit 0). A `ConfigError` → log the issues and exit 1.

- [ ] **Step 1: Write failing test** `server.test.ts`:
  - `start({...env, PORT:'0'})` returns a url; `fetch(url + '/health')` → 200; after `stop()`, fetch rejects.
  - `start({})` (no `DATABASE_URL`) rejects with `ConfigError`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (listen on `0.0.0.0`; `PORT=0` gets an ephemeral port read from `server.address()`).
- [ ] **Step 4:** Run → PASS. Also `npm run build && DATABASE_URL=… COOKIE_SECRET=… node dist/server.js` and `curl localhost:3000/ready` → `{"status":"ready"}`. Commit `feat: server boot and graceful shutdown`.

### Task 7: Docker, CI, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `README.md`

- [ ] **Step 1:** `Dockerfile`, multi-stage:
  - Build stage: `node:22-slim`, `npm ci`, `npm run build`.
  - Runtime stage: `node:22-slim`, `npm ci --omit=dev`, copy `dist` and `drizzle`, `USER node`, `EXPOSE 3000`, `CMD ["node","dist/server.js"]`.
  - `.dockerignore`: `node_modules dist legacy .git test docs`.
- [ ] **Step 2:** `ci.yml` on push and pull_request:
  - Job with a `postgres:16` service (`POSTGRES_PASSWORD=postgres`, db `sport_test`, health check).
  - Steps: checkout, setup-node 22 with npm cache, `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`, `DATABASE_URL=… npm run db:migrate`, `npm run test:int` with `TEST_DATABASE_URL`, `docker build .`.
- [ ] **Step 3:** `README.md`: what this is, prerequisites, setup (`cp .env.example .env`, create the db, `npm run build && npm run db:migrate`, `npm run dev`), the scripts table, the project layout, and that `legacy/` is pending port.
- [ ] **Step 4: Verify.** `npm ci && npm run typecheck && npm test && npm run build` all pass locally. `docker build .` succeeds if the Docker daemon is available here; if not, note it and rely on CI. Commit `chore: dockerfile, CI workflow, README`.

---

## Roadmap — later phases (each gets its own plan before it starts)

| Phase | Plan file (to write) | Delivers | Ports from `legacy/` |
|---|---|---|---|
| 2 Auth & accounts | `phase-2-auth-accounts.md` | Firebase verify middleware, `POST /v1/auth/session`, users/roles/staff branch, geo tables + seed, addresses, wishlist, profile, account deletion | `middleware/auth.ts`, `lib/firebaseAdmin.ts`, account parts of `repositories/storeRepository.ts` |
| 3 Catalog | `phase-3-catalog.md` | Catalog tables, `catalog:import`, listing/filters/detail/search, home sections, admin product + stock + counter-sale APIs, safety buffer | `routes/adminRouter.ts` (inventory), catalog data from sport-heaven |
| 4 Cart & pricing | `phase-4-cart-pricing.md` | Pricing module (team discount, member perks, promo better-wins, shipping, KHR), carts + guest cookie + merge, promotions, shipping rates | pricing rules from `sport-heaven/src/utils/commerce.ts` |
| 5 Checkout & payments | `phase-5-checkout-payments.md` | Quote, order placement with reservation and multi-branch allocation, PayWay provider (sandbox), payment attempts, webhook + poll + sweeper, notifications outbox | `payments/*`, `notifications/*`, webhook parts of `adminRepository.ts` |
| 6 Post-purchase | `phase-6-post-purchase.md` | Tracking, status machine + admin orders, RMA (30-day exchange / 14-day refund), Q&A, loyalty ledger and tiers, admin system-health | `health/*`, RMA/questions parts of `storeRepository.ts`; `components/SystemHealthDashboard.tsx` handed to the frontend repo |
| 7 Hardening | `phase-7-hardening.md` | Stricter per-route rate limits, load test of the order path, PayWay sandbox checklist, delete `legacy/` | — |
