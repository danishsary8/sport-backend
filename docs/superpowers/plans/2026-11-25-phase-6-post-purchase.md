# Phase 6 — Post-purchase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After paying, customers can track an order (guests by number + phone, members in their account), ask for a size exchange or a refund, see their loyalty points and buying insights, and ask product questions. Staff run orders end to end (status, pick lists, cancel, refunds, cash at the counter, notes), handle returns and questions, and admins see an overview, webhook/notification logs and system health. Everything still in `legacy/` is ported or dropped, and `legacy/` is deleted.

**Architecture:**
- `modules/orders` gains customer tracking (`tracking.ts`) and staff operations (`admin.ts`, with `adminRouter.ts`). Every staff action goes through `transitionOrder()` (status machine + event + notification).
- `modules/rma` holds pure window/amount rules (`rules.ts`) plus the service and routers.
- `modules/loyalty` adds the read API, insights and admin adjustments.
- `modules/questions` is Q&A.
- `modules/admin/overviewRouter.ts` and `modules/admin/logsRouter.ts` hold the overview and the logs.
- `modules/health/system/*` ports the legacy system-health service with an injected pool (no PDF).

**Tech Stack:** as phase 5. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` §11 (status machine, tracking), §13 (account, Q&A, returns, loyalty), §14 (admin orders, Q&A moderation, RMA approval, monitoring), §15 (RMA/question notifications); work order Stage 2.

## Global Constraints

- Everything in phase 5's Global Constraints still applies (cents, `applyMovement` + `lockStock` order, `AppError`, no PII in logs, `no-store` on user/staff responses).
- Tracking: `POST /v1/orders/track {orderNumber, phone}`, rate limited to 10/min/IP. The phone is normalised with `normalizePhone`. Any mismatch → `404 order_not_found`. The address is masked: `recipientName` reduced to its first name + initial, street/landmark/lat/lng/phone removed, commune/district/province names kept.
- Staff scope: staff with `staff_branch_id` see and act on orders that have an allocation at their branch (pickup orders: their branch is the pickup branch). Admins and unscoped staff see everything. Out of scope → 404.
- Status changes by staff use the phase 5 machine. Extra guards:
  - `out_for_delivery`, `delivered` and `completed` need `payment_status = 'paid'`;
  - `ready_for_pickup` needs fulfillment `pickup`;
  - `out_for_delivery` needs `delivery`.
  
  The first move into `delivered` (delivery) or `completed` (pickup) sets `orders.delivered_at`, which starts the return windows. Customer-visible moves enqueue `status_changed`.
- Cancel (staff):
  - Unpaid (`pending_payment`, `awaiting_pickup_payment`) → release reservations, give back the promo use, cancel provider attempts.
  - Paid and not yet dispatched (`confirmed`, `printing`, `ready_for_pickup`) → put the committed units back on the shelf (`order_cancel` movement at each allocation's branch), reverse the order's loyalty (ledger `order_cancelled`, −points, −spend, tier recomputed), set `needs_refund`.
- Cash on pickup at the counter: `POST …/collect-cash` (from `awaiting_pickup_payment` or `ready_for_pickup`, unpaid) → commit allocations, paid, loyalty, promo redemption, status `completed` (via `ready_for_pickup` when needed), `delivered_at` set.
- Returns (`settings.return_rules`, seeded `{exchangeDays: 30, refundDays: 14, nonReturnable: ['socks', 'underwear']}`):
  - members only, own orders, `delivered_at` set and status `delivered` or `completed`;
  - a `nonReturnable` entry matches the product's category slug, its `attributes.garmentType`, or a whole hyphen-separated word of its slug (`…-grip-socks` matches `socks`);
  - lines with `custom_print` are never returnable;
  - qty ≤ purchased − already requested (requested or approved RMAs);
  - size exchange: ≤ `exchangeDays` after `delivered_at`; the replacement is the same product at the same unit price, reserved now (`exchange_reserve`) from the branch with the most online availability;
  - refund / store credit: ≤ `refundDays`;
  - refund amount per line = `round(line_total_cents × qty / item.qty)` (promo, team and member discounts are already inside `line_total_cents`; shipping is never refunded).
  
  RMA numbers are `RMA-YYMM-XXXXX`.
- RMA decision (staff/admin, branch-scoped like orders):
  - approve → returned units go back on the shelf at `branchId` (body; default: the item's first allocation branch) with `rma_restock`;
  - refund / store credit → loyalty reversal (`rma_reversal`: −`floor(refund × pointsPerUsd / 100)` points, −refund spend, tier recomputed) and the order's `needs_refund` set (refund) or an event note "store credit to issue" (store credit; there is no store-credit wallet yet);
  - exchange → the held replacement leaves the shelf (`exchange_commit` movement);
  - reject → the held replacement is released (`exchange_release`).
  - Customer gets an email; ops get Telegram on new requests.
- Loyalty read: `GET /v1/me/loyalty` → `{ pointsBalance, tier, lifetimeSpendCents, nextTier: {id, minSpendCents, remainingCents} | null, perks: {memberDiscountPercent?, memberDiscountCategories?, freeDelivery?, freePrinting?}, phoneVerified, ledger: [{delta, reason, orderNumber, note, createdAt}] (latest 50) }`. Admin adjust: `POST /v1/admin/users/:id/loyalty {delta (−100000..100000, ≠0), note (1–200)}` → ledger `admin`.
- Insights: `GET /v1/me/insights` (paid orders only) → `{ totalOrders, totalItems, totalSpendCents, customPrintedCount, categories: Slice[], brands: Slice[], favoriteCategory, favoriteBrand }`, with `Slice = {key, label, itemCount, orderCount, spendCents, sharePct}`, sorted by spend desc.
- Q&A:
  - `GET /v1/catalog/products/:slug/questions` → published only: `{id, authorName, question, answer, answeredAt, createdAt}` (cacheable 60 s, no user ids);
  - `POST` (guest or member) `{authorName 1–60, question 5–500}` → 201 `{status:'pending'}`, rate limited 5/min/IP;
  - admin: `GET /v1/admin/questions?status=&page=` and `PATCH /v1/admin/questions/:id {answer?, status?: published|hidden}`; publishing needs an answer.
- Admin overview `GET /v1/admin/overview` (staff + admin; scoped staff see their branch where it applies), with "today" in Asia/Phnom_Penh: `{ today: {orders, paidOrders, revenueCents}, pendingPayments, needsRefund, awaitingFulfilment: {confirmed, printing, readyForPickup, outForDelivery}, openReturns, pendingQuestions, lowStockRows (online available 1–3), needsCountRows, outboxFailed }`.
- Logs (admin): `GET /v1/admin/payments/webhooks?status=&page=` (payloads included: no PII in PayWay pushbacks), `GET /v1/admin/notifications?status=&page=` (recipient masked as `ops` or `d***@example.com`, no payload), `POST /v1/admin/notifications/test {channel}` → sends one test message directly (not via the outbox) and returns `{sent: boolean, error?}`.
- System health (admin): `GET /v1/admin/system-health`, `/metrics?limit=&thresholdMs=&probe=`, `/logs.csv`. The shapes are the legacy `SystemHealthSnapshot` / `SystemHealthMetricsResponse` (engine label `PostgreSQL`); the probe is `select 1` timed on the app pool. The PDF report is **dropped server-side** (the frontend already renders it from `/metrics` with jsPDF).
- New movement reasons: `order_cancel`, `exchange_commit`, `exchange_release`. New loyalty ledger reason: `order_cancelled`.

## Review Focus

1. **Return windows at the edges:** an exchange on day 29 and day 31, a refund on day 13 and day 15, all counted from `delivered_at` in whole days; a refund amount on a discounted line (team/promo) is exactly the paid share, never more than was paid; two RMAs for the same line can't exceed the qty bought. Pinned in Tasks 1 and 4.
2. **A staff member at Sen Sok** can't see, change, cancel or pick another branch's order (404), and can't approve another branch's return. Pinned in Tasks 3 and 4.
3. **Cancelling a paid order twice, or racing cancel and delivery** → stock is put back once and points reversed once (status re-checked under the order row lock). Pinned in Task 3.
4. **Tracking never leaks:** a wrong phone, another order's phone or a malformed number gives the same 404; the masked address has no street or phone; it is rate limited. Pinned in Task 2.
5. **Q&A abuse:** HTML in a question is stored as text and returned as JSON (no HTML rendering server-side); pending/hidden questions never appear publicly; an over-long body → 400; the 6th post in a minute → 429. Pinned in Task 6.

---

## Data model (migration `0006_post_purchase.sql`)

- `orders.delivered_at timestamptz null`.
- `rma_requests`: id uuid, number text unique, order_id FK, user_id FK, resolution `refund|size_exchange|store_credit`, status `requested|approved|rejected`, refund_cents int default 0, note (customer) null, decision_note null, decided_by uuid null FK users, decided_at null, created_at. Index (user_id, created_at), (status, created_at).
- `rma_items`: id uuid, rma_id FK cascade, order_item_id FK, qty > 0, reason text (1–300), exchange_variant_id null FK variants, exchange_branch_id null FK branches, refund_cents int ≥ 0.
- `product_questions`: id uuid, product_id FK cascade, user_id null FK set null, author_name, question, answer null, answered_by null, answered_at null, status `pending|published|hidden` default pending, created_at. Index (product_id, status, created_at).
- The `loyalty_ledger` reason check gains `order_cancelled`.
- Setting `return_rules` seeded when missing.

---

### Task 1: Schema, return rules and RMA maths (pure)

**Files:** `src/db/schema/postPurchase.ts`, `src/db/schema/orders.ts` (deliveredAt, ledger check), `src/db/schema/index.ts`, `src/db/seed/index.ts`, `drizzle/0006_*.sql`, `src/modules/rma/rules.ts`, `src/modules/stock/service.ts` (reasons), `test/unit/rmaRules.test.ts`, `test/integration/postPurchaseSchema.test.ts`

**Interfaces — Produces:**
```ts
export interface ReturnRules { exchangeDays: number; refundDays: number; nonReturnable: string[] }
export function daysSince(from: Date, now: Date): number;   // whole days, floor
export function returnWindowOpen(resolution: 'refund'|'size_exchange'|'store_credit', deliveredAt: Date, now: Date, rules: ReturnRules): boolean;
export function isNonReturnable(p: { categorySlug: string; productSlug: string; garmentType: string | null }, rules: ReturnRules): boolean;
export function refundForLine(lineTotalCents: number, itemQty: number, returnQty: number): number;
export async function loadReturnRules(db: Exec): Promise<ReturnRules>;
export function newRmaNumber(now: Date): string;   // RMA-YYMM-XXXXX (reuse the order-number alphabet)
```
- [ ] **Step 1: Failing tests.**
  - `rmaRules.test.ts`:
    - an exchange delivered 29 days ago → open, 31 → closed (exactly 30 → open);
    - a refund at 13 → open, 15 → closed;
    - `refundForLine(9000, 3, 1)` → 3000, `(10000, 3, 1)` → 3333, `(10000, 3, 3)` → 10000;
    - `isNonReturnable` for category `socks`, garmentType `underwear`, slug `trusox-3-0-mid-calf-non-slip-grip-socks` → true; slug `sockeroo-boot` → false;
    - `newRmaNumber` matches `^RMA-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$`.
  - Schema: `return_rules` is seeded; `rma_items.qty` 0 → rejected; a question status `spam` → rejected; a ledger reason `order_cancelled` → accepted.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + suite. Commit `feat: return, question schema and return-window rules`.

### Task 2: Tracking and member order history

**Files:** `src/modules/orders/tracking.ts`, `src/modules/orders/customerRouter.ts`, `src/modules/orders/view.ts` (masking helper), `src/app.ts`, `test/integration/orderTracking.test.ts`

**Interfaces — Produces:**
```ts
export function maskedAddress(a: ShipAddressSnapshot | null): MaskedAddress | null; // {recipient: 'Sok D.', communeName, districtName, provinceName}
export async function trackOrder(db: Db, number: string, phoneE164: string, lang, assetBase): Promise<{ order: OrderView /* shipAddress masked, contact phone masked to ***678, email removed */ }>;
export async function listMemberOrders(db, userId, page, pageSize, lang, assetBase): Promise<{ orders: OrderSummary[]; total: number; page: number; pageSize: number }>;
// OrderSummary = { number, status, paymentStatus, totalCents, itemCount, firstItem: {name, imageUrl} | null, createdAt }
```
- `POST /v1/orders/track` (rate limit bucket `track`, 10/min/IP; the test app disables general limits but this route's limiter is configurable: `deps.rateLimit.trackMax`).
- `GET /v1/me/orders?page=&pageSize=` (member; newest first; pageSize ≤ 50) and `GET /v1/me/orders/:number` (member's own; full view with timeline and latest payment; 404 otherwise).

- [ ] **Step 1: Failing tests** `orderTracking.test.ts`:
  - track with `012 345 678` for an order placed with `+85512345678` → 200, status + timeline (`pending_payment`), items, totals;
  - `shipAddress` has no `street`/`phoneE164`/`landmark`, the recipient is `Sok D.`, the contact phone is `***678`;
  - a wrong phone → 404 `order_not_found`; an unknown number → the same 404 body; `SC-bad` → 404 (not 400);
  - 11 requests in a minute from one IP with the limiter on → the 11th is 429;
  - member `GET /v1/me/orders` → only their orders, newest first, with `total`; page 2 works;
  - `GET /v1/me/orders/:number` for another member's order → 404.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: order tracking by number and phone, and member order history`.

### Task 3: Staff order operations

**Files:** `src/modules/orders/admin.ts`, `src/modules/orders/adminRouter.ts`, `src/modules/orders/transition.ts`, `src/modules/loyalty/award.ts` (add `reverseLoyalty`), `src/modules/stock/locking.ts` (add `restockAllocations`), `src/app.ts`, `test/integration/adminOrders.test.ts`

**Interfaces — Produces:**
```ts
export async function transitionOrder(tx: Tx, order: OrderRow, to: OrderStatus, actor: string, note?: string): Promise<OrderRow>; // guards + event + delivered_at + status_changed notice
export async function reverseLoyalty(tx: Tx, userId: string, points: number, spendCents: number, reason: 'order_cancelled'|'rma_reversal', orderId: string | null, rules: LoyaltyRules): Promise<void>;
export async function restockAllocations(tx: Tx, allocs: StockAllocation[], refId: string, reason: 'order_cancel'|'rma_restock'): Promise<void>;
export function orderScope(user: UserRow): { branchId: string | null }; // null = all branches
```
Routes (`requireRole('staff','admin')`, `no-store`):
- `GET /v1/admin/orders?q=&status=&branch=&from=&to=&needsRefund=&page=&pageSize=`:
  - `q` = the number (prefix, case-insensitive) or ≥ 3 phone digits (matched against the digits of `contact_phone_e164`);
  - dates are ISO dates in Phnom Penh time;
  - → `{ orders: [{number, status, paymentStatus, paymentMethod, fulfillment, contactName, contactPhone, totalCents, needsRefund, branches[], createdAt}], total }`.
- `GET /v1/admin/orders/:number` → the full view plus `events` (all kinds, with actor names), `payments` (attempt, method, status, amount, tranId, timestamps), `allocations` per item, `needsRefund`, `pickList: {branchId: [{sku, name, size, color, qty, customPrint}]}` (scoped staff see only their branch's list).
- `POST /v1/admin/orders/:number/status {to, note?}`, `POST …/cancel {reason}`, `POST …/collect-cash`, `POST …/refunded {note?}` (paid or cancelled-with-needs_refund → payment_status `refunded`, needs_refund false), `POST …/clear-refund-flag {note}`, `POST …/notes {note}`.
  - Each locks the order row, re-checks the state and writes an `order_events` row with the actor user id.

- [ ] **Step 1: Failing tests** `adminOrders.test.ts`:
  - access: a customer → 403; a Sen Sok staff member sees a Sonthormuk-allocated order → 404 and it's absent from the list; an admin sees all;
  - search by the last 4 phone digits and by number prefix;
  - confirmed delivery → `out_for_delivery` → `delivered` (sets `delivered_at`, a `status_changed` outbox row) → `completed`;
  - an invalid move (`confirmed → delivered`) → 409 `invalid_transition`;
  - `out_for_delivery` on an unpaid order → 409;
  - the pick list groups by branch;
  - cancel unpaid → reserved back to 0, promo `used_count` −1, the provider attempt cancelled;
  - cancel paid (member with points) → on_hand back, an `order_cancel` movement, a ledger `order_cancelled` with −points, `needs_refund` true; cancelling again → 409 and no second restock;
  - `refunded` → payment_status refunded, flag cleared;
  - cash on pickup → `collect-cash` → completed, paid, stock committed, loyalty awarded;
  - a note appears in the admin events but not in the customer `GET /v1/orders/:number` timeline;
  - concurrent cancel + `out_for_delivery` → exactly one succeeds.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: staff order list, pick lists, status changes, cancel, refunds and cash at the counter`.

### Task 4: Returns (RMA)

**Files:** `src/modules/rma/{service.ts,router.ts,adminRouter.ts}`, `src/modules/notifications/templates.ts` + `outbox.ts` (templates `rma_requested`, `rma_decided`), `src/app.ts`, `test/integration/returns.test.ts`

**Interfaces — Produces:**
```ts
export const rmaCreateSchema; // {orderNumber, resolution, note?: ≤500, items: [{orderItemId: uuid, qty: 1–20, reason: 1–300, exchangeVariantId?: uuid}] (1–20)}
export async function createRma(db: Db, user: UserRow, input, now: Date): Promise<RmaView>;
export async function decideRma(db: Db, actor: UserRow, number: string, d: { decision: 'approve'|'reject'; branchId?: string; note?: string }, now: Date): Promise<RmaView>;
// RmaView = { number, orderNumber, resolution, status, refundCents, items: [{orderItemId, name, size, qty, reason, refundCents, exchangeSize}], createdAt, decidedAt, decisionNote }
```
Routes:
- `POST /v1/me/returns` and `GET /v1/me/returns` (member);
- `GET /v1/admin/returns?status=&page=`, `GET /v1/admin/returns/:number`, `POST /v1/admin/returns/:number/decision {decision, branchId?, note?}` (staff, branch-scoped by the order's allocations).

Validation errors are 400 `return_not_allowed` with `details: [{orderItemId, reason: 'window_closed'|'custom_print'|'non_returnable'|'qty_exceeded'|'not_delivered'|'exchange_variant_invalid'|'exchange_out_of_stock'}]`.

- [ ] **Step 1: Failing tests** `returns.test.ts` (orders made paid + delivered with `delivered_at` set by SQL):
  - refund of 1 of 3 discounted jerseys → `refundCents` = round(line_total/3); `needs_refund` stays false until approved;
  - exchange M→L → L reserved (`exchange_reserve`) immediately; reject → released; approve → M back on the shelf at the branch, L committed (`exchange_commit`);
  - exchange to another product, or to a size with a different price → 400 `exchange_variant_invalid`;
  - day 31 exchange → `window_closed`; day 15 refund → `window_closed`; day 13 refund ok;
  - a printed line → `custom_print`; the socks product → `non_returnable`;
  - a second RMA for the same unit → `qty_exceeded`;
  - an order not delivered → `not_delivered`; another member's order → 404;
  - approve a refund for a member who earned points → a ledger `rma_reversal` with −floor(refund×10/100), spend reduced, the order's `needs_refund` true; deciding twice → 409;
  - a Sen Sok staff member approving a Sonthormuk return → 404;
  - outbox: `rma_requested` → ops telegram; decision → a customer email when an email is set.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: size exchanges, refunds and store credit requests with staff approval`.

### Task 5: Loyalty, insights and admin adjustments

**Files:** `src/modules/loyalty/{router.ts,insights.ts}`, `src/modules/admin/usersRouter.ts` (adjust route), `test/integration/loyalty.test.ts`

- [ ] **Step 1: Failing tests** `loyalty.test.ts`:
  - a new member → bronze, 0 points, next tier silver with `remainingCents` 15000, `phoneVerified` true, perks empty;
  - after the ledger + account are seeded to 16000 spend → silver, perks `memberDiscountPercent 10` + categories, next = gold remaining 14000;
  - pro → `nextTier null`, perks include free delivery + free printing;
  - the Google-only member → `phoneVerified false`;
  - the ledger lists the order number;
  - insights with two paid orders (jerseys + a boot) and one unpaid → counts only the paid ones, favourite category jerseys, shares sum to 100 (±1 rounding);
  - admin adjust +500 → balance +500 and a ledger `admin` row with the note; staff → 403; delta 0 → 400; a negative adjust below zero balance → allowed down to 0 only (409 `insufficient_points` otherwise).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: loyalty balance, perks, ledger and purchase insights`.

### Task 6: Product questions

**Files:** `src/modules/questions/{service.ts,router.ts,adminRouter.ts}`, templates `question_received`, `src/app.ts`, `test/integration/questions.test.ts`

- [ ] **Step 1: Failing tests** `questions.test.ts`:
  - a guest posts → 201 pending and an ops outbox row; the public list is empty;
  - admin answers + publishes → the public list has it with `answeredAt`, and no user ids/emails appear;
  - publish without an answer → 400;
  - hide → it disappears;
  - `<script>` stays as literal text in the JSON;
  - a question of 4 or 501 chars → 400;
  - an unknown product → 404;
  - the limiter on: the 6th post in a minute → 429;
  - the public GET has `Cache-Control: public, max-age=60`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: product questions with staff moderation`.

### Task 7: Admin overview and logs

**Files:** `src/modules/admin/overviewRouter.ts`, `src/modules/admin/logsRouter.ts`, `src/app.ts` (pass notifiers to the context), `src/context.ts`, `test/integration/adminOverview.test.ts`

**Interfaces:** `AppContext.notifiers: { telegram: Notifier; email: Notifier }` (createApp deps `notifiers?`, default built from config); the server passes the same instances to the scheduler.

- [ ] **Step 1: Failing tests** `adminOverview.test.ts`:
  - with 2 orders today (1 paid at $52.50), 1 pending payment, 1 needs_refund, 1 open return, 1 pending question, stock rows with available 2 and needs_count → each counter matches;
  - a customer → 403;
  - webhooks list paginates and filters by status;
  - the notifications list masks the email recipient (`d***@example.com`) and has no payload;
  - notifications test with a fake telegram → `{sent:true}` and the fake received it; unconfigured → `{sent:false, error:'not configured'}`; staff → 403.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: admin overview, webhook and notification logs`.

### Task 8: System health (admin)

**Files:** `src/modules/health/system/{types.ts,service.ts,router.ts}` (types copied from `legacy/health/systemHealthTypes.ts`, unused UI-only helpers kept since the frontend shares the file), `src/app.ts`, `test/integration/systemHealth.test.ts`

**Interfaces:** `createSystemHealth(pool: Pool, opts?: { now?: () => Date; probe?: () => Promise<{connected, latencyMs, message}> })` → `{ snapshot(), metrics({limit, thresholdMs, probe}), csv() }`. In-memory history (max 500 samples) per process.

- [ ] **Step 1: Failing tests** `systemHealth.test.ts`:
  - `GET /v1/admin/system-health` as admin → 200 `overallStatus 'operational'`, `database.status 'connected'`, a numeric latency, pool counts;
  - staff → 403; anonymous → 401;
  - `/metrics?limit=5` → `series.length ≤ 5`, `summary`, `alert`;
  - a failing probe (injected) → 503 with `overallStatus 'degraded'`;
  - `/logs.csv` → `text/csv` with a header row;
  - `/report.pdf` → 404.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: admin-only system health metrics and CSV log`.

### Task 9: Retire `legacy/`

**Files:** delete `legacy/`, `README.md` (phase 6 endpoints, returns policy, staff operations, system health), `docs/superpowers/LEGACY-PORT.md` (each legacy file → where it went or why it was dropped), `tsconfig*.json` / `vitest.config.ts` (remove legacy excludes)

- [ ] **Step 1:** Write `LEGACY-PORT.md`:
  - `apiRouter` (catalog/questions/orders/track/account/rma) → phases 2–6;
  - `account/payments` dropped (spec §8: no card vault);
  - `adminRouter` (overview, orders, status, inventory → stock API, webhooks, notifications);
  - `webhookCrypto` + `webhookRouter` → `payments/*` (Stripe dropped by spec);
  - `notificationService` → `notifications/*`;
  - the repositories → module services;
  - `validators/schemas.ts` → per-route Zod;
  - `middleware/rateLimit.ts` → `src/middleware/rateLimit.ts`;
  - `health/*` → `health/system/*`, PDF dropped (frontend renders it);
  - `components/SystemHealthDashboard.tsx` → already copied to `sport-heaven/src/components/admin/` (frontend clean-up);
  - `app.ts` → `src/app.ts`.
- [ ] **Step 2:** `git rm -r legacy`; drop the legacy excludes; `npm run typecheck && npm test && npm run build` green twice; README refreshed. Commit `chore: retire legacy code now that every feature is ported`.

---

## Deferred (not in phase 6)

- Store-credit wallet and point redemption (spec non-goals; store credit is issued by hand for now).
- Per-route limits on order create/auth, the rate-limit store interface, ESLint, the load test, contracts/OpenAPI: phase 7.
