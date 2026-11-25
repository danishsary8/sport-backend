# Phase 3 — Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Products, sizes, prices and per-branch stock live in Postgres, imported from today's frontend catalog. The API serves:
- listing with server-defined filters (facet counts), sorting and paging;
- product detail with per-size availability;
- search and suggestions;
- menu, collections and home sections;
- a wishlist.

Staff and admins manage products and stock, including a fast counter-sale API, and every stock change is audited.

**Architecture:**
- One `catalog` module: a pure `availability` helper; `catalogRepo` (SQL); `catalogService` (shaping + i18n); public routers.
- An `admin/catalog` module: product CRUD and stock operations.
- Stock is only ever changed through `stockService.applyMovement(tx, …)`, which locks the `stock` row, checks the invariant and writes `stock_movements` in the same transaction.
- Online availability = Σ over branches of `max(0, on_hand − reserved − buffer)`.
- Filters are plain query params; facets come back typed (`checkbox | range | radio`) so the frontend renders them generically.

**Tech Stack:** as phases 1–2. Postgres extensions `pg_trgm` + `unaccent` for search.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` §8 Catalog, §10 availability exposure, §12 Catalog API, §13 wishlist, §14 stock + counter sales, §17 import. Behaviour reference: `sport-heaven/docs/research/zando-behavior-reference.md` §2.4–2.5, §3 Adopt A3/A10/A11, Avoid list.

## Global Constraints

- Everything in phases 1–2's Global Constraints still applies.
- Money is integer **cents** (`price_cents`, `compare_at_cents`). API money fields are integers in cents, named `…Cents`.
- **Exact stock is never exposed publicly.**
  - Availability is `ok` (> 3 available online), `low` (1–3; the response also gives `lowStockCount`), or `out`.
  - Per-branch values on the product page are `ok | low | out` only.
  - Staff and admin endpoints show real numbers.
- Safety buffer: `buffer = stock.online_buffer ?? settings.online_safety_buffer`, default **1**, applied per (variant, branch).
- Stock invariant, enforced in SQL checks **and** in `applyMovement`: `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand`. A counter sale that would push `on_hand` below `reserved` → `409 held_for_online_order`.
- Every stock change writes one `stock_movements` row: `delta_on_hand`, `delta_reserved`, `reason`, `ref_id`, `actor_user_id`.
  - Reasons: `import | admin_adjust | store_sale | transfer_out | transfer_in`; phases 4–6 add `order_reserve | order_release | order_commit | rma_restock | exchange_reserve`.
- Staff with `staff_branch_id` can only touch their branch: `403 forbidden` for others. Admins can touch every branch. Product create/update/price changes are **admin only**; stock operations are staff or admin.
- i18n:
  - `name_i18n` / `description_i18n` jsonb `{ en, km? }`.
  - Public endpoints take `?lang=en|km` (default `en`, falls back to `en`) and return plain strings.
  - Admin endpoints return the full i18n objects.
- Public catalog GETs send `Cache-Control: public, max-age=60, stale-while-revalidate=300`; anything user-specific sends `no-store`.
- Only `status = 'active'` products appear publicly (`draft` and `archived` are hidden, and their detail → 404).
- **No fabricated reviews:** the frontend's `rating` / `reviewCount` values are not imported. Sort `popular` = best-seller flag first, then newest.
- Image URLs are stored as **paths** (e.g. `catalog/jersey_cambodia_blue.jpg`) and returned absolute by prefixing config `ASSET_BASE_URL` (default `/assets/`).

## Review Focus

1. **A filter combination that matches nothing** (e.g. `brand=nike&size=EU 39&surface=IC`) → `200` with `products: []`, `total: 0` and facets still returned. Facet counts for other values reflect the other active filters, so the UI can offer a way out. Never 500, never an empty facet list. Pinned in Task 3.
2. **Hostile or odd query input**:
   - `q` with `%`, `_` or quotes;
   - `page=0`, `page=99999`, `pageSize=1000`;
   - `price_min > price_max`, negative prices;
   - unknown `sort`;
   - repeated params (`brand=a&brand=b`).
   
   Each → either `400 validation_failed` or a sane result: repeated params are an OR; a page past the end → empty list with the correct `total`. Pinned in Task 3.
3. **Two staff ring up the last unit at the same time at the same branch** → exactly one succeeds; the other gets `409 insufficient_stock` (the row lock). `on_hand` never goes negative, and both attempts are visible (one movement). Pinned in Task 5.
4. **A product's last size sells out** → the listing shows `availability: 'out'`. The product stays listed (with an `inStockOnly=true` filter available), its detail shows every size with `out`, and the wishlist still returns it. Pinned in Tasks 3/4/6.
5. **Admin archives a product that is in someone's wishlist** → the wishlist hides it, with no 500 and no broken card. Pinned in Task 6.

---

## Data model (migration `0003_catalog.sql`)

- `brands`: id uuid, slug unique, name, logo_path null, sort.
- `categories`: id uuid, slug unique, parent_id null, name_i18n jsonb, sort. Seeded: `boots`, `jerseys`, `f1`, `balls`, `essentials`, with names from `sport-heaven` `CATEGORY_LABELS`.
- `products`:
  - id uuid, slug unique, brand_id, category_id;
  - name_i18n, short_name_i18n, description_i18n (jsonb);
  - highlights jsonb (array of strings), specs jsonb;
  - attributes jsonb: `{ league?, club?, season?, kitType?, nationalRegion?, surface?, garmentType?, isChampionsLeague?, isRetro?, weightGrams?, jerseyTheme? }`;
  - is_customizable bool;
  - flags jsonb: `{ featured, bestSeller, newArrival, limitedEdition, signatureEdition, heroSpotlight }`, hero_tagline null;
  - status `draft|active|archived`; search_text text (maintained by the service: name + short name + brand + club + league + colorway); created_at, updated_at.
  - Indexes: `(category_id)`, `(brand_id)`, `(status)`, GIN trigram on `search_text`.
- `product_colors`: id uuid, product_id, name, swatch_hex null, sort. One per product today (from `colorway` / `swatchHex`).
- `product_images`: id uuid, product_id, color_id null, path, alt null, sort.
- `variants`:
  - id uuid, product_id, color_id, size_label, size_sort int, sku unique;
  - price_cents int ≥ 0, compare_at_cents int null (`> price_cents` when set);
  - status `active|inactive`.
  - Unique `(product_id, color_id, size_label)`.
- `stock`: variant_id, branch_id, on_hand int, reserved int, online_buffer int null, needs_count bool default false, updated_at; PK (variant_id, branch_id); checks as in Global Constraints.
- `stock_movements`: id bigserial, variant_id, branch_id, delta_on_hand int, delta_reserved int, reason text, ref_id text null, note text null, actor_user_id uuid null, created_at. Index `(variant_id, created_at)`.
- `collections`: id uuid, slug unique, name_i18n, description_i18n, rule jsonb (the same shape as the listing filters), sort, active.
- `home_sections`: id uuid, type `hero|product_rail|category_grid|brand_row`, payload jsonb, sort, active, starts_at null, ends_at null.
- `wishlist_items`: user_id, product_id, created_at; PK (user_id, product_id); FKs cascade.
- Settings row `online_safety_buffer` = `{ "units": 1 }`.

`size_sort`:
- EU sizes → the number × 10 (`EU 42.5` → 425).
- Letter sizes → index in `XS S M L XL XXL 3XL`, plus 1000.
- `Size N` → N, plus 2000.
- Anything else → 9000 + position.

---

### Task 1: Catalog schema, extensions, stock invariants

**Files:**
- Create: `src/db/schema/catalog.ts`, `src/db/schema/stock.ts`, `src/db/schema/engagement.ts` (wishlist, collections, home sections); `drizzle/0003_catalog.sql` (generated, then the extensions + check constraints hand-appended if drizzle doesn't emit them); `test/integration/catalogSchema.test.ts`
- Modify: `src/db/schema/index.ts`, `src/db/seed/index.ts` (categories + the `online_safety_buffer` setting), `test/helpers/db.ts` (add `brands`, `categories` to the reference tables kept by `resetDb`)

**Interfaces:**
- Produces Drizzle tables `brands, categories, products, productColors, productImages, variants, stock, stockMovements, collections, homeSections, wishlistItems`, plus the row types `ProductRow`, `VariantRow`, `StockRow`.
- Produces `sizeSort(label: string, position: number): number` in `src/modules/catalog/sizes.ts`.

- [ ] **Step 1: Failing tests.**
  - `catalogSchema.test.ts`:
    - Inserting a stock row with `on_hand = -1` fails.
    - `reserved = 5, on_hand = 3` fails.
    - A duplicate `sku` fails.
    - A variant with `compare_at_cents <= price_cents` fails.
    - `select extname from pg_extension` includes `pg_trgm` and `unaccent`.
    - After seeding, the 5 categories exist and the setting `online_safety_buffer` = `{units: 1}`.
  - `test/unit/sizes.test.ts`:
    - `EU 42.5` → 425 and `EU 39` → 390;
    - `M` < `L` < `XXL`;
    - `Size 5` → 2005;
    - `S (EU 36–39)` → 9000-range, keeping the given order.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite). Commit `feat: catalog, stock and engagement schema`.

### Task 2: Catalog import from the frontend data

**Files:**
- Create: `src/db/seed/data/catalog.json` (export of `sport-heaven` `PRODUCTS`, 80 products, generated once by a throwaway script, not committed), `src/modules/catalog/importer.ts`, `src/db/seed/importCatalog.ts` (CLI), `test/integration/importCatalog.test.ts`
- Modify: `package.json` (`catalog:import`: `node dist/db/seed/importCatalog.js`)

**Interfaces:**
- `importCatalog(db: Db, products: FrontendProduct[]): Promise<{ products: number; variants: number; created: number; updated: number }>`. Upserts by slug and is idempotent. For each product:
  - brand by slugified name (created if missing);
  - category by slug;
  - one color (`colorway`, `swatchHex`);
  - one image (path = `catalog/` + basename of `image`);
  - one variant per size:
    - `sku = {SLUGPREFIX}-{SIZECODE}` (uppercase, `[A-Z0-9-]`, ≤ 40 chars, unique; on collision append `-2`);
    - `price_cents = round(price × 100)`;
    - `compare_at_cents = originalPrice` if > price.
  - Stock per branch from `branchStock`: `In Stock` → 10, `Limited Stock` → 2, `Out of Stock` → 0, with `needs_count = true`.
    - Stock is **only written when the variant is new**: re-import never overwrites real counts.
    - Writes a `stock_movements` row (`import`) when on_hand > 0.
  - `attributes` and `flags` are copied from the matching fields; `rating` and `reviewCount` are dropped.
  - `search_text` is built.
  - Status `active`.
- `FrontendProduct` is typed in `importer.ts` (the subset of fields read).

- [ ] **Step 1:** Generate `catalog.json`: run a scratch `tsx` script importing `sport-heaven/src/data/catalog.ts` and writing `PRODUCTS` (80; `EXPANDED_*` are already contained in `PRODUCTS`). Keep only fields the importer reads.
- [ ] **Step 2: Failing test** `importCatalog.test.ts`:
  - After import: 80 products, and `variants` count = Σ sizes.
  - Cambodia home jersey (`cambodia-national-team-home-jersey-varaman`): brand `Varaman`, category `jerseys`, 5 variants S…XXL with `price_cents 3500`, attributes.league `International`, `is_customizable` true, and image path `catalog/jersey_cambodia_blue_1795112605589.jpg`.
  - A `Limited Stock` branch → on_hand 2; `Out of Stock` → 0; all `needs_count`.
  - Re-import → same counts, `created 0`. After setting one stock row to 7 and re-importing, it stays 7.
  - Products with `originalPrice` have `compare_at_cents`.
  - No column or attribute holds `rating`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS. Commit `feat: import the frontend catalog into Postgres`.

### Task 3: Public listing and facets

**Files:**
- Create: `src/modules/catalog/availability.ts`, `listing.ts` (query builder), `facets.ts`, `view.ts`, `router.ts`, `test/unit/availability.test.ts`, `test/integration/catalogListing.test.ts`
- Modify: `src/app.ts`, `src/config/env.ts` (`ASSET_BASE_URL`, default `/assets/`)

**Interfaces:**
- `availability.ts`:
  ```ts
  export type Availability = 'ok' | 'low' | 'out';
  export function onlineAvailable(rows: { onHand: number; reserved: number; buffer: number }[]): number; // Σ max(0, onHand-reserved-buffer)
  export function availabilityOf(units: number): { availability: Availability; lowStockCount: number | null }; // >3 ok; 1..3 low+count; 0 out
  ```
  SQL mirror: a view-like CTE `variant_online(variant_id, units)` computed per query with the global buffer passed as a parameter.
- Listing query schema (`catalogQuerySchema`), all optional:
  - `category`, `collection` (slug; its `rule` is merged under the explicit params);
  - `brand[]`, `size[]`, `color[]`, `league[]`, `surface[]`, `kitType[]` (repeatable → OR within a param, AND across params);
  - `priceMin`, `priceMax` (cents, ≥ 0, `priceMin ≤ priceMax`);
  - `discount` (`1|2|3`: ≥10%, ≥30%, ≥50%);
  - `inStockOnly` (bool);
  - `q` (≤ 100);
  - `sort` (`popular|new|price_asc|price_desc|discount`, default `popular`);
  - `page` (≥ 1), `pageSize` (1–48, default 24);
  - `lang`.
- `GET /v1/catalog/products` → `{ products: ProductCard[], total, page, pageSize }`. `ProductCard`:
  - `{ id, slug, name, brand: {slug, name}, category, imageUrl, hoverImageUrl|null, priceCents, compareAtCents|null, discountPct|null, badges: string[], colors: [{name, swatchHex}], sizes: string[], availability, lowStockCount }`.
  - Price = min active variant price; `discountPct` = round((compareAt − price) / compareAt × 100).
  - `badges` from flags: `new`, `best_seller`, `limited`, `signature`, plus `sale` when discounted.
- `GET /v1/catalog/filters?<same params>` → `{ total, facets: Facet[] }`. `Facet = { key, label, type: 'checkbox'|'range'|'radio', options?: [{ value, label, count, selected }], range?: { min, max, selectedMin, selectedMax, buckets: [{ label, min, max, count }] } }`.
  - Facet keys: `category, brand, size, league, surface, kitType, price, discount, inStockOnly`.
  - Each facet's counts apply every active filter **except its own** (standard drill-down).
  - Price buckets in cents: `0–2500, 2500–5000, 5000–10000, 10000–20000, 20000+`.
  - Options with count 0 are kept only when selected.
- Search in listing: `q` → `search_text ILIKE %q%` (escaped) OR `similarity(search_text, q) > 0.3`; with `sort=popular`, ordered by similarity first.

- [ ] **Step 1: Failing tests.**
  - `availability.test.ts`:
    - `[ {10,0,1}, {2,0,1}, {0,0,1} ]` → 10.
    - Reserved beyond the buffer → clamps at 0.
    - `availabilityOf` for 0/1/3/4 → out / low(1) / low(3) / ok.
  - `catalogListing.test.ts` (imports the catalog in `beforeAll`):
    - default page: 24 cards, `total 80`;
    - `category=jerseys` → only jerseys;
    - `brand=nike&brand=adidas` → only those two brands;
    - `size=EU 42` → every card's sizes include it;
    - `priceMin=3000&priceMax=4000` → prices within;
    - `sort=price_asc` → non-decreasing;
    - `sort=discount` puts discounted products first;
    - `q=cambodia` → includes the Cambodia jersey;
    - `q=%_'` → 200, no crash;
    - `page=999` → `products []`, `total 80`;
    - `pageSize=1000` → 400; `priceMin=5000&priceMax=100` → 400; `sort=nope` → 400;
    - after setting all of one product's stock to 0 → its card shows `availability 'out'`, and with `inStockOnly=true` it disappears;
    - a `draft` product is not listed;
    - no card contains a stock number above 3 (scan for `lowStockCount > 3`);
    - the cache header is set.
  - Facets:
    - `category=boots` → the `brand` facet only counts boots;
    - the `category` facet still lists other categories with their counts;
    - `brand=nike&size=EU 39&surface=IC` (no match) → total 0 and facets still present (Review Focus 1);
    - `price` facet buckets sum to total.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (one SQL builder producing a `where` from params minus an optional excluded key, reused for the listing and each facet). **Step 4:** PASS. Commit `feat: catalog listing with server-defined filters`.

### Task 4: Product detail, search suggestions, menu, collections, home

**Files:**
- Create: `src/modules/catalog/detail.ts`, `search.ts`, `home.ts`, `test/integration/catalogDetail.test.ts`
- Modify: `src/modules/catalog/router.ts`, `src/db/seed/index.ts` (seed collections from `sport-heaven/src/data/editorial.ts` `COLLECTION_CATALOG` where their rule maps to filters; otherwise skip and list them in the ledger; plus default home sections: hero placeholder, new-arrivals rail, best-sellers rail, category grid)

**Interfaces:**
- `GET /v1/catalog/products/:slug` → `{ product: ProductDetail }`:
  - card fields, plus `shortName, description, highlights, specs, attributes, isCustomizable, images: [{url, alt, colorName}]`;
  - `variants: [{ id, size, color, priceCents, compareAtCents, availability, lowStockCount, byBranch: { [branchId]: 'ok'|'low'|'out' } }]`, sorted by `size_sort`. `byBranch` uses the per-branch units after the buffer: >3 ok, 1–3 low, 0 out;
  - `related`: up to 8 active cards, same category, preferring the same brand/league, excluding self.
  - Unknown/draft/archived → 404 `not_found`.
- `GET /v1/search/suggest?q=` (q 2–60 chars, otherwise 400) → `{ products: [{slug, name, imageUrl, priceCents}] (≤6), brands: [{slug,name}] (≤4), categories: [{slug,name}] (≤3) }`, by trigram similarity; `Cache-Control: public, max-age=60`.
- `GET /v1/catalog/menu` → `{ categories: [{slug, name, productCount}], brands: [{slug, name, productCount}], collections: [{slug, name}] }` (active products only; `max-age=300`).
- `GET /v1/catalog/collections/:slug` → `{ collection: {slug, name, description} }` (the listing uses `?collection=`).
- `GET /v1/catalog/home` → `{ sections: [{ id, type, payload }] }`. Active sections in time window, sorted. A `product_rail` payload `{ title, query }` is resolved into `products: ProductCard[]` (≤12) using the listing query.

- [ ] **Step 1: Failing tests** `catalogDetail.test.ts`:
  - the Cambodia jersey detail has 5 variants in S…XXL order, each with `byBranch` keys for all three branches, and `isCustomizable` true;
  - after stock for size M is set to 2/0/0 with a buffer of 1 → M is `low` with `lowStockCount 1`, and `byBranch.sonthormuk 'low'`, others `out`;
  - all sizes at 0 → all `out` but still returned (Review Focus 4);
  - an archived product → 404;
  - `related` excludes self and has ≤ 8;
  - suggest `q=mess` returns a Messi boot in products; `q=a` → 400; `q=nike` → brands include Nike;
  - the menu category counts sum to 80;
  - home returns ≥ 1 `product_rail` with products resolved.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: product detail, search suggestions, menu, collections and home sections`.

### Task 5: Stock service and staff/admin catalog API

**Files:**
- Create: `src/modules/stock/service.ts`, `src/modules/admin/catalogRouter.ts`, `src/modules/admin/stockRouter.ts`, `test/integration/stock.test.ts`, `test/integration/adminCatalog.test.ts`

**Interfaces:**
- `stockService`:
  ```ts
  export type StockReason = 'import'|'admin_adjust'|'store_sale'|'transfer_out'|'transfer_in';
  export async function applyMovement(tx, m: { variantId; branchId; deltaOnHand: number; deltaReserved?: number; reason: StockReason; refId?: string; note?: string; actorUserId?: string }): Promise<StockRow>;
  // SELECT … FOR UPDATE the (variant, branch) row (insert 0/0 if missing),
  // check the invariants (on_hand+Δ ≥ 0 → else 409 insufficient_stock {available: on_hand};
  //   on_hand+Δ ≥ reserved+Δr → else 409 held_for_online_order {reserved}),
  // update, insert the movement, clear needs_count on admin_adjust; return the new row.
  ```
- Staff/admin routes under `/v1/admin` (requireRole('staff','admin'); a branch-scoped staff member on another branch → 403):
  - `GET /stock/lookup?q=` → products matching SKU/name (≤ 20) with variants and **this branch's** (`staff_branch_id`, or a `branchId` query param for admins) `onHand`, `reserved`, `available`.
  - `GET /stock?productId=` → every variant × branch with real numbers and `needsCount`.
  - `POST /stock/sale { branchId?, lines: [{ variantId, qty ≥ 1 }] (1–50) }`: all lines in one transaction (all-or-nothing), `store_sale`, `ref_id` = a generated sale id. Returns `{ saleId, lines: [{variantId, onHand}] }`. `branchId` defaults to the staff member's branch; for an admin it is required.
  - `POST /stock/adjust { variantId, branchId, delta (≠0), note (1–200) }`.
  - `POST /stock/transfer { variantId, from, to (≠from), qty ≥ 1 }`: `transfer_out` + `transfer_in` with one shared ref_id.
  - `GET /stock/movements?variantId=&branchId=&limit≤200`.
- Admin-only routes (requireRole('admin')):
  - `GET /admin/products?q=&status=&page=` (full i18n, all statuses).
  - `POST /admin/products`: `{ slug, brandSlug, categorySlug, name: {en, km?}, … , colors: [{name, swatchHex}], variants: [{ color, size, sku?, priceCents, compareAtCents? }], images: [{ path, color? }] , status }`. Creates everything with stock rows 0 at every branch.
  - `PATCH /admin/products/:id` (top-level fields + status).
  - `PUT /admin/products/:id/variants/:variantId { priceCents?, compareAtCents?, status? }`.
  - `POST /admin/products/:id/variants` (add size).
  - Every write refreshes `search_text` and `updated_at`.

- [ ] **Step 1: Failing tests.**
  - `stock.test.ts`, service-level:
    - a sale of 1 from 2 → 1 plus one movement;
    - a sale of 3 from 2 → `insufficient_stock` and nothing changes;
    - with reserved=2 and on_hand=2, a sale of 1 → `held_for_online_order`;
    - **two concurrent sales of the last unit → exactly one succeeds** (Review Focus 3);
    - a multi-line sale where line 2 fails → line 1 is rolled back;
    - a transfer moves units and writes 2 movements with the same ref;
    - an adjust clears `needs_count`.
  - `adminCatalog.test.ts`, HTTP:
    - a customer → 403 on every route;
    - staff at `sensok` → `POST /stock/sale` with `branchId: 'sonthormuk'` → 403; without branchId → it uses sensok;
    - staff → `POST /admin/products` → 403;
    - lookup by SKU shows real numbers;
    - admin creates a product (draft) → hidden publicly, then visible once activated, with a `priceCents` change reflected in the listing;
    - an invalid `compareAtCents ≤ priceCents` → 400;
    - a duplicate slug → 409 `slug_taken`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: stock service with audit trail, staff counter sales and admin catalog API`.

### Task 6: Wishlist, README, legacy clean-up

**Files:**
- Create: `src/modules/wishlist/router.ts`, `test/integration/wishlist.test.ts`
- Modify: `src/app.ts`, `README.md`, `.env.example` (`ASSET_BASE_URL`); delete `legacy/routes/apiRouter.ts` catalog parts? **No**: legacy files are deleted whole only when fully superseded. Delete `legacy/repositories/adminRepository.ts` **only if** nothing in `legacy/` that later phases port still needs it (it holds webhook logic for phase 5, so keep it).

**Interfaces:**
- `GET /v1/me/wishlist` → `{ products: ProductCard[] }` (active products only, newest first; archived or draft are hidden: Review Focus 5).
- `PUT /v1/me/wishlist/:productId` → 204, idempotent. Unknown or non-active product → 404. Max 200 items → `409 wishlist_full`.
- `DELETE /v1/me/wishlist/:productId` → 204, idempotent.
- The `productId` param also accepts a slug (resolved server-side), because the frontend works with slugs.

- [ ] **Step 1: Failing tests:**
  - add by id and by slug → `GET` lists both, newest first;
  - adding twice → still one entry;
  - delete → gone;
  - an unknown id → 404;
  - archiving a wishlisted product → hidden from the GET;
  - an out-of-stock product is still listed with `availability 'out'`;
  - another user's list is separate;
  - no auth → 401.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite, typecheck, build). Update the README endpoints table and the `catalog:import` setup step. Commit `feat: member wishlist`.

---

## Deferred (not in phase 3)

- CSV import/export for admins (spec §14 mentions it): JSON APIs come first; CSV is a thin layer added once the admin UI exists.
- Image upload to object storage: paths only for now. Hosting and optimising the 42 MB of images belongs to deployment.
- Reviews and ratings: not in the spec. The fabricated frontend values are intentionally not imported.
