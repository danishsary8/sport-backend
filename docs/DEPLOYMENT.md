# Deploying the Sport Castle API

This runbook takes the API from this repository to a live server that shoppers use. The storefront (`sport-heaven`) is deployed separately as static files. For everything you have to supply yourself (accounts, keys, prices), see `docs/superpowers/OWNER-TODO.md`.

## 1. What you need

- **A container host** that runs a Docker image and gives it HTTPS. Examples: Google Cloud Run, Fly.io, Render, Railway, or any VM with Docker behind Caddy/nginx.
- **PostgreSQL 16** with the `pg_trgm` and `unaccent` extensions available. Managed options include Cloud SQL, Neon, Supabase and RDS. The migrations create the extensions; the database user needs permission to do that (or ask your provider to enable them).
- **Two domains on the same site:** the shop (e.g. `sportcastle.com.kh`) and the API (e.g. `api.sportcastle.com.kh`). The guest bag cookie is `SameSite=Lax`, so browsers only send it when shop and API share a registrable domain. Do not host the API on a different domain (e.g. `*.run.app`) in production.
- **An ABA PayWay merchant account**, **a Firebase project**, and (optionally) a **Telegram bot** and a **Resend** account.

## 2. Environment variables

Every variable is validated at start-up. The server refuses to start, and lists every problem, if anything is wrong.

| Variable | Production | What it is |
|---|---|---|
| `NODE_ENV` | `production` | Turns on production checks. |
| `PORT` | optional (3000) | The platform usually sets it. |
| `DATABASE_URL` | **required** | `postgres://user:pass@host:5432/db` |
| `DATABASE_SSL` | default on | TLS to Postgres with certificate verification. |
| `DATABASE_SSL_CA` | if your provider uses a private CA | The CA certificate, as PEM text or a file path starting with `/`. |
| `CORS_ORIGINS` | **required** | The shop's origin(s), comma-separated, e.g. `https://sportcastle.com.kh,https://www.sportcastle.com.kh`. |
| `COOKIE_SECRET` | **required** | A random string of 32+ characters (`openssl rand -base64 48`). Changing it empties every guest's bag. |
| `LOG_LEVEL` | optional (`info`) | `debug` adds detail; logs never contain phones, emails, addresses or tokens. |
| `FIREBASE_PROJECT_ID` | **required** | The Firebase project id. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **required** | The service-account key JSON, on one line (needed to check revoked tokens and delete accounts). |
| `BOOTSTRAP_ADMIN_PHONES` / `BOOTSTRAP_ADMIN_EMAILS` | recommended | People who become admin when they sign in (your own number). |
| `ASSET_BASE_URL` | recommended | Where product photos live, e.g. `https://cdn.sportcastle.com.kh/` (default `/assets/`, served by the shop). |
| `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY` | **required** (unless cash only) | From ABA. |
| `PAYWAY_BASE_URL` | **required** (with PayWay keys) | `https://checkout.payway.com.kh` in production, or the sandbox URL on a test server. Production refuses to start without it, so it can never silently use the sandbox. |
| `PAYWAY_RETURN_URL` | **required** | This API's webhook: `https://api.<domain>/v1/webhooks/payway`. Register the same URL with ABA. |
| `PAYWAY_CONTINUE_URL` | **required** | The shop page card payers return to: `https://<domain>/checkout/return` (the shop sends them on to their order). |
| `PAYMENT_METHODS_CASH_ONLY` | optional | `true` lets production start without PayWay. Only cash on pickup is offered, so delivery orders are switched off until PayWay is set up. |
| `PUBLIC_API_URL` | optional | This API's own URL (used only by development payment pages). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | recommended | Staff alerts: new orders, payments, refunds owed, returns and questions. |
| `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL` | optional | Customer emails (payment received, status changes, returns). The domain must be verified in Resend. |
| `TRUST_PROXY_HOPS` | optional (1) | How many proxies sit in front of the API. One load balancer (Cloud Run, Fly, Render, nginx) = 1; a CDN such as Cloudflare **plus** a load balancer = 2. If this is wrong, every shopper looks like the same IP and rate limits block them together. |
| `JOBS_ENABLED` | optional (`true`) | The per-minute background job. Leave it on; with several servers only one runs it at a time. |
| `AUTH_TEST_MODE` | **never** | End-to-end tests only; production refuses to start with it. **Never set it on any server reachable from the internet** (staging included): test tokens can claim any phone, including an admin's. |

## 3. Build and first start

```bash
docker build -t sport-backend .
# one-off: create tables (safe to run on every deploy)
docker run --rm --env-file prod.env sport-backend node dist/db/migrate.js
# one-off: branches, Cambodian provinces/districts/communes, categories, settings, delivery rates, promo codes
docker run --rm --env-file prod.env sport-backend node dist/db/seed/run.js
# one-off: the 80 storefront products (stock starts as estimates flagged "needs count")
docker run --rm --env-file prod.env sport-backend node dist/db/seed/importCatalog.js
# the API
docker run -d --env-file prod.env -p 3000:3000 sport-backend
```

- **Seeding is safe to repeat:** reference data is upserted, and settings or delivery rates you changed in the admin are never overwritten.
- **The catalog import only adds missing products:** it never overwrites admin edits.

**Cloud Run example:**
```bash
gcloud run deploy sport-api --image=REGION-docker.pkg.dev/PROJECT/repo/sport-backend \
  --region=asia-southeast1 --port=3000 --min-instances=1 --max-instances=3 --no-cpu-throttling \
  --set-env-vars=NODE_ENV=production,... --set-secrets=COOKIE_SECRET=cookie-secret:latest,...
```
`--min-instances=1` together with `--no-cpu-throttling` (CPU always allocated) keeps the per-minute background job running between requests. Without it Cloud Run pauses the CPU when no request is in flight, and unpaid orders, late payments and notifications are not processed. It also avoids cold starts at checkout. Run migrations as a Cloud Run job, or with the `docker run` command above, before shifting traffic.

## 4. Health checks

- **Liveness:** `GET /health` → 200 while the process is up.
- **Readiness:** `GET /ready` → 200 when Postgres answers, 503 otherwise. Use it for load-balancer health.
- Neither probe is logged. Detailed health for admins is at `GET /v1/admin/system-health`.

## 5. After the first deploy

1. Sign in on the shop with a phone number listed in `BOOTSTRAP_ADMIN_PHONES`. You are now admin.
2. In the admin area:
   - check the delivery rates (the province courier fee is a $3.00 placeholder);
   - check the pricing settings and the payment methods;
   - make staff accounts (with a store each, for counter staff).
3. Have staff **count the stock** at each store and correct it on the stock screen (every imported row is flagged "needs count").
4. Make a real $0.50–$1.00 KHQR payment and refund it in the PayWay portal (see `docs/PAYWAY-SANDBOX-CHECKLIST.md`).
5. Send a test notification: `POST /v1/admin/notifications/test` from the admin area.

## 6. Running more than one server

- **Rate limits** are counted per server in memory. With two or more servers, either accept limits that are N× looser, or implement the `RateLimitStore` interface (`src/middleware/rateLimit.ts`) with Redis (`INCR` + `PEXPIRE`) and pass it to `createApp`.
- **The background job** uses a Postgres advisory lock, so only one server runs it at a time. No change is needed.
- **Guest bags and sessions** are stateless on the server (a signed cookie and Firebase tokens), so any server can serve any request.

## 7. Backups and recovery

- Turn on your provider's automatic daily backups with point-in-time recovery (7–30 days).
- Additionally, take a weekly logical dump stored outside the provider:
  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > sport-$(date +%F).dump
  pg_restore --no-owner --dbname "$TARGET_DATABASE_URL" sport-2026-12-01.dump
  ```
- Test a restore into a scratch database once a quarter.

## 8. Rolling back

- Migrations are written so the previous image keeps working with the newer schema (they add tables, columns and indexes, and occasionally clean data, e.g. 0008 makes colour names unique per product). To roll back, redeploy the previous image tag.
- Never delete migration files. A schema mistake is fixed with a new migration.

## 9. Security notes

- **Cookies:**
  - The bag cookie is `HttpOnly; Secure; SameSite=Lax`, signed with `COOKIE_SECRET`.
  - Any site under your registrable domain can set cookies for it, so do not let third parties host pages on subdomains of your shop domain (a sibling subdomain could plant a bag cookie: "cookie fixation"). The worst it can do is show someone a different guest bag; it can't reach orders or accounts.
- **Sign-in tokens:** Firebase ID tokens are cached for up to 5 minutes after verification. Disabling a user in Firebase therefore takes up to 5 minutes to lock them out of the API.
- **Logs:** phones are masked (`***678`), and order tokens, cookies and authorization headers are redacted.
- **Webhooks:** the PayWay webhook is never trusted on its own. Every payment is confirmed with PayWay's signed check API. It is limited to 60 calls a minute per address, and its records are kept for 90 days.
- **Development payment pages:** when PayWay keys are missing and `NODE_ENV` isn't `production`, `/v1/dev/payments/*` lets anyone approve a test payment. A public staging server must run with `NODE_ENV=production` and sandbox PayWay keys, never with the fake provider.
