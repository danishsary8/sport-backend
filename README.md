# Sport Castle API (`sport-backend`)

The commerce backend for Sport Castle, a Phnom Penh football / futsal / F1 store: catalog, cart, checkout, KHQR payments, orders and member accounts. The frontend lives in `sport-heaven`.

- Design: `docs/superpowers/specs/2026-11-25-backend-production-design.md`
- Plans: `docs/superpowers/plans/`
- Behaviour research: `sport-heaven/docs/research/zando-behavior-reference.md`

**Status:** phases 1–4 done: foundation (config, logging, errors, security baseline, probes, migrations, CI); auth & accounts (Firebase phone/Google sign-in, roles, profile, addresses, geo, branches, admin roles); catalog (products, sizes, per-branch stock with audit trail, filters, search, collections, home, wishlist, staff counter sales, admin product API). cart & pricing (server-priced guest/member carts, team discount, member perks, promo codes, delivery rates, admin pricing). Checkout and payments arrive in phases 5–6; pre-split code waiting to be ported sits in `legacy/` (not built, not tested).

## Requirements

- Node 22+
- PostgreSQL 16 (local install or `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`)

## Setup

```bash
npm ci
cp .env.example .env            # then edit DATABASE_URL / COOKIE_SECRET
createdb sport_dev              # or: psql -c 'CREATE DATABASE sport_dev;'
npm run build && npm run db:migrate && npm run db:seed
npm run catalog:import          # 80 storefront products; stock starts as estimates flagged for counting
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
| `npm run db:seed` | Load branches, Cambodian provinces/districts/communes, categories, collections, default home sections (idempotent) |
| `npm run catalog:import` | Add storefront products that are not in the database yet. Existing products are skipped, so admin edits to names, prices and stock are never reverted |

## Configuration

All environment variables are validated at boot; the server refuses to start and lists every problem if any are wrong. See `.env.example` for the full list. In production, `CORS_ORIGINS` is required and Postgres SSL is on by default.

## Authentication

Customers sign in on the frontend with Firebase (phone number + SMS code, or Google) and send `Authorization: Bearer <Firebase ID token>`.

- `POST /v1/auth/session`: call right after sign-in; creates or refreshes the user and returns it.
- Roles: `customer`, `staff` (optionally limited to one branch), `admin`. Numbers/emails in `BOOTSTRAP_ADMIN_PHONES` / `BOOTSTRAP_ADMIN_EMAILS` become admin when they sign in.
- Without `FIREBASE_PROJECT_ID`, sign-in routes answer `503 auth_unavailable` (fine for local work on public routes). Production requires `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` (enables revoked-token checks and account deletion).

## Endpoints (so far)

| Method & path | Who | Purpose |
|---|---|---|
| `GET /health`, `GET /ready` | anyone | Liveness / readiness |
| `GET /v1/branches` | anyone | The three stores |
| `GET /v1/geo/provinces`, `/districts?provinceCode=`, `/communes?districtCode=` | anyone | Address pickers (Khmer + English) |
| `POST /v1/auth/session` | signed in | Create/refresh the user after Firebase sign-in |
| `GET /v1/me`, `PATCH /v1/me`, `DELETE /v1/me` | signed in | Profile; deletion anonymises the account and removes the Firebase user |
| `GET/POST /v1/me/addresses`, `PATCH/DELETE /v1/me/addresses/:id`, `POST /v1/me/addresses/:id/default` | signed in | Delivery addresses (max 20, one default) |
| `GET /v1/admin/users?q=&role=&page=&pageSize=`, `PATCH /v1/admin/users/:id/role` | admin | Find users, set customer/staff/admin and staff branch |
| `GET /v1/catalog/products?category=&collection=&brand=&size=&league=&surface=&kitType=&garmentType=&tag=&priceMin=&priceMax=&discount=&inStockOnly=&q=&sort=&page=&pageSize=&lang=` | anyone | Product listing (repeat a param for OR; prices in cents) |
| `GET /v1/catalog/filters?<same>` | anyone | Facets with counts for the current filters |
| `GET /v1/catalog/products/:slug` | anyone | Detail: sizes with availability (`ok`/`low`/`out`) per branch, images, related |
| `GET /v1/search/suggest?q=` | anyone | Type-ahead (min 2 characters; debounce on the client) |
| `GET /v1/catalog/menu`, `/catalog/collections/:slug`, `/catalog/home` | anyone | Navigation, collection info, home sections |
| `GET /v1/me/wishlist`, `PUT/DELETE /v1/me/wishlist/:idOrSlug` | signed in | Wishlist (max 200) |
| `GET /v1/admin/stock/lookup?q=`, `GET /v1/admin/stock?productId=`, `GET /v1/admin/stock/movements?variantId=` | staff, admin | Real stock numbers and history |
| `POST /v1/admin/stock/sale`, `/stock/adjust`, `/stock/transfer` | staff, admin | Counter sales, counted corrections, branch transfers (branch-scoped staff: own branch only) |
| `GET/POST /v1/admin/products`, `GET/PATCH /v1/admin/products/:id`, `POST /v1/admin/products/:id/variants`, `PUT /v1/admin/products/:id/variants/:variantId` | admin | Product management and prices |

Stock rules: customers only ever see `ok`, `low` (with 1–3 left) or `out`. The website holds back a safety buffer (setting `online_safety_buffer`, default 1 per size per branch) so a unit just sold in a shop isn't sold online too. Every stock change is recorded in `stock_movements`.

## Cart and pricing

- The server prices everything. Clients send only product variant ids, quantities, print choices and a promo code; any price sent by a client is ignored.
- Guests get a bag through an `sc_cart` cookie (HttpOnly, SameSite=Lax, signed with `COOKIE_SECRET`, 60 days). **Serve the API from the same site as the storefront** (e.g. `api.example.com` for `example.com`) so browsers send it. Signed-in members' bags are stored on their account, and a guest bag is merged in when they sign in (`POST /v1/auth/session` → `cartMerged`).
- Bags don't hold stock; stock is held when an order is placed (phase 5).
- Rules, in order: item price + printing ($8 + patch) → 10% team discount on 5+ jerseys/F1 → member perks (Silver 10% off, Gold free Phnom Penh delivery, Pro free printing; only for members with a verified phone) → one promo code (if a code and the member discount both apply, the cheaper result wins) → delivery → KHR total (nearest 100 riel).
- Delivery: Phnom Penh rider $2.50, free from $50 after discounts; province courier **$3.00 placeholder — confirm the real price** with `PUT /v1/admin/shipping-rates/:id`; store pickup free.
- Pricing settings (`khr_rate`, `custom_print_fees`, `team_discount_rule`, `loyalty_rules`) are seeded with the storefront's current values and edited with `PUT /v1/admin/settings/pricing/:key`.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /v1/cart?fulfillment=&shippingMethodId=&provinceCode=&pickupBranchId=&lang=` | anyone | Bag with lines, problems (`unavailable`, `exceeds_stock`), full price breakdown and `checkoutReady` |
| `POST /v1/cart/items`, `PATCH/DELETE /v1/cart/items/:id` | anyone | Add (with optional `customPrint`), change size/quantity, remove |
| `PUT/DELETE /v1/cart/promo` | anyone | Enter or clear a promo code (the response explains if it doesn't apply) |
| `GET/POST /v1/admin/promotions`, `PATCH /v1/admin/promotions/:id` | admin | Promo codes |
| `GET /v1/admin/shipping-rates`, `PUT /v1/admin/shipping-rates/:id` | admin | Delivery fees |
| `GET /v1/admin/settings/pricing`, `PUT /v1/admin/settings/pricing/:key` | admin | Pricing rules |

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
  context.ts           shared dependencies + auth middleware chains for routers
  modules/<feature>/   routers + services (auth, account, users, admin, geo, branches, catalog, stock, wishlist, pricing, cart, health)
  db/seed/             reference data (branches, geo) + seed script
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
