# Phase 4 — Cart & Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server alone decides what a cart costs. Guests and members have a server-side cart. Each line carries a size, a quantity and optional custom printing, and the cart totals come back as labelled lines covering:
- item prices and printing fees;
- the 5+ jersey team discount;
- member tier perks;
- one promo code (the better of code vs member discount wins);
- delivery or pickup fees;
- the KHR total.

Admins manage promo codes, delivery rates and pricing settings.

**Architecture:**
- `modules/pricing/engine.ts` is **pure**: no DB, no clock except an injected `now`. It takes resolved inputs (lines with prices and categories, the member tier, at most one promotion, the delivery choice and its rate, the rules from settings) and returns the full breakdown. Every rule is unit-tested here. Phase 5's order creation calls the same function, so cart, checkout quote and order always agree.
- `modules/pricing/context.ts` loads those inputs from Postgres.
- `modules/cart/*` owns carts: guest cart via a signed `sc_cart` cookie, member cart via user id, merged on sign-in.

**Tech Stack:** as phases 1–3. No new dependencies; the cookie is HMAC-signed with `node:crypto` using `COOKIE_SECRET`.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md`:
- §2 decisions (member perks, better-wins);
- §8 commerce tables (`carts`, `cart_items`, `promotions`, `shipping_methods`, `shipping_rates`, `loyalty_accounts`, settings);
- §9 pricing rules 1–8;
- §10 cart.

Current storefront rules come from `sport-heaven/src/utils/commerce.ts` and `loyaltyTier.ts`.

## Global Constraints

- All money is integer **cents**. Percentages are applied per line and rounded half-up (`Math.round`).
- **No price, discount, fee or total is ever read from the request.** Requests carry only `variantId`, `qty`, the `customPrint` choices and a promo code.
- Pricing rules live in `settings`, seeded with today's storefront values:
  - `khr_rate`: `{ "rate": 4100 }`. KHR total = `round(totalCents / 100 × rate / 100) × 100` (nearest 100 riel).
  - `custom_print_fees`: `{ "baseCents": 800, "patches": { "none": 0, "ucl": 500, "cpl": 400, "aff": 400, "champions": 500, "f1-paddock": 500 } }`.
  - `team_discount_rule`: `{ "minItems": 5, "percent": 10, "categories": ["jerseys", "f1"] }`.
  - `loyalty_rules`: `{ "pointsPerUsd": 10, "tiers": [ {"id":"bronze","minSpendCents":0}, {"id":"silver","minSpendCents":15000}, {"id":"gold","minSpendCents":30000}, {"id":"pro","minSpendCents":50000} ], "memberDiscount": { "fromTier": "silver", "percent": 10, "categories": ["boots","jerseys","f1","balls","essentials"] }, "freeDelivery": { "fromTier": "gold", "methods": ["pp_rider"] }, "freePrinting": { "fromTier": "pro" } }`.
- Custom print:
  - only on `is_customizable` products (otherwise `400 not_customizable`);
  - `name` is uppercased, may contain only `A–Z 0–9 space . ' -` and is 1–14 chars;
  - `number` is an integer 1–99;
  - `patch` is one of the six ids;
  - `font` is one of `pro-condensed | classic-block | motorsport-aero` (default `pro-condensed`).

  Two lines are the same line when (variant, normalised print) match.
- Member perks apply only to a signed-in user whose phone is verified (`phoneVerified`). Tier = `loyalty_accounts.tier`, `bronze` when absent. Perks are cumulative up the tiers.
- Team discount and member 10% never stack on one line: each line gets at most one of them (they're the same 10% today; take the larger if they ever differ).
- One promo code at most. When both a code and a member discount apply, the engine prices both scenarios and keeps the one with the **lower total**. Ties keep the member discount; the response says which won. The team discount stacks with a code. Free-delivery effects (Gold perk, `free_shipping` promo) always apply.
- Delivery:
  - `pickup` = $0, at a branch with `pickup_enabled`;
  - `pp_rider` = Phnom Penh only (province `12`), $2.50, free when merchandise after discounts ≥ $50;
  - `province_courier` = every other province, **$3.00 placeholder, flagged for the owner to confirm**, no free threshold.

  An unknown or unsupported province/method → the breakdown has `shipping: null` and a message, and `checkoutReady: false`.
- Cart limits: ≤ 30 distinct lines, qty 1–20 per line, total units ≤ 50. Adding beyond online availability → `409 insufficient_stock` with `available`.
- Guest cookie `sc_cart`:
  - value `<128-bit base64url id>.<HMAC-SHA256 base64url>`;
  - `HttpOnly; SameSite=Lax; Path=/; Max-Age=60 days`, plus `Secure` in production;
  - a bad signature is ignored and a new cart is started on the next write;
  - **the API must be served from the same site as the storefront** (e.g. `api.shop.com` + `shop.com`), so Lax cookies are sent. Documented in the README.
- Carts never reserve stock (reservation happens at order time, phase 5). The cart response says so in `notices`.

## Review Focus

1. **A price changes or a product is archived while it sits in a cart.**
   - `GET /cart` shows the new price.
   - An archived/inactive variant's line is flagged `unavailable` and excluded from totals; `checkoutReady` is false until it is removed. No 500.
   - Pinned in Task 4.
2. **Stock drops below a line's quantity after it was added** (counter sale).
   - The line shows `maxQty` = current online availability and `availability: 'low' | 'out'`.
   - Totals still compute; `checkoutReady` is false while any line exceeds availability.
   - Pinned in Task 4.
3. **Guest adds items, then signs in to an account that already has a cart.**
   - Quantities are summed per (variant, print) and capped at availability and the line limit.
   - The guest cart is deleted and the cookie cleared.
   - Signing in twice (or two tabs) never duplicates lines.
   - Pinned in Task 5.
4. **Promo edge cases**, each with a clear message and never a 500:
   - an expired code, a code below its minimum spend, a code whose scope matches nothing in the cart, a code at its usage cap;
   - a lowercase or spaced code (`" castle10 "` works);
   - a code that is worse than the member discount → `promo.applied: false` with a "your member discount saves more" message, while the code stays saved on the cart in case the cart changes.
   - Pinned in Tasks 2/3.
5. **Tampered or forged cart cookie / another guest's cart id** → treated as no cart; never reads another cart. Pinned in Task 4.

---

## Data model (migration `0004_cart_pricing.sql`)

- `shipping_methods`: id text PK (`pp_rider | province_courier | pickup`), name_i18n, active, sort.
- `shipping_rates`: id uuid, method_id FK, province_code FK null (null = default for the method), fee_cents ≥ 0, free_over_cents null, eta_i18n jsonb, needs_review bool. Unique `(method_id, coalesce(province_code, '*'))`.
- `promotions`:
  - id uuid, code text unique null (null = automatic rule; codes stored uppercase), name, type `percent | fixed | free_shipping`;
  - value int (percent 1–100, or cents for fixed; 0 for free_shipping), min_subtotal_cents default 0;
  - scope jsonb `{ categories?: string[], brands?: string[], methods?: string[] }` (empty = everything; `methods` limits a free_shipping promo to delivery methods);
  - starts_at null, ends_at null, max_uses null, used_count default 0, max_uses_per_user null, active bool, created_at.
  - Check: `type <> 'percent' or value between 1 and 100`.
- `loyalty_accounts`: user_id PK FK users, points_balance int default 0, lifetime_spend_cents int default 0, tier text default `bronze`, updated_at. (Written in phases 5–6; read here.)
- `carts`:
  - id uuid, user_id uuid unique null FK users ON DELETE CASCADE, guest_token text unique null;
  - promo_code text null, created_at, updated_at;
  - check exactly one of user_id/guest_token is set.
- `cart_items`:
  - id uuid, cart_id FK cascade, variant_id FK variants;
  - qty int (1–20), custom_print jsonb null, print_key text not null default `''` (normalised print fingerprint), created_at.
  - Unique `(cart_id, variant_id, print_key)`.
- Seeds: the three shipping methods; rates (`pp_rider` province 12 → 250 / free over 5000; `province_courier` default → 300, `needs_review: true`; `pickup` default → 0); promotions `CASTLE10` (percent 10) and `PPFREE` (free_shipping, `scope.methods: ['pp_rider']`); and the settings above, inserted only when missing.

---

### Task 1: Schema and seeds

**Files:** `src/db/schema/commerce.ts`, `src/db/schema/index.ts`, `src/db/seed/index.ts`, `drizzle/0004_*.sql`, `test/integration/commerceSchema.test.ts`

**Interfaces:** Drizzle tables `shippingMethods, shippingRates, promotions, loyaltyAccounts, carts, cartItems`; types `PromotionRow`, `ShippingRateRow`.

- [ ] **Step 1: Failing test:**
  - After seeding: 3 methods.
  - The `pp_rider` rate for province `12` is 250 / free over 5000, and the `province_courier` default rate has `needs_review` true.
  - `CASTLE10` and `PPFREE` exist.
  - The settings `khr_rate`, `custom_print_fees`, `team_discount_rule` and `loyalty_rules` hold exactly the values in Global Constraints.
  - A cart with both `user_id` and `guest_token`, or neither, is rejected.
  - A `cart_items` qty of 0 or 21 is rejected.
  - A percent promotion with value 150 is rejected.
  - Seeding twice keeps counts, and an admin-changed setting survives re-seeding.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite). Commit `feat: cart, promotion, shipping and loyalty schema with seeded rules`.

### Task 2: Pricing engine (pure)

**Files:** `src/modules/pricing/engine.ts`, `src/modules/pricing/types.ts`, `src/modules/pricing/print.ts`, `test/unit/pricing.test.ts`, `test/unit/print.test.ts`

**Interfaces:**
```ts
// print.ts
export interface CustomPrint { name: string; number: number; patch: PatchId; font: FontId }
export const customPrintSchema: ZodType<CustomPrint>;  // normalises name (uppercase, trims, collapses spaces)
export function printKey(p: CustomPrint | null): string; // '' or 'NAME|7|ucl|pro-condensed'
export function printFeeCents(p: CustomPrint | null, fees: PrintFees, freePrinting: boolean): number;

// types.ts
export type TierId = 'bronze' | 'silver' | 'gold' | 'pro';
export interface PricingRules { khrRate: number; printFees: PrintFees; team: { minItems; percent; categories: string[] }; loyalty: LoyaltyRules }
export interface PriceLineInput { lineId: string; categorySlug: string; brandSlug: string; unitPriceCents: number; compareAtCents: number | null; qty: number; customPrint: CustomPrint | null; purchasable: boolean }
export interface PromotionInput { code: string | null; name: string; type: 'percent'|'fixed'|'free_shipping'; value: number; minSubtotalCents: number; scope: { categories?: string[]; brands?: string[]; methods?: string[] } }
export interface DeliveryInput { fulfillment: 'delivery'|'pickup'; methodId: string | null; rate: { feeCents: number; freeOverCents: number | null } | null }
export interface PricingInput { lines: PriceLineInput[]; tier: TierId | null /* null = guest or unverified */; promo: { promotion: PromotionInput | null; rejectedMessage?: string; enteredCode: string | null }; delivery: DeliveryInput; rules: PricingRules }

export interface PricedLine { lineId; unitPriceCents; printFeeCents; qty; subtotalCents; discountCents; totalCents; discountSource: 'team'|'member'|null; purchasable }
export interface Breakdown {
  lines: PricedLine[];
  merchandiseCents: number;          // Σ (unit + print) × qty over purchasable lines
  discounts: { kind: 'team'|'member'|'promo'; label: string; amountCents: number }[];
  shippingCents: number | null;      // null = no quote
  totalCents: number;
  totalKhr: number;
  promo: { code: string | null; applied: boolean; message: string | null };
  memberPerks: { tier: TierId | null; applied: string[] };   // e.g. ['member_discount','free_delivery','free_printing']
  freeDeliveryRemainingCents: number | null;
  messages: string[];
}
export function priceCart(input: PricingInput): Breakdown;
```
Algorithm, in order:
1. Purchasable lines only.
2. Print fee per unit (0 for Pro).
3. Team discount on qualifying lines when the qualifying unit count ≥ `minItems`.
4. Member 10% on eligible lines; a line gets max(team, member), never both.
5. Promo scenario: team (+ member when not using the code) vs team + code.
   - Percent applies to the scope lines' remaining amount.
   - Fixed is allocated pro rata over the scope lines (remainder to the largest), capped at their amount.
   - `free_shipping` is a delivery effect, so it never competes with the member discount.
   - The engine keeps the lower total.
6. Shipping: pickup → 0; no rate → null; free when (a Gold perk method matches) or a `free_shipping` promo applies or merchandise-after-discounts ≥ `freeOverCents`.
7. KHR.

Messages are plain English, e.g.:
- `"Spend $12.50 more for free delivery"`;
- `"Your Silver member discount saves more than CASTLE10"`;
- `"Add 2 more jerseys to unlock the 10% team discount"` (only when 3–4 qualifying units).

- [ ] **Step 1: Failing tests.**
  - `print.test.ts`:
    - name `" sok  dara "` → `SOK DARA`;
    - a 15-char name → error;
    - `é` → error;
    - number 0 / 100 → error;
    - an unknown patch → error;
    - `printKey` is identical for equal prints;
    - fees: base 800 + ucl 500 = 1300, and 0 with free printing.
  - `pricing.test.ts`: one test per rule, with exact cents.
    - Single $35 jersey, guest, pickup → total 3500, KHR 143,500 (3500 × 41 = 143,500).
    - 5 jerseys at $35 → team 1750 off.
    - 4 jerseys → no team discount, message "Add 1 more…".
    - A Silver member with a $255 boot → member 2550 off.
    - Silver + 5 jerseys → 10% once per line (1750, not 3500).
    - Silver + `CASTLE10` on a boot → tie, so member kept with the "member discount saves more" message.
    - Bronze + `CASTLE10` → code applied 10%.
    - A fixed $5 code over two scoped lines of $30 and $10 → 375 and 125.
    - A fixed code larger than the scoped amount → capped.
    - A scoped promo (`categories: ['balls']`) with no balls → `applied: false`, "doesn't apply to items in your bag".
    - `minSubtotal` not met → "Spend $X more to use CODE".
    - PP delivery $40 → 250 fee and "Spend $10.00 more…"; $50 after discounts → 0.
    - Gold → `pp_rider` free; Gold with `province_courier` → still 300.
    - `PPFREE` with `province_courier` → courier still charged (the scope is `pp_rider`); `PPFREE` + pickup → 0 and code applied: false, "only for Phnom Penh delivery".
    - Pro + printed jersey → print fee 0.
    - An unverified member (tier null) gets no perks.
    - A non-purchasable line is excluded from all totals.
    - `rate: null` → `shippingCents null` and a message.
    - Rounding: 3 × $33.33 at 10% → per line `round(9999 × 0.1) = 1000`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: pure pricing engine with team, member, promo and delivery rules`.

**`PPFREE` scope:** the promotion has `type free_shipping`, and its effect is limited to method `pp_rider`. Encode this in `scope.methods: ['pp_rider']`; the engine treats `free_shipping` as applicable only when `delivery.methodId` is in `scope.methods` (or `scope.methods` is absent).

### Task 3: Pricing context, promo lookup and admin pricing API

**Files:** `src/modules/pricing/context.ts`, `src/modules/pricing/promotions.ts`, `src/modules/admin/pricingRouter.ts`, `test/integration/promotions.test.ts`, `test/integration/adminPricing.test.ts`

**Interfaces:**
- `loadRules(db): Promise<PricingRules>` (from settings; missing keys → seeded defaults).
- `tierFor(db, user: UserRow | undefined): Promise<TierId | null>`: null unless the user's phone is verified.
- `findPromotion(db, rawCode, now): Promise<{ promotion: PromotionInput } | { rejectedMessage: string }>`. Normalises with trim and uppercase, then rejects with a message when:
  - unknown → "We don't recognise that code";
  - inactive or outside its dates → "That code has expired" / "That code isn't active yet";
  - `max_uses` reached → "That code has been fully used".
  
  The per-user limit is enforced at order time (phase 5; `promotion_redemptions` doesn't exist yet).
- `deliveryRate(db, { fulfillment, methodId, provinceCode, pickupBranchId }): Promise<DeliveryInput>`:
  - Method-province rules: `pp_rider` only for `12`, `province_courier` only for others.
  - The province-specific rate wins over the default.
  - Pickup needs a pickup-enabled branch.
  - Otherwise `rate: null`.
- Admin (`requireRole('admin')`):
  - `GET/POST /v1/admin/promotions`, `PATCH /v1/admin/promotions/:id`: validates the type/value check, stores the code uppercase, and maps a duplicate code to `409 code_taken`.
  - `GET /v1/admin/shipping-rates`, `PUT /v1/admin/shipping-rates/:id { feeCents, freeOverCents, etaEn?, etaKm? }`, which clears `needs_review`.
  - `GET /v1/admin/settings/pricing`, `PUT /v1/admin/settings/pricing/:key`, with each key validated by its own Zod schema (`khr_rate`, `custom_print_fees`, `team_discount_rule`, `loyalty_rules`).

- [ ] **Step 1: Failing tests.**
  - `promotions.test.ts`:
    - `" castle10 "` → found;
    - expired, future and exhausted codes → their messages;
    - unknown → its message;
    - `deliveryRate`: province 12 + `pp_rider` → 250/5000; province `17` + `pp_rider` → null; province 17 + courier → 300; pickup at `sensok` → 0; pickup at a branch with `pickup_enabled=false` → null.
  - `adminPricing.test.ts`:
    - staff → 403;
    - create a percent promo with value 0 → 400;
    - duplicate code → 409;
    - update the courier rate to 350 → `needs_review` false;
    - set `khr_rate` to `{rate: 4000}` → `loadRules` sees 4000;
    - `khr_rate` `{rate: -1}` → 400.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: promotion lookup, delivery rates and admin pricing API`.

### Task 4: Cart endpoints (guest and member)

**Files:** `src/lib/signedCookie.ts`, `src/middleware/auth.ts` (add `optionalUser`), `src/modules/cart/repo.ts`, `service.ts`, `router.ts`, `test/unit/signedCookie.test.ts`, `test/integration/cart.test.ts`

**Interfaces:**
- `signedCookie.ts`: `sign(value, secret): string`, `verify(signed, secret): string | null` (timing-safe), `readCookie(req, name): string | undefined` (manual header parse; no new dependency).
- `optionalUser(db, bootstrap)`: when `req.auth` is set, behaves like `requireUser` (upsert, reject deleted); otherwise continues as a guest.
- Cart owner: member → the cart by `user_id` (created on first write); guest → the cart by the verified `sc_cart` token (created on first write, cookie set).
- Endpoints (all `Cache-Control: no-store`; reads never create a cart):
  - `GET /v1/cart?fulfillment=delivery|pickup&provinceCode=&shippingMethodId=&pickupBranchId=&lang=` → `{ cart: CartView }`. Default delivery is `pp_rider` to province `12` when nothing is given.
  - `POST /v1/cart/items { variantId, qty, customPrint? }` → 200 `{ cart }`.
    - Merges into an existing identical line (summed qty).
    - Rejects: unknown or inactive variant / non-active product → 404; `customPrint` on a non-customizable product → 400 `not_customizable`; resulting qty > online availability → 409 `insufficient_stock {available}`; limits → 409 `cart_limit`.
  - `PATCH /v1/cart/items/:id { qty?, variantId? }`. A size change keeps the print, must stay within the same product, and merges if the target line exists. Same checks.
  - `DELETE /v1/cart/items/:id` → `{ cart }`.
  - `PUT /v1/cart/promo { code }` → `{ cart }` (the code is stored even when rejected or not applied; the message explains). `DELETE /v1/cart/promo` → `{ cart }`.
- `CartView = { id, lines: CartLineView[], pricing: Breakdown, promoCode, checkoutReady, notices: string[] }`.
  - `CartLineView = { id, productSlug, productName, brand, imageUrl, size, color, sku, qty, maxQty, availability, lowStockCount, customPrint, unitPriceCents, compareAtCents, printFeeCents, lineTotalCents, discountCents, purchasable, problem: null | 'unavailable' | 'exceeds_stock' }`.
  - `checkoutReady` = ≥ 1 line, every line purchasable with `qty ≤ maxQty`, and `pricing.shippingCents !== null`.
  - `notices` always includes "Items in your bag aren't reserved until you check out".

- [ ] **Step 1: Failing tests.**
  - `signedCookie.test.ts`: sign/verify round trip; a tampered value → null; a wrong secret → null.
  - `cart.test.ts` (catalog imported, real DB, supertest agent for cookies):
    - A guest's first `GET /cart` → an empty cart and **no** Set-Cookie.
    - A guest adds 2 × jersey M → Set-Cookie `sc_cart` HttpOnly SameSite=Lax; the cart has 1 line; merchandise 7000 ≥ 5000 so delivery is 0, total 7000, KHR 287,000.
    - Adding the same again sums to qty 4. With a print (name DARA, number 10, patch cpl) → a separate line, print fee 1200.
    - Print on a non-customizable boot → 400.
    - qty beyond availability → 409 with `available`.
    - Changing size M→L merges or moves correctly.
    - Delete a line.
    - `PUT /promo CASTLE10` → promo applied 10%. `" nope "` → stored, applied false, message.
    - A tampered cookie → treated as a new guest (empty cart; the other guest's cart is untouched).
    - A different guest agent can't see the first cart.
    - Member: bearer token → separate member cart, no cookie needed.
    - A Silver member (`loyalty_accounts` tier silver, phone verified) gets the member discount on a boot.
    - Review Focus 1: admin changes a price → GET shows it; archive the product → line `problem: 'unavailable'`, excluded, `checkoutReady false`.
    - Review Focus 2: drop stock to 1 after adding qty 3 → `maxQty 1`, `problem 'exceeds_stock'`, `checkoutReady false`.
    - Delivery params: `provinceCode=17&shippingMethodId=province_courier` → 300; `fulfillment=pickup&pickupBranchId=sensok` → 0; `provinceCode=17&shippingMethodId=pp_rider` → `shippingCents null`, `checkoutReady false`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (the service loads lines joined to variants/products/stock in one query, builds `PriceLineInput[]`, calls `priceCart`). **Step 4:** PASS. Commit `feat: guest and member carts priced by the server`.

### Task 5: Guest → member merge on sign-in

**Files:** `src/modules/cart/merge.ts`, `src/modules/auth/router.ts`, `test/integration/cartMerge.test.ts`, `README.md`, `.env.example`

**Interfaces:** `mergeGuestCart(db, guestToken: string, userId: string): Promise<{ mergedLines: number; cappedLines: number }>`.
- In one transaction, lock both carts.
- For each guest line: add to the member line with the same (variant, print_key), capping qty at min(20, online availability).
- The member keeps their promo code if they have one, otherwise inherits the guest's.
- Delete the guest cart.

`POST /v1/auth/session` reads `sc_cart`. If it's valid: merge, clear the cookie (`Max-Age=0`) and include `cartMerged: { mergedLines, cappedLines }` in the response.

- [ ] **Step 1: Failing tests** `cartMerge.test.ts`:
  - The guest has jersey M × 2 + boot × 1, and the member has jersey M × 1. Sign in → the member cart has jersey M × 3 and boot × 1, the guest cart row is gone, and Set-Cookie clears `sc_cart`.
  - Merging past availability → capped, `cappedLines 1`.
  - Calling `/auth/session` twice (same cookie replayed) → no duplication (the second call finds no guest cart).
  - Two concurrent `/auth/session` calls with the same cookie → final qty still 3.
  - Promo: the member has none and the guest has CASTLE10 → the member gets it.
  - A deleted user can't merge (403 before merge).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite + typecheck + build). README: the cart section, the same-site cookie requirement, the endpoint table, the pricing settings and the courier rate placeholder. Commit `feat: merge the guest cart into the member cart at sign-in`.

---

## Deferred (not in phase 4)

- The per-user promo limit, `used_count` increments and loyalty points earning: these happen when an order is paid (phase 5/6).
- Checkout quote and order placement (phase 5) reuse `priceCart` unchanged.
- Cleaning up abandoned guest carts: a scheduled job deletes guest carts untouched for 60 days (phase 7 hardening).
