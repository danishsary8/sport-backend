# Phase 7 — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API safe to put in front of real shoppers. Close every deferred minor from phases 1–6 (or rule it out in writing). Add per-route rate limits, a lint gate, a load-tested order path, a machine-readable API contract for the frontend, a test-only sign-in for end-to-end tests, and the deployment and PayWay sandbox runbooks.

**Architecture:** Mostly local fixes in existing modules. New pieces:
- `src/middleware/rateLimitStore.ts`: a store interface plus the in-memory store;
- `src/lib/testIdentity.ts`: the `AUTH_TEST_MODE` identity provider;
- `src/contracts/*`: Zod request/response schemas, shared by the routers and the OpenAPI generator;
- `scripts/openapi.ts` → `docs/api/openapi.json`;
- `scripts/loadtest.ts` (autocannon);
- `eslint.config.js`.

**Tech Stack:** as before. New dev dependencies: `eslint`, `typescript-eslint`, `autocannon` (+ types). OpenAPI uses Zod 4's built-in `z.toJSONSchema()` (no new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` §16 (security & operations), §18 (testing, CI lint), §19 phase 7; work order Stage 3 (and its list of deferred minors); `docs/superpowers/STATUS.md` "Deferred minors".

## Global Constraints

- Every fix is test-first (RED → GREEN), and the suite runs twice per task.
- A minor that is deliberately not fixed gets a ledger `Ruling:` with the reason. Nothing is silently skipped.
- Rate limits (per minute, fixed window):
  - general `/v1` 120/IP;
  - `POST /v1/orders` 10/IP **and** 5/user (members, keyed by user id);
  - `POST /v1/orders/track` 10/IP;
  - `POST /v1/catalog/products/:slug/questions` 5/IP;
  - `POST /v1/auth/session` 20/IP;
  - webhooks exempt.
  
  A 429 carries `Retry-After` and code `rate_limited`.
- `AUTH_TEST_MODE=true` is honoured only when `NODE_ENV !== 'production'`. In production, config validation **fails to start** if it is set to true. Test tokens are `test:<uid>:<phone|->:<email|->`, valid only through the test provider.
- Logs: one error line per 500; probes (`/health`, `/ready`) are not access-logged; no phone/email/name/address/token in any log line (the grep step in Task 8).
- ESLint: typescript-eslint `recommendedTypeChecked` subset with `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `await-thenable` as errors. `npm run lint` is clean and runs in CI.
- CI: `push` limited to `main`; PRs run typecheck, lint, unit, build, migrate and integration. The Docker build stays.
- Load test target: 50 concurrent guest checkouts for one variant with 10 sellable units → exactly 10 orders, 0 × 5xx (503 `busy` counts as a retryable success-path answer and is retried by the script), p95 recorded in STATUS.md.

## Review Focus

1. **Rate-limit keys behind the load balancer:** `trust proxy` 1 means `req.ip` is the client; limits must not key on the proxy IP. The per-user order limit applies to members only and never blocks guests by a shared key. Pinned in Task 6.
2. **`AUTH_TEST_MODE` can't reach production:** config refuses it, and `createApp` also refuses a test identity when `nodeEnv === 'production'`. Pinned in Task 7.
3. **The OpenAPI document matches real responses:** contract tests parse live responses with the response schemas, so the frontend's generated types can't drift silently. Pinned in Task 10.
4. **The catalog filters rewrite returns identical facets** (same counts as before for a set of filter combinations) while using ≤ 2 queries. Pinned in Task 3.
5. **Lock-order changes** (promotion before stock in expiry/re-reserve; all payments locked in attempt order in confirmation) don't reintroduce deadlocks: the stress tests from phase 5 stay green ×3. Pinned in Task 5.

---

### Task 1: HTTP, logging and startup edges (phase 1 minors)

**Files:** `src/app.ts`, `src/lib/errors.ts`, `src/config/env.ts`, `src/db/client.ts`, `src/server.ts`, tests in `test/unit/errors.test.ts`, `test/unit/config.test.ts`, `test/integration/app.test.ts`, `test/integration/server.test.ts`
- A 500 is logged once: pino-http's level for 5xx becomes `warn`, without the error object; errorHandler logs the `safeError`.
- `/health` and `/ready` are skipped by pino-http autoLogging.
- Body-parser errors map to:
  - `request.aborted` → 400 `request_aborted`;
  - `request.size.invalid` → 400 `invalid_body`;
  - `entity.verify.failed` → 400 `invalid_body`;
  - `parameters.too.many` → 413 `payload_too_large`.
- `DATABASE_SSL_CA` (PEM text, or a path when it starts with `/`) → `ssl: { ca, rejectUnauthorized: true }`.
- `start()` closes the pool when `listen` fails (a port in use → the rejection and `pool.ended === true`).
- The raw body keeps `buf` (no copy).
- [ ] Failing tests for each item → implement → green. Commit `fix: one log line per error, quiet probes, mapped body errors, DB CA and clean failed start`.

### Task 2: Accounts (phase 2 minors)

**Files:** `src/modules/users/repo.ts`, `src/modules/users/admin.ts`, `README.md`, `test/integration/auth.test.ts`, `test/integration/adminUsers.test.ts`, `test/integration/addresses.test.ts`
- `upsertFromClaims` writes only when a claim changed (`is distinct from` guards). The phone-release update runs only when the phone changed. Test: two calls with the same claims → `updated_at` unchanged.
- Demoting a bootstrap admin through `PATCH /v1/admin/users/:id/role` → 409 `bootstrap_admin` ("remove them from BOOTSTRAP_ADMIN_PHONES/EMAILS first").
- README documents the 5-minute token-cache revocation window.
- A set-default concurrency test: two parallel `POST …/default` calls on different addresses → exactly one default.
- [ ] Commit `fix: fewer user writes, protected bootstrap admins, default address race test`.

### Task 3: Catalog (phase 3 minors)

**Files:** `src/modules/catalog/{listing.ts,facets.ts,view.ts,searchText.ts}`, `src/modules/admin/productsRouter.ts`, `src/modules/admin/stockRouter.ts`, `src/modules/wishlist/router.ts`, migration `0008_catalog_hardening.sql`, catalog tests
- `tag` is validated with `z.enum` (unknown → 400).
- Card `sizes` are distinct and ordered by the minimum `size_sort`.
- A unique index on `(product_id, lower(name))` for colours; the admin API returns 400 `color_exists`.
- Admin image paths are validated: `^[a-z0-9][a-z0-9/_.-]*$`, no `..`, no scheme. An unknown image colour → 400.
- `unaccent` is used in `search_text` (an immutable wrapper function) with a backfill. Test: `"Mbappe"` finds `"Mbappé"` if such a name exists, else a seeded accented product.
- `/catalog/filters` computes all facets from one materialised CTE in ≤ 2 queries. Test: the facet output for 5 filter combinations equals the pre-change output (recorded as fixtures from the current code before the change).
- Wishlist: the cap is enforced atomically (insert … select where count < 200 under an advisory xact lock per user); PUT rejects products without an active variant (404).
- Branch-scoped staff read stock only at their branch (`GET /admin/stock*` filtered; another branch → 403).
- Facets add `color`, `tag` and `garmentType`; the README documents `color`.
- [ ] Commit `fix: catalog validation, accent-insensitive search, two-query facets, atomic wishlist cap, scoped stock reads`.

### Task 4: Promotions, carts and checkout leftovers (phase 4 + phase 5 minors)

**Files:** `src/modules/admin/pricingRouter.ts`, `src/modules/cart/service.ts`, `src/modules/checkout/{placeOrder.ts,idempotency.ts,pricing.ts}`, `src/modules/stock/locking.ts`, `src/modules/notifications/templates.ts`, `src/jobs/sweeper.ts`, `README.md`, tests
- Promotion validation:
  - `startsAt < endsAt`;
  - `free_shipping` ⇒ value 0 and no category/brand scope;
  - percent/fixed ⇒ no `scope.methods` (400 with paths).
- The concurrent first add no longer orphans a guest cart (an insert … on conflict of the token, or a re-read).
- README: the cookie-fixation-via-sibling-subdomain note.
- `stock_changed` details always use `{lineId?, variantId, available}`: reserveAllocations adds the line ids it knows; both paths share one shape.
- A non-AppError after the order transaction commits → still 201 with `paymentError` (the order exists; a guest gets the token).
- Idempotency keys older than 24 h are deleted by the sweeper. The takeover releases a key only if `status_code is null` and `created_at` equals the claim it made.
- `pricedCheckout` runs queries sequentially on a transaction (no concurrent queries on one client).
- The `needs_refund` alert headline uses the amount actually paid when the reason is a mismatch (payload `paidCents`).
- `reReserve` exceeding `max_uses`: Ruling (accepted; the customer paid).
- [ ] Commit `fix: promotion rules, guest cart race, one stock_changed shape, safer idempotency and post-commit errors`.

### Task 5: Lock order and sweeper resilience (phase 5 minors)

**Files:** `src/jobs/sweeper.ts`, `src/modules/payments/confirm.ts`, `test/integration/sweeper.test.ts`, `test/integration/paymentConfirm.test.ts`
- `expireOrder` and `reReserve` update `promotions` **before** touching stock (same order as placement).
- `applyProviderResult` locks all of the order's payments in attempt order, then the order. Test: two pending attempts approved in parallel → no 40P01, one confirm + one needs_refund.
- Sweeper:
  - runs the outbox first;
  - after the first provider error in a run, skips further provider calls in that run;
  - `stop()` sets a flag checked between items, so a stop during an outage resolves in < 2 s (test with a hanging fake).
- [ ] Commit `fix: consistent lock order and a sweeper that stops fast during outages`.

### Task 6: Per-route rate limits with a pluggable store

**Files:** `src/middleware/rateLimitStore.ts`, `src/middleware/rateLimit.ts`, `src/context.ts`, `src/modules/checkout/router.ts`, `src/modules/auth/router.ts`, `README.md`, `test/unit/rateLimit.test.ts`, `test/integration/rateLimits.test.ts`
- `interface RateLimitStore { consume(key, windowMs, max, nowMs): Promise<RateLimitDecision> | RateLimitDecision }`; the in-memory default; `createApp` deps `rateLimitStore?`.
- Order create: 10/IP + 5/user; auth session: 20/IP.
- The README explains running more than one instance (Redis store; the interface is the seam).
- Tests:
  - the 11th order from one IP → 429 with `Retry-After`;
  - a member's 6th order in a minute from different IPs (`X-Forwarded-For` with trust proxy 1) → 429;
  - two guests from different IPs are independent;
  - the 21st session call → 429.
- [ ] Commit `feat: per-route rate limits for orders, sign-in, tracking and questions`.

### Task 7: Test-only identity provider

**Files:** `src/lib/testIdentity.ts`, `src/config/env.ts`, `src/server.ts`, `src/app.ts`, `.env.example`, `README.md`, `test/unit/testIdentity.test.ts`, `test/unit/config.test.ts`
- `createTestIdentity()`: `verifyIdToken('test:<uid>:<phone|->:<email|->')` → claims (sign-in provider `phone` when a phone is given, else `google.com`); anything else → `InvalidTokenError`; `deleteUser` → no-op.
- The server uses it when `AUTH_TEST_MODE=true` (dev/test only) instead of Firebase, and logs a warning.
- Config: `AUTH_TEST_MODE=true` with `NODE_ENV=production` → ConfigError.
- `createApp` throws if given a test identity while `nodeEnv === 'production'`.
- [ ] Commit `feat: test sign-in for end-to-end tests, impossible to enable in production`.

### Task 8: Lint, CI and the security pass

**Files:** `eslint.config.js`, `package.json` (lint script), `.github/workflows/ci.yml`, `src/app.ts` (helmet options), any code the linter flags, `docs/superpowers/SECURITY-PASS.md`
- ESLint is clean; CI gains `npm run lint`; push runs only on `main`.
- Helmet for a JSON API: defaults, plus `crossOriginResourcePolicy: same-site` and `contentSecurityPolicy: { directives: { default-src 'none'; frame-ancestors 'none' } }` (the dev checkout page gets its own permissive CSP since it is HTML).
- CORS: credentials only for listed origins. Test: a disallowed origin gets no `Access-Control-Allow-Credentials`.
- Write-endpoint audit: every POST/PUT/PATCH/DELETE route has `validate({ body })` or takes no body. Test: a script-like test walks the Express router stack and asserts it.
- `sql.raw` audit: every use has only constants. A PII grep over `src/` for `logger.(info|warn|error)(` call sites (log fields checked by hand), written up in SECURITY-PASS.md.
- `npm audit`: no high/critical (dev-only moderate esbuild via drizzle-kit recorded).
- [ ] Commit `chore: lint gate, API security headers and the security pass`.

### Task 9: Load test of the order path

**Files:** `scripts/loadtest.ts`, `package.json` (`loadtest` script), `docs/superpowers/STATUS.md`
- The script boots the app on the test DB (fake payments, limits off), seeds one variant with 11 on hand at one branch (buffer 1 → 10 sellable), prepares 50 guest carts (cookies), then fires 50 concurrent `POST /v1/orders` with autocannon-style concurrency. It retries 503 `busy` up to 3 times and asserts exactly 10 × 201, 40 × 409 `stock_changed`, 0 other 5xx. It prints p50/p95/p99 latency.
- [ ] Run it 3×, record the numbers in STATUS.md. Commit `test: load test proving the last 10 units sell exactly once under 50 concurrent checkouts`.

### Task 10: API contracts and OpenAPI

**Files:** `src/contracts/{common.ts,catalog.ts,cart.ts,checkout.ts,orders.ts,account.ts,loyalty.ts,returns.ts,questions.ts,index.ts}`, routers (import request schemas from contracts), `scripts/openapi.ts`, `docs/api/openapi.json`, `package.json` (`contracts:openapi`), `test/integration/contracts.test.ts`
- Request schemas move into contracts (the routers import them).
- Response schemas are written for every public and member endpoint: catalog list/detail/filters/menu/home/suggest, branches, geo, cart, quote, place order, order view, payment status, tracking, me, addresses, wishlist, my orders, returns, loyalty, insights, questions.
- `scripts/openapi.ts` builds OpenAPI 3.1 from a route table `{method, path, summary, auth, request, response}` with `z.toJSONSchema`. CI checks the committed `docs/api/openapi.json` is up to date (`npm run contracts:openapi && git diff --exit-code docs/api`).
- Contract tests: each listed endpoint's real response (from a seeded app) parses with its response schema (`.strict()` off; unknown fields would mean the schema is incomplete, so a test also checks there are no extra top-level keys).
- [ ] Commit `feat: API contracts and OpenAPI document for the frontend`.

### Task 11: Runbooks and README

**Files:** `docs/DEPLOYMENT.md`, `docs/PAYWAY-SANDBOX-CHECKLIST.md`, `README.md`
- DEPLOYMENT.md covers:
  - every env var (a table: required/optional, prod default);
  - build → migrate → seed → catalog import;
  - the PayWay webhook URL;
  - Firebase setup;
  - the same-site cookie requirement + CORS;
  - container hosts (Cloud Run example + any Docker host);
  - health probes;
  - background jobs (one instance or the advisory lock; `JOBS_ENABLED`);
  - backups (`pg_dump` schedule, point-in-time recovery note);
  - rollback;
  - log redaction.
- PAYWAY-SANDBOX-CHECKLIST.md walks through each `VERIFY` item:
  - hash field orders;
  - `req_time` format/timezone;
  - phone format;
  - QR response fields;
  - check-transaction statuses (incl. "not found" for abandoned card checkouts);
  - the pushback shape + whether it is signed;
  - card form fields;
  - close-transaction;
  - amounts;
  - with a step-by-step test script using the dev routes replaced by real sandbox payments.
- README refresh: status (phases 1–7), quick start, links to both docs.
- [ ] Commit `docs: deployment runbook, PayWay sandbox checklist, README refresh`.

### Task 12: Phase 6 review minors

Filled in from the phase 6 final review's deferred minors: each is fixed test-first or ruled out in the ledger.

---

## Deferred (not in phase 7)

Nothing, by design: Stage 4 audits the whole backend against the spec afterwards.
