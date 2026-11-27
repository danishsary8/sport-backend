# Sport Heaven API — full reference

The commerce backend for Sport Heaven, a Phnom Penh football / futsal / F1 store: catalog, cart, checkout, KHQR payments, orders and member accounts. The frontend lives in `sport-heaven`.

- Design: `docs/superpowers/specs/2026-11-25-backend-production-design.md`
- Plans: `docs/superpowers/plans/`
- Behaviour research: `sport-heaven/docs/research/zando-behavior-reference.md`

**Status:** phases 1–7 done.

- Foundation; auth & accounts; catalog with per-branch stock; server-priced carts.
- Checkout with Bakong KHQR (any Cambodian banking app) or ABA PayWay (KHQR/card), stock held while paying, and a per-minute sweeper.
- Post-purchase: tracking, member history, staff order desk, returns and exchanges, loyalty, Q&A, admin overview, logs and system health.
- Hardening: per-route rate limits, a lint gate, a security pass, a load-tested order path, an OpenAPI contract and a test sign-in for end-to-end tests.

Deploying: [`DEPLOYMENT.md`](DEPLOYMENT.md). Before taking real payments: [`BAKONG-SETUP.md`](BAKONG-SETUP.md) (Bakong) or [`PAYWAY-SANDBOX-CHECKLIST.md`](PAYWAY-SANDBOX-CHECKLIST.md) (PayWay). API contract: [`api/openapi.json`](api/openapi.json). Security review: [`superpowers/SECURITY-PASS.md`](superpowers/SECURITY-PASS.md). Where the old pre-split code went: [`superpowers/LEGACY-PORT.md`](superpowers/LEGACY-PORT.md).

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
| `npm run typecheck` | Type-check source, tests and scripts |
| `npm run lint` | ESLint (typescript-eslint, no floating promises) |
| `npm test` / `test:unit` / `test:int` | All tests / pure unit tests / tests against Postgres |
| `npm run db:generate` | Generate a SQL migration from schema changes into `drizzle/` (commit it) |
| `npm run db:migrate` | Apply migrations (run after `build`) |
| `npm run db:seed` | Load branches, Cambodian provinces/districts/communes, categories, collections, default home sections (idempotent) |
| `npm run contracts:openapi` | Regenerate `docs/api/openapi.json` from `src/contracts` (CI checks it is current) |
| `npm run loadtest` | 50 concurrent checkouts for 10 units against `sport_test` (resets it): exactly 10 orders |
| `npm run catalog:import` | Add storefront products that are not in the database yet. Existing products are skipped, so admin edits to names, prices and stock are never reverted |

## Configuration

All environment variables are validated at boot; the server refuses to start and lists every problem if any are wrong. See `.env.example` for the full list. In production, `CORS_ORIGINS` is required and Postgres SSL is on by default.

## Authentication

Customers sign in on the frontend with Firebase (phone number + SMS code, or Google) and send `Authorization: Bearer <Firebase ID token>`.

- `POST /v1/auth/session`: call right after sign-in; creates or refreshes the user and returns it.
- Roles: `customer`, `staff` (optionally limited to one branch), `admin`. Numbers/emails in `BOOTSTRAP_ADMIN_PHONES` / `BOOTSTRAP_ADMIN_EMAILS` become admin when they sign in.
- Verified tokens are cached for up to 5 minutes: disabling or revoking a user in Firebase takes up to 5 minutes to lock them out.
- **End-to-end tests:** with `AUTH_TEST_MODE=true` (refused in production) the API accepts test tokens `test:<uid>:<phone|->:<email|->[:<name>]`, e.g. `Authorization: Bearer test:e2e-alice:+85512000001:-`.
- Without `FIREBASE_PROJECT_ID`, sign-in routes answer `503 auth_unavailable` (fine for local work on public routes). Production requires `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` (enables revoked-token checks and account deletion).

## Endpoints

| Method & path | Who | Purpose |
|---|---|---|
| `GET /health`, `GET /ready` | anyone | Liveness / readiness |
| `GET /v1/branches` | anyone | The three stores |
| `GET /v1/geo/provinces`, `/districts?provinceCode=`, `/communes?districtCode=` | anyone | Address pickers (Khmer + English) |
| `POST /v1/auth/session` | signed in | Create/refresh the user after Firebase sign-in |
| `GET /v1/me`, `PATCH /v1/me`, `DELETE /v1/me` | signed in | Profile; deletion anonymises the account and removes the Firebase user |
| `GET/POST /v1/me/addresses`, `PATCH/DELETE /v1/me/addresses/:id`, `POST /v1/me/addresses/:id/default` | signed in | Delivery addresses (max 20, one default) |
| `GET /v1/admin/users?q=&role=&page=&pageSize=`, `PATCH /v1/admin/users/:id/role` | admin | Find users, set customer/staff/admin and staff branch |
| `GET /v1/catalog/products?category=&collection=&brand=&size=&color=&league=&surface=&kitType=&garmentType=&tag=&priceMin=&priceMax=&discount=&inStockOnly=&q=&sort=&page=&pageSize=&lang=` | anyone | Product listing (repeat a param for OR; prices in cents; `tag` is one of new, best_seller, limited, signature, retro, ucl, sale; search ignores accents) |
| `GET /v1/catalog/filters?<same>` | anyone | Facets with counts for the current filters: category, brand, size, colour, league, surface, kit, type, highlights (tags), price buckets, discount, availability |
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

## Checkout, orders and payments

1. The checkout page calls `POST /v1/checkout/quote` whenever the shopper changes delivery or payment. It prices the bag exactly as `GET /v1/cart` does and lists the delivery options (with this bag's fee), pickup stores and payment methods.
2. `POST /v1/orders` with a unique `Idempotency-Key` header (a UUID per checkout attempt; resending the same key returns the same order). The server re-prices the bag, holds the stock (`reserved_until` = 30 minutes; 48 hours for cash on pickup), empties the bag and returns `{order, payment, orderAccessToken}`.
   - Delivery takes each line from the store with the most stock, splitting it across stores when needed; pickup uses only the chosen store. The online safety buffer always applies.
   - Two shoppers buying the last unit at the same moment: exactly one order succeeds; the other gets `409 stock_changed`.
   - `payment.instructions` is `{kind:'qr', qrString, deeplink}` (render the KHQR from `qrString`), `{kind:'redirect', url, method, fields}` (card: submit a form to PayWay) or `{kind:'none'}` (cash on pickup).
3. While the QR is shown the page polls `GET /v1/orders/:number/payment-status` every 3 s; the server asks PayWay at most once every 5 s per order.
   Which payment service is used: PayWay when `PAYWAY_MERCHANT_ID`/`PAYWAY_API_KEY` are set, else Bakong when `BAKONG_TOKEN`/`BAKONG_ACCOUNT_ID`/`BAKONG_MERCHANT_NAME` are set (KHQR only: the shop builds the QR itself and finds the payment by the QR's md5, so there is no webhook), else the local fake outside production.
4. Payment is confirmed by any of: PayWay's webhook (`POST /v1/webhooks/payway`), the poll, or the per-minute sweeper. Each one re-checks the transaction with PayWay's signed check API before trusting it, and confirming twice changes nothing. On payment the stock leaves the shelf, members with a verified phone earn 10 points per $1 (excluding delivery), the promo use is recorded and ops/customers are notified.
5. Unpaid orders expire when their hold ends: the stock and the promo use are released. A payment that arrives after expiry re-holds the stock if it can; otherwise the order is flagged `needs_refund` and ops get an urgent Telegram message. A second payment for the same order, or a wrong amount, is flagged the same way.

Guests prove access to their order with the `orderAccessToken` (24 h) in an `X-Order-Token` header; switching payment method also needs their contact phone. Members just send their sign-in token.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /v1/checkout/quote` | anyone | Totals, delivery options, pickup stores and payment methods for the bag |
| `POST /v1/orders` | anyone (needs `Idempotency-Key`) | Place the order and start payment |
| `GET /v1/orders/:number` | owner | Order with timeline and the latest payment |
| `GET /v1/orders/:number/payment-status` | owner | Poll while paying |
| `POST /v1/orders/:number/payments` | owner (+ contact phone for guests) | Retry or switch payment method while the order is still held |
| `POST /v1/webhooks/payway` | PayWay | Payment pushback (not rate limited; always re-verified) |
| `POST /v1/dev/payments/:tranId/approve`, `GET /v1/dev/payments/:tranId/checkout` | development only | Approve a fake payment (only when PayWay isn't configured and `NODE_ENV` isn't production) |

**Payments setup.** Without `PAYWAY_MERCHANT_ID` / `PAYWAY_API_KEY` the API uses a fake provider: QR codes are placeholders and payments are approved with the dev route above. Production refuses to start without PayWay (unless `PAYMENT_METHODS_CASH_ONLY=true`). Set `PAYWAY_BASE_URL` (sandbox by default), `PAYWAY_RETURN_URL` (this API's `/v1/webhooks/payway`, registered with ABA) and `PAYWAY_CONTINUE_URL` (the shop page shoppers return to after card payment). Which methods are offered is the `payment_methods_enabled` setting (KHQR and card on; ACLEDA, Wing and cash on pickup off). Every PayWay field name lives in `src/modules/payments/payway/mapping.ts`, marked to be verified in the sandbox.

**Background jobs.** Every minute (one instance at a time, via a Postgres advisory lock) the API checks pending payments, expires unpaid orders, sends queued notifications and deletes guest bags untouched for 60 days. Set `JOBS_ENABLED=false` to run an instance without them.

**Notifications.** Messages are queued in `notification_outbox` with the order and sent by the job with retries (backing off up to an hour; given up after 8 tries). Ops get Telegram messages for new orders, payments and refunds needed (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); customers who gave an email get payment and status emails through Resend (`RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`). Unconfigured channels are skipped. A failed send never affects an order.

## After the order

- **Tracking:** `POST /v1/orders/track {orderNumber, phone}` (10 a minute per address) shows status, timeline, items and totals. Name, phone and street are masked. Members see their orders at `GET /v1/me/orders` and `GET /v1/me/orders/:number`.
- **Staff order desk:** list and search by number or phone digits; filter by status, store, date or "needs refund". The order page shows the timeline (with who did what), payment attempts and a pick list per store. Staff move orders through the status machine; each change emails the customer if they gave an email. They can cancel (an unpaid order's hold is released; a paid order's items go back on the shelf, its points are taken back and it is flagged for refund), mark a refund done in the PayWay portal, take cash at the counter for pickup orders, and add internal notes. Staff tied to a store only see orders that touch that store.
- **Returns:** members ask at `POST /v1/me/returns`.
  - A size exchange (same product, same price) is possible up to 30 days after delivery or pickup. The new size is held at once.
  - A refund or store credit is possible up to 14 days after delivery or pickup. The amount is what was actually paid for those items.
  - Printed shirts and hygiene items (setting `return_rules.nonReturnable`: matched against the category, the garment type or a word in the product's web address, e.g. `socks`) can't be returned.
  - Staff approve or reject. Approval puts the returned items back on the shelf, takes back the points and flags the refund (or "store credit to issue").
- **Loyalty:** `GET /v1/me/loyalty` (points, tier, progress, perks, history) and `GET /v1/me/insights` (what you buy most). Admins can add or remove points with a note.
- **Questions:** anyone can ask about a product (5 a minute per address). Questions appear only after staff answer and publish them.
- **Admin overview, logs and health:** `GET /v1/admin/overview` (today's sales and everything waiting on staff), payment webhook and notification logs, a test message per channel, and `/v1/admin/system-health` (database latency, uptime, CSV).

| Method & path | Who | Purpose |
|---|---|---|
| `POST /v1/orders/track` | anyone | Track an order with its number and phone |
| `GET /v1/me/orders`, `GET /v1/me/orders/:number` | signed in | Order history and detail |
| `GET /v1/admin/orders`, `GET /v1/admin/orders/:number` | staff, admin | Order desk and order page with pick list |
| `POST /v1/admin/orders/:number/status` · `/cancel` · `/collect-cash` · `/refunded` · `/clear-refund-flag` · `/notes` | staff, admin | Order actions (all recorded with the staff member) |
| `POST/GET /v1/me/returns` | signed in | Ask for and follow returns |
| `GET /v1/admin/returns`, `GET /v1/admin/returns/:number`, `POST /v1/admin/returns/:number/decision` | staff, admin | Handle returns |
| `GET /v1/me/loyalty`, `GET /v1/me/insights` | signed in | Points, tier, perks; buying insights |
| `POST /v1/admin/users/:id/loyalty` | admin | Adjust points |
| `GET/POST /v1/catalog/products/:slug/questions` | anyone | Published questions; ask one |
| `GET /v1/admin/questions`, `PATCH /v1/admin/questions/:id` | staff, admin | Answer, publish, hide |
| `GET /v1/admin/overview` | staff, admin | Dashboard numbers |
| `GET /v1/admin/payments/webhooks`, `GET /v1/admin/notifications`, `POST /v1/admin/notifications/test` | admin | Logs and channel test |
| `GET /v1/admin/system-health`, `/metrics`, `/logs.csv` | admin | Monitoring |

## HTTP conventions

- API routes live under `/v1`. Probes: `GET /health` (liveness) and `GET /ready` (database reachable → 200, otherwise 503).
- Errors always look like `{"error":{"code":"…","message":"…","details":…}}`. A 500 also carries `requestId`, which matches the `X-Request-Id` response header and the logs.
- Request bodies are limited to 1 MB; unknown JSON fields are stripped by validation.
- Rate limits per minute: all of `/v1` 300 per IP (generous because mobile carriers put many shoppers behind one address); placing orders 10 per IP and 5 per signed-in member; sign-in 20 per IP; tracking 10 per IP; questions 5 per IP. A 429 carries `Retry-After`. Counters are in memory per server. With more than one server, plug a Redis-backed `RateLimitStore` into `createApp` (see `docs/DEPLOYMENT.md`).
- Guest bag cookie: serve the API on the shop's registrable domain, and don't let third parties host pages on subdomains of it (a sibling subdomain could plant a bag cookie). The worst case is showing someone a different guest bag, never an order or account.

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
  modules/<feature>/   routers + services (auth, account, users, admin, geo, branches, catalog, stock, wishlist, pricing, cart, checkout, orders, payments, loyalty, rma, questions, notifications, settings, health)
  jobs/                per-minute sweeper (payments, expiry, notifications, old guest bags)
  contracts/           Zod response/request schemas (the API contract; → docs/api/openapi.json)
  db/seed/             reference data (branches, geo) + seed script
drizzle/               committed SQL migrations
test/unit, test/integration
scripts/               openapi.ts (contract → OpenAPI), loadtest.ts
```

## Docker

Full production runbook: [`DEPLOYMENT.md`](DEPLOYMENT.md).

```bash
docker build -t sport-backend .
docker run --env-file .env sport-backend node dist/db/migrate.js   # migrations
docker run --env-file .env -p 3000:3000 sport-backend
```
