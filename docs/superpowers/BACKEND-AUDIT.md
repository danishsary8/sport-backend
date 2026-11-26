# Backend completeness audit (Stage 4)

Spec: `docs/superpowers/specs/2026-11-25-backend-production-design.md`. Every requirement is listed with its evidence (code, endpoint, test). ✅ means implemented and tested. 📝 means a recorded decision, with the reason; those are also in `OWNER-DECISIONS.md` and `STATUS.md` "Rulings". There are **no open items**.

Test files are under `test/unit/` and `test/integration/`.

## §1–§4 Intent, owner decisions, goals, constraints

| Requirement | Status | Evidence |
|---|---|---|
| Standalone repo: `npm ci && npm test && npm start`, no frontend imports | ✅ | `package.json`, `server.test.ts`, CI workflow; `legacy/` removed (`LEGACY-PORT.md`) |
| Firebase Auth, phone OTP + Google, no passwords | ✅ | `lib/identity.ts`, `middleware/auth.ts`, `auth.test.ts` |
| Guest checkout; members earn points | ✅ | `placeOrder.test.ts` (guest), `paymentConfirm.test.ts` "awards points…" |
| Client sends ids + qty only; server prices everything | ✅ | `pricing/engine.ts`, `placeOrder.test.ts` "ignores prices sent by the client" |
| Member perks Silver 10% / Gold free PP delivery / Pro free printing; better-of code vs member | ✅ | `pricing.test.ts`, `cart.test.ts` |
| Staff stock screen + safety buffer (1 per size per branch) | ✅ | `admin/stockRouter.ts`, `stock.test.ts`, `availability.test.ts` |
| Returns: exchange 30 days, refund 14 days, no printed items | ✅ | `rma/rules.ts`, `returns.test.ts`, `rmaRules.test.ts` |
| PayWay KHQR + card; methods switchable in settings | ✅ 📝 | `payments/payway/*`, `settings/payments.ts`, `checkoutQuote.test.ts`; field mapping verified against PayWay docs from memory → `PAYWAY-SANDBOX-CHECKLIST.md` (owner to-do) |
| USD with KHR at a configured rate; E.164 phones | ✅ | `pricing.test.ts` (KHR), `lib/phone.ts`, `phone.test.ts` |
| Anti-goals: no client totals, no overselling, no double charge/fulfil, no paid without verified check, no PII leaks, none of Zando's "Avoid" bugs | ✅ | `placeOrderConcurrency.test.ts`, `paymentConfirm.test.ts` (3× webhook, forged), `orderTracking.test.ts`, `SECURITY-PASS.md`; Avoid list below |

## §6 Architecture

| Requirement | Status | Evidence |
|---|---|---|
| Feature modules with router/service; pure pricing module shared by cart/quote/order | ✅ | `src/modules/*`, `checkout/pricing.ts` (`pricedCheckout`), `checkoutQuote.test.ts` "prices exactly like the cart" |
| `src/contracts` (Zod) as the API contract for the frontend | ✅ | `src/contracts/*`, `docs/api/openapi.json`, `contracts.test.ts`; CI checks it is current |
| `SystemHealthDashboard.tsx` back to the frontend | ✅ | `sport-heaven/src/components/admin/SystemHealthDashboard.tsx` |

## §7 Authentication & identity

| Requirement | Status | Evidence |
|---|---|---|
| `POST /v1/auth/session` verifies (revocation checked), upserts, merges guest bag | ✅ | `auth/router.ts`, `auth.test.ts`, `cartMerge.test.ts` |
| Token cache ≤ 5 min | ✅ | `lib/identity.ts`, `identity.test.ts`; documented in README / DEPLOYMENT |
| Identity key firebase_uid; phone unique; phone released from stale rows | ✅ | `users/repo.ts`, `auth.test.ts`, `accountsHardening.test.ts` |
| Google-only users buy but don't earn points until a phone is verified | ✅ | `paymentConfirm.test.ts` "gives no points…", `loyalty.test.ts` `phoneVerified` |
| Roles customer/staff/admin; bootstrap admins via env; no hard-coded email | ✅ | `adminUsers.test.ts`, `accountsHardening.test.ts` "refuses to demote a bootstrap admin" |
| optionalAuth: invalid token on public route | 📝 | An invalid/expired token sent to a public route answers 401 (so the client refreshes it) instead of silently treating a member as a guest with an empty bag; a request **without** a token is a guest. Phase 2 ruling. |
| `DELETE /v1/me` anonymises; orders kept with name/phone redacted; Firebase user deleted | ✅ 📝 | `account/service.ts`, `accountDeletion.test.ts`; refused while an order is in progress (`open_orders`) so staff can still reach the customer |
| Guest cookie `sc_cart` 128-bit, httpOnly, Secure, SameSite=Lax, 60 days, HMAC-signed | ✅ | `cart/owner.ts`, `signedCookie.test.ts`, `cart.test.ts` |
| Guests track with number + phone | ✅ | `orderTracking.test.ts` |
| Test-only sign-in for e2e, impossible in production | ✅ | `lib/testIdentity.ts`, `testIdentity.test.ts` |

## §8 Data model

| Requirement | Status | Evidence |
|---|---|---|
| All tables in §8 with integer cents | ✅ | `src/db/schema/*`, migrations 0000–0009, `catalogSchema.test.ts`, `commerceSchema.test.ts`, `ordersSchema.test.ts`, `postPurchaseSchema.test.ts` |
| `stock` with buffer; online = Σ max(0, on_hand − reserved − buffer); `stock_movements` audit | ✅ | `stock/service.ts` `applyMovement`, `stock.test.ts`, `stockLocking.test.ts` |
| `order_item_allocations` (multi-branch lines) | ✅ | `placeOrder.test.ts` "splits a delivery line across branches" |
| `payments` with attempts, unique `provider_tran_id`; `payment_webhook_events` idempotency | ✅ | `ordersSchema.test.ts`, `paymentConfirm.test.ts` |
| `loyalty_accounts` + `loyalty_ledger` | ✅ | `loyalty.test.ts`, `paymentConfirm.test.ts` |
| `notification_logs` kept | 📝 | Replaced by `notification_outbox` (each row is the log: status, attempts, last error), as §15 asks for an outbox; admin view at `GET /v1/admin/notifications` |
| Settings keys (khr_rate, reservation_minutes, online_safety_buffer, custom_print_fees, team_discount_rule, loyalty_rules, payment_methods_enabled, return_rules) | ✅ | `db/seed/index.ts`, `seed.test.ts`, `commerceSchema.test.ts`, `ordersSchema.test.ts`, `postPurchaseSchema.test.ts`; plus `cash_on_pickup_hours`, `size_guides` |
| Removed: payment_methods vault, inventory_overrides | ✅ | Not in schema; `LEGACY-PORT.md` |

## §9 Pricing rules

| Rule | Status | Evidence |
|---|---|---|
| 1 Unit price from variant; inactive → `unavailable`, excluded | ✅ | `pricing.test.ts`, `cart.test.ts` (Review Focus 1) |
| 2 Custom print validation + fee (14 chars / 1–99, owner decision) | ✅ 📝 | `print.test.ts`; spec updated in Stage 0 |
| 3 Member perks (verified phone) | ✅ | `pricing.test.ts`, `cart.test.ts` |
| 4 Team 10% on 5+ jerseys/F1; never stacks with member 10% on a line | ✅ | `pricing.test.ts` |
| 5 One promo; better-of vs member with message; team stacks; free-shipping always applies | ✅ | `pricing.test.ts`, `promotions.test.ts`; per-user/global limits at order time `placeOrder.test.ts` "per-customer promo limit" |
| 6 Shipping per method/province, free-over, Gold perk; unknown → blocked | ✅ | `pricing.test.ts`, `checkoutQuote.test.ts` |
| 7 Rounding half-up per line, sums consistent | ✅ | `pricing.test.ts` rounding case; DB `orders_money_check`, `order_items_total_check` |
| 8 KHR to nearest 100 riel, snapshotted | ✅ | `pricing.test.ts`, `orders.khr_rate/total_khr` |
| CASTLE10 / PPFREE seeded | ✅ | `commerceSchema.test.ts` |

## §10 Cart

| Requirement | Status | Evidence |
|---|---|---|
| GET / POST / PATCH / DELETE items; promo PUT/DELETE | ✅ | `cart/router.ts`, `cart.test.ts`, `contracts.test.ts` |
| 409 insufficient_stock with available | ✅ | `cart.test.ts` |
| Merge on login: summed, capped, guest cart deleted | ✅ | `cartMerge.test.ts` |
| Carts don't reserve; honest notice | ✅ | `CartView.notices`, `cart.test.ts` |
| Public availability ok / low (1–3 with count) / out only | ✅ | `availability.test.ts`, `contracts.test.ts` (`lowStockCount` ≤ 3) |
| Abandoned guest carts cleaned | ✅ | `sweeper.test.ts` "deletes guest bags untouched for 60 days" |

## §11 Checkout, orders & payment

| Requirement | Status | Evidence |
|---|---|---|
| `POST /v1/checkout/quote` with methods | ✅ | `checkoutQuote.test.ts` |
| `POST /v1/orders` + Idempotency-Key (24 h) | ✅ | `placeOrder.test.ts`, `placeOrderConcurrency.test.ts`, `checkoutLeftovers.test.ts` (24 h cleanup) |
| One serializable transaction: load cart, re-price, allocate (pickup branch / most-stock with split, Sonthormuk on ties), lock rows, reserve, insert, clear cart; shortfall → 409 stock_changed | ✅ | `checkout/placeOrder.ts`, `allocation.test.ts`, `placeOrderConcurrency.test.ts`, `checkoutLeftovers.test.ts`; retries + 503 `busy` `serializable.test.ts` |
| PayWay transaction outside the transaction; instructions qr / redirect | ✅ | `checkout/paymentAttempt.ts`, `payway.test.ts` |
| Retry / switch method (owner check) | ✅ 📝 | `paymentRoutes.test.ts`; guests prove access with the order token **and** phone (instead of the bag cookie, which is cleared at checkout) |
| `cash_on_pickup` → `awaiting_pickup_payment`, 48 h hold | ✅ | `placeOrder.test.ts`, `sweeper.test.ts`, `adminOrders.test.ts` collect-cash |
| Webhook verified, recorded idempotently, always re-checked | ✅ | `paymentConfirm.test.ts`, `phase5Fixes.test.ts`, `phase7Fixes.test.ts` |
| Client poll throttled to 5 s per order | ✅ | `paymentRoutes.test.ts` |
| Sweeper: checks pending, expires, releases, refunds promo | ✅ | `sweeper.test.ts`, `sweeperResilience.test.ts`, `phase6Fixes.test.ts` |
| On approved: paid, confirmed/printing, commit, loyalty, events, notifications | ✅ | `paymentConfirm.test.ts` |
| Paid after expiry → re-reserve or needs_refund + ops alert; second approval → needs_refund | ✅ | `paymentConfirm.test.ts`, `phase6Fixes.test.ts` (real sweeper path) |
| Status machine enforced in one place, every transition evented | ✅ | `orders/statusMachine.ts`, `statusMachine.test.ts`, `orders/transition.ts`, `adminOrders.test.ts`, `phase6Fixes.test.ts` |
| Tracking with masked address; member order history | ✅ | `orderTracking.test.ts` |
| Order numbers `SC-YYMM-XXXXX` Crockford, never from client | ✅ 📝 | `orderNumber.test.ts`; 5 random characters ≈ 25 bits per month (the spec's "~33 bits" doesn't fit its own 5-character example), collisions retried |

## §12 Catalog API

| Requirement | Status | Evidence |
|---|---|---|
| menu, home (sections with rails), products (filters/sort/paging), filters (typed facets, counts excluding own filter, price buckets), detail (colours, images per colour, variants with per-branch availability, size guide, related) | ✅ | `catalogListing.test.ts`, `catalogDetail.test.ts`, `catalogHardening.test.ts` (fixture-pinned facets), `sizeGuide.test.ts` |
| Search suggest (min 2, pg_trgm + accent-insensitive) and `GET /v1/search` | ✅ | `catalogHardening.test.ts` (accents), `searchPage.test.ts` |
| Branches, geo | ✅ | `geo.test.ts`, `contracts.test.ts` |
| ETag + `public, max-age=60, stale-while-revalidate=300`; `no-store` on user data | ✅ | `securityHeaders.test.ts` (ETag → 304), catalog routers, `cart.test.ts`/`placeOrder.test.ts` headers |

## §13 Account, wishlist, Q&A, returns, loyalty

| Requirement | Status | Evidence |
|---|---|---|
| GET/PATCH/DELETE /me; phone only via Firebase | ✅ | `account.test.ts` |
| Addresses (geo-validated, one default) | ✅ | `addresses.test.ts`, `accountsHardening.test.ts` (default race) |
| Wishlist (atomic cap) | ✅ | `wishlist.test.ts`, `catalogHardening.test.ts` |
| Q&A: published only; post (guest/member, rate-limited, pending) | ✅ | `questions.test.ts` |
| Returns: delivered/completed only; no printed/non-returnable; exchange ≤ 30 d same product & price, reserved; refund/store credit ≤ 14 d, server-computed amount | ✅ | `returns.test.ts`, `rmaRules.test.ts`, `phase6Fixes.test.ts` (cumulative refunds) |
| Loyalty: 10 pts/$ excl. shipping, reversed on refunds, tiers by lifetime spend, `GET /v1/me/loyalty` | ✅ | `loyalty.test.ts`, `paymentConfirm.test.ts`, `returns.test.ts`, `adminOrders.test.ts` (cancel reversal) |

## §14 Admin API

| Requirement | Status | Evidence |
|---|---|---|
| Products/colours/variants/images CRUD | ✅ | `adminCatalog.test.ts`, `catalogHardening.test.ts` |
| CSV import/export | ✅ 📝 | `adminProductsCsv.test.ts`; import updates prices/status of existing SKUs only (dry run first) |
| Stock: per variant/branch; adjust; lookup; counter sale (refused when held, naming the order); transfer; branch-scoped staff | ✅ | `stock.test.ts`, `adminCatalog.test.ts`, `counterSaleHolds.test.ts`, `catalogHardening.test.ts` (scoped reads) |
| Orders: list/filter/search, detail with events, transitions, cancel, mark refunded | ✅ | `adminOrders.test.ts`, `phase6Minors.test.ts` |
| Promotions, shipping rates, settings, roles | ✅ | `adminPricing.test.ts`, `checkoutLeftovers.test.ts` (promotion rules), `adminUsers.test.ts` |
| Q&A moderation; RMA approval (restock, loyalty reversal, refund flag) | ✅ | `questions.test.ts`, `returns.test.ts` |
| Monitoring under `/v1/admin/system-health/*`; public `/health`, `/ready` only | ✅ | `systemHealth.test.ts`, `app.test.ts` |
| Every admin write records the actor | ✅ | order events actor, `stock_movements.actor_user_id`, `loyalty_ledger.actor_user_id`, `product_questions.answered_by/moderated_by`, `rma_requests.decided_by`, admin change logs |

## §15 Notifications

| Requirement | Status | Evidence |
|---|---|---|
| Outbox with retries/backoff in the per-minute job; failure never blocks an order | ✅ | `outbox.test.ts`, `placeOrder.test.ts` (order placed regardless) |
| Paid (ops + customer), status changes (customer), new RMA / question (ops), needs refund (ops urgent) | ✅ | `notificationTemplates.test.ts`, `paymentConfirm.test.ts`, `returns.test.ts`, `questions.test.ts`, `phase6Fixes.test.ts` |

## §16 Security & operations

| Requirement | Status | Evidence |
|---|---|---|
| helmet, CORS allowlist, trust proxy (configurable hops) | ✅ | `securityHeaders.test.ts`, `phase7Fixes.test.ts` |
| Zod on every body/query/param; unknown keys stripped | ✅ | `validate.test.ts`, `writeValidation.test.ts` |
| Rate limits (general, orders IP+user, track, questions, sign-in, webhook) with pluggable store | ✅ 📝 | `rateLimits.test.ts`, `orderTracking.test.ts`, `questions.test.ts`, `phase7Fixes.test.ts`; general limit 300/min/IP instead of 120 (carrier NAT) |
| Errors `{error:{code,message,details?}}`, request id | ✅ | `errors.test.ts`, `app.test.ts` |
| pino JSON with PII redaction | ✅ | `logger.test.ts`, `logRedaction.test.ts` |
| Config validated at boot | ✅ | `config.test.ts` |
| DB SSL in production, committed migrations, pool of 10 | ✅ | `db/client.ts`, `httpEdges.test.ts` (CA), `drizzle/` |
| Background jobs under an advisory lock | ✅ | `sweeper.test.ts`, `phase7Fixes.test.ts` |
| Graceful shutdown | ✅ | `server.test.ts` |
| Dockerfile (node:22-slim, non-root, prod deps) | ✅ | `Dockerfile`; Docker Hub rate limits block a local build (CI builds it) |

## §17 Data migration & seed

| Requirement | Status | Evidence |
|---|---|---|
| Seed branches, geo (both languages), settings, promotions, shipping rates (courier placeholder flagged) | ✅ | `seed.test.ts`, `commerceSchema.test.ts` |
| Catalog import (dedup by slug, sizes → variants, stock estimates flagged) | ✅ | `importCatalog.test.ts` |
| Images on object storage via `ASSET_BASE_URL` | ✅ 📝 | `catalog/view.ts` `assetUrl`; the optimised images are in `sport-heaven/public/assets/catalog`; the storage choice is the owner's (OWNER-TODO) |

## §18 Testing

| Requirement | Status | Evidence |
|---|---|---|
| Unit + integration against real Postgres; concurrency, expiry, idempotency, paid-after-expiry, auth, RMA amounts, tracking privacy | ✅ | 79 test files, ~690 tests; `npm test` |
| CI: typecheck, lint, unit, integration, docker build, contract check | ✅ | `.github/workflows/ci.yml` |
| PayWay sandbox manual checklist | ✅ | `docs/PAYWAY-SANDBOX-CHECKLIST.md` |
| Load test of the order path | ✅ | `scripts/loadtest.ts`, STATUS.md numbers |

## §19 Phases / §20 builder's choices

All seven phases are delivered (`STATUS.md`). The index set includes `variants(product_id)`, `stock(variant_id)` (PK), `orders(user_id, created_at)`, `orders(contact_phone_e164)` and trigram on search text (`drizzle/0003_catalog.sql`, `0005_checkout_payments.sql`).

## Zando reference — backend-relevant items

| Item | Status | Evidence |
|---|---|---|
| A1 ids + qty only, server totals as labelled lines | ✅ | `Breakdown.discounts`, `pricing.test.ts` |
| A2 server-side guest cart, merged at login | ✅ | `cart.test.ts`, `cartMerge.test.ts` |
| A3 stock-aware add with friendly message; "N left" on lines | ✅ | `cart.test.ts` (409 + available), `lowStockCount` |
| A4 phone (+855) primary identity + Google | ✅ | §7 |
| A5 guest checkout | ✅ | §11 |
| A6 Province → District → Commune | ✅ | `geo.test.ts`, `addresses.test.ts` |
| A7 carrier options with zone quotes + pickup | ✅ | `checkoutQuote.test.ts` |
| A8 preferred contact channel | ✅ | `orders.contact_channel`, `placeOrderSchema` |
| A9 KHQR first, card, ACLEDA/Wing switchable | ✅ | `settings/payments.ts`, `checkoutQuote.test.ts` |
| A10 server-defined filters, price buckets | ✅ | `catalogHardening.test.ts` |
| A11 only available sizes enabled (data per size) | ✅ | detail `variants[].availability` (UI work in the frontend) |
| A12 in-place size/qty edit | ✅ | `PATCH /v1/cart/items/:id`, `cart.test.ts` |
| A13 honest "not reserved" note | ✅ | `CartView.notices` |
| A14 loyalty tiers + points | ✅ | §13 |
| A15 multi-language content maps | ✅ | `name_i18n` etc., `lang` param on catalog/cart/order reads |
| Avoid: POST for reads | ✅ | All reads are GET (the quote is POST because it is computed from a body of choices; tracking is POST so phone numbers stay out of URLs/logs) |
| Avoid: no debounce / 500s on suggest | ✅ | min 2 characters server-side (`catalog/router.ts`); debounce is a frontend task |
| Avoid: infinite skeletons | — | frontend (Stage 7) |
| Avoid: exact stock counts | ✅ | `availability.test.ts`, `contracts.test.ts` |
| Avoid: non-httpOnly session cookies | ✅ | `cart.test.ts` (HttpOnly, SameSite=Lax, Secure in production) |
| Avoid: phone + password | ✅ | Firebase OTP only |

## Legacy code

Every legacy file is ported or dropped with a reason: `docs/superpowers/LEGACY-PORT.md` (verified by the phase 6 reviewer).
