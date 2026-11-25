# Sport Castle — Overnight Work Order (Handoff to a Fresh Session)

> **For agentic workers:** You are continuing a project another session started. Read this whole file before acting. It is the **master plan of plans**: each stage below gets its own detailed plan, written with `superpowers:writing-plans` and executed with `superpowers:executing-plans` (inline). Steps use checkbox (`- [ ]`) syntax. Keep `docs/superpowers/STATUS.md` (Stage 0 creates it) up to date after every stage, so a later session can resume from it.

**Goal:** Make Sport Castle (a Phnom Penh football / futsal / F1 store with 3 branches) a complete, production-ready product: finish the backend (phases 5–7), audit the backend against the design until nothing is left, then rebuild the frontend so that it runs entirely on that backend with a polished, mobile-first UX. Do all of this autonomously overnight; the owner is asleep.

**Architecture:**
- **Backend** `sport-backend`: Node 22, TypeScript, Express 5, Drizzle ORM 0.45, Postgres 16, Zod 4, Firebase Auth (phone OTP + Google), pino, Vitest + supertest. Feature modules live in `src/modules/*`. Prices are computed by the pure engine `src/modules/pricing/engine.ts`, and stock changes only through `src/modules/stock/service.ts` `applyMovement`.
- **Frontend** `sport-heaven`: React 19, Vite 8, Tailwind 4. It currently does not build (details in Stage 5).

**Tech Stack:** see each repo's `package.json`. The backend README lists every endpoint built so far.

**Spec (binding):**
- `sport-backend/docs/superpowers/specs/2026-11-25-backend-production-design.md`: read all of it.
- Behaviour reference: `sport-heaven/docs/research/zando-behavior-reference.md` (Adopt / Adapt / Avoid lists).
- Completed plans: `sport-backend/docs/superpowers/plans/2026-11-25-phase-{1..4}-*.md` (match their style).

---

## 0. Ground rules for this run (owner's standing instructions)

The owner said, verbatim in intent: *"continue automatically to the next phase when the current one is completely done; don't wait for me; when all phases are finished, review the backend to see if it is completely done, and if not, finish it; then do the same for the frontend; work non-stop overnight; nothing left undone; everything must be done and perfect. Anything that needs me, I will do later, all at once."*

So:
1. **Never stop to ask the owner a question, and never wait for approval between phases or stages.** For every decision, choose the option the spec (or this file) points to, otherwise the safest sensible default. Record each one in `docs/superpowers/OWNER-DECISIONS.md` (backend repo) as `- [Stage N] Decision — why — what changes if you disagree`, and keep going.
2. **Anything only the owner can provide goes in `docs/superpowers/OWNER-TODO.md`. Never block on it.** That covers credentials, merchant accounts, prices, hosting, domain and legal text. Build against fakes, sandboxes or placeholders that are clearly marked.
3. **Do not request environment or network changes, credentials, or anything that shows an approval prompt.** Nobody is awake to approve. If a host is blocked, work without it and add it to OWNER-TODO.
4. **Git:**
   - Commit early and often on branch `claude/awesome-mayer-fhxeom` in **both** repos.
   - Push after every task: `git push -u origin claude/awesome-mayer-fhxeom`, retrying up to 4× with backoff on network errors.
   - **Never** create PRs, never merge, never push to another branch, never force-push.
   - End every commit message with:
     ```
     Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
     Claude-Session: <this session's URL from your system reminder>
     ```
   - No model names in commits, code or docs.
5. **Quality bar (every task):**
   - `superpowers:test-driven-development`: write the failing test, watch it fail, implement, watch it pass, run the whole suite.
   - `superpowers:verification-before-completion`: no claim without command output.
   - Typecheck and build must be clean.
6. **Final review per phase or stage is mandatory.**
   - Dispatch a fresh `general-purpose` subagent with `model: "opus"` using `superpowers:requesting-code-review` and its `code-reviewer.md`. Pass it the review range, plan, spec, the ledger's `Ruling:` lines and the plan's Review Focus. Run it in the background and wait for its notification.
   - Re-grade findings by real user/operator impact.
   - Fix every Critical and Important finding test-first (RED→GREEN) in one fix pass. Ledger Minors as deferred.
   - Then push, update STATUS.md and move on **without asking**.
   - If the reviewer hits a usage or rate limit, wait for the reset time it reports, then resume the same agent with `SendMessage` ("continue the review from where you stopped"). Never skip the review.
7. **Context hygiene (this is a long run, and your context will be compacted):**
   - Keep per-plan ledgers (see §1) and STATUS.md current; after compaction, trust them and `git log` over memory.
   - Redirect long command output to files and read the tails.
   - Never re-implement a task whose ledger line says `complete`.
8. **Report at the very end** (Stage 8) in plain language, for a non-expert owner: what was built, the decisions taken (link OWNER-DECISIONS.md), and the owner's to-do list (link OWNER-TODO.md).

---

## 1. Environment and workflow mechanics

**Workspace:** `/home/user/sport-backend` and `/home/user/sport-heaven` (both cloned, on branch `claude/awesome-mayer-fhxeom`). If either is missing or behind, `git fetch origin claude/awesome-mayer-fhxeom && git checkout claude/awesome-mayer-fhxeom && git pull`.

**Postgres 16 (local):**
- Start: `pg_ctlcluster 16 main start` (it sometimes stops by itself; on `ECONNREFUSED 127.0.0.1:5432`, start it again and rerun).
- User `postgres`, password `postgres`. Databases `sport_test` (tests) and `sport_dev` (manual runs). Create missing ones with `su postgres -c "psql -c 'CREATE DATABASE sport_test;'"`.
- Backend setup:
  ```bash
  npm ci
  npm run build
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/sport_dev COOKIE_SECRET=$(printf 'x%.0s' {1..40}) npm run db:migrate
  ```
  Then run `db:seed` and `catalog:import` the same way.
- Tests use `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/sport_test`) and run files serially.
- **Test hygiene:** reference tables (`settings`, `shipping_rates`, `branches`, `categories`, geo) survive `resetDb`. Any test that changes them must restore them in both `beforeAll` and `afterAll` (see `test/integration/adminPricing.test.ts`). Run the suite twice before each commit at the end of a task, so cross-run leaks show up.

**Docker:** `docker build` fails on a Docker Hub 429 rate limit. Don't fight it; CI builds the image. Verify image contents by simulating the runtime stage, as phase 1 Task 7 did.

**Skills and scripts:**
- Plans: `superpowers:writing-plans`. Save to `docs/superpowers/plans/2026-11-2X-<name>.md` in the repo the plan changes. Header, Global Constraints and Review Focus follow the skill's template; read the phase 4 plan for the house style.
- Execution: `superpowers:executing-plans` (inline). Its scripts live in the skill's base directory:
  - `scripts/task-start PLAN N` prints the brief and BASE;
  - `scripts/task-done PLAN N BASE -- npm test` writes the ledger line;
  - `../subagent-driven-development/scripts/sdd-workspace PLAN` prints the workspace;
  - `../subagent-driven-development/scripts/review-package PLAN BASE HEAD` builds the review diff.
- Ledger: `<repo>/.superpowers/sdd/<plan-basename>/progress.md`, git-ignored. Its first line is `# SDD ledger — plan: <path>`. Every deviation is `Task N: Ruling: <what> — <why> — <cost if wrong>`. After the final review: `Final: fixed …` / `Final: minor (deferred): …`. When a stage is done, copy the ledger's Rulings and deferred minors into STATUS.md, then delete the workspace.
- Frontend design work: `frontend-design:frontend-design`. Look at real screenshots with Playwright (Chromium is pre-installed: `require('playwright')`, no install). Use phone 390×844 and desktop 1366×900, and read the PNGs yourself.

**Network:** package registries work. The session's environment ("Sport Castle (research)") also allows `zandoshops.com` and its CDN (`zand.sgp1.cdn.digitaloceanspaces.com`), `checkout.payway.com.kh`, `www.google.com` and `www.gstatic.com`. Other hosts may be blocked; don't ask for more (§0.3).

---

## 2. Where the project stands (as of commit `eb8e374`, backend)

**Done and reviewed — backend phases 1–4:**
- **Phase 1:** foundation. Config validation, pino with deep phone redaction, the error model, request ids, helmet, a CORS allowlist, rate limiting, `/health` + `/ready`, Drizzle migrations, CI and a Dockerfile. Upgraded to Express 5.
- **Phase 2:** auth and accounts.
  - Firebase ID token verification with a cache; user upsert, where the token's phone is authoritative.
  - Roles: customer / staff (optional `staff_branch_id`) / admin; bootstrap admins via env.
  - Profile, and account deletion (anonymise + Firebase delete, retried later).
  - Addresses with Province→District→Commune validation (25 provinces / 210 districts / 1,652 communes seeded); branches; admin user/role management.
- **Phase 3:** catalog.
  - 80 storefront products / 448 variants imported (insert-only importer); per-branch stock with `stock_movements` audit.
  - Online availability = Σ max(0, on_hand − reserved − buffer), buffer 1 by default. Only `ok`/`low`(1–3)/`out` is public.
  - Listing with server-defined facets, detail, search suggestions (pg_trgm), menu, 14 collections stored as saved filters, home sections, wishlist.
  - Staff stock API: lookup, counter sale, adjust, transfer. Admin product API.
- **Phase 4:** cart and pricing.
  - Pure `priceCart`: print fees, the 5+ jersey team discount, member perks (Silver 10%, Gold free `pp_rider`, Pro free printing; verified phone only), one promo code (the lower *final total* wins; ties keep member), delivery, KHR.
  - Server carts: a guest via the signed `sc_cart` cookie, members by account; merged at `/v1/auth/session`.
  - Promotions, shipping rates and pricing settings with an admin API.
- 281 tests green; typecheck and build clean.

**Not started:** backend phases 5–7, and all frontend work.

**Legacy code still to port or delete** (`sport-backend/legacy/`, excluded from build):
- `routes/apiRouter.ts` (orders, track, RMA, questions, account bootstrap);
- `routes/adminRouter.ts` (overview stats, orders, order status, webhooks log, notifications log + test);
- `payments/webhookCrypto.ts` + `webhookRouter.ts` (ABA HMAC verify; Stripe is dropped);
- `notifications/notificationService.ts` (Telegram + Resend);
- `repositories/adminRepository.ts` (webhook recording), `repositories/storeRepository.ts` (orders, RMA, questions);
- `validators/schemas.ts`;
- `health/*` (system-health service, router, PDF report, types);
- `components/SystemHealthDashboard.tsx` (React; belongs to the frontend).

**Deferred minors from phases 1–4.** Each must be fixed in Stage 3, or ruled out with a reason in STATUS.md.
- P1:
  - a 500 is logged twice (errorHandler + pino-http);
  - `/health` and `/ready` are logged on every probe;
  - unmapped client body-parser errors (`request.aborted`, `request.size.invalid`, `entity.verify.failed`) become 500;
  - no `DATABASE_SSL_CA` option;
  - `start()` leaks the pool if `listen` fails;
  - the raw body buffer is copied per request (`Buffer.from(buf)` → `buf`);
  - CI runs twice on push + PR (restrict `push` to `main`);
  - there is no ESLint step in CI (spec §18 asks for lint).
- P2:
  - every authenticated request writes the users row (add `is distinct from` guards, skip the phone-release update when it is unchanged);
  - document the 5-minute token-cache revocation window;
  - demoting a bootstrap admin via the API is undone at their next login (return 409 `bootstrap_admin`, or document it);
  - add a test for set-default address concurrency.
- P3:
  - an unknown `tag` value → should be 400 (z.enum);
  - card `sizes` repeat for multi-colour products (distinct, ordered by min size_sort);
  - colour names are deduplicated case-sensitively only (unique index on `(product_id, lower(name))` + 400);
  - admin image paths aren't validated (`^[a-z0-9][a-z0-9/_.-]*$`, no `..`, no scheme), and an unknown image colour silently becomes null (make it 400);
  - `unaccent` is installed but unused (use it in search_text, or say so);
  - `/catalog/filters` runs 11 parallel queries on a pool of 10 (collapse into 1–2 queries over a materialised base);
  - the wishlist cap isn't atomic, and PUT accepts active products with no active variants (reuse `base`);
  - branch-scoped staff can read every branch's stock (decide; default: restrict reads to their branch for scoped staff);
  - the README lacks the `color` param, and there are no color/tag/garmentType facets.
- P4:
  - promotion validation: `startsAt < endsAt`; `free_shipping` must have value 0 and no category/brand scope; percent/fixed must not have `scope.methods`;
  - concurrent first adds create an orphan guest cart, and abandoned guest carts are never cleaned up (a job that deletes guest carts untouched for 60 days);
  - cookie fixation via a trusted sibling subdomain (document it in the README);
  - spec vs code: print name 12 vs 14 chars, number 0–99 vs 1–99, the 409 `available` at the top level vs `details.available`. **Decision already taken:** keep 14 / 1–99 / `details.available`, update the spec, and note it in OWNER-DECISIONS.

---

## 3. Stages (do them in order; each is "done" only after its final review fixes are pushed)

### Stage 0 — Bootstrap (≈15 min)
- [ ] Get both repos onto the branch and up to date; start Postgres; `npm ci` and `npm test` in the backend. It must be 281/281 green, twice. If it isn't, fix it first (`superpowers:systematic-debugging`).
- [ ] Create, in `sport-backend/docs/superpowers/`:
  - `STATUS.md`: a stage checklist mirroring §3, with columns for stage, plan file, last commit and state. Plus sections for the cumulative "Rulings" and "Deferred minors".
  - `OWNER-DECISIONS.md` and `OWNER-TODO.md`. Seed OWNER-TODO with the known items in §5.
- [ ] Commit `docs: overnight run status, owner decisions and to-do` and push.

### Stage 1 — Backend phase 5: Checkout, orders & payments
Write `docs/superpowers/plans/2026-11-2X-phase-5-checkout-payments.md`, then execute it. The scope is spec §11 and §15, plus the decisions in §2 of the spec:

- **Schema** (migration `0005_…`):
  - `orders`: id uuid, `number` unique `SC-YYMM-XXXXX` (Crockford base32, random), user_id null, contact name / phone_e164 / email null / channel `phone|telegram|whatsapp`, fulfillment, pickup_branch_id, ship_address jsonb snapshot (with resolved geo names), shipping_method_id, status, `needs_refund` bool flag, payment_status, payment_method, all money in cents (`merchandise_cents`, `discount_cents`, `shipping_cents`, `total_cents`), khr_rate, total_khr, promo_code, `pricing` jsonb (the full Breakdown snapshot), note, reserved_until, paid_at, timestamps.
  - `order_items`: product_snapshot jsonb, variant_id, unit/compare-at/print fee/discount/line total cents, qty, custom_print.
  - `order_item_allocations` (order_item_id, branch_id, qty).
  - `order_events` (from/to status, actor, note).
  - `payments`: order_id, attempt, provider `payway`, `provider_tran_id` unique = `{number}-{attempt}`, method, amount_cents, status `pending|approved|declined|refunded|expired|cancelled`, raw jsonb.
  - `payment_webhook_events`: port the legacy idempotency table (unique provider + event id, signature_valid, processing_status, payload).
  - `promotion_redemptions` (promotion_id, user_id null, order_id, contact_phone): enforces `max_uses_per_user`.
  - `loyalty_ledger` (user_id, delta, reason `order_paid|rma_reversal|admin`, order_id, created_at): created here so points awarded at payment have history; Stage 2 adds the read API.
  - `notification_outbox` (channel, recipient, template, payload, attempts, next_attempt_at, sent_at, last_error).
  - `idempotency_keys` (key, scope, request hash, response, created_at, 24h TTL).
- **`POST /v1/checkout/quote`**: the same `priceCart` used by the cart, plus the available delivery and payment methods for that cart. Read-only.
- **`POST /v1/orders`**, with header `Idempotency-Key` required; a replay returns the same response.
  - Validate the contact (name, phone via `normalizePhone`, channel), the delivery (an `addressId` of the member, or an inline address validated like phase 2's addresses for guests), the payment method (only those enabled in `settings.payment_methods_enabled`, seeded `{aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false}`), and `acceptTerms: true`.
  - In **one SERIALIZABLE transaction**, with a retry on serialization failure (up to 3×):
    1. load and lock the cart;
    2. re-price with `priceCart` from the DB;
    3. refuse when `checkoutReady` would be false (409 with the line problems);
    4. enforce the promo's per-user limit and increment `used_count` (refund it on expiry or cancel);
    5. allocate and reserve stock: pickup = the chosen branch only; delivery = the branch with the most online availability per line, **splitting a line across branches** when needed; use **one stock-locking helper that locks (variantId, branchId) in ascending order**, the same order counter sales and transfers use;
    6. `applyMovement(order_reserve, deltaReserved=+qty)`;
    7. insert the order, items, allocations and an event; set `reserved_until = now() + settings.reservation_minutes` (seed 30);
    8. clear the cart.
- **Payments:**
  - A `PaymentProvider` interface (`createTransaction`, `checkTransaction`, `cancelTransaction`, `verifyWebhook`) with:
    - `PayWayProvider`: ABA PayWay, HMAC-SHA512 request hash, base64; check-transaction API; KHQR `qrString` / deeplink / checkout URL. Implement from the official PayWay API docs if reachable; otherwise from your best knowledge, behind the interface, with the exact field mapping in one file and a `// VERIFY AGAINST PAYWAY SANDBOX` marker. Add "verify PayWay field mapping in sandbox" to OWNER-TODO.
    - `FakePaymentProvider` for tests and for local dev when PayWay env vars are missing, with a dev-only `POST /v1/dev/payments/:tranId/approve` that is enabled only when `NODE_ENV !== 'production'` and the fake is active.
  - Config: `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY`, `PAYWAY_BASE_URL` (sandbox default), `PAYWAY_RETURN_URL`, `PAYWAY_CONTINUE_URL`. In production they are required unless only `cash_on_pickup` is enabled.
  - `POST /v1/orders/:number/payments {method}`: retry or switch method while `pending_payment`. Owner = the member, or a guest proving the `contactPhone` plus a short-lived `orderAccessToken` returned at creation.
  - `GET /v1/orders/:number/payment-status`: polls the provider at most once per 5s per order.
  - Webhook `POST /v1/webhooks/payway`: verify (port legacy `webhookCrypto`), record idempotently, then **always re-check with `checkTransaction` before trusting it**.
  - On approved, in one transaction:
    - `payment_status=paid`; status `confirmed`, or `printing` if any line has a print;
    - `order_commit` (on_hand −qty, reserved −qty) per allocation;
    - write the promotion redemption;
    - loyalty: `loyalty_accounts` += points (`pointsPerUsd` × total dollars, floor) with a `loyalty_ledger` `order_paid` row, lifetime spend += total, tier recomputed from `loyalty_rules.tiers`; only for members with a verified phone;
    - write events, and enqueue notifications.
  - An approved payment on an expired order → re-reserve if possible; otherwise set the `needs_refund` flag + an ops alert. A second approved attempt → `needs_refund`.
- **Sweeper:** an in-process scheduler running every minute under `pg_try_advisory_lock`.
  - Checks pending payments.
  - Expires orders past `reserved_until`: `order_release`, cancels the provider transaction, refunds promo usage, status `expired`.
  - Processes the notification outbox with exponential backoff.
  - Deletes guest carts untouched for 60 days (closes the P4 minor).
  - Must be stoppable for graceful shutdown and testable with an injected clock.
- **Notifications:** port the Telegram (ops) and Resend (customer email if given) senders behind a `Notifier` interface with a fake. Templates: order placed (ops), payment received (ops + customer), status changed (customer), needs refund (ops, urgent). A send failure never fails the order.
- **Order status machine** (spec §11): `pending_payment → confirmed | expired | cancelled`; `confirmed → printing | ready_for_pickup | out_for_delivery | cancelled`; `printing → ready_for_pickup | out_for_delivery`; `out_for_delivery → delivered`; `delivered | ready_for_pickup → completed`; plus `awaiting_pickup_payment` for cash on pickup. Enforce it in one function with a table-driven test.
- **Review Focus to pin with tests:**
  - two customers buying the last unit at the same moment → exactly one order;
  - the same `Idempotency-Key` twice → one order;
  - a webhook delivered 3× → one commit;
  - paid after expiry → re-reserve or `needs_refund`;
  - a forged webhook → rejected and logged;
  - quote and order totals are identical to the cart's to the cent;
  - a guest can't read or pay someone else's order.

### Stage 2 — Backend phase 6: Post-purchase
Plan: `…phase-6-post-purchase.md`. Scope:
- **Order tracking:**
  - `POST /v1/orders/track {orderNumber, phone}` returns status, timeline, items and totals, with the address masked (street hidden; commune/district shown). Rate-limited 10/min/IP. Phone matching uses `normalizePhone`.
  - Members: `GET /v1/me/orders` (paged) and `GET /v1/me/orders/:number`.
- **Admin orders (staff + admin; branch-scoped staff see orders with an allocation at their branch):**
  - list, filter and search (number, phone digits, status, date, branch);
  - detail with events, payments and allocations; a per-branch pick list;
  - status transitions via the machine;
  - cancel (releases reservations if unpaid; if paid → `needs_refund`);
  - mark refunded (manual, in the PayWay portal); clear `needs_refund`; add an internal note.
  - Every change writes `order_events` with the actor.
- **RMA:** `rma_requests` + `rma_items`.
  - `POST /v1/me/returns {orderNumber, items: [{orderItemId, qty, reason, exchangeVariantId?}], resolution: refund|size_exchange|store_credit}`.
  - Members only. Only delivered or completed orders. Never custom-printed lines or non-returnable categories (`settings.return_rules`, seeded with `{exchangeDays: 30, refundDays: 14, nonReturnable: ['socks', 'underwear']}`; map these to categories or product attributes and document it).
  - A size exchange must be **within 30 days** of delivered/completed and the same product at the same price, and the replacement is **reserved immediately** (`exchange_reserve`).
  - A refund or store credit must be **within 14 days**, and the amount is **computed by the server** from what was paid for those lines, pro rata including discounts.
  - Admin approves (restock via `rma_restock`, loyalty reversal, refund flag) or rejects (release the exchange reservation).
  - `GET /v1/me/returns`.
- **Loyalty** (the ledger table exists since Stage 1):
  - `GET /v1/me/loyalty` → balance, tier, lifetime spend, progress to the next tier, perks (from settings) and the ledger. Admin adjustment endpoint.
  - The frontend's old `loyaltyTier.ts` and `purchaseInsights.ts` logic moves here: `GET /v1/me/insights` (favourite category/brand, totals) if it adds value; otherwise record a decision.
- **Product Q&A:**
  - `GET /v1/catalog/products/:slug/questions` (published only).
  - `POST` (guest or member, rate-limited 5/min/IP, status `pending`).
  - Admin moderation: answer, publish, hide.
- **Admin overview:** `GET /v1/admin/overview` (today's orders and revenue, pending payments, needs_refund count, low-stock count, needs-count stock rows).
- **System health:** port `legacy/health/*` under `/v1/admin/system-health/*` (admin only; metrics, logs.csv, report.pdf). Port the PDF report only if the `jspdf` dependency is acceptable server-side; otherwise drop it and record why.
- Webhook and notification logs for admins: `GET /v1/admin/payments/webhooks`, `GET /v1/admin/notifications`, `POST /v1/admin/notifications/test`.
- When everything in `legacy/` is ported or consciously dropped (record each), **delete `legacy/`**. Move `components/SystemHealthDashboard.tsx` to the frontend in Stage 5.

### Stage 3 — Backend phase 7: Hardening + every deferred minor
Plan: `…phase-7-hardening.md`. Scope:
- Every deferred minor in §2 and any added by Stages 1–2: fix it, or record why not.
- Per-route rate limits:
  - order create 10/min/IP and 5/min/user;
  - track 10/min/IP;
  - questions 5/min/IP;
  - auth/session 20/min/IP;
  - a pluggable store interface with an in-memory default; document Redis for more than one instance.
- **Security pass:**
  - `npm audit` (fix high and critical);
  - helmet settings for an API (no CSP needed for JSON, but keep the rest);
  - CORS credentials only for allowed origins;
  - every write endpoint validated;
  - no PII in public responses or logs (grep);
  - SQL only through Drizzle / parameterised `sql`.
- **ESLint** (typescript-eslint flat config, no-floating-promises), clean, added to CI.
- **Load test** the order path locally (`autocannon`, a dev dependency): 50 concurrent checkouts for the same last 10 units → exactly 10 orders, no 500s, p95 noted in STATUS.md.
- **API contract export:** `src/contracts/*.ts` (Zod request/response schemas for every public and member endpoint) plus a generated `openapi.json` (`zod-to-openapi` or a small hand-rolled generator) committed under `docs/api/`. The frontend uses these types (Stage 5).
- Docs:
  - `docs/DEPLOYMENT.md`: env vars, migrations, seed, catalog import, PayWay webhook URL, Firebase setup, same-site cookie requirement, Cloud Run / any container host, health probes, backups.
  - `docs/PAYWAY-SANDBOX-CHECKLIST.md`.
  - A README refresh.

### Stage 4 — Backend completeness audit (loop until clean)
- [ ] Re-read the spec section by section (§1–§20). In `docs/superpowers/BACKEND-AUDIT.md`, list each requirement with its evidence: file, endpoint and test name. Anything missing or partial → write a plan and implement it test-first.
- [ ] Re-read the Zando "Adopt" list A1–A15 and the "Avoid" list. Confirm that each backend-relevant item is satisfied.
- [ ] Confirm that every legacy feature is ported or dropped with a reason.
- [ ] Run a fresh `opus` reviewer over the **whole backend** (not a diff): architecture, security, money, concurrency, data integrity, operability. Fix Critical and Important findings.
- [ ] **Exit criteria:** `npm ci && npm run lint && npm run typecheck && npm test && npm run build` green twice. BACKEND-AUDIT.md has no open items. STATUS.md says backend done.

### Stage 5 — Frontend: design (self-approved)
The frontend (`sport-heaven`) is a large single-page React app built in AI Studio. Its current state:
- **The build fails.** `server.ts` imports `./backend/app.ts`, `App.tsx` imports `../backend/components/SystemHealthDashboard`, `src/components/admin/*Chart.tsx` import `../../../backend/health/systemHealthTypes`, and `src/utils/commerce.test.ts` (4,131 lines) imports `../../backend/*`. `tsc` reports 64 errors.
- `src/context/StoreContext.tsx` (1,918 lines) keeps auth, cart, orders, addresses and payments in localStorage.
- A custom hash router, `src/utils/router.ts` (417 lines).
- Mock catalogs in `src/data/*.ts`.
- 42 MB of unoptimised JPGs in `src/assets/images` and 15 MB in `public/assets`.
- Firebase web auth (email + Google).
- Leftovers: the package name `react-example`, unused `@google/genai`, `.gmp_cache/`, `metadata.json`, the `DISABLE_HMR` hack, and a Google Maps quota banner shown to customers.
- Fake ratings and reviews.
- Existing design docs: `docs/frontend-re-blueprint/01–04*.md`.

Do this:
- [ ] Use `superpowers:brainstorming`, but **the owner has opted out of questions**: make every call yourself, write the design doc, self-approve it and record the calls in OWNER-DECISIONS.md.
  - Spec file: `sport-heaven/docs/superpowers/specs/2026-11-2X-frontend-production-design.md`.
  - Then use `frontend-design:frontend-design` for the visual direction. Keep the brand's existing palette and type unless they're poor, keep it original (no copying of Zando's branding), and be mobile-first.
- [ ] The design must cover:
  - **Stack:** keep React 19 + Vite + Tailwind 4. Add React Router (real paths, not hash; SPA fallback; SEO meta per route; sitemap from the API), TanStack Query (all server data), Firebase web SDK (phone OTP with invisible reCAPTCHA + Google), and an API client generated from or typed by the backend contracts. Use `credentials: 'include'` for the cart cookie, and a dev Vite proxy `/v1 → http://localhost:3000`, so the cookie is same-site in dev.
  - **Remove:** all mock data, StoreContext business logic (keep only UI state), the localStorage persistence of server data, fake reviews and ratings, AI Studio leftovers, `server.ts` (a static SPA served by any host, or `vite preview`), and the broken backend imports.
  - **Pages:**
    - home (sections from `/v1/catalog/home`);
    - listing (facets from `/v1/catalog/filters`, URL-synced, a filter drawer with Apply/Clear on mobile, infinite scroll with a Load-more fallback and page in the URL);
    - product (sizes with availability, only in-stock sizes enabled, add-to-bag disabled until a size is chosen, a **sticky mobile add-to-bag bar**, the print studio for customizable products using the server's print rules and fees, related products, Q&A);
    - search (suggest with 250 ms debounce, min 2 chars, cancel stale requests, popular searches; never infinite skeletons);
    - bag drawer and bag page (in-place size/qty edit, problems shown, promo field with server messages, delivery estimate);
    - checkout as one page: contact + channel, delivery address with Province/District/Commune pickers and saved addresses, delivery method or pickup branch, payment method, terms, `Idempotency-Key`, then pay: **render the real KHQR from `qrString`** with the `qrcode` lib, a countdown to `reserved_until`, polling payment status every 3s, card/deeplink redirect, and retry/switch method;
    - order confirmation;
    - order tracking (number + phone);
    - account: profile, phone linking for Google users, addresses, orders, returns (exchange/refund flows), wishlist, loyalty tier/points/perks;
    - auth (phone OTP first, Google second; the guest-bag merge message);
    - branches (map optional: keep Google Maps only if `VITE_GOOGLE_MAPS_API_KEY` is set, otherwise a static list; never show the quota banner);
    - static/legal pages (keep the existing content);
    - 404.
  - **Admin area** (lazy-loaded, behind the role):
    - staff stock screen (scan or SKU search, counter sale, adjust, transfer; phone-friendly);
    - orders (list/filter, detail, status buttons, pick list, refunds flag);
    - products (create/edit, variants, prices, status);
    - promotions, delivery rates, pricing settings;
    - users/roles, Q&A moderation, returns;
    - overview, and system health (move `SystemHealthDashboard.tsx` + the chart components here and fix their imports to use the API).
  - **States:** every data view has loading (skeleton with a timeout), empty, and error with Retry. Toasts for actions. Optimistic UI only where safe (wishlist).
  - **i18n:** English + Khmer (`km`) via a light i18n layer. Pass `lang` to the API. Khmer font (Noto Sans Khmer, self-hosted). An EN/ខ្មែរ switch in the header.
  - **Performance:** route-level code splitting; images converted to WebP/AVIF in 3 widths with `srcset`, served from `/assets/catalog/` to match the backend's `ASSET_BASE_URL` (write a `scripts/optimize-images.mjs` with `sharp` and commit the outputs, or document a CDN step); Lighthouse mobile ≥ 85 for performance and ≥ 95 for accessibility and best practices on home, listing and product.
  - **Accessibility:** keyboard navigation, focus states, labels, contrast AA, reduced motion.
  - **Analytics:** none for now (OWNER-TODO).
  - **Testing:** Vitest + Testing Library for components and hooks; delete or replace `commerce.test.ts` (its logic is now server-side); Playwright e2e against a real local backend (seeded DB + fake identity/payment providers). The happy paths: browse → filter → product → add → bag → checkout (guest, KHQR via the fake provider dev-approve) → confirmation → track; member sign-in (test identity) → merge bag → address → order → return; staff counter sale; admin price change visible in the shop.
  - **Test-only auth:** the backend needs a dev/test identity provider so e2e can sign in without Firebase. Add it in the backend (enabled only when `NODE_ENV !== 'production'` and an explicit `AUTH_TEST_MODE=true`), with tests proving it is impossible to enable in production.
- [ ] Commit the spec, then write the implementation plan(s) with `superpowers:writing-plans`: likely 3–5 plans (foundation & API layer; storefront browse; bag & checkout & payment; account & auth; admin). Each plan produces working software on its own.

### Stage 6 — Frontend: build
- [ ] Execute each frontend plan in order with `superpowers:executing-plans`, test-first, with a final `opus` review per plan and a fix pass, pushing to `sport-heaven` `claude/awesome-mayer-fhxeom`.
- [ ] After every UI task, start the backend (`npm run dev` with the dev DB seeded and imported, `AUTH_TEST_MODE=true`, fake payments) and the frontend (`npm run dev`). Take Playwright screenshots at 390×844 and 1366×900 of what changed, look at them, and fix what looks wrong before committing. Keep the screenshots out of git (scratchpad).
- [ ] CI for the frontend: typecheck, lint, unit, build, and Playwright e2e against a Postgres service plus the backend checked out at the same branch (or document why e2e runs only locally).

### Stage 7 — Frontend completeness audit (loop until clean)
- [ ] Check every page in the design spec, every Zando Adopt item and every Avoid item. Check that no mock data or localStorage server-state remains: `grep -r "localStorage" src`, and `grep -rn "data/catalog\|mock-store" src` must show none outside tests or fixtures.
- [ ] Check that the build is clean and the bundle is split, run Lighthouse with the numbers recorded, and run the e2e suite green twice.
- [ ] Review every screen at both sizes in screenshots.
- [ ] Run a fresh `opus` reviewer over the whole frontend (UX, accessibility, security of tokens and cookies, error handling, performance). Fix Critical and Important findings.
- [ ] Write `sport-heaven/docs/superpowers/FRONTEND-AUDIT.md`.

### Stage 8 — Final report
- [ ] Update STATUS.md (all stages done), OWNER-DECISIONS.md and OWNER-TODO.md (grouped: accounts & keys, prices & policies, hosting & domain, content, legal).
- [ ] Write `sport-backend/docs/superpowers/OVERNIGHT-REPORT.md`: what is done, how to run both apps locally (copy-paste commands), how to deploy, what to check first in the morning, and test counts.
- [ ] Push both repos and end with a short plain-language summary that links those files. **Do not open PRs.**

---

## 4. Global constraints (apply everywhere)

- Money is integer cents in the DB and API. Never accept prices, totals, discounts or fees from clients. The pricing engine is the single source of truth: cart, quote and order call `priceCart`.
- Stock changes only via `applyMovement` (or a helper that calls it), always inside a transaction, with rows locked in (variantId, branchId) ascending order. Public responses show only `ok` / `low` (1–3) / `out`.
- Phones are E.164 via `normalizePhone` (default KH) and redacted in logs. No PII in public responses.
- Error body: `{"error":{"code","message","details?","requestId? (5xx)"}}`. Validate every input with Zod (unknown keys stripped).
- Public catalog GETs are cacheable (`public, max-age=60, stale-while-revalidate=300`); user-specific responses are `no-store`.
- Reference tables survive `resetDb`. Tests that touch them restore them in both `beforeAll` and `afterAll`.
- Express 5: async handlers may throw. Use the shared `AppError`.
- Frontend: never store server state in localStorage (UI preferences only); handle 401 from the API by refreshing the Firebase token once and retrying, then signing out; always send `credentials: 'include'`.

## 5. Known owner to-dos (seed OWNER-TODO.md with these)

1. **ABA PayWay merchant account:** sandbox and production `PAYWAY_MERCHANT_ID` / `PAYWAY_API_KEY`, the webhook URL to register, and which methods the contract includes (ACLEDA/Wing?). Verify the PayWay field mapping in sandbox using `PAYWAY-SANDBOX-CHECKLIST.md`.
2. **Firebase:** a project on the Blaze plan (SMS billed per message), phone + Google sign-in enabled, authorised domains, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, and web config (`VITE_FIREBASE_*`).
3. **Admin bootstrap:** `BOOTSTRAP_ADMIN_PHONES` (the owner's number).
4. **Prices and policies to confirm:**
   - the province courier fee (a $3.00 placeholder);
   - Silver 10% on all five categories;
   - print name 14 chars / numbers 1–99;
   - return windows (30-day exchange / 14-day refund) and the non-returnable list;
   - the reservation time (30 min);
   - the online safety buffer (1 per size per branch);
   - KHR rate 4100.
5. **Count real stock:** every imported stock row is an estimate flagged `needs_count` (In Stock = 10, Limited = 2, Out = 0). Staff must count and correct it via the stock screen before launch.
6. **Hosting:** the API on the same site as the storefront (e.g. `api.example.com` + `example.com`) for the cart cookie; Postgres with the `pg_trgm` + `unaccent` extensions; set `CORS_ORIGINS`, `COOKIE_SECRET` (random, 32+ chars) and `ASSET_BASE_URL` (CDN for product images); upload the optimised images.
7. **Notifications:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` for ops; `RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL` and a verified sending domain.
8. **Content:** real product photos (today's are AI-generated), Khmer translations for product names and descriptions, and legal pages reviewed by the owner.
9. **Optional:** a Google Maps key for the branch map; analytics/pixel choice; a domain.
