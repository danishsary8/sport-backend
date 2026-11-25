# Sport Castle API: design

Date: 2026-11-25 · Status: draft for approval · Repo: `danishsary8/sport-backend`

## 1. Why

Sport Castle (the store in `danishsary8/sport-heaven`) is Sary Danish's portfolio project. The goal is for a reviewer to come away thinking: **"a strong API developer who also builds clean UI."** The store's UI already shows the second half. The API exists as code (about 35 endpoints), but nobody can run it, try it or trust it: the backend repo has no `package.json`, the API needs Postgres and Firebase admin keys to start, and there are no tests and no API docs.

This project turns `sport-backend` into a **standalone, production-grade API** that a reviewer can open live, read, try and run locally with one command, and that the store uses for real.

**Success looks like:** a reviewer opens the live `/docs`, registers an account, signs in, places an order and sees it in their account, all through the API from the browser. The README explains the design in five minutes. CI is green. `docker compose up` runs it locally.

## 2. Goals

1. Standalone service: own `package.json`, scripts, config, Dockerfile, CI; no code shared with the frontend repo at runtime.
2. **Own authentication** (decided by Sary): email and password, no third-party identity provider.
3. Catalog stored in Postgres and served by the API (the API becomes the source of truth).
4. Checkout that is safe to expose publicly: **the server computes every price**, checks stock, and cannot create duplicate orders on retry.
5. Interactive API docs generated from the same schemas that validate requests.
6. Integration tests against a real Postgres database, run in CI.
7. Live deploy on free tiers, and the store wired to it.
8. Production habits visible in the code: config validated at boot, structured logs with request IDs, a consistent error format, health and readiness checks, graceful shutdown, security headers, rate limits.

## 3. Non-goals

- Real money. Payments run in a clearly labelled **demo mode** (pay at pickup / cash on delivery / a test card that always succeeds). The existing ABA KHQR and Stripe webhook verification code stays, but is only active when its secrets are set.
- Social sign-in (Google etc.), two-factor auth, email verification at sign-up.
- Microservices, message queues, Redis, Kubernetes. One service and one database.
- The admin UI redesign and the remaining store pages in the new style: a separate project after this one.
- The PDF "system health" report: dropped from the API (health and readiness endpoints remain).

## 4. Anti-goals (would make it a failure even if it works)

- Trusting prices, totals or discounts sent by the browser.
- Any secret committed to the repo, or a default secret that works in production.
- Endpoints without request validation, or without a test for their main path.
- Pretending demo payments are real anywhere in the API or the store.
- A live demo that loses data on restart.

## 5. Constraints

- Free hosting: **Neon** (Postgres) and **Render** (web service). Render's free tier sleeps after ~15 minutes idle, so the first request can take ~30–60 s; the store must stay usable meanwhile (it keeps its built-in catalog as a read-only fallback and shows a short "waking up the API" note on sign-in/checkout).
- Node 22, TypeScript. Keep the existing stack where it is sound: **Express, Zod 4, Drizzle ORM, PostgreSQL**. Existing route, repository, webhook and notification code is reused and refactored, not thrown away.
- Sary works on Windows (cmd); local setup must work there (Docker Desktop for Postgres, or a Neon dev branch as an alternative).
- Two repos must stay in step: the store reads the API's OpenAPI spec to generate its typed client, so a contract change shows up as a type error in the store.

## 6. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Standalone API in `sport-backend`, deployed on its own; store calls it | Most work; two repos to keep in step | **Chosen by Sary.** Two portfolio cards that link to each other; the API stands on its own |
| B | Keep the API inside the store repo, deploy as one service | Simpler, but the API is buried in a frontend project | Rejected |
| C | Add docs and tests only, no deploy | Quickest, but reviewers can only read code | Rejected |

Sign-in:

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Own auth: passwords hashed with Argon2id, short-lived access tokens, rotating refresh tokens | ~1 day more; store sign-in pages are rewired | **Chosen by Sary** |
| B | Keep Firebase Auth | Less code, but the key security piece isn't his, and deploy depends on Firebase admin keys | Rejected |

## 7. Design

### 7.1 Shape of the service

```
src/
  app.ts               builds the Express app (no listen) so tests can import it
  server.ts            listen + graceful shutdown
  config.ts            Zod-validated environment; the process exits on bad config
  db/                  Drizzle schema, migrations, client, seed
  modules/<area>/      routes.ts · service.ts · repository.ts · schemas.ts per area:
                       health, auth, catalog, account, orders, returns, questions, admin, payments, notifications
  lib/                 errors, logger, openapi, pagination, money, ids
test/                  integration tests (real Postgres) + unit tests
```

Routes are thin (parse, call service, respond). Services hold rules (pricing, stock, status changes) and run inside transactions where needed. Repositories hold SQL via Drizzle.

### 7.2 API conventions

- Base path **`/v1`**. JSON only. Money as **integer cents** in the API and database (`priceCents`), formatted by the client.
- Errors use **RFC 9457 problem details** (`application/problem+json`): `type`, `title`, `status`, `detail`, `instance`, plus `errors[]` for validation (field path + message) and the request ID.
- Every response carries `X-Request-Id` (accepted from the caller or generated).
- Lists: `?limit=&cursor=` (cursor pagination) for orders and admin lists; the catalog also accepts the store's filter keys (`category`, `league`, `team`, `season`, `kit`, `brand`, `q`, `sort`).
- `POST /v1/orders` requires an **`Idempotency-Key`** header; the same key with the same body returns the original order, with a different body returns `409`.
- Times in ISO 8601 UTC. IDs: UUID v7 internally; orders also get a human number (`SC-24817`).

### 7.3 Endpoints (v1)

| Area | Endpoints |
|---|---|
| Health | `GET /health` (alive) · `GET /ready` (database reachable) |
| Docs | `GET /docs` (interactive reference) · `GET /openapi.json` |
| Auth | `POST /v1/auth/register` · `POST /v1/auth/login` · `POST /v1/auth/refresh` · `POST /v1/auth/logout` · `POST /v1/auth/password/forgot` · `POST /v1/auth/password/reset` · `GET /v1/auth/me` |
| Catalog | `GET /v1/products` (filters, sort, pagination) · `GET /v1/products/{slug}` · `GET /v1/products/{slug}/questions` |
| Account | `GET/PATCH /v1/me/profile` · `GET/POST/PATCH/DELETE /v1/me/addresses` · `GET/PUT/DELETE /v1/me/wishlist` · `GET /v1/me/orders` |
| Orders | `POST /v1/orders/quote` (prices a bag, no side effects) · `POST /v1/orders` · `GET /v1/orders/{number}` (owner) · `POST /v1/orders/track` (guest: number + phone or email) |
| Returns | `POST /v1/orders/{number}/returns` · `GET /v1/me/returns` |
| Questions | `POST /v1/products/{slug}/questions` (signed in) |
| Admin | `GET /v1/admin/overview` · `GET /v1/admin/orders` · `PATCH /v1/admin/orders/{number}/status` · `GET/PATCH /v1/admin/products/{id}/stock` · `GET /v1/admin/notifications` · `POST /v1/admin/questions/{id}/answer` |
| Payments | `POST /v1/webhooks/payments/aba-khqr` · `POST /v1/webhooks/payments/stripe` (only when secrets are set) |

Saved card details are dropped (the old `payment_methods` table stored card metadata; a production store never should without a PCI provider).

### 7.4 Authentication

- Passwords: **Argon2id** (`@node-rs/argon2`), minimum 10 characters, checked against a short list of common passwords.
- **Access token:** JWT, signed with **EdDSA (Ed25519)**, 15 minutes, sent as `Authorization: Bearer`. Claims: `sub` (user id), `role` (`customer` | `admin`), `exp`, `iat`, `jti`.
- **Refresh token:** 256-bit random value, stored **hashed** in `refresh_tokens`, 30 days, sent and received only as an `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` cookie. The store's host forwards `/api/*` to the API (Vercel rewrite; Vite proxy in development), so the browser sees one site: the cookie is first-party and works in Safari and in privacy modes, and the store needs no CORS. Direct calls to the API domain (e.g. from `/docs`) use the Bearer token only. Every refresh **rotates** the token; reusing an old one revokes the whole token family (theft detection).
- Logout revokes the current family. Changing or resetting a password revokes all families.
- Password reset: single-use token (hashed, 30 minutes). Sent by email when `RESEND_API_KEY` is set; otherwise logged (development) and the response is identical either way (no account enumeration).
- Login and reset endpoints have strict per-IP and per-email rate limits; failed logins return the same message whether or not the email exists.
- Admins: a `role` column. The first admin is created by `npm run admin:create -- --email ...` (prompts for a password); no hard-coded admin emails.
- Guest checkout stays allowed; a guest order can be claimed later by an account with the same email.

### 7.5 Data model (PostgreSQL, Drizzle migrations)

`users` (id, email unique case-insensitive (`citext` or a unique index on `lower(email)`), password_hash, full_name, phone, telegram, role, created_at) · `refresh_tokens` (id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by) · `password_resets` · `products` (id, slug unique, name, brand, category, league, team, team_type, season, kit_type, versions[], fits[], sleeves[], price_cents, original_price_cents, customizable, attributes jsonb for specs/facts, media jsonb, is_active) · `product_stock` (product_id, branch, size, quantity; check `quantity >= 0`) · `addresses` · `wishlist_items` · `orders` (id, number unique, user_id null, guest email/phone, status, fulfilment, branch, payment_method, payment_status, subtotal/discount/shipping/total cents, idempotency_key unique, request_hash) · `order_items` (product snapshot: name, size, variant, print, unit_price_cents, quantity) · `order_status_events` (history for tracking) · `returns` · `product_questions` · `payment_webhook_events` (provider + event id unique: replay-safe) · `notification_logs`.

Constraints live in the database: foreign keys, unique keys, `CHECK` on money and stock, enums for statuses. Order status changes follow one allowed path (`confirmed → printing → ready_for_pickup | dispatched → delivered`, `cancelled` from the first two only) enforced in the service and recorded in `order_status_events`.

**Seed:** the store's 80 products are exported once from `sport-heaven` (`npm run export:catalog` there writes JSON) and committed here as `db/seed/catalog.json`; `npm run db:seed` loads products and starting stock (the per-size stock numbers the store already shows). Seeding is idempotent (upsert by slug).

### 7.6 Checkout rules

`POST /v1/orders/quote` and `POST /v1/orders` share one pricing function:
unit price = product price + **Player version $55** + **name/number printing fee** (existing store rule), × quantity; promo codes and the existing team-order discount rule are evaluated server-side; delivery fee from the existing Phnom Penh rule. In one transaction the order is inserted and stock is decremented with a guarded `UPDATE … WHERE quantity >= n`; any shortfall returns `409` with the items affected. Cancelling restores stock. Notifications (Telegram / email, each only if configured) are written to `notification_logs` and sent after commit; failures are logged and retryable from admin.

### 7.7 Docs, quality and operations

- **OpenAPI 3.1** generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), served at `/openapi.json` and rendered with **Scalar** at `/docs`, including the Bearer auth flow so reviewers can try protected endpoints.
- **Tests:** Vitest + Supertest. Integration tests run against a real Postgres (Docker locally, a service container in GitHub Actions), each test file in its own schema/transaction. Coverage targets the rules that matter: pricing, stock and idempotency, auth flows (rotation, reuse detection, reset), permissions (a customer can't read another customer's order, admin-only routes), validation errors. Unit tests for pricing and status transitions.
- **Logging:** pino JSON logs with request ID, method, path, status, duration; secrets and passwords redacted.
- **Security:** helmet, CORS allow-list from config, 100 kB JSON limit, rate limits (general, auth, tracking, webhooks), Zod on every input, `trust proxy` set for Render.
- **Operations:** `/health` and `/ready`, graceful shutdown (stop accepting, finish in-flight, close pool), migrations run as a release step, not on every boot.
- **CI (GitHub Actions):** type-check, lint, tests against Postgres, build, Docker image build; OpenAPI spec diff uploaded as an artifact.
- **Local:** `docker compose up` (API + Postgres + migrations + seed). Windows instructions in the README.

### 7.8 Store (`sport-heaven`) changes

- The store calls `/api/v1/...` on its own origin; `vercel.json` rewrites `/api/:path*` to the Render URL and Vite's dev proxy does the same locally. A typed client generated from `/openapi.json` (`openapi-typescript` + `openapi-fetch`).
- Catalog loads from the API, falling back to the built-in data if the API is asleep or down.
- Sign-in, register, forgot/reset password, account (profile, addresses, wishlist, orders, returns) and checkout call the API. Access token kept in memory; refresh via cookie on load.
- Firebase is removed from the store; the old `backend/` folder and `server.ts` are removed (the store becomes a pure static site, `npm run dev` = Vite).

### 7.9 Delivery in milestones (each one merged, deployed-ready and tested)

1. **Foundation:** project setup, config, logging, errors, health, schema + migrations, seed, catalog endpoints, OpenAPI docs, Docker, CI.
2. **Auth and account:** register, login, refresh, logout, reset, profile, addresses, wishlist.
3. **Orders:** quote, checkout (pricing, stock, idempotency), my orders, guest tracking, returns, questions.
4. **Admin and integrations:** admin endpoints, notifications, payment webhooks (demo mode default).
5. **Ship:** Neon + Render deploy, store wired to the API, old store backend removed, READMEs and portfolio text for both repos.

## 8. Decided by Sary

- Standalone API repo (approach A), production quality, live deploy.
- Own sign-in, no Firebase.
- The reviewer impression to aim for: strong API developer who also builds clean UI.

## 9. Calls made by Claude (open to change)

- Neon + Render for hosting; store forwards `/api` to the API so auth cookies are first-party; Express/Zod/Drizzle kept; `/v1` paths; integer cents; RFC 9457 errors; EdDSA JWT + rotating refresh cookie; Argon2id; Scalar for docs; Vitest + Supertest with real Postgres; UUID v7 + human order numbers.
- Demo-mode payments; saved card details dropped; system-health PDF dropped.
- Catalog moves into the database; the store keeps its built-in copy only as an offline fallback.
- Milestone order above.

## 10. Left to the builder

Exact table column types and indexes beyond the constraints listed; Drizzle query shapes; folder details inside modules; which common-password list; log field names; Render/Neon dashboard settings (documented in the README as steps for Sary, since those need his accounts).
