# Sport Castle: final report

Date: 2026-11-26. Repositories: `sport-backend` (the API) and `sport-heaven` (the shop). All work is on the branch `claude/vibrant-albattani-h43mrz` in both repositories, ready to merge into `main`.

## What was built

**The API (`sport-backend`)**: Node, Express, Drizzle and Postgres. It holds the catalog, stock per store, bag, checkout, ABA PayWay (KHQR and card) with webhooks, orders and their status changes, tracking, member accounts (Firebase sign-in), addresses, wishlist, points and tiers, returns and exchanges, product questions, promotions, delivery rates, staff and admin roles, the counter screen (sell, adjust, transfer stock), notifications (Telegram and email), a background job for expiring unpaid orders, and system health. It has 724 tests.

**The shop (`sport-heaven`)**: React 19, Vite 8, Tailwind 4, React Router and TanStack Query, in English and Khmer.

- **Customers:** home, listings with filters, search, product pages with sizes and per-store availability, name and number printing, bag, checkout (delivery or store pickup), KHQR and card payment, order confirmation and tracking.
- **Members:** profile, addresses, orders, returns, wishlist and points.
- **Staff and admins:** a phone-friendly admin area with orders, the stock counter screen, returns, questions, products and prices, promotions, delivery fees, settings, users, health and logs.

Everything shown comes from the API: there is no mock data, and no invented reviews or urgency.

**Quality:**

| Check | Result |
|---|---|
| Backend tests | 724 passing |
| Shop unit tests | 162 passing |
| End-to-end tests (real API, real database) | 6 passing: guest pays with KHQR and tracks, member with a merged bag and a return, staff counter sale, admin price change, two accessibility sweeps |
| Lighthouse, mobile (home, listing, product) | Performance 89–90, accessibility 100, best practices 100 (target 85/95/95) |
| Accessibility (axe, WCAG 2 AA) | No serious or critical problems on 8 key pages |
| First-load JavaScript | 146 kB gzipped (budget 150 kB, checked on every build) |
| CI | GitHub Actions: checks job and end-to-end job (`sport-heaven/.github/workflows/ci.yml`) |

The full audit against the design is in `sport-heaven/docs/superpowers/FRONTEND-AUDIT.md`. The history of every stage, with rulings and known small issues, is in `docs/superpowers/STATUS.md`.

## Run both apps on your computer

You need Node 22 and Postgres 16. Postgres user `postgres`, password `postgres`.

Create the databases (once):

```bash
createdb -U postgres sport_dev
```

```bash
createdb -U postgres sport_test
```

Set up the API (once), in `sport-backend`:

```bash
npm ci
```

```bash
export NODE_ENV=development DATABASE_URL=postgres://postgres:postgres@localhost:5432/sport_dev DATABASE_SSL=false COOKIE_SECRET=local-dev-cookie-secret-0123456789abcdef CORS_ORIGINS=http://localhost:5173 AUTH_TEST_MODE=true
```

```bash
npx tsx src/db/migrate.ts && npx tsx src/db/seed/run.ts && npx tsx src/db/seed/importCatalog.ts
```

Start the API (in the same terminal, so the variables above are set):

```bash
npx tsx src/server.ts
```

In a second terminal, start the shop in `sport-heaven`:

```bash
npm ci
```

```bash
VITE_AUTH_TEST_MODE=true npx vite --port 5173
```

Open http://localhost:5173. To sign in, use any `012 xxx xxx` number with the code `123456`. To try the admin, sign in with `011 111 111`, then run this in Postgres and sign in again:

```sql
update users set role='admin' where phone_e164='+85511111111';
```

Run the checks:

```bash
cd sport-backend && npm run typecheck && npm run lint && npm test
```

```bash
cd sport-heaven && npm run typecheck && npm run lint && npm test && npm run build
```

```bash
cd sport-heaven && npx playwright test --trace off
```

The end-to-end run starts its own API on port 3100 with a fresh `sport_e2e` database.

## Deploy

1. **The API:** follow `docs/DEPLOYMENT.md`. Build the Docker image, run the migrate, seed and catalog import once, then start it. It refuses to start if a production setting is missing or unsafe, and lists what's wrong.
2. **The shop:** follow `sport-heaven/docs/HOSTING.md`. Set `VITE_API_URL` and the Firebase web keys, refresh the sitemap, run `npm run build` and upload `dist/` to any static host (Netlify, Cloudflare Pages, Vercel or nginx are already configured).
3. The API and the shop must be on the same domain (for example `api.sportcastle.com.kh` and `sportcastle.com.kh`), or guests' bags won't work.

## What to check first after deploying

1. `https://api.<your-domain>/ready` shows `{"status":"ready"}`.
2. Sign in with the phone in `BOOTSTRAP_ADMIN_PHONES`, then open `/admin`.
3. In the admin, check the delivery fees (the province fee is a $3.00 placeholder), settings and payment methods.
4. Make one real $0.50 KHQR payment, see it turn paid, and refund it in the PayWay portal.
5. Pay once by card and check you land back on your order.
6. Send a test Telegram message from Admin, then Logs.
7. Have staff count the stock in every store before opening.

## Merging into main

- **`sport-heaven`:** the branch sits directly on top of `main`, so it merges cleanly.
- **`sport-backend`:** `main` holds a single unrelated "Initial backend" commit that is not in this branch's history. Merging needs either `git merge --allow-unrelated-histories` (and resolving the conflicts in favour of the branch) or replacing `main` with the branch. Replacing is simpler if nothing else depends on that commit.

## Decisions and your to-do list

- Every decision made without you, with the reason and how to change it: [`OWNER-DECISIONS.md`](./OWNER-DECISIONS.md)
- What only you can provide, step by step: [`OWNER-TODO.md`](./OWNER-TODO.md)

## In plain words

Your online shop is finished and works end to end. Customers can browse boots, kits and F1 gear in English or Khmer, choose a size, add name printing, and pay with ABA KHQR or card, or reserve and pay at one of your three stores. They can then follow their order. Members get points and can request returns. Your staff get a simple admin area that works on a phone, including a counter screen for in-store sales and stock.

Everything has been tested automatically, including full test purchases against a real database, and the pages are fast and accessible on phones.

To open the shop, three things are needed from you: your ABA PayWay account, a Firebase account for sign-in, and a domain with hosting. You also need to count your real stock and approve the legal pages. `OWNER-TODO.md` walks through each one in order. Until PayWay is connected, the shop can still take orders for pickup and payment in store.
