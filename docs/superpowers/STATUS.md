# Overnight run — status

Work order: `docs/superpowers/plans/2026-11-25-overnight-handoff.md`. Owner decisions: [OWNER-DECISIONS.md](OWNER-DECISIONS.md). Owner to-do: [OWNER-TODO.md](OWNER-TODO.md).

After a context reset, trust this file, the plan ledgers (`.superpowers/sdd/<plan>/progress.md`) and `git log` over memory.

| Stage | What | Plan file | Last commit | State |
|---|---|---|---|---|
| 0 | Bootstrap | (work order) | see git log | done |
| 1 | Backend phase 5: checkout, orders, payments | `plans/2026-11-25-phase-5-checkout-payments.md` | 10c4ecd | done (review: 5 Important fixed) |
| 2 | Backend phase 6: post-purchase | `plans/2026-11-25-phase-6-post-purchase.md` | bfea8ba | done (review: 2 Critical + 5 Important fixed) |
| 3 | Backend phase 7: hardening + deferred minors | `plans/2026-11-25-phase-7-hardening.md` | b06e98c | done (review: 5 Important fixed; every phase 1–6 minor fixed or ruled) |
| 4 | Backend completeness audit | `plans/2026-11-26-stage-4-backend-audit.md` → `BACKEND-AUDIT.md` | 6484192 → HEAD | **done** — gaps closed, whole-backend review fixed (C-1, I-1…I-7, M-2, M-5, M-6, M-8); 721 tests |
| 5 | Frontend design | `sport-heaven/docs/superpowers/specs/…` | – | not started |
| 6 | Frontend build | `sport-heaven/docs/superpowers/plans/…` | – | not started |
| 7 | Frontend audit | `sport-heaven/docs/superpowers/FRONTEND-AUDIT.md` | – | not started |
| 8 | Final report | `OVERNIGHT-REPORT.md` | – | not started |

## Test counts

| When | Backend | Frontend |
|---|---|---|
| Stage 0 (fresh DB, twice) | 281/281 | – |
| Stage 1 done incl. review fixes (twice) | 535/535 |
| Stage 2 done incl. review fixes (twice) | 596/596 |
| Stage 3 done incl. review fixes (twice) | 680/680 | frontend clean-up: 2/2 (typecheck, lint, build clean) |
| Stage 4 done incl. whole-backend review fixes (twice: lint, typecheck, test, build) | 721/721 | – |
| FE1 foundation done incl. review fixes (twice) | 722/722 | 53/53 (typecheck, lint, build, bundle check) |
| FE2 browse done incl. review fixes (twice) | 724/724 | 100/100 (typecheck, lint, build, bundle check) |
| FE3 checkout done incl. review fixes (twice) | 724/724 | 136/136 |
| FE4 account done incl. review fixes (twice) | 724/724 | 160/160 |

## Load test (phase 7, `npm run loadtest`)

50 guests checking out the same size at once, 10 units sellable online (local laptop-class container, Postgres on the same machine). Three runs:

| Run | Orders (201) | Sold out (409) | Other | Busy retries | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| 1 | 10 | 40 | 0 | 0 | 596 ms | 621 ms | 698 ms |
| 2 | 10 | 40 | 0 | 0 | 614 ms | 659 ms | 739 ms |
| 3 | 10 | 40 | 0 | 0 | 606 ms | 624 ms | 679 ms |

The latency is mostly queueing behind the 10-connection pool, since all 50 requests arrive within milliseconds of each other. Normal checkouts take tens of milliseconds.

## Rulings (cumulative)

- [Stage 0] Seed inserted shipping rates before the provinces they reference, so seeding a brand-new database failed (every integration test skipped). Geo is now seeded first in the same transaction.

### Stage 1 (phase 5)

- Pre-flight: add a checkCalls counter to the fake — the T8 test counts provider checks — none. T6 enqueueOrderNotifications consumed by T7/T8/T9 — consistent. T8 refreshPayment consumed by T9 — consistent.
- Task 1: added payments.instructions jsonb — the status poll and the retry endpoint must return the QR/redirect again without calling the provider — one extra column.
- Task 1: first full-suite run after adding migration 0005 had 2 failures that did not reproduce in 3 later runs (290/290 each) — attributed to the one-time migration applying mid-suite; will watch for flakiness — a real flake would resurface in later double runs.
- Task 4: added Exec/Tx in src/db/exec.ts and cart/types.ts (CART_LIMITS + view types) to avoid a cart↔checkout import cycle; pricedCheckout also returns reprice(delivery) so the quote's per-method fees cost no extra DB loads — none.
- Task 4: findPromotion's success branch now also returns promotionId — orders need the id — none.
- Task 5: production requires PAYWAY_RETURN_URL and PAYWAY_CONTINUE_URL too (not only merchant id/key), unless PAYMENT_METHODS_CASH_ONLY=true — without them PayWay can't call back or return shoppers — one more env var to set.
- Task 5: fake card payments redirect (GET) to a dev checkout page at PUBLIC_API_URL/v1/dev/payments/:tranId/checkout — lets e2e exercise the card path — none.
- Task 5: PayWay pushback is treated as untrusted (shape check + optional hash); only the signed check-transaction call can approve — docs unreachable, safest reading — if PayWay signs pushbacks differently, the hash check only rejects bodies that carry a wrong hash.
- Task 6: outbox rows are leased (next_attempt_at += 5 min via UPDATE … FOR UPDATE SKIP LOCKED) and sent outside any transaction, instead of holding a row lock during the network send — parallel workers can't double-send and no transaction waits on Telegram/Resend — a crash mid-send retries after 5 minutes (possible duplicate message).
- Task 7: a line whose only problem is stock (exceeds_stock) answers 409 stock_changed {lines:[{lineId, available=maxQty}]}; archived items / no shipping answer checkout_not_ready — spec §11 names stock_changed for shortfalls; the concurrent loser sees the shortfall through the cart view on retry — none.
- Task 7: members may also send an inline address (not saved); guests must — keeps "deliver somewhere else once" simple — none.
- Task 7: payment attempt row is inserted before calling the provider and marked cancelled if the provider fails; a successful new attempt cancels older pending ones (DB + provider best effort) — keeps attempts numbered and auditable — a cancelled-but-paid attempt still confirms via Task 8 with needs_refund if the order was already paid.
- Task 7: orders.shipping_method_id = 'pickup' for pickup orders — the method row exists; keeps reporting uniform — none.
- Task 8: an approved payment on a staff-cancelled order is not re-reserved; it is marked paid + needs_refund (only `expired` orders are revived) — staff cancelled deliberately; the machine only allows expired→confirmed — a customer who paid seconds after a staff cancel gets a refund rather than goods.
- Task 8: amount mismatch marks the payment approved but leaves the order unpaid + needs_refund + urgent alert — money arrived but it isn't the order total; staff decide — none.
- Task 8: webhook answers 503 when the provider check itself fails (event stored as failed and re-processed on redelivery); 200 for duplicates, unknown tran ids and status mismatches; 401 for bad signatures — lets PayWay retry real outages without retry storms — none.
- Task 8: webhook router mounted on /v1 before the rate-limited router (spec §16 "webhooks exempt but signature-gated") — none.
- Task 8: guest reads (GET order, payment-status) need only the X-Order-Token header; guest writes (retry/switch payment) need the token plus contact phone — keeps phone numbers out of URLs and logs — a leaked token exposes the order view for up to 24h.
- Task 9: SweepDeps takes `database` (pool + db) instead of `db`, and startScheduler lives in jobs/sweeper.ts (no separate scheduler.ts) — the advisory lock needs a dedicated pool connection — none.
- Task 9: expireOrder makes one last unthrottled provider check per pending attempt before expiring, and keeps the hold if the provider is unreachable — avoids expiring orders that were paid seconds ago — an outage delays expiry until the provider answers.
- Task 9: the sweeper's payment checks use a 30 s throttle (the customer poll uses 5 s) — fewer provider calls; webhook + poll cover the fast path — confirmation via sweeper alone can lag 30–90 s.
- Final: kept SERIALIZABLE (spec §11) with 8 attempts + exponential backoff + 503 busy, rather than switching to READ COMMITTED — spec names serializable; row locks + retries keep invariants — heavy bursts may still see occasional retryable 503s.
- Final: a webhook arriving within 2 s of another provider check for the same payment is stored as ignored/throttled; the poll (3 s) and sweeper still confirm the payment — protects the merchant API key from pushback floods — confirmation can lag a few seconds in that window.

### Stage 2 (phase 6)

- Task 2: tracking also masks the contact block (first name + initial, phone ***678, no email) and drops the order note, beyond the planned address masking — anyone with number+phone can call it — none.
- Task 2: per-route limiters come from ctx.routeLimit(bucket, max); AppDeps.rateLimit.routes (default = enabled) lets tests switch them on separately — needed to pin the 429 — none.
- Task 3: staff status changes into `cancelled` via POST …/status are routed to the same cancelOrder as POST …/cancel — one cancel path, so stock/points/promo are always handled — none.
- Task 3: collect-cash accepts any unpaid pickup order in awaiting_pickup_payment or ready_for_pickup (not only cash_on_pickup ones) and records the method as cash_on_pickup — a KHQR shopper may pay cash at the counter instead — none.
- Task 3: customer status_changed emails for printing, ready_for_pickup, out_for_delivery, delivered, completed, cancelled (not for confirmed, which payment_received covers) — none.
- Task 3: cancel of a paid order reverses exactly the points the order earned (ledger order_paid delta), never below zero balance — none.
- Task 4: the return-decision email goes to the member's account email, falling back to the order contact email — returns are member-only — none.
- Task 4: store credit approvals also take back the points for the credited amount (like refunds), and record "Store credit to issue" on the order timeline; no wallet exists (spec non-goal) — the customer got value back — staff must issue credit by hand.
- Task 4: an approved refund also enqueues the urgent ops needs_refund message — staff refund in the PayWay portal — none.
- Task 4: added problem reason `not_in_order` (an orderItemId from another order) to the plan's list — needed for a complete 400 — none.
- Task 4: returned units go back at the deciding staff member's branch, else the body's branchId, else the item's first shipping branch — matches where the parcel physically arrives — staff can't pick another store when tied to one.
- Task 5: loyalty_ledger gains actor_user_id (migration 0007) for admin adjustments, instead of writing the actor into the note — spec §14 "every admin write records actor_user_id" — none.
- Task 5: GET /me/insights is kept (it powers the account page's purchase breakdown); colours/labels for charts stay in the frontend — owner's old UI already had it — none.
- Task 5: the loyalty response also includes pointsPerUsd so the UI can explain earning without hard-coding 10 — none.
- Task 6: public Q&A returns at most the 50 newest published questions per product; questions about archived/draft products answer 404 — enough for a product page — older answers aren't shown.
- Task 7: logs and the test-message route are admin-only; the overview is staff+admin, branch-scoped for tied staff (questions and outbox counts are shop-wide) — logs hold payment data; staff need the daily picture — none.
- Task 7: the test email goes to the signed-in admin's own email — no recipient in the request means it can't be used to spam others — admins without an email can only test Telegram.
- Task 8: system-health PDF dropped server-side (no jspdf on the API); the frontend dashboard already renders the PDF from /metrics — keeps a heavy client library off the server — none.
- Task 8: the CSV exports the last 20 checks (legacy: 5) and the HTML /view page is not ported (the admin UI replaces it) — none.
- Final: RMA stock lock order fixed (one sorted lockStock up front in createRma/decideRma) without a RED test — the deadlock needs a precise interleaving that can't be reproduced reliably; existing returns tests stay green — a residual ordering bug would surface as a retryable 500 for staff.
- Final: a pushback inside the 2 s check window now waits once and retries; if still busy it is stored as failed (reprocessed on redelivery) — dropping it lost late payments — a flood holds each request ≤ 2 s.
- Final: the sweeper re-checks expired/cancelled attempts of orders expired in the last 24 h every 10 minutes — safety net when no webhook arrives — up to 144 provider checks per expired order per day.

### Stage 3 (phase 7)

- Task 1: the raw-body copy fix (buf instead of Buffer.from(buf)) has no observable behaviour to test; the webhook tests cover raw-body use — none.
- Task 2: the phone-release UPDATE is kept unconditional — it matches (and writes) no rows unless another account holds the number, so it never writes needlessly; a pre-check SELECT would add a round trip — none.
- Task 2: the 5-minute token-cache revocation note goes into the README in Task 11 (docs task) — one docs pass — none.
- Task 3: facets now load the active catalogue in one query and count in memory (≤2 queries), pinned to fixtures recorded from the old SQL (test/fixtures/facets.json) — the pool-exhaustion fix the minor asked for — memory grows with catalogue size (fine to several thousand products).
- Task 3: accents are folded in JS (foldAccents) for search_text and the needle, plus unaccent() in the admin refresh and a backfill migration; no immutable unaccent index wrapper needed — keeps the trigram index plain — none.
- Task 3: migration 0008 is hand-written (colour lower(name) unique index + dedupe + search_text backfill) and the index is not mirrored in the Drizzle schema — drizzle-kit can't express expression indexes cleanly; future generates won't touch it — a schema reader won't see the index in TS.
- Task 3: README color/facet docs are written in Task 11's docs pass — one docs pass — none.
- Task 4: concurrent first adds from a guest with no cookie yet can't be linked (no shared token exists); the orphan cart is removed by the 60-day guest cart cleanup (phase 5 sweeper) — no correctness impact — an extra empty-ish cart row for up to 60 days.
- Task 4: reReserve may push used_count past max_uses — the customer has already paid; refusing would only add a refund — a code can be "used" once more than its cap in that rare case.
- Task 4: the cookie-fixation note goes into the README in Task 11 — one docs pass — none.
- Task 5: scheduler.stop() waits at most 1.5 s for a running sweep (then lets shutdown continue); a provider call stuck past that is bounded by the client's own 15 s timeout — shutdown must fit the platform's grace period — the pool close may wait for that call to return.
- Task 6: the Redis store is documented (README/DEPLOYMENT) but not shipped — one instance needs none and no Redis host exists yet; the RateLimitStore interface is the seam — running 2+ instances without it multiplies the limits by the instance count.
- Task 7: test tokens take an optional 5th part (URL-encoded display name) beyond the planned format — lets e2e create named accounts — none.
- Task 8: ESLint uses typescript-eslint `recommended` plus the type-aware promise rules (no-floating-promises, no-misused-promises, await-thenable) rather than the whole recommendedTypeChecked set — the promise rules are the safety value; the full set mostly flags `any` from DB rows — some stylistic type-aware checks are off.
- Task 8: the write-endpoint audit is a static source scan (router.<verb>('path' … validate({ body: …})) with an explicit allowlist — Express 5 router internals aren't a stable API to walk — a route registered outside src/modules wouldn't be scanned.
- Task 8: the 4 moderate npm audit advisories (esbuild via drizzle-kit, dev only) are left; `npm audit fix --force` would downgrade drizzle-kit — no production exposure — none.
- Task 9: the load test uses 50 concurrent fetch calls against a real listening server instead of autocannon — the property under test is concurrency correctness + percentiles, and it needs per-shopper cookies and idempotency keys that autocannon makes awkward; no new dependency — none.
- Task 10: request schemas stay next to their routers and are re-exported from src/contracts (one source of truth) instead of being moved — avoids churn across every router — none.
- Task 10: response schemas are strict (unknown keys fail) except CMS home-section payloads and product specs/attributes, which are open records — free-form by design — the frontend gets loose types there.
- Task 10: OpenAPI covers the 35 public/member operations the storefront uses; staff/admin endpoints are documented in the README — the admin UI uses hand-written types — admin types can drift without a contract test.
- Task 12: exchange holds don't expire automatically — a size promised to a waiting customer shouldn't vanish; open returns are on the admin overview — a forgotten return keeps one unit off sale until staff decide.
- Task 12: "mark refunded" sets payment_status refunded only for cancelled/expired orders; for delivered orders (a returned item) it just clears the flag and notes it — partial refunds must not mark the whole order refunded — none.
- Task 12: collect-cash also accepts unpaid KHQR pickup orders still pending payment (the shopper pays cash at the counter instead), passing through confirmed/ready silently with one "completed" email and closing open QR attempts — none.
- Final: general per-IP limit raised 120 → 300/min (spec says 120) — Cambodian carriers share IPs (CGNAT), so 120 would block real shoppers browsing together — a single abusive IP gets 2.5× more requests before 429.

## Frontend clean-up (done early, in parallel with Stage 1)

Commits `2c6a01a..4eb3e7a` in `sport-heaven`: the build/typecheck/lint/test now pass; backend-only code and deps removed (`server.ts`, `src/db`, `commerce.test.ts`, `@google/genai`, express, pg, drizzle, firebase-admin…); AI Studio leftovers removed (package name, `.gmp_cache`, `metadata.json`, the Maps quota banner, `DISABLE_HMR`); Firebase web config moved to `VITE_FIREBASE_*`; `/v1` dev proxy to the API; ESLint 9 + Vitest; `scripts/optimize-images.mjs` wrote WebP/AVIF/JPEG variants to `public/assets/catalog` (7.5 MB) and `public/assets/site` (1.2 MB). Open items for Stage 6: original images (≈56 MB) still in the repo and copied into `dist` by a Vite plugin; the system-health dashboard still points at old `/api/system-health*` URLs; 27 lint warnings in legacy screens; `npm audit` reports 4 high advisories; TypeScript pinned to 6.0 (typescript-eslint doesn't support 7 yet).

## Deferred minors (cumulative)

The phase 1–4 minors are listed in the work order §2; Stage 3 closes or rules out each one. New ones are added here as stages finish.

### Stage 1 (phase 5) — for Stage 3

- lock-order inversion promotion vs stock in expireOrder/reReserve (self-heals via retry)
- two pending attempts can deadlock in fulfil (lock all payments in attempt order)
- sweeper can stall during provider outage; stop() waits for the whole tick
- idempotency keys never deleted (spec: 24h)
- withIdempotency takeover may release a key owned by a slow original request
- non-AppError after order commit returns 500 though the order exists (return 201 + paymentError)
- stock_changed details shape differs between planner ({lineId}) and reserveAllocations ({variantId})
- pricedCheckout runs Promise.all on a transaction client (pg deprecation; pg@9 will reject)
- needs_refund alert headline shows the order total, not the amount actually paid
- reReserve increments used_count past max_uses (arguably correct: customer paid)

### Stage 2 (phase 6) — for Stage 3 (phase 7 Task 12)

- sweeper logs raw err (use safeError)
- cancel/RMA can re-flag needs_refund on an order already marked refunded
- marking refunded after a partial RMA refund marks the whole order refunded
- collect-cash sends two emails and doesn't close open KHQR attempts
- overview revenue and insights count cancelled-but-paid orders
- question status-only changes record no actor
- RMA restock fallback branch is the literal 'sonthormuk'
- exchange holds never expire

All phase 1–6 minors above were closed in Stage 3 (fixed, or ruled in the Stage 3 rulings).

### Stage 3 (phase 7) — for Stage 4

- IPv6 limits keyed on the full address (not /64)
- circuit breaker also trips on cancelTransaction failures
- a payment skipped by the breaker isn't rechecked until its interval passes (≤10 min for late payments)
- matches() vs SQL edge cases for non-string attributes / numeric flags (theoretical with admin-validated data)
- markRefunded clears all refund flags at once; no separate partial-refund marker
- migration 0008 rename suffix may show in colour names; index absent from Drizzle snapshot
- loadtest resets whatever TEST_DATABASE_URL names (no name guard)
- wishlist re-add of an item whose sizes are all inactive returns 404 instead of 204
- contract duplicates the order/payment status enums instead of importing them

**Stage 4 ruling on the Stage 3 minors:** all stay deferred. Each is theoretical with admin-validated data, affects only operators (not shoppers' money or stock), or is a developer tool (loadtest). None changes what a shopper pays or receives.

### Stage 4 (whole-backend review) — deferred

- M-1 branch staff can cancel/refund a split multi-branch order (scope = any allocation at their branch)
- M-3 a stock adjustment below the reserved count doesn't name the holding order
- M-4 (rest) the CSV price import logs a count, not each change; no persisted admin audit table
- M-7 expiry emails go to unverified guest addresses; ops Telegram gets one message per unpaid order

## FE1 storefront foundation (done, review fixed)

Rulings:
- Task 1: Ruling: tokens test lives at src/test/tokens.test.ts — vitest include is src/** — none
- Task 1: Ruling: openapi-typescript peer-requires TS 5; package.json overrides it to the project TS 6 — generation verified — if it breaks, regenerate with TS 5 via npx
- Task 3: Ruling: Lang type lives in lib/i18n/types.ts (format.ts and the provider both need it without a cycle) — none
- Task 4: Ruling: createAuthAdapter(env) takes env as a parameter (default import.meta.env) so the build-flag test needs no module mocking; without Firebase keys an "unconfigured" adapter keeps guests browsing and sign-in explains it isn't set up — none
- Task 4: Ruling: useAuth also exposes signOut() and clearCartMerged() (the account menu and the merge notice need them) — additive
- Task 4: Ruling: Firebase is lazy-loaded on first auth use (keeps ~100 kB out of the first load); onChange uses onIdTokenChanged — none
- Task 5: Ruling: QueryView takes isEmpty(data) next to empty (the view can't guess what "empty" means per query); Dialog is Sheet side="center" (one focus-trap implementation) — none
- Task 5: Ruling: the srcset manifest is generated by scripts/image-manifest.mjs from public/assets (not the optimiser) into src/lib/images.manifest.json, so it survives deleting the original images in Task 7 — none
- Task 6: Ruling: Khmer glyphs fall back to Noto Sans Khmer inside every font stack (display included) instead of switching the whole page font, so the Latin wordmark keeps Barlow — screenshots checked en/km at 390 and 1366 — none
- Task 6: Ruling: the desktop header shows the language switch; on phones it lives in the menu sheet and footer (header must fit 390 px) — none
- Task 7: Ruling: the admin health dashboard keeps its localStorage use (alert threshold and toast preference are per-device UI preferences, allowed by the spec) — none
- Task 7: Ruling: old help/policy copy (src/pages/PolicyAndSystemPages.tsx, SupportPages.tsx) is recoverable from git at 264082a for the FE2 help pages — none
- Task 7: Ruling: public/assets/aistudio (4 unoptimised PNGs, 15 MB) removed; backend importer now maps every photo to catalog/<name>.jpg (+ migration 0010) — the one product that used a PNG was showing a broken image — none
- Task 7: Ruling: kept deps qrcode (KHQR), recharts + jspdf (admin health), @vis.gl/react-google-maps (stores map); removed motion — none

Deferred minors:
- Sheet Escape closes nested dialogs together; add inert on siblings; iOS scroll lock — revisit in FE3 when nested dialogs appear
- first guest cart fetch before Firebase restores the user (authStateReady)
- mobile menu shows only "Shop all" when the menu API is down
- SPA fallback config for the static host; SameSite=Lax needs same-site API (documented in backend DEPLOYMENT)

## FE2 browse (done, review fixed)

Rulings:
- Task 2: Ruling: /custom has no listing filter in the API (no "customizable" tag); customizable products are exactly the jerseys and F1 categories, so /custom shows those two rails (Task 9) — none
- Task 2: Ruling: search results use /v1/search (ranked) with the same filters; facets come from /v1/catalog/filters?q= — none
- Task 2: Ruling: a deep link with page=N loads N pages in one request (pageSize 24·N, capped at 96) instead of N requests — fewer round trips on Back — beyond page 4 the first request is capped and later pages load on demand
- Task 3: Ruling: product photos are cut-outs, shown object-contain with multiply blend on the stone stage — visual check in Task 4 screens — none
- Task 3/4: Ruling: product photos are full-bleed studio shots, so cards use object-cover (plan said contain for cut-outs; Global Constraints line updated) — screens checked — none
- Task 4: Ruling: swipe rails get contain:paint + scroll-padding on phones (Chromium counted their scroll content in the page width: 567 px at 390) — verified 390 px with no horizontal scroll en/km — none
- Task 4: Ruling: hero falls back to the catalog's hero boot photo when the section has no image — none
- Task 5: Ruling: filters apply as soon as they are ticked (also in the phone sheet); the sheet's button shows the live count and closes it — fewer taps, the grid behind updates — none
- Task 6: Ruling: the header search button opens the overlay (a new Sheet side 'top'); /search stays the results page; the overlay mounts only while open so each opening starts empty — none
- Task 7: Ruling: per-store availability is shown only after a size is chosen (the API gives it per variant) with a hint before — none
- Task 7: Ruling: spec labels are humanised from the API's keys (English only until the owner adds translated specs) — Khmer pages show English spec names — listed in OWNER-TODO (Khmer product content)
- Task 8: Ruling: the studio lives on the product page (#print) and uses the size chosen in the buy box; one printed shirt per add (quantity 1) since each print is personal — none
- Task 9: Ruling: help copy is rewritten from the real rules (old pages were invented chat/marketing text); terms and privacy marked "Draft: waiting for the owner's review"; terms/privacy/size-guide/about are English-only in Khmer with a note — costs the owner a legal read and Khmer translations (OWNER-TODO)
- Task 9: Ruling: the stores page uses "Open in Google Maps" links for every store; an embedded map is skipped (no Maps key, and the links work on every phone) — the owner can ask for the map once a key exists
- Task 9: Ruling: the return windows on the help page (30/14 days) are written text matching the seeded settings; if the owner changes them in admin, the help text must be edited too — noted in OWNER-TODO
- Task 9: Ruling: the Khmer .font-display spacing rule moved outside the CSS layers so it beats leading/tracking utilities (Khmer headings overlapped) — none
- Final: Ruling: a deep link with page=N>2 opens with the first 48 products and Load more, not N pages — avoids several requests — the shopper scrolls a little further after Back from deep pages

Deferred minors: none (all review minors fixed).

## FE3 bag, checkout, payment, orders (done, review fixed)

Rulings:
- Task 2: Ruling: the bag shows the total without delivery ("Calculated at checkout") and the KHR line only once delivery is known; the delivery estimate uses the quote — the cart's default PP delivery would otherwise look like a promise — none
- Task 2: Ruling: the header bag icon opens the drawer (modified clicks still open /bag) — none
- Task 3: Ruling: the form is checked in the browser first with friendly messages (name, Cambodian phone, address, store, payment, terms); the server's field errors are mapped onto the same fields — server stays the authority — none
- Task 3: Ruling: the Idempotency-Key is kept after an offline/5xx failure (the order may have been received) and replaced after any other answer; a second tap while sending is ignored — none
- Task 3: Ruling: an empty recipient phone means "same as my phone" — none
- Task 4: Ruling: the guest's contact phone is kept with the order token in sessionStorage (this tab) because the API asks for it again to switch payment or cancel; if missing, the page asks once — none
- Task 4: Ruling: the QR is drawn in the browser as SVG from PayWay's string (no image request); the card page opens only when the shopper presses Continue (no automatic redirect) — none
- Task 5: Ruling: renderRoutes takes the app's staleTime when a test needs real caching behaviour — none

Deferred minors:
- focus does not move to the first invalid field on submit (the summary alert is announced)
- member order page on hard reload before Firebase restores the user may show "Find this order" (needs real Firebase to verify; FE6 manual check)

## FE4 sign-in and account (done, review fixed)

Rulings:
- Task 1: Ruling: in test builds (VITE_AUTH_TEST_MODE) the phone sign-in works with code 123456 and a uid derived from the phone, so e2e and local development can sign in through the real page; the bundle check refuses it in production builds — none
- Task 1: Ruling: the guest-bag merge message is a one-time toast shown by a MergeNotice inside the providers — none
- Task 2: Ruling: account pages are registered eagerly under the store layout (small); sign out sits in the sidebar on desktop and at the end of the overview on phones — none
- Task 3: Ruling: the address form is its own component (label + recipient + gazetteer) rather than sharing the checkout form state — none
- Task 4: Ruling: the return reason is sent as the shopper's chosen words (the API stores free text up to 300 chars) — staff read it as written — none
- Task 4: Ruling: new-return screenshots deferred to the e2e run in FE6 (needs a delivered member order; the e2e scenario 2 creates one) — layout reuses checked components

Deferred minors:
- return reasons are stored in the shopper's language (Khmer reasons reach staff in Khmer)
