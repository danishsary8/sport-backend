# Stage 4 — Backend Completeness Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every requirement of the backend spec (§1–§20) and every backend-relevant Zando "Adopt"/"Avoid" item has evidence (file, endpoint, test) in `docs/superpowers/BACKEND-AUDIT.md`. Every gap found is implemented test-first. A fresh whole-backend review is clean of Critical/Important findings.

**Architecture:** No new modules. Gaps are closed inside the owning module: account deletion, catalog search/detail, admin products, counter sales.

**Tech Stack:** as phase 7.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md`; `sport-heaven/docs/research/zando-behavior-reference.md` §3; work order Stage 4.

## Global Constraints

- Phase 7's constraints apply.
- Exit criteria: `npm ci && npm run lint && npm run typecheck && npm test && npm run build` green twice; BACKEND-AUDIT.md has no open items; STATUS.md says backend done.

## Review Focus

1. **Deleting an account with an order in flight** must not strand staff without a way to reach the customer: deletion is refused until every order has finished. Pinned in Task 1.
2. **The CSV import** only ever changes prices/compare-at/status of existing SKUs. A malformed or hostile file (formula injection on export, a huge file, unknown SKUs, a compare-at not above the price) changes nothing and explains every rejected row. Pinned in Task 4.
3. **The size guide** is content the owner must confirm; it is served from settings, so it can be corrected without a deploy. Pinned in Task 3.

---

### Task 1: Account deletion redacts the person's orders (spec §7)

**Files:** `src/modules/account/service.ts`, `test/integration/account.test.ts` (or a new `accountDeletion.test.ts`)
- `DELETE /v1/me` with any order not in `completed | cancelled | expired | delivered` → 409 `open_orders` ("You have orders in progress; you can delete your account once they are finished").
- Otherwise, in the same transaction as the user anonymisation:
  - the user's orders get `contact_name = 'Deleted customer'`, `contact_phone_e164 = '+85500000000'`, `contact_email = null`, and `ship_address` reduced to province/district/commune names and codes (street, landmark, lat/lng and recipient phone removed, recipient name 'Deleted customer');
  - the order note is cleared;
  - RMA customer notes are cleared.
  Amounts, items and timelines stay (accounting).
- [ ] Failing tests → implement → green ×2. Commit `fix: deleting an account redacts the person's orders`.

### Task 2: `GET /v1/search` (spec §12)

**Files:** `src/modules/catalog/router.ts`, `test/integration/catalogListing.test.ts`
- `GET /v1/search?q=` (min 2 characters, otherwise 400) returns the listing response with the same params, sorted by relevance by default. Cacheable like the listing.
- [ ] Commit `feat: search results page endpoint`.

### Task 3: Size guide on product detail (spec §12)

**Files:** `src/db/seed/index.ts` (setting `size_guides`), `src/modules/catalog/detail.ts`, `src/contracts/catalog.ts`, `docs/api/openapi.json`, test
- Setting `size_guides` (seeded when missing), keyed by category slug:
  - **boots:** EU/UK/US/foot-length-cm rows for EU 38–46;
  - **jerseys and f1:** S–XXL with chest/length cm;
  - **balls:** size 3/4/5 with the age guidance.
  Each guide is `{ title: {en, km?}, columns: string[], rows: string[][], note?: {en} }`.
- Product detail gains `sizeGuide: SizeGuide | null` (by category). The values are standard industry charts, flagged in OWNER-TODO for the owner to confirm against the actual brands.
- [ ] Commit `feat: size guides on product pages`.

### Task 4: Admin product CSV export/import (spec §14)

**Files:** `src/modules/admin/productsCsv.ts`, `src/modules/admin/productsRouter.ts`, `test/integration/adminProductsCsv.test.ts`
- `GET /v1/admin/products/export.csv` (admin) has one row per variant: `sku,product_slug,product_name,brand,category,product_status,color,size,price_usd,compare_at_usd,variant_status`. RFC 4180 quoting; cells starting with `= + - @` are prefixed with `'` (formula injection).
- `POST /v1/admin/products/import` (admin), `text/csv` body ≤ 2 MB, same header. It **updates existing SKUs only**: `price_usd`, `compare_at_usd`, `variant_status`. A dry run comes first: `?apply=true` applies; the default returns the preview.
  - The response is `{ applied, changes: [{sku, field, from, to}], errors: [{line, sku, message}] }`.
  - Any error → nothing is applied.
  - Unknown SKUs, bad money (> 2 decimals, negative), compare-at ≤ price, or an unknown status → errors.
  - The changes are logged with the actor.
- [ ] Commit `feat: product price CSV export and safe import`.

### Task 5: Counter sale names the order holding the stock (spec §14)

**Files:** `src/modules/stock/service.ts` (or the stock router), `test/integration/stock.test.ts`
- When a counter sale fails with `held_for_online_order`, the error's `details.orders` lists the order numbers (up to 5) that hold units of that variant at that branch (from allocations of `pending_payment | awaiting_pickup_payment | confirmed | printing | ready_for_pickup` orders whose stock isn't committed yet — i.e. allocations of orders with `payment_status = 'unpaid'`, plus exchange holds as `RMA-…`).
- [ ] Commit `feat: counter sales say which online order holds a unit`.

### Task 6: The audit document and the whole-backend review

- [ ] Write `docs/superpowers/BACKEND-AUDIT.md`: spec §1–§20 line by line (requirement → evidence: file, endpoint, test), then Zando Adopt A1–A15 and the Avoid list (backend-relevant items), then the legacy port (link LEGACY-PORT.md). Every row is either ✅ with evidence, or a ruling.
- [ ] Dispatch a fresh reviewer (most capable model) over the **whole backend** (not a diff). Re-grade, fix Critical/Important test-first, ledger the minors.
- [ ] Run the exit criteria twice; update STATUS.md (backend done).
