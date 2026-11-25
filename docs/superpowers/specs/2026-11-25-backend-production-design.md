# Sport Castle Backend — Production Design

Date: 2026-11-25 · Repo: `sport-backend` · Status: draft for approval

## 1. Intent

Sport Castle is a Phnom Penh football / futsal / F1 store with three branches (Sonthormuk, Sen Sok, Chomkadong). The `sport-backend` repo was split out of the frontend and does not run on its own. It also has security holes that make real trading unsafe: prices come from the browser, payment is a fake QR, products and stock are hard-coded, and the monitoring endpoints are public.

**Goal:** a standalone, production-grade API that real Cambodian customers can buy from. It is phone-first, takes real KHQR payments, and is the single source of truth for products, stock, prices and orders.

Behaviour benchmarks come from `sport-heaven/docs/research/zando-behavior-reference.md` (a Cambodian store studied on 2026-11-25).

## 2. Decisions already made by the owner

| Decision | Choice |
|---|---|
| Who owns login | **Firebase Auth** (keep). The backend verifies Firebase ID tokens. |
| Sign-in methods | **Phone number + SMS OTP (primary, +855 default)** and **Google**. No passwords. |
| Guests | **Guest checkout allowed**; members get loyalty points. |
| Pricing trust | Client sends **ids + quantities only**; the server computes every price, discount, fee and total. |
| Behaviours to adopt | Zando reference §3 "Adopt" list: server-side guest cart, stock-aware add-to-cart, Province→District→Commune addresses, carrier options + store pickup, preferred contact channel (Phone/Telegram/WhatsApp), KHQR-first payments, server-defined filters, loyalty tiers + points, multi-language content. |
| In-store sales | No till system to integrate. Staff record counter sales on a **fast staff stock screen/API**. The website holds back a **safety buffer** (default 1 unit per size per branch) so a just-sold shop item isn't oversold online. |
| Member perks | **Applied at checkout**, as the site already promises: Silver ($150 lifetime spend) 10% off eligible items, Gold ($300) free Phnom Penh express delivery, Pro ($500) free name/number/patch printing. Perks are cumulative up the tiers. **10 points per $1.** Member discounts don't stack with promo codes: the better one wins. |
| Returns | **Size exchange within 30 days** of delivery/pickup (replacement size reserved from stock); **refund within 14 days**. Custom-printed items cannot be returned. |
| Payments | No PayWay merchant account yet: **build on the PayWay sandbox** with KHQR + card. Every payment method can be switched on/off in settings; ACLEDA/Wing appear only if the contract includes them. |

## 3. Goals, non-goals, anti-goals

**Goals**
1. `sport-backend` installs, builds, tests and runs by itself (`npm ci && npm test && npm start`), with no imports from the frontend repo.
2. Phone OTP + Google login, roles (customer / staff / admin) in Postgres, guest checkout.
3. Products, variants (size × color), prices (one price per variant, the same at every branch) and per-branch stock live in Postgres, with an admin API and a fast staff stock screen API for counter sales.
4. Server-side cart (guests and members) with server-computed totals.
5. Checkout: Cambodian addresses, shipping quotes, promo codes, real **ABA PayWay** payment (KHQR + card), webhook-confirmed orders, stock reserved without overselling.
6. Order tracking, returns (RMA), wishlist, addresses, product Q&A, loyalty points: ported and hardened.
7. Security baseline: input validation everywhere, rate limits, CORS allowlist, httpOnly cookies, admin-only monitoring, no secrets in code.
8. Automated tests for money, stock, auth and payments; CI; Dockerfile; versioned DB migrations.

**Non-goals (this project)**
- Rebuilding the frontend. It moves to the new API in a separate project; this design defines the API contract it will consume.
- Gift-card issuing and redemption, point redemption, multi-currency checkout, international shipping, a marketplace/merchants model, push notifications.
- A full CMS or page builder (only a small `home_sections` table).

**Anti-goals (failure even if it "works")**
- Any total, price or discount accepted from the client.
- Overselling the last unit, or double-charging / double-fulfilling on a repeated webhook.
- An order marked paid without a verified PayWay callback **and** a server-side status check.
- Customers' phone numbers, addresses or exact stock levels leaking through public endpoints.
- Copying the Zando bugs in reference §3 "Avoid" (no debounce, infinite skeletons, POST-for-reads, exact stock in listings, non-httpOnly session cookies).

## 4. Constraints

- Market: Cambodia. Prices in **USD**, with KHR shown at a store-configured rate. Phone numbers in E.164 (`+855…`).
- Existing stack to build on: Node 22, TypeScript, Express 4, PostgreSQL, Drizzle ORM, Zod, `firebase-admin`. The frontend already has Firebase web auth (email + Google), which will switch to phone + Google.
- Firebase phone auth needs the **Blaze (pay-as-you-go) plan**; SMS to Cambodia is billed per message. Firebase's reCAPTCHA / App Check limits SMS abuse.
- ABA PayWay needs a **merchant account** (sandbox credentials for development, production credentials before launch).
- Single region; expected load is small (hundreds of orders a day at most). Design for one to three instances behind a load balancer.

## 5. Approaches considered

| Approach | Summary | Trade-off | Verdict |
|---|---|---|---|
| **A. Firebase Auth + Postgres roles** | Firebase handles OTP, Google and token security; the backend verifies ID tokens and stores users and roles in Postgres | Less security-critical code; depends on Google; SMS cost | **Chosen by owner**, with phone OTP as primary |
| B. Own auth (passwords + JWT) | All auth in-house | 2–3× the work, more attack surface, frontend login rewrite | Rejected |
| C. Phone + password (Zando's model) | Phone as username with a password | Password storage and reset burden; weaker than OTP | Rejected; we take Zando's phone-first identity, not its passwords |

For the server shape, the plan is to **keep Express + Drizzle and restructure into feature modules**, rather than switch frameworks (NestJS, Fastify, Hono). The existing middleware, webhook crypto, notification and repository code ports over directly, and the gain from switching doesn't justify the rewrite. *(Builder's call, recorded.)*

## 6. Architecture

```
sport-backend/
  package.json  tsconfig.json  Dockerfile  .env.example  drizzle.config.ts
  drizzle/                      # generated SQL migrations (committed)
  src/
    server.ts                   # boot: load config, connect DB, listen, graceful shutdown
    app.ts                      # express app factory (DI for tests)
    config/env.ts               # zod-validated env; process exits on invalid config
    db/ client.ts schema/*.ts seed/*.ts
    lib/ logger.ts (pino) errors.ts (AppError → JSON) money.ts ids.ts firebase.ts
    middleware/ auth.ts rateLimit.ts cartCookie.ts requestId.ts validate.ts
    modules/
      auth/  catalog/  cart/  pricing/  checkout/  orders/  payments/
      geo/   account/  loyalty/  rma/  questions/  admin/  health/  notifications/
    contracts/                  # zod request/response schemas, exported for the frontend
  test/ (unit + integration)
```

- Each module has `router.ts`, `service.ts` (business rules, no Express) and `repo.ts` (Drizzle).
- **Pricing is one pure module** (`modules/pricing`) used by the cart, the checkout quote and order creation, so all three always agree.
- `src/contracts` holds the Zod schemas. They are the single API contract; the frontend imports them later (shared package or copied build artifact — decided in the frontend project).
- Everything the server needs is in this repo: the frontend's `src/db`, `types`, the `loyaltyTier`/`purchaseInsights` utils and the catalog data are moved or rewritten here. The React `SystemHealthDashboard.tsx` moves **back to the frontend repo**.

## 7. Authentication & identity

**Flow**
1. The frontend signs in with Firebase (`signInWithPhoneNumber` + invisible reCAPTCHA, or Google popup) and sends `Authorization: Bearer <Firebase ID token>`.
2. `POST /v1/auth/session` verifies the token (`verifyIdToken(token, checkRevoked=true)`), upserts the `users` row (`firebase_uid`, `phone_e164`, `email`, `name`, `photo`), **merges the guest cart into the member cart**, and returns the profile + role.
3. Every authenticated request verifies the token with middleware (cache decoded tokens in memory until their `exp`, up to 5 minutes).

**Rules**
- Identity key: `firebase_uid`. `phone_e164` is unique when present; it links to in-store membership.
- **Google-only users** can browse and buy. To earn loyalty points they must verify a phone number (the frontend uses Firebase `linkWithPhoneNumber`; the backend reads `phone_number` from the refreshed token). Until then the account shows "Add your phone to earn points".
- **Roles:** `customer` (default), `staff` (orders + stock), `admin` (everything, including prices, promos and roles). Stored in `users.role`. Bootstrap admins come from env `BOOTSTRAP_ADMIN_PHONES` / `BOOTSTRAP_ADMIN_EMAILS`, applied at login. The hard-coded email in `middleware/auth.ts` is removed.
- `optionalAuth` on public endpoints: an invalid or expired token on a public route is ignored (treated as a guest). On member routes it is a 401.
- Account deletion: `DELETE /v1/me` anonymises the user row (orders are kept for accounting with the name/phone redacted) and deletes the Firebase user.

**Guest identity**
- A first cart write sets cookie `sc_cart` = random 128-bit id, **httpOnly, Secure, SameSite=Lax, 60-day expiry, HMAC-signed** with `COOKIE_SECRET`.
- Guest orders store the contact phone. Guests track an order with **order number + phone**.

## 8. Data model (Postgres, Drizzle; money in integer **cents**)

All money columns are `integer` cents (USD). The current `doublePrecision` money columns are replaced. IDs are `uuid` unless noted; timestamps are `timestamptz`.

**Identity**
- `users` (id, firebase_uid unique, phone_e164 unique null, email null, full_name, photo_url, role, staff_branch_id null, preferred_boot_size, preferred_jersey_size, home_branch_id, created_at, updated_at, deleted_at). `staff_branch_id` set → that staff member can only adjust stock and handle orders for their branch; null → all branches. *(Builder's call.)*
- `addresses` (id, user_id, label, recipient_name, phone_e164, province_id, district_id, commune_id, street, landmark, lat, lng, is_default)

**Catalog**
- `brands` (id, slug, name, logo_url)
- `categories` (id, slug, parent_id, name_i18n jsonb, sort)
- `products` (id, slug unique, brand_id, category_id, name_i18n, description_i18n, specs jsonb, attributes jsonb {league, club, season, kit_type, surface, …}, is_customizable, flags {new, best_seller, limited, featured}, status draft|active|archived, created_at)
- `product_images` (id, product_id, color_id null, url, alt, sort)
- `colors` (id, product_id, name, swatch_hex, sort)
- `variants` (id, product_id, color_id, size_label, size_sort, sku unique, price_cents, compare_at_cents null, status)
- `branches` (id `sonthormuk|sensok|chomkadong`, name, address, lat, lng, phone, hours jsonb, pickup_enabled)
- `stock` (variant_id, branch_id, on_hand int ≥ 0, reserved int ≥ 0, online_buffer int null, PK(variant_id, branch_id)); **online available = max(0, on_hand − reserved − buffer)**, where buffer = `online_buffer` ?? `settings.online_safety_buffer` (default 1). For pickup at a branch the buffer still applies.
- `stock_movements` (id, variant_id, branch_id, delta, reason `order_reserve|order_release|order_commit|store_sale|admin_adjust|transfer|rma_restock|exchange_reserve`, ref_id, actor_user_id, created_at): audit trail
- `collections` (id, slug, name_i18n, rule jsonb or manual list) + `collection_products`
- `home_sections` (id, type `hero|product_rail|category_grid|brand_row`, payload jsonb with i18n, sort, active, starts_at, ends_at)

**Commerce**
- `carts` (id, user_id null, guest_token null, promo_code null, updated_at); one active cart per user or guest token
- `cart_items` (id, cart_id, variant_id, qty, custom_print jsonb null); unique (cart_id, variant_id, print hash)
- `promotions` (id, code unique null for automatic rules, type `percent|fixed|free_shipping`, value, min_subtotal_cents, applies_to jsonb (categories/brands), auto boolean, starts_at, ends_at, max_uses, max_uses_per_user, used_count, active)
- `shipping_methods` (id `pp_rider|province_courier|pickup`, name_i18n, active) + `shipping_rates` (method_id, province_id null = default, fee_cents, free_over_cents null, eta_text_i18n)
- `orders` (id uuid, number unique e.g. `SC-2611-7Q4K9`, user_id null, contact_name, contact_phone_e164, contact_email null, contact_channel `phone|telegram|whatsapp`, fulfillment `delivery|pickup`, pickup_branch_id null, ship_address jsonb snapshot, shipping_method_id, status, payment_status, payment_method `aba_khqr|card|acleda|wing|cash_on_pickup`, subtotal_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, promo_code null, note, reserved_until, paid_at, created_at)
- `order_items` (id, order_id, variant_id, product_snapshot jsonb {name, brand, color, size, image, sku}, unit_price_cents, compare_at_cents, qty, custom_print jsonb, print_fee_cents, discount_cents, line_total_cents)
- `order_item_allocations` (order_item_id, branch_id, qty): one line can be picked from several branches; the ops pick list is per branch. *(Builder's call.)*
- `order_events` (id, order_id, from_status, to_status, actor, note, created_at): timeline for tracking and admin
- `payments` (id, order_id, attempt int, provider `payway`, provider_tran_id unique = `{order number}-{attempt}`, method, amount_cents, status `pending|approved|declined|refunded|expired`, raw jsonb, created_at, updated_at). An order can have several attempts (expired QR, switching KHQR → card); at most one can be approved.
- `payment_webhook_events`: kept (idempotency + audit)

**Engagement**
- `wishlist_items` (user_id, product_id, PK both)
- `product_questions` (id, product_id, user_id null, author_name, question, answer, answered_by, status pending|published|hidden)
- `rma_requests` + `rma_items` (lines by order_item_id + qty; refund amount computed by the server)
- `loyalty_accounts` (user_id PK, points_balance, lifetime_spend_cents, tier `bronze|silver|gold|pro`) + `loyalty_ledger` (id, user_id, delta, reason `order_paid|rma_reversal|admin`, order_id, created_at)
- `notification_logs`: kept

**Geo** (seeded, read-only): `geo_provinces`, `geo_districts`, `geo_communes` (id, parent_id, code, name_en, name_km).

**Settings:** `settings` (key, value jsonb): `khr_rate`, `reservation_minutes`, `online_safety_buffer`, `custom_print_fees`, `team_discount_rule`, `loyalty_rules` (points per $, tier thresholds, perks, eligible categories), `payment_methods_enabled`, `return_rules` (exchange 30 days, refund 14 days, non-returnable categories).

**Removed:** `payment_methods` (fake card vault; PayWay stores cards if needed), `inventory_overrides` (replaced by real tables).

## 9. Pricing rules (`modules/pricing`, pure and unit-tested)

Input: cart lines (variant ids, qty, custom print), promo code, fulfillment, shipping method, province, user (for per-user promo limits). Output: `{ lines[], subtotal, discounts[], shipping, total, khr_total, messages[] }`, each discount and fee a labelled line.

1. Unit price = `variants.price_cents` (current, active). Inactive or archived variant → line flagged `unavailable`, excluded from totals.
2. Custom print (only if `products.is_customizable`): validated name (1–14 chars, A–Z 0–9 space . - ') and number (1–99); fee = base + patch fee from `settings.custom_print_fees` (today $8 + patch).
3. Member tier (signed-in member with a verified phone; tier from `loyalty_accounts`, lifetime spend). Perks are cumulative:
   - Silver+ → **10% off** lines in eligible categories (`loyalty_rules.eligible_categories`: kits, boots, accessories; gift cards excluded).
   - Gold+ → **free `pp_rider` delivery**.
   - Pro → **custom print fee = $0**.
4. Team discount (kept): **10% on jersey/F1 lines when the cart has ≥ 5 jerseys/F1 items**. Per line, team and member 10% **don't stack**: the line gets one 10%.
5. Promo code: at most **one**; checks dates, active flag, min subtotal, scope, global and per-user usage. A code **doesn't stack with the member discount**: the server computes both and applies whichever saves more, with a message ("Your Silver 10% saves more than CASTLE10"). The team discount stacks with a code (today's behaviour). Free-shipping effects (Gold perk, `PPFREE`) always apply alongside a code.
6. Shipping: pickup = $0; otherwise the rate for (method, province) with `free_over_cents`, the Gold perk and free-shipping promos applied. Unknown province or method → no quote; checkout is blocked with a message.
7. Rounding: per-line integer cents; percentage discounts are rounded half-up per line and the remainder assigned to the largest line, so lines always sum to totals.
8. KHR = round(total × khr_rate) to the nearest 100 riel, snapshotted on the order.

The old `CASTLE10` (10%) and `PPFREE` (free `pp_rider` delivery) codes are seeded as `promotions` rows, so behaviour is unchanged.

## 10. Cart

- `GET /v1/cart` → lines (product snapshot, size, color, qty, availability `ok|low|out|unavailable`, max_qty), pricing output, promo state.
- `POST /v1/cart/items {variantId, qty, customPrint?}`: rejects with `409 {code:"insufficient_stock", message, details:{available:n}}` if qty exceeds availability across branches (pickup-specific checks happen at checkout).
- `PATCH /v1/cart/items/:id {qty?, variantId?}`: in-place size/qty change. `DELETE /v1/cart/items/:id`.
- `PUT /v1/cart/promo {code}` / `DELETE /v1/cart/promo`.
- Merge on login: quantities are summed per (variant, print), capped at availability; the guest cart is deleted.
- **Carts don't reserve stock** (customers are told in copy, as Zando does). Reservation happens at order placement (§11).
- Availability exposed publicly: `ok` (> 3), `low` (1–3, with the exact number shown as "Only 2 left"), `out`. Exact counts above 3 are never exposed.

## 11. Checkout, orders & payment

**Quote:** `POST /v1/checkout/quote {fulfillment, shippingMethodId?, provinceId?, pickupBranchId?, promoCode?}` → pricing output + available shipping methods and payment methods for that cart. Read-only; called by the UI whenever an input changes.

**Place order:** `POST /v1/orders` with header `Idempotency-Key` (uuid from the client, stored 24h; a replay returns the same order):
```
{ contact:{name, phoneE164, email?, channel}, fulfillment, address?|addressId?, pickupBranchId?,
  shippingMethodId?, paymentMethod, note?, acceptTerms:true }
```
In **one serializable transaction**:
1. Load the cart (by user or `sc_cart` cookie); empty → 400.
2. Re-run pricing from the DB (never from the request).
3. **Allocate and reserve stock** (using online-available, i.e. after the safety buffer): pickup → the chosen branch must have every line available; delivery → allocate each line from the branch with the most availability (Sonthormuk on ties), **splitting the line across branches** if no single branch has enough, recorded in `order_item_allocations`. Lock with `SELECT … FOR UPDATE` on the `stock` rows; increment `reserved`; write `stock_movements(order_reserve)`. Any shortfall → roll back, `409 {code:"stock_changed", lines:[…]}`, and the cart is refreshed.
4. Insert the order (`status=pending_payment`, `reserved_until = now + 30 min`), items and an event; increment promo usage.
5. Clear the cart.

Then, outside the transaction:
- `aba_khqr` / `card` (plus `acleda` / `wing` only if enabled in `payment_methods_enabled`) → create a **PayWay** transaction (server-to-server, HMAC-signed with the merchant key, `tran_id` = `{order number}-{attempt}`, amount from the order). Return `{order, payment:{method, qrString | checkoutUrl | deeplink, expiresAt}}`. The frontend renders the real KHQR from `qrString`.
- **Retry / switch method**: `POST /v1/orders/:number/payments {method}` (same owner: member token or guest cart cookie + phone) creates a new attempt while the order is `pending_payment`; earlier pending attempts are cancelled with PayWay where possible. If an earlier attempt is approved anyway, it is accepted and any second approval is flagged `needs_refund`.
- PayWay is wrapped in a `PaymentProvider` interface; development and CI use the **PayWay sandbox** or a local fake.
- `cash_on_pickup` (pickup only, optional, controlled by a setting) → `status=awaiting_pickup_payment`; stock stays reserved for 48h.

**Confirming payment** (any one is enough; all are idempotent):
1. **Webhook** `POST /v1/webhooks/payway`: verify the signature (existing `webhookCrypto` adapted to PayWay's hash), record it in `payment_webhook_events` (unique provider event id) and then **re-check the status with PayWay's check-transaction API** before trusting it.
2. **Client poll** `GET /v1/orders/:number/payment-status` (every 3s while the QR is shown) → the server calls PayWay check-transaction if still pending (throttled to once every 5s per order).
3. **Sweeper** job every minute: checks pending orders with PayWay; at `reserved_until` it expires the order, releases stock (`order_release`) and refunds promo usage.

On approved: in one transaction → `payment_status=paid`, `status=confirmed` (or `printing` if any line has a custom print), `stock.on_hand -= qty, reserved -= qty` (`order_commit`), award loyalty points (members with a verified phone), add an event; then async notifications (Telegram to ops; email to the customer if given). If an approved payment arrives for an **expired** order → re-reserve if stock allows, otherwise flag `needs_refund` for an admin and alert ops on Telegram.

**Order status machine**
```
pending_payment ──paid──▶ confirmed ──▶ printing ──▶ ready_for_pickup ──▶ completed
        │                     └──────────▶ out_for_delivery ──▶ delivered ─▶ completed
        ├──expire──▶ expired          (staff can cancel before out_for_delivery → cancelled, refund flow)
        └──cancel──▶ cancelled
```
Also: `awaiting_pickup_payment` (cash on pickup, if enabled) → `ready_for_pickup` → `completed` or `expired` after 48h. `needs_refund` is a **flag** on the order (not a status), set by the paid-after-expiry and double-approval paths and cleared by an admin.
Only the transitions above are allowed, enforced in the service. Every transition writes `order_events`.

**Tracking:** `POST /v1/orders/track {orderNumber, phoneE164}` → status, timeline, items, totals; the address is masked. Members use `GET /v1/me/orders` and `GET /v1/me/orders/:number`.

**Order numbers:** `SC-YYMM-XXXXX`, Crockford base32 random (~33 bits) and unique. Never accepted from the client.

## 12. Catalog API (GET, cacheable)

- `GET /v1/catalog/menu`: categories tree + brands (Cache-Control 5 min).
- `GET /v1/catalog/home`: active `home_sections` with product rails resolved.
- `GET /v1/catalog/products?category=&collection=&brand=&size=&color=&league=&surface=&price_min=&price_max=&discount=&sort=new|price_asc|price_desc|discount|popular&page=&pageSize=`: cards with `{slug, name, brand, image, hoverImage, price, compareAt, discountPct, badges, colors[], availability}` + `total`.
- `GET /v1/catalog/filters?<same params>`: typed facets in Zando's shape (`checkbox|radio|range` with labelled `price buckets`), including counts that respect the other active filters.
- `GET /v1/catalog/products/:slug`: full detail, colors, images per color, variants `{id, size, color, price, compareAt, availability, byBranch: {branchId: ok|low|out}}`, size guide, related products.
- `GET /v1/search/suggest?q=` (min 2 chars; the client debounces 250 ms): top products, brands and categories. Postgres `pg_trgm` + `unaccent` on name/brand/club. `GET /v1/search?q=` uses the listing response shape.
- `GET /v1/branches`, `GET /v1/geo/provinces|districts?provinceId=|communes?districtId=`.

ETag / `Cache-Control: public, max-age=60, stale-while-revalidate=300` on catalog GETs; `no-store` on anything user-specific.

## 13. Account, wishlist, Q&A, returns, loyalty

- `GET/PATCH /v1/me` (name, sizes, home branch; phone changes only through Firebase re-verification), `DELETE /v1/me`.
- `GET/POST/PATCH/DELETE /v1/me/addresses` (validated against the geo tables; one default).
- `GET/PUT/DELETE /v1/me/wishlist/:productId`.
- `GET /v1/catalog/products/:slug/questions` (published only); `POST` (auth optional, rate limited, status pending until staff answer).
- `POST /v1/me/returns {orderNumber, items:[{orderItemId, qty, reason, exchangeVariantId?}], resolution: refund|size_exchange|store_credit}`. Members only in phase 1; guests return in store.
  - Allowed for delivered/completed orders only; never for custom-printed items or non-returnable categories (socks, underwear; list in `return_rules`).
  - **Size exchange: within 30 days** of delivery/pickup. The replacement must be the same product (another size/color, same price). It is **reserved immediately** (`exchange_reserve`) and released if the RMA is rejected.
  - **Refund / store credit: within 14 days**. The **refund amount is computed by the server** from what was actually paid for those lines (after discounts). The customer enters nothing.
  - `GET /v1/me/returns`.
- Loyalty: **10 points per $1** of paid order total (excluding shipping); points are reversed on refunded returns. Tier from **lifetime spend**: Bronze $0, Silver $150, Gold $300, Pro $500, matching the current frontend (`loyaltyTier.ts`). Thresholds and perks live in `settings.loyalty_rules`; the frontend's tier calculation moves here and the frontend just displays `GET /v1/me/loyalty` (balance, tier, progress, perks, ledger). Redemption is a later project.

## 14. Admin API (`/v1/admin/*`, staff or admin)

- Products/colors/variants/images CRUD (admin), with CSV import/export.
- Stock: `GET` per variant and branch; `POST /stock/adjust {variantId, branchId, delta, reason}` (staff), always through `stock_movements`.
- **Counter sales (staff stock screen API)**, built for speed on a phone at the till:
  - `GET /v1/admin/stock/lookup?q=` searches by SKU/barcode/name and returns sizes with this branch's on-hand.
  - `POST /v1/admin/stock/sale {lines:[{variantId, qty}]}` decrements the staff member's branch (`store_sale`). It is rejected if it would push on_hand below reserved, so an online order already holding the unit isn't silently broken; staff are then told which online order holds it.
  - `POST /v1/admin/stock/transfer {variantId, from, to, qty}`.
  - Staff with `staff_branch_id` only touch their branch.
- Orders: list/filter/search, detail with events, status transitions (validated), cancel + mark refunded (refund itself done in the PayWay portal in phase 1).
- Promotions CRUD (admin); shipping rates (admin); settings (admin); users → set role (admin).
- Q&A moderation, RMA approval (approve → restock movement + loyalty reversal + refund flag).
- Monitoring: the existing system-health endpoints move under `/v1/admin/system-health/*`. Public is only `GET /health` (liveness, no details) and `GET /ready` (DB ping → 200/503, no details).

Every admin write records `actor_user_id`.

## 15. Notifications

Existing Telegram + Resend email service, kept and moved to an **outbox table** (`notification_outbox`, processed by the same per-minute job with retries and backoff). A failed send never blocks an order.
Events: order paid (ops Telegram + customer email if given), status changes (customer email), new RMA / new question (ops Telegram), order needing refund (ops Telegram, high priority).
Customer SMS or Telegram updates are a later project; `contact_channel` tells staff how to reach the customer manually.

## 16. Security & operations

- `helmet` defaults; CORS allowlist from `CORS_ORIGINS`; `trust proxy` set to 1.
- Zod validation on every body, query and param (`middleware/validate.ts`); unknown keys stripped.
- Rate limits: general 120/min/IP; OTP-adjacent and order-create 10/min/IP and 5/min/user; track 10/min/IP; webhooks exempt but signature-gated. In-memory store with a pluggable interface; **Redis store if running more than one instance**.
- Errors: `AppError(code, httpStatus, message)` → `{error:{code, message, details?}}`; no stack traces; request id in every response and log.
- Logging: pino JSON, PII redacted (phone shown as last 3 digits).
- Config: `src/config/env.ts` validates all env vars at boot (DATABASE_URL, FIREBASE_PROJECT_ID + service account, COOKIE_SECRET, CORS_ORIGINS, PAYWAY_MERCHANT_ID, PAYWAY_API_KEY, PAYWAY_BASE_URL, TELEGRAM_*, RESEND_*, BOOTSTRAP_ADMIN_*).
- DB: `DATABASE_URL` with SSL in production; Drizzle migrations generated and committed, applied by `npm run db:migrate` before start; pool of 10.
- Background jobs: a single in-process scheduler guarded by a Postgres advisory lock, so only one instance runs the sweeper/outbox at a time.
- Graceful shutdown: stop accepting connections, finish requests (10s), close the pool.
- Dockerfile (node:22-slim, non-root, `npm ci --omit=dev`, compiled JS via `tsc`), `GET /health` for the platform probe.

## 17. Data migration & seed

- `npm run db:seed` loads branches, geo (provinces/districts/communes; source: the official Cambodian administrative gazetteer, both languages), settings, promotions (`CASTLE10`, `PPFREE`, team discount) and shipping rates:
  - `pp_rider`: Phnom Penh, $2.50, free over $50 (today's values).
  - `province_courier`: every other province, **placeholder $3.00, 2–3 days, flagged for the owner to confirm** before launch.
  - `pickup`: $0 at all three branches.
- `npm run catalog:import <file.json>` loads products from a JSON export of today's frontend catalog (`catalog.ts`, `expandedCatalog.ts`, `boots.ts`; deduplicated by slug). Sizes become variants. Initial per-branch stock comes from the current `branchStock` levels mapped to a starting quantity (In Stock = 10, Low = 2, Out = 0), **flagged for staff to correct** before launch.
- Product images: uploaded to object storage; the importer rewrites URLs. Storage choice (Cloudflare R2 / Firebase Storage / GCS) is part of deployment.
- No existing production order data needs migrating.

## 18. Testing

- **Unit** (Vitest): pricing (every rule, rounding, promo edge cases, member perks per tier, member-vs-code "better wins", team + member no-double-10%), safety-buffer availability, multi-branch allocation, RMA windows (29/31-day exchange, 13/15-day refund), status machine, order number generator, signature verification, availability mapping.
- **Integration** (Vitest + supertest against a real Postgres, started by `docker compose` locally and as a CI service): cart flows, guest→member merge, order placement with concurrent last-unit purchases (two parallel requests → exactly one succeeds), reservation expiry, webhook idempotency (same event ×3 → one commit), paid-after-expiry path, auth (missing/invalid/revoked token, role checks), RMA amount calculation, tracking doesn't leak data.
- Firebase and PayWay sit behind interfaces with fakes in tests; a manual **PayWay sandbox** checklist before launch.
- CI (GitHub Actions): typecheck, lint, unit, integration, build the Docker image.

## 19. Delivery phases

1. **Foundation**: standalone repo (package.json, tsconfig, config, logger, errors, health/ready), move schema in, new migrations, Docker, CI. Remove frontend imports.
2. **Auth & accounts**: Firebase verify, session/upsert, roles, addresses (with geo), wishlist, profile.
3. **Catalog**: tables, import script, listing/filter/detail/search endpoints, admin product + stock API.
4. **Cart & pricing**: pricing module, cart endpoints, promotions, shipping quotes.
5. **Checkout & payments**: orders, reservations, PayWay integration, webhook + poll + sweeper, notifications outbox.
6. **Post-purchase**: tracking, status machine admin, RMA, Q&A, loyalty.
7. **Hardening**: rate limits, security headers, load test of the order path, PayWay sandbox run.

## 20. Left to the builder

Folder naming inside modules, exact Zod schema names, the pagination style (page numbers, matching the frontend), pino transport, how the scheduler is implemented under the advisory lock, test fixtures, and the exact Postgres index set (at least: `variants(product_id)`, `stock(variant_id)`, `orders(user_id, created_at)`, `orders(contact_phone_e164)`, trigram on product search fields).
