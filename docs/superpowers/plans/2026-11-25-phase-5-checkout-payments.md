# Phase 5 — Checkout, Orders & Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer (guest or member) can turn their bag into an order. Stock is reserved without overselling, they pay with ABA PayWay (KHQR or card; a fake provider in dev/CI), and the order is confirmed only after a verified payment check. Unpaid orders expire and release stock, and ops and customers are notified through an outbox.

**Architecture:**
- `modules/checkout` prices the cart for checkout (the same `priceCart` path the cart uses) and places orders in one SERIALIZABLE transaction with retries. The pure helpers `orderNumber`, `statusMachine`, `allocation` and `loyaltyMath` are unit-tested on their own.
- `modules/stock/locking.ts` is the single place that locks `stock` rows, always in (variantId, branchId) ascending order. Counter sales, transfers, reservations, commits and releases all go through it, and every change still goes through `applyMovement`.
- `modules/payments` has a `PaymentProvider` interface, the `PayWayProvider` (one field-mapping file) and the `FakePaymentProvider`. `confirm.ts` is the one idempotent "payment approved" path, used by the webhook, the client poll and the sweeper.
- `modules/notifications`: an outbox table plus `Notifier` senders (Telegram, Resend, fake). `jobs/scheduler.ts` runs the per-minute sweeper under a Postgres advisory lock, with an injected clock.

**Tech Stack:** as phases 1–4. No new runtime dependencies: PayWay, Telegram and Resend are called with global `fetch`, which is injected for tests.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` §2 (payments, member perks), §8 commerce tables, §11 checkout/orders/payment, §15 notifications, §16 background jobs; work order `docs/superpowers/plans/2026-11-25-overnight-handoff.md` Stage 1.

## Global Constraints

- Money is integer cents. Order totals come only from `priceCart` (via `pricedCheckout`, Task 4). Clients send ids, quantities and choices; any price field in a request is stripped by Zod.
- Stock changes only through `applyMovement`, inside a transaction, after the rows have been locked with `lockStock` in (variantId, branchId) ascending order.
- Online availability = Σ max(0, on_hand − reserved − buffer), with buffer = `online_buffer` ?? `settings.online_safety_buffer`. The buffer applies to pickup too.
- Public responses expose stock only as `ok` / `low` (1–3) / `out`; error `details.available` is allowed only when it is ≤ 3 or is the quantity the customer asked about (as in phase 4).
- Phones are E.164 via `normalizePhone`. Logs never contain phones, names, emails, addresses or provider payloads (the logger redacts phones; never log `contact`, `shipAddress` or `raw`).
- Errors use `AppError`. New codes: `stock_changed` 409, `checkout_not_ready` 409, `payment_method_unavailable` 400, `idempotency_key_required` 400, `idempotency_mismatch` 422, `request_in_progress` 409, `order_not_found` 404, `order_not_payable` 409, `promo_limit_reached` 409, `payment_provider_error` 502.
- Order number: `SC-YYMM-XXXXX`, where YYMM is in Asia/Phnom_Penh time and XXXXX is 5 Crockford base32 characters (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`) from `crypto.randomInt`. Retry on a unique violation (max 5). Never accepted from the client.
- `provider_tran_id` = `{number}-{attempt}` without dashes inside the number: PayWay limits `tran_id` to 20 chars, `[A-Za-z0-9-]` (`SC2611ABCDE-1`). **VERIFY AGAINST PAYWAY SANDBOX.**
- Settings, seeded only when missing:
  - `payment_methods_enabled`: `{aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false}`;
  - `reservation_minutes`: `{minutes: 30}`;
  - `cash_on_pickup_hours`: `{hours: 48}`.
- Order statuses: `pending_payment, awaiting_pickup_payment, confirmed, printing, ready_for_pickup, out_for_delivery, delivered, completed, cancelled, expired`. Payment statuses: `unpaid, paid, refunded`. `needs_refund` is a boolean flag.
- Loyalty on payment: only for `orders.user_id` users with a non-null `phone_e164` at that moment. Points = `floor((total_cents − shipping_cents) × pointsPerUsd / 100)`; lifetime spend += `total_cents − shipping_cents`; tier = the highest tier whose `minSpendCents` ≤ lifetime spend.
- The guest order access token = `base64url(exp).base64url(HMAC-SHA256(COOKIE_SECRET, "order:"+number+":"+exp))`, valid 24 h. Guest writes need the token **and** the contact phone; guest reads need the token (header `X-Order-Token`).
- Dev-only routes exist only when `NODE_ENV !== 'production'` **and** the fake payment provider is active.
- Every new table is non-reference (truncated by `resetDb`); tests that change `settings` restore them in `beforeAll` and `afterAll`.

## Review Focus

1. **Two customers buy the last unit at the same moment** → exactly one order is created, the other gets `409 stock_changed`, and `reserved` never exceeds `on_hand`. Pinned in Task 7.
2. **The same `Idempotency-Key` twice (sequentially and concurrently)** → one order, the same response body; a different body with the same key → 422. Pinned in Task 7.
3. **A webhook delivered 3×, and the poll and webhook racing** → one `order_commit` per allocation, one loyalty award, one redemption. Pinned in Task 8.
4. **Paid after expiry** → re-reserved and confirmed when stock allows, otherwise `needs_refund` plus an urgent ops notification. **A forged webhook** (the provider check says not approved, or an unknown tran id) → nothing changes, and the event is stored as `rejected`. **An approved amount ≠ the order total** → `needs_refund`, not fulfilled. Pinned in Task 8.
5. **A guest can't read or pay another order** (wrong token, a token for another number, a wrong phone, an expired token) → 404 `order_not_found` with no detail. Quote and order totals equal the cart's to the cent. Pinned in Tasks 4 and 7.

---

## Data model (migration `0005_checkout_payments.sql`, schema file `src/db/schema/orders.ts`)

- `orders`:
  - id uuid PK, number text unique, user_id uuid null FK users ON DELETE SET NULL;
  - contact_name, contact_phone_e164, contact_email null, contact_channel `phone|telegram|whatsapp`;
  - fulfillment `delivery|pickup`, pickup_branch_id null FK branches, ship_address jsonb null, shipping_method_id null FK;
  - status, payment_status default `unpaid`, payment_method, needs_refund bool default false;
  - merchandise_cents, discount_cents, shipping_cents, total_cents (all int ≥ 0), khr_rate int, total_khr int;
  - promo_code null, promotion_id null FK, pricing jsonb (the Breakdown), note null;
  - reserved_until timestamptz null, paid_at null, created_at, updated_at.
  - Checks: the status set, `total_cents = merchandise_cents - discount_cents + shipping_cents`, pickup ⇔ pickup_branch_id not null.
  - Indexes: `(user_id, created_at)`, `(contact_phone_e164)`, `(status, reserved_until)`.
  - `ship_address` = `{recipientName, phoneE164, provinceCode, provinceName{en,km}, districtCode, districtName, communeCode, communeName, street, landmark, lat, lng}`.
- `order_items`: id, order_id FK cascade, variant_id FK, product_snapshot jsonb `{productId, slug, name, brand, color, size, sku, imagePath, categorySlug}`, unit_price_cents, compare_at_cents null, print_fee_cents, discount_cents, line_total_cents, qty (1–20), custom_print jsonb null. Check `line_total_cents = (unit_price_cents + print_fee_cents) * qty - discount_cents`.
- `order_item_allocations`: order_item_id FK cascade, branch_id FK, qty > 0, PK (order_item_id, branch_id).
- `order_events`: bigserial id, order_id FK cascade, from_status null, to_status null, kind text (`status|payment|note|flag`), actor text (`system`, `customer`, or a user uuid), note null, created_at.
- `payments`: id uuid, order_id FK, attempt int, provider text, provider_tran_id unique, method, amount_cents, status `pending|approved|declined|refunded|expired|cancelled`, raw jsonb null, last_checked_at null, created_at, updated_at. Unique (order_id, attempt).
- `payment_webhook_events`: bigserial id, provider, event_id, signature_valid bool, processing_status `received|processed|ignored|rejected|failed`, tran_id null, payload jsonb, error null, received_at, processed_at null. Unique (provider, event_id).
- `promotion_redemptions`: id, promotion_id FK, user_id null, order_id FK unique, contact_phone_e164, created_at.
- `loyalty_ledger`: bigserial id, user_id FK cascade, delta int, reason `order_paid|rma_reversal|admin`, order_id null FK, note null, created_at. Unique (order_id, reason) where order_id not null.
- `notification_outbox`: bigserial id, channel `telegram|email`, recipient text (`ops` or an email), template, payload jsonb, status `pending|sent|failed|skipped`, attempts int default 0, next_attempt_at default now(), sent_at null, last_error null, created_at. Index (status, next_attempt_at).
- `idempotency_keys`: key text, scope text, request_hash text, status_code int null, response jsonb null, created_at; PK (scope, key).

---

### Task 1: Schema, migration and settings

**Files:** `src/db/schema/orders.ts`, `src/db/schema/index.ts`, `src/db/seed/index.ts`, `drizzle/0005_*.sql` (via `npm run db:generate`, then hand-add the check constraints Drizzle can't express), `test/integration/ordersSchema.test.ts`

**Interfaces — Produces:** Drizzle tables `orders, orderItems, orderItemAllocations, orderEvents, payments, paymentWebhookEvents, promotionRedemptions, loyaltyLedger, notificationOutbox, idempotencyKeys`; `ORDER_STATUSES`, `OrderStatus`, `PAYMENT_METHODS = ['aba_khqr','card','acleda','wing','cash_on_pickup']`, `PaymentMethod`, `ShipAddressSnapshot`, `ProductSnapshot`, and the row types `OrderRow`, `OrderItemRow`, `PaymentRow`.

- [ ] **Step 1: Failing test `ordersSchema.test.ts`:**
  - After seed, settings `payment_methods_enabled`, `reservation_minutes` (30) and `cash_on_pickup_hours` (48) equal the Global Constraints values.
  - Inserting an order whose total ≠ merchandise − discount + shipping → rejected (23514).
  - A pickup order with no branch → rejected.
  - An unknown status → rejected.
  - A duplicate `provider_tran_id` → 23505.
  - A duplicate (provider, event_id) webhook event → 23505.
  - A second `loyalty_ledger` `order_paid` row for the same order → 23505.
  - An order item whose line total doesn't match → rejected.
- [ ] **Step 2:** Run `npx vitest run test/integration/ordersSchema.test.ts` → FAIL (tables missing).
- [ ] **Step 3:** Implement the schema, generate the migration, add the settings to `DEFAULT_SETTINGS`.
- [ ] **Step 4:** PASS, whole suite green. Commit `feat: order, payment, outbox and loyalty ledger schema`.

### Task 2: Pure order domain helpers

**Files:** `src/modules/orders/number.ts`, `src/modules/orders/statusMachine.ts`, `src/modules/checkout/allocation.ts`, `src/modules/loyalty/math.ts`, `test/unit/orderNumber.test.ts`, `test/unit/statusMachine.test.ts`, `test/unit/allocation.test.ts`, `test/unit/loyaltyMath.test.ts`

**Interfaces — Produces:**
```ts
export function newOrderNumber(now: Date, rand?: (max: number) => number): string; // SC-2611-7Q4K9
export function tranIdFor(number: string, attempt: number): string;              // SC26117Q4K9-1
export function canTransition(from: OrderStatus, to: OrderStatus): boolean;
export function assertTransition(from: OrderStatus, to: OrderStatus): void;      // throws AppError invalid_transition 409
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]>;
export interface BranchAvailability { branchId: string; sort: number; available: number }
export interface AllocationLine { lineId: string; variantId: string; qty: number; branches: BranchAvailability[] }
export type AllocationResult =
  | { ok: true; allocations: { lineId: string; variantId: string; branchId: string; qty: number }[] }
  | { ok: false; shortfalls: { lineId: string; variantId: string; requested: number; available: number }[] };
export function planAllocations(lines: AllocationLine[], mode: { fulfillment: 'pickup'; branchId: string } | { fulfillment: 'delivery' }): AllocationResult;
export function pointsFor(totalCents: number, shippingCents: number, pointsPerUsd: number): number;
export function tierForSpend(lifetimeSpendCents: number, tiers: { id: TierId; minSpendCents: number }[]): TierId;
```
The transitions table (the system path `expired → confirmed|printing` is used only by paid-after-expiry):
```
pending_payment         → confirmed, printing, expired, cancelled
awaiting_pickup_payment → ready_for_pickup, expired, cancelled
confirmed               → printing, ready_for_pickup, out_for_delivery, cancelled
printing                → ready_for_pickup, out_for_delivery, cancelled
ready_for_pickup        → completed, cancelled
out_for_delivery        → delivered
delivered               → completed
expired                 → confirmed, printing
completed, cancelled    → (none)
```
Allocation algorithm: lines share branch capacity (two lines of the same variant draw from the same pool).
- Pickup: every line must fit in the chosen branch, or it is a shortfall.
- Delivery: for each line, take the branch with the most remaining availability (ties → lowest `sort`, i.e. Sonthormuk first); if it can't cover the line, take all of it and continue with the next best branch, until the line is covered or capacity runs out (shortfall).

- [ ] **Step 1: Failing tests.**
  - `orderNumber`:
    - matches `/^SC-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/`;
    - 2026-11-30T20:00Z → `SC-2612-…` (Phnom Penh is UTC+7);
    - with `rand` always 0 → `SC-2612-00000`;
    - 1,000 numbers have no duplicates;
    - `tranIdFor('SC-2611-7Q4K9', 2)` → `SC26117Q4K9-2` (length ≤ 20).
  - `statusMachine`: table-driven. Every pair in TRANSITIONS is allowed; every other pair over the 10×10 grid is rejected; `assertTransition('delivered','cancelled')` throws code `invalid_transition`.
  - `allocation`:
    - delivery, 3 units, branches {sonthormuk 1, sensok 5} → all 3 from sensok;
    - 6 units with {2, 3, 2} → split 3 + 2 + 1 in order of availability;
    - a tie {2, 2} → Sonthormuk first;
    - two lines of the same variant drawing from the same pool, total 4 over a pool of 3 → shortfall on the second line with `available` 1;
    - pickup at sensok, which has 1 of the 2 asked for → shortfall even though sonthormuk has 10;
    - zero lines → ok with empty allocations.
  - `loyaltyMath`:
    - `pointsFor(5250, 250, 10)` → 500;
    - `pointsFor(99, 0, 10)` → 9;
    - `tierForSpend(14999)` → bronze, `15000` → silver, `30000` → gold, `50000` → pro (with the seeded tiers).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: order numbers, status machine, stock allocation and loyalty maths`.

### Task 3: Ordered stock locking for every multi-row stock change

**Files:** `src/modules/stock/locking.ts`, `src/modules/stock/service.ts` (use it in `recordSale` and `transferStock`), `test/integration/stockLocking.test.ts`

**Interfaces — Produces:**
```ts
export interface StockKey { variantId: string; branchId: string }
export function sortStockKeys(keys: StockKey[]): StockKey[];               // dedupe + ascending (variantId, branchId)
export async function lockStock(tx: Tx, keys: StockKey[]): Promise<Map<string, StockRow>>; // key `${variantId}@${branchId}`; creates missing rows first
export async function reserveAllocations(tx: Tx, allocs: (StockKey & { qty: number })[], refId: string, reason?: 'order_reserve' | 'exchange_reserve'): Promise<void>;
export async function releaseAllocations(tx: Tx, allocs: (StockKey & { qty: number })[], refId: string, reason?: 'order_release'): Promise<void>;
export async function commitAllocations(tx: Tx, allocs: (StockKey & { qty: number })[], refId: string): Promise<void>; // order_commit: onHand −qty, reserved −qty
```
Each of these calls `lockStock` on the full key set first, then `applyMovement` per key in the same sorted order. `reserveAllocations` re-checks `on_hand − reserved − buffer ≥ qty` per key after locking and throws `AppError('stock_changed', 409, …, { lines: [{variantId, available}] })` with the online availability of each short key.

- [ ] **Step 1: Failing tests `stockLocking.test.ts`:**
  - `sortStockKeys` orders by variant, then branch, and dedupes;
  - reserving with buffer 1 and on_hand 3 → 2 allowed, 3 → `stock_changed`;
  - commit lowers both on_hand and reserved and writes `order_commit` movements;
  - release writes `order_release`;
  - **deadlock check:** two concurrent transactions, one reserving keys [B@x, A@y] and the other [A@y, B@x], with a `pg_sleep(0.2)` between the lock and the commit, both finish with no `40P01` (run 5 rounds);
  - existing `recordSale` / `transferStock` tests still pass.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: one ordered stock-locking helper for reservations, commits, sales and transfers`.

### Task 4: Checkout pricing and quote

**Files:** `src/modules/checkout/pricing.ts`, `src/modules/checkout/router.ts`, `src/modules/cart/service.ts` (refactor `cartView` to use `pricedCheckout`), `src/modules/settings/payments.ts`, `src/app.ts`, `test/integration/checkoutQuote.test.ts`

**Interfaces — Produces:**
```ts
// checkout/pricing.ts
export interface PricedCheckout {
  cart: CartRow | undefined; items: CartItemRow[]; infos: Map<string, VariantInfo>;
  pricing: Breakdown; view: CartView; promotionId: string | null;
}
export async function pricedCheckout(db: Exec, cart: CartRow | undefined,
  opts: { user?: Pick<UserRow,'id'|'phoneE164'>; delivery: DeliveryChoice; lang: Lang; assetBase: string; now?: Date; promoOverride?: string | null }): Promise<PricedCheckout>;
// settings/payments.ts
export type PaymentMethodsEnabled = Record<PaymentMethod, boolean>;
export async function paymentMethodsEnabled(db: Exec): Promise<PaymentMethodsEnabled>;
export function availablePaymentMethods(enabled: PaymentMethodsEnabled, fulfillment: 'delivery'|'pickup'): PaymentMethod[]; // cash_on_pickup only for pickup
```
`VariantInfo` and `variantInfo` move to `src/modules/cart/variants.ts` (exported) so checkout can reuse them; `cartView` becomes a thin wrapper that returns `pricedCheckout(...).view`. `Exec = Db | Tx`.

`POST /v1/checkout/quote` (guestOrMember, `no-store`), with body `{ fulfillment, shippingMethodId?, provinceCode?, pickupBranchId?, promoCode?, lang? }` → `{ cart: CartView, shippingOptions: [{ methodId, name, feeCents | null, available, eta }], pickupBranches: [{ id, name }], paymentMethods: PaymentMethod[] }`.
- `shippingOptions` lists `pp_rider` and `province_courier` for the given province, each with the fee **as this cart would pay it** (that is, `priceCart` run with that method: free thresholds and the Gold perk applied).
- `promoCode` prices with that code without saving it.

- [ ] **Step 1: Failing tests `checkoutQuote.test.ts`:**
  - for the same cart and delivery, `quote.cart.pricing` deep-equals `GET /v1/cart`'s `pricing`, for a guest and for a Silver member;
  - province 17 → `pp_rider` unavailable, courier 300;
  - `fulfillment: pickup` + `sensok` → shipping 0;
  - `promoCode: 'CASTLE10'` applies but `GET /cart` still has no promo;
  - payment methods = `['aba_khqr','card']`; after the setting enables `cash_on_pickup`, it appears only for pickup (restore the setting);
  - an empty cart → `checkoutReady false`, no 500;
  - every existing cart test still passes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: checkout quote priced by the same engine as the cart`.

### Task 5: Payment providers (fake + PayWay) and config

**Files:** `src/modules/payments/provider.ts`, `src/modules/payments/fake.ts`, `src/modules/payments/payway/{client.ts,mapping.ts,hash.ts}`, `src/config/env.ts`, `.env.example`, `test/unit/payway.test.ts`, `test/unit/fakePayments.test.ts`, `test/unit/config.test.ts`

**Interfaces — Produces:**
```ts
export type ProviderStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'refunded' | 'expired';
export type PaymentInstructions =
  | { kind: 'qr'; qrString: string; deeplink: string | null; expiresAt: string }
  | { kind: 'redirect'; url: string; method: 'GET' | 'POST'; fields: Record<string, string>; expiresAt: string }
  | { kind: 'none' };   // cash on pickup
export interface CreateTransactionInput { tranId: string; method: PaymentMethod; amountCents: number; expiresAt: Date;
  customer: { firstName: string; lastName: string; phone: string; email: string | null }; items: { name: string; qty: number; priceCents: number }[] }
export interface TransactionCheck { status: ProviderStatus; amountCents: number | null; raw: unknown }
export interface WebhookVerification { valid: boolean; tranId: string | null; eventId: string; reason?: string; claimedStatus: ProviderStatus | null }
export interface PaymentProvider {
  readonly name: 'payway' | 'fake';
  createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }>;
  checkTransaction(tranId: string): Promise<TransactionCheck>;
  cancelTransaction(tranId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification;
}
export function createPaymentProvider(config: Config, fetchImpl?: typeof fetch): PaymentProvider; // PayWay when PAYWAY_MERCHANT_ID+API_KEY set, else fake
// fake.ts
export class FakePaymentProvider implements PaymentProvider {
  approve(tranId: string, amountCents?: number): void; decline(tranId: string): void;
  failNextCreate(): void; readonly created: CreateTransactionInput[]; readonly cancelled: string[];
  sign(body: string): string; // HMAC-SHA512 base64 with a fixed dev secret, header x-fake-signature
}
```
PayWay (`payway/mapping.ts` holds every field name and URL; the file starts with `// VERIFY AGAINST PAYWAY SANDBOX`):
- `hash.ts`: `paywayHash(values: string[], apiKey): string` = base64(HMAC-SHA512(values.join(''), apiKey)); `safeEqualB64(a, b)`.
- KHQR: `POST {base}/api/payment-gateway/v1/payments/generate-qr`, JSON `{req_time (YYYYMMDDHHmmss UTC), merchant_id, tran_id, first_name, last_name, email, phone, amount ("12.50"), purchase_type: "purchase", payment_option: "abapay_khqr", items (base64 JSON), currency: "USD", callback_url (base64 of PAYWAY_RETURN_URL), return_deeplink: "", custom_fields: "", return_params: "", payout: "", lifetime (minutes), qr_image_template: "template3_color", hash}`. The hash runs over the same fields in that order (minus hash) → response `{qrString, abapay_deeplink, status:{code:"0"}}`.
- Card: a redirect form to `{base}/api/payment-gateway/v1/payments/purchase`, method POST, fields `{req_time, merchant_id, tran_id, amount, items, firstname, lastname, email, phone, type:"purchase", payment_option:"cards", return_url (base64), continue_success_url, currency:"USD", lifetime, hash}`, with the hash over the purchase-API field order.
- Check: `POST {base}/api/payment-gateway/v1/payments/check-transaction-2` `{req_time, merchant_id, tran_id, hash(req_time+merchant_id+tran_id)}` → `data.payment_status` (`APPROVED|PENDING|DECLINED|REFUNDED|CANCELLED`) and `data.total_amount`.
- Cancel: `POST …/close-transaction` with the same fields as check.
- Webhook: JSON `{tran_id, apv, status, return_params?}`. PayWay's pushback is not reliably signed, so `verifyWebhook` validates the shape and the tran_id pattern, sets `eventId = tran_id:status:apv`, and returns `valid: true` only for well-formed bodies. **The trust decision is the signed check-transaction call (Task 8)**. A `hash` field, when present, is verified with `paywayHash([tran_id, apv, status])` and must match.
- Errors (network, non-2xx, `status.code !== "0"`) → `AppError('payment_provider_error', 502, 'The payment service is not responding; please try again')`; the raw response goes into the returned `raw`, never the logs.
- Config additions: `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY`, `PAYWAY_BASE_URL` (default `https://checkout-sandbox.payway.com.kh`), `PAYWAY_RETURN_URL` (the webhook URL), `PAYWAY_CONTINUE_URL`, `PUBLIC_API_URL` (default `http://localhost:3000`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, `JOBS_ENABLED` (default true; false in tests).
  - In production the PayWay vars are required unless `PAYMENT_METHODS_CASH_ONLY=true`. That env flag stands in for the setting, because config can't read the DB; record it as a Ruling.
  - Merchant id and key must be set together.

- [ ] **Step 1: Failing tests.**
  - `payway.test.ts` (a fake `fetch` records requests):
    - `paywayHash(['a','b'],'k')` equals the base64 HMAC-SHA512 computed independently in the test;
    - the KHQR request has all the fields above, `amount` "12.50" for 1250, a hash that verifies, and maps to `{kind:'qr', qrString, deeplink}`;
    - card → `{kind:'redirect', method:'POST'}` with the purchase URL and a verifying hash;
    - check maps APPROVED/PENDING/DECLINED/REFUNDED/CANCELLED and `total_amount` "12.50" → 1250;
    - an HTTP 500 → `payment_provider_error`;
    - webhook: a valid body → valid with `eventId`; garbage → invalid; a wrong `hash` → invalid.
  - `fakePayments.test.ts`:
    - create → a qr instruction; check → pending; `approve` → approved; `decline` → declined;
    - `failNextCreate` → the next create throws `payment_provider_error`;
    - `verifyWebhook` with a good `x-fake-signature` → valid, a bad one → invalid.
  - `config.test.ts`:
    - production without PayWay vars → error naming `PAYWAY_MERCHANT_ID`;
    - production with `PAYMENT_METHODS_CASH_ONLY=true` → ok;
    - a merchant id without a key → error.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `createApp` accepts an optional `payments?: PaymentProvider` (default `createPaymentProvider(config)`) and stores it on `AppContext`. **Step 4:** PASS. Commit `feat: PayWay and fake payment providers behind one interface`.

### Task 6: Notifications outbox and senders

**Files:** `src/modules/notifications/{notifier.ts,telegram.ts,resend.ts,templates.ts,outbox.ts}`, `test/unit/notificationTemplates.test.ts`, `test/unit/notifiers.test.ts`, `test/integration/outbox.test.ts`

**Interfaces — Produces:**
```ts
export interface OutgoingMessage { channel: 'telegram' | 'email'; to: string; subject: string; text: string; html?: string }
export interface Notifier { readonly channel: 'telegram' | 'email'; readonly configured: boolean; send(m: OutgoingMessage): Promise<void> }
export function telegramNotifier(cfg: { botToken?: string; chatId?: string }, fetchImpl?: typeof fetch): Notifier; // to='ops' → chatId
export function resendNotifier(cfg: { apiKey?: string; from?: string }, fetchImpl?: typeof fetch): Notifier;
export class FakeNotifier implements Notifier { sent: OutgoingMessage[]; failNext(n: number): void }
export type Template = 'order_placed' | 'payment_received' | 'status_changed' | 'needs_refund';
export function render(template: Template, payload: OrderNotice, channel: 'telegram'|'email'): { subject: string; text: string; html?: string };
export interface OrderNotice { number: string; status: string; totalCents: number; totalKhr: number; contactName: string; contactPhone: string; contactChannel: string; fulfillment: string; items: { name: string; size: string; qty: number }[]; reason?: string }
export async function enqueueOrderNotifications(tx: Exec, event: 'order_placed' | 'payment_received' | 'status_changed' | 'needs_refund', orderId: string): Promise<void>;
export async function processOutbox(db: Db, notifiers: { telegram: Notifier; email: Notifier }, now: Date, limit?: number): Promise<{ sent: number; failed: number; skipped: number }>;
```
Routing:
- `order_placed` → ops telegram;
- `payment_received` → ops telegram, plus a customer email when `contact_email` is set;
- `status_changed` → a customer email when set;
- `needs_refund` → ops telegram with the subject prefix `🔴 URGENT`.

Outbox processing:
- Claim with `for update skip locked`, limit 20.
- On success → `sent`.
- On failure → attempts+1, `next_attempt_at = now + min(2^attempts, 60) minutes`, `last_error` = the message truncated to 300 chars; after 8 attempts → `failed`.
- An unconfigured notifier → `skipped`.
- The HTML is escaped (port `escapeEmailHtml`).
- Telegram: `POST https://api.telegram.org/bot<token>/sendMessage {chat_id, text, disable_web_page_preview:true}`.
- Resend: `POST https://api.resend.com/emails {from, to:[to], subject, text, html}` with `Authorization: Bearer`.

- [ ] **Step 1: Failing tests.**
  - Templates: the payment-received email contains the number and `$52.50`, and contains no `<script>` from a name `<script>x</script>` (escaped); `needs_refund` telegram starts with `🔴 URGENT`.
  - Notifiers: the Telegram request URL/body; Resend's auth header; a non-2xx → throws; unconfigured → `configured false`.
  - Outbox (DB): enqueue `payment_received` for an order with an email → 2 rows; `processOutbox` with fakes → both sent; a failing email → attempts 1 and `next_attempt_at` ≈ now+2 min; at 8 failures → `failed`; an unconfigured email notifier → `skipped`; two concurrent `processOutbox` calls send each message once.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: notification outbox with Telegram and Resend senders`.

### Task 7: Place an order

**Files:** `src/modules/checkout/{orderInput.ts,placeOrder.ts,idempotency.ts,serializable.ts,orderToken.ts}`, `src/modules/orders/{view.ts,events.ts,access.ts}`, `src/modules/checkout/router.ts`, `test/integration/placeOrder.test.ts`, `test/integration/placeOrderConcurrency.test.ts`, `test/unit/orderToken.test.ts`

**Interfaces — Produces:**
```ts
export const placeOrderSchema: ZodType<PlaceOrderInput>;
// { contact:{name 1–120, phone→E164, email?: email|null, channel}, fulfillment, addressId?: uuid, address?: guest address (addressCreateSchema fields minus label/isDefault),
//   pickupBranchId?, shippingMethodId?, provinceCode? (derived from the address; not accepted), paymentMethod, note?: ≤500, acceptTerms: literal(true), lang? }
export async function withSerializable<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T>; // retries 40001 and 40P01
export function signOrderToken(number: string, secret: string, now: Date, ttlMs = 86_400_000): string;
export function verifyOrderToken(token: string, number: string, secret: string, now: Date): boolean;
export async function withIdempotency(db: Db, scope: string, key: string, requestHash: string, fn: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }>;
export async function placeOrder(deps: { db: Db; payments: PaymentProvider; config: Config; now: () => Date }, owner: CartOwner, user: UserRow | undefined, input: PlaceOrderInput): Promise<PlacedOrder>;
export interface PlacedOrder { order: OrderView; payment: PaymentView | null; paymentError: string | null; orderAccessToken: string | null }
export async function startPaymentAttempt(deps, orderId: string, method: PaymentMethod): Promise<PaymentView>; // creates attempt N+1, cancels earlier pending attempts (best effort)
export async function recordEvent(tx: Exec, e: { orderId; from?: OrderStatus|null; to?: OrderStatus|null; kind: 'status'|'payment'|'note'|'flag'; actor: string; note?: string }): Promise<void>;
export function orderView(order: OrderRow, items: OrderItemRow[], extras: { events?: OrderEventRow[]; payments?: PaymentRow[] }): OrderView;
export async function findOrderForAccess(db: Db, number: string, who: { user?: UserRow; token?: string; phone?: string }, secret: string, now: Date): Promise<OrderRow>; // 404 order_not_found otherwise
```
`POST /v1/orders` (guestOrMember; rate limits arrive in phase 7):
- `Idempotency-Key` must be a uuid, otherwise `400 idempotency_key_required`. Scope = `user:<id>`, `guest:<cart token>`, or `ip:<ip>` when there is no cart. The request hash = sha256 of the canonical JSON of the parsed body.
- Idempotency rules:
  - A replay with the same hash returns the stored status + body.
  - A different hash → 422 `idempotency_mismatch`.
  - A row without a response that is younger than 60 s → 409 `request_in_progress`; an older one is taken over.
  - Only 2xx responses are stored; on a 4xx/5xx the key row is deleted, so the customer can fix the cart and retry with the same key.
- Validation before the transaction:
  - `addressId` must belong to the member (404 otherwise); guests must send `address`.
  - Delivery needs `shippingMethodId`; pickup needs a `pickup_enabled` branch.
  - The payment method must be enabled and available for the fulfillment (`payment_method_unavailable`).
  - The guest address goes through the same hierarchy check as phase 2 addresses (export `assertHierarchy` from `account/addresses.ts`).
- The transaction (`withSerializable`):
  1. `findCart(tx, owner, true)`; no cart or no lines → 400 `cart_empty`.
  2. `pricedCheckout` with the delivery from the input. `!view.checkoutReady` → 409 `checkout_not_ready` with `details.lines` (`{lineId, problem}`) or `details.shipping: 'unavailable'`.
  3. When a promotion applied:
     - lock the promotion row `for update`;
     - global limit: `used_count < max_uses`, else 409 `promo_limit_reached`;
     - per-user limit: count `promotion_redemptions` + this promotion's pending/awaiting orders for this user id or contact phone, which must be < `max_uses_per_user`, else 409 `promo_limit_reached`;
     - `used_count += 1`.
  4. Load online availability per (variant, branch) for the cart's variants (branch `sort` included), `planAllocations`, and on a shortfall → 409 `stock_changed { lines: [{lineId, available}] }`. Then `reserveAllocations(tx, …, refId = order number)`.
  5. Insert the order: status `pending_payment`, or `awaiting_pickup_payment` for cash, with `reserved_until = now + reservation_minutes` (cash: `cash_on_pickup_hours`). Insert the items with snapshots and the allocations, and record the event (`null → pending_payment`, actor `customer`).
  6. Delete the cart's items and clear its promo code.
  7. Enqueue `order_placed`.
- After commit: unless cash, `startPaymentAttempt`. A provider failure leaves the order and returns `payment: null, paymentError`.
- The response is 201 `PlacedOrder`; `orderAccessToken` is set for guests only.
- `OrderView` = `{ number, status, paymentStatus, paymentMethod, fulfillment, contact, shipAddress, pickupBranch, items[{id, productSlug, name, brand, size, color, imageUrl, qty, unitPriceCents, printFeeCents, discountCents, lineTotalCents, customPrint}], pricing{merchandiseCents, discountCents, shippingCents, totalCents, totalKhr, discounts}, reservedUntil, createdAt, needsRefund? (staff only, omitted here) }`. The allocations are never in customer views.
- `PaymentView` = `{ attempt, method, status, tranId, instructions, amountCents, expiresAt }`.

- [ ] **Step 1: Failing tests.**
  - `orderToken.test.ts`: round trip; the wrong number → false; expired → false; tampered → false.
  - `placeOrder.test.ts` (catalog imported, `FakePaymentProvider`, `FakeNotifier`):
    - Guest, 2 × jersey M, `pp_rider` province 12 address, KHQR:
      - 201;
      - the number matches the pattern;
      - `total_cents` equals `GET /cart`'s total (taken just before) **to the cent**;
      - `payment.instructions.kind === 'qr'`;
      - `reserved` +2 split per the plan;
      - the cart is empty after;
      - an `order_reserve` movement with ref = the number;
      - `reserved_until` = created + 30 min (±5 s);
      - an `order_placed` outbox row;
      - `orderAccessToken` is present.
    - Member with `addressId` + Silver tier → the order discount equals the cart's member discount; `orderAccessToken` null.
    - Missing `Idempotency-Key` → 400.
    - Same key twice → the same body, one order row.
    - Same key, different body → 422.
    - `acceptTerms: false` → 400.
    - A disabled method `wing` → 400 `payment_method_unavailable`.
    - Another member's `addressId` → 404.
    - An archived product in the cart → 409 `checkout_not_ready`, and the key can be reused after removing the line.
    - Pickup at sensok when only sonthormuk has stock → 409 `stock_changed`.
    - Delivery split across branches → two allocations.
    - Prices sent in the body (`totalCents: 1`) are ignored.
    - `CASTLE10` with `max_uses_per_user 1`: first order ok, a second order from the same phone → 409 `promo_limit_reached`.
    - `failNextCreate` → 201 with `payment: null` and a `paymentError`.
    - Cash on pickup (setting enabled, then restored) → `awaiting_pickup_payment`, `instructions.kind 'none'`, `reserved_until` +48 h.
    - Logs: capture logger output during a guest order; the contact phone digits don't appear.
  - `placeOrderConcurrency.test.ts`:
    - stock = 2 on one branch only (buffer 1 → 1 sellable); two guests with 1 unit each POST at the same time → exactly one 201 and one 409 `stock_changed`; `reserved = 1`; repeated 5 times;
    - the same idempotency key fired twice concurrently → one order (one 201 + either the same 201 replay or 409 `request_in_progress`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (twice). Commit `feat: place orders with serializable stock reservation and idempotency keys`.

### Task 8: Confirming payments: webhook, poll, retry and dev approve

**Files:** `src/modules/payments/{confirm.ts,router.ts,devRouter.ts,check.ts}`, `src/modules/loyalty/award.ts`, `test/integration/paymentConfirm.test.ts`, `test/integration/paymentRoutes.test.ts`

**Interfaces — Produces:**
```ts
export async function applyProviderResult(deps: { db: Db; now: () => Date }, tranId: string, check: TransactionCheck, source: 'webhook'|'poll'|'sweeper'|'dev'): Promise<'approved'|'already'|'pending'|'declined'|'unknown'|'needs_refund'>;
export async function refreshPayment(deps: { db; payments: PaymentProvider; now }, payment: PaymentRow, opts?: { minIntervalMs?: number }): Promise<PaymentRow>; // claims last_checked_at atomically; at most one provider call per 5 s per order
export async function awardLoyalty(tx: Tx, order: OrderRow, rules: LoyaltyRules): Promise<void>;
```
`applyProviderResult` runs in one transaction:
- Lock the payment, then its order (`for update`, payment first, then order, everywhere).
- **Approved:**
  - If the payment is already approved → `already`.
  - If `amountCents` ≠ the payment amount → the payment is approved, the order gets `needs_refund`, flag event + `needs_refund` notification → `needs_refund`.
  - If the order is already paid (another attempt) → the payment is approved, `needs_refund`, notify → `needs_refund`.
  - If the order is `pending_payment` → `commitAllocations`, status → `printing` if any item has `custom_print`, else `confirmed`; `payment_status paid`, `paid_at`, a redemption row (when there's a `promotion_id`), `awardLoyalty`, events (payment + status), enqueue `payment_received`; earlier pending attempts → `cancelled` → `approved`.
  - If the order is `expired` or `cancelled` → try `reserveAllocations` with a fresh `planAllocations` (same fulfillment/branch) then commit, the transition `expired → confirmed|printing`, and `used_count += 1` when there's a promotion; on `stock_changed` → mark paid + `needs_refund`, status unchanged, notify urgent → `needs_refund`.
- **Declined / cancelled / expired** → the payment status is updated and the order is unchanged (the customer can retry).
- **Pending** → `last_checked_at` only.

Routes (all `no-store`):
- `POST /v1/webhooks/payway` (no auth, no general rate limit; the raw body is required):
  - `verifyWebhook` → store the event (on a conflict on (provider, event_id), re-run processing only if the stored status is `failed`).
  - Invalid → `rejected`, `401 invalid_signature`.
  - Valid → `checkTransaction(tranId)` → `applyProviderResult(source 'webhook')` → `processed`. If the provider says not approved while the webhook claimed approved → `rejected` with error `status_mismatch`, and the response is still 200 (no retry storm).
  - An unknown tran id → `ignored`, 200.
  - The response body is `{ok:true}` only.
- `GET /v1/orders/:number/payment-status` (member owner or `X-Order-Token`) → `refreshPayment` on the latest pending attempt (throttled) → `{ status, paymentStatus, latestPayment: PaymentView, reservedUntil }`.
- `GET /v1/orders/:number` (member owner or `X-Order-Token`) → `{ order: OrderView, payment: PaymentView | null }`.
- `POST /v1/orders/:number/payments { method, contactPhone?, orderAccessToken? }` (member owner, or guest token + phone):
  - only while `pending_payment` and before `reserved_until`, else 409 `order_not_payable`;
  - the method must be enabled and not `cash_on_pickup`;
  - → `startPaymentAttempt` → 201 `{ payment }`.
- Dev (only fake + non-production):
  - `POST /v1/dev/payments/:tranId/approve` → `fake.approve` + `applyProviderResult(source 'dev')` → `{ result }`;
  - `GET /v1/dev/payments/:tranId/checkout` → a minimal HTML page with an "Approve test payment" button (POST approve, then redirect to `PAYWAY_CONTINUE_URL`).

- [ ] **Step 1: Failing tests.**
  - `paymentConfirm.test.ts`:
    - approve → `confirmed`, `paid`; on_hand −2, reserved −2; one `order_commit` per allocation; an outbox `payment_received`;
    - a printed line → `printing`;
    - a Silver member with a verified phone, $52.50 total including $2.50 shipping → +500 points, lifetime +5000, one ledger row; reaching 15,000 → tier silver;
    - an unverified member → no loyalty row;
    - **3× webhook** (the same body) → one commit, one ledger row, one redemption, and the events are recorded once each (the 2nd and 3rd deduped);
    - **poll + webhook in parallel** (`Promise.all`) → one commit;
    - **forged:** a webhook claiming approved while the fake check says pending → order still `pending_payment`, event `rejected`;
    - a fake signature mismatch → 401 and stored with `signature_valid false`;
    - an unknown tran id → 200 `ignored`;
    - **paid after expiry, stock available** → `confirmed`, stock committed;
    - **paid after expiry, stock gone** → `needs_refund` true, an urgent outbox row, status `expired`;
    - **second approval** on another attempt → `needs_refund`;
    - **amount mismatch** → `needs_refund`, not committed.
  - `paymentRoutes.test.ts`:
    - status poll with a good token → pending; with another order's token → 404; without a token as a guest → 404; as the owning member → 200, another member → 404;
    - poll twice within 5 s → one provider check (count the fake's `checkCalls`);
    - retry with `card` → attempt 2, `redirect` instructions, attempt 1 `cancelled` with `fake.cancelled` containing its tran id;
    - retry with a wrong phone → 404; retry after expiry → 409;
    - the dev approve route works in test, and `createApp` with `nodeEnv: 'production'` (and the fake) has no `/v1/dev` route (404);
    - `GET /v1/orders/:number` with a token returns no allocations and no `needsRefund`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (twice). Commit `feat: idempotent payment confirmation via webhook, poll and retry`.

### Task 9: Sweeper, scheduler and wiring

**Files:** `src/jobs/{scheduler.ts,sweeper.ts}`, `src/server.ts`, `src/app.ts` (return the context for the scheduler), `README.md`, `.env.example`, `test/integration/sweeper.test.ts`, `test/integration/server.test.ts`

**Interfaces — Produces:**
```ts
export interface SweepDeps { db: Db; payments: PaymentProvider; notifiers: { telegram: Notifier; email: Notifier }; logger: Logger; now: () => Date }
export async function sweepOnce(deps: SweepDeps): Promise<{ checked: number; expired: number; notifications: { sent; failed; skipped }; guestCartsDeleted: number }>;
export async function expireOrder(deps, orderId: string, reason: 'timeout'): Promise<boolean>; // release allocations, cancel provider attempts, refund promo used_count, status expired, event, status_changed notice
export function startScheduler(deps: SweepDeps & { intervalMs?: number; lockKey?: number }): { stop(): Promise<void>; runNow(): Promise<void> };
```
`sweepOnce` steps, each in its own try/catch so one failure doesn't stop the others:
1. `pg_try_advisory_lock(727001)` on a dedicated pool client; not acquired → return zeros. Unlock in `finally`.
2. Payments `pending` whose order is `pending_payment`, oldest `last_checked_at` first, limit 50 → `refreshPayment` + `applyProviderResult(source 'sweeper')`.
3. Orders `pending_payment|awaiting_pickup_payment` with `reserved_until < now` → `expireOrder` each in its own transaction, which re-checks the status under the lock (a payment that landed meanwhile wins).
4. `processOutbox`.
5. Delete guest carts with `updated_at < now − 60 days` (closes the phase 4 minor).

`startScheduler` uses `setInterval(60_000)` (unref'd), skips a tick while one is running, and `stop()` waits for the running tick. `server.ts` starts it when `JOBS_ENABLED` and stops it before closing the pool.

- [ ] **Step 1: Failing tests `sweeper.test.ts`** (injected `now`):
  - an order past `reserved_until` → `expired`, reserved back to 0, an `order_release` movement, the fake's `cancelled` has its tran id, promo `used_count` decremented, a `status_changed` outbox row;
  - an order approved at the provider but not yet confirmed → the sweeper confirms it **instead of** expiring it, even when it is also past `reserved_until`;
  - a held advisory lock (taken by another client in the test) → `sweepOnce` does nothing;
  - a guest cart 61 days old is deleted, while a 59-day-old one and member carts are kept;
  - a cash order expires after 48 h;
  - `startScheduler(...).stop()` resolves while a tick is mid-run;
  - `server.test.ts`: start with `JOBS_ENABLED=false` → no timer (the process exits cleanly in the existing test).
- [ ] **Step 2:** FAIL. **Step 3:** Implement + README:
  - the checkout/orders/payments endpoint table;
  - the payment flow;
  - the fake provider + dev approve;
  - the PayWay env vars;
  - the sweeper;
  - notifications.
  
  Also `.env.example`.
- [ ] **Step 4:** PASS. Run the whole suite twice, then typecheck + build. Commit `feat: per-minute sweeper for payments, expiry, notifications and stale guest carts`.

---

## Deferred (not in phase 5)

- Admin order screens, tracking, returns, the loyalty read API, the webhook and notification log views: phase 6.
- Marking a cash-on-pickup order paid at the counter (`awaiting_pickup_payment → ready_for_pickup` with a stock commit): phase 6 admin orders, which reuse `commitAllocations` and `awardLoyalty`.
- Per-route rate limits on order create and the webhook: phase 7.
