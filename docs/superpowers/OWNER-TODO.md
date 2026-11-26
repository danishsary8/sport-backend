# Things only you can do

The shop is built and tested. It runs on test stand-ins until you supply the items below. Work through them in this order: each step says what to get, where it goes and how to check it worked.

Where a step says "API settings", that means the API server's environment variables (see `docs/DEPLOYMENT.md`, section 2). "Shop build settings" means the storefront's `VITE_*` variables, set before `npm run build` (see `sport-heaven/docs/HOSTING.md`).

## Step 1: Domain and hosting

1. **Choose and confirm the domain.** The sitemap and robots.txt assume `sportcastle.com.kh`. If yours is different, tell your developer, or set `SITE_URL` when building the sitemap and change the `Sitemap:` line in `sport-heaven/public/robots.txt`.
2. **Put the API and the shop on the same domain**, for example `api.sportcastle.com.kh` and `sportcastle.com.kh`. If they are on different domains, guests' bags don't work.
3. **Get a Postgres 16 database** with the `pg_trgm` and `unaccent` extensions (Neon, Supabase, Cloud SQL and RDS all have them).
4. **Set the API settings** `DATABASE_URL`, `CORS_ORIGINS` (the shop's address) and `COOKIE_SECRET` (a random string of 32 or more characters, for example from `openssl rand -base64 48`).
5. **Choose where product photos live**, upload the optimised photos there, and set `ASSET_BASE_URL` in the API settings. Skip this to serve them from the shop itself.

Check: open `https://api.<your-domain>/ready`. It should show `{"status":"ready"}`.

## Step 2: Sign-in (Firebase)

6. **Create a Firebase project on the Blaze plan** (SMS codes are billed per message). Turn on Phone and Google sign-in, and add your domain to the authorised domains.
7. **API settings:** `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON`.
8. **Shop build settings:** the four `VITE_FIREBASE_*` values from the Firebase console (Project settings, Your apps).
9. **Make yourself admin:** put your own phone number in `BOOTSTRAP_ADMIN_PHONES` in the API settings, for example `+85512345678`.

Check: sign in on the shop with that phone, then open `https://<your-domain>/admin`. You should see the admin overview.

## Step 3: Payments (ABA PayWay)

10. **Open an ABA PayWay merchant account.** Get the sandbox and production `PAYWAY_MERCHANT_ID` and `PAYWAY_API_KEY`, and ask which methods your contract includes (KHQR, card, ACLEDA, Wing).
11. **Register the webhook** `https://api.<your-domain>/v1/webhooks/payway` with ABA, and set it as `PAYWAY_RETURN_URL`.
12. **Set `PAYWAY_CONTINUE_URL`** to `https://<your-domain>/checkout/return`. Card payers come back there, and the shop sends them on to their order.
13. **Run the sandbox checklist** in `docs/PAYWAY-SANDBOX-CHECKLIST.md`. The code was written from ABA's published API, and the places to confirm are marked `VERIFY AGAINST PAYWAY SANDBOX`.
14. **In the admin settings, turn on the payment methods** you have.

Until then the shop runs as "cash on pickup only": customers can order online and pay at a store, and home delivery is switched off.

Check: make a real $0.50 KHQR payment, see the order turn paid, then refund it in the PayWay portal.

## Step 4: Notifications (optional, recommended)

15. **Staff alerts on Telegram:** create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
16. **Customer emails:** set `RESEND_API_KEY` and `NOTIFICATION_FROM_EMAIL`, and verify your sending domain in Resend.

Check: in the admin, open Logs and press "Send a test Telegram message" (or "Send a test email").

## Step 5: Automatic tests on GitHub

17. **Add the `BACKEND_REPO_TOKEN` secret** to the `sport-heaven` repository (Settings, Secrets and variables, Actions). It must be a GitHub token that can read `sport-backend`. The end-to-end tests check out the backend with it; without it that job fails at checkout if the backend repository is private.

Check: the next push shows both CI jobs green.

## Step 6: Prices and rules (confirm or change in the admin)

18. Province courier fee: **$3.00 is a placeholder** (Admin, then Delivery).
19. Silver members get 10% off boots, jerseys, F1, balls and essentials.
20. Name and number printing: names up to 14 characters, numbers 1–99, $8 plus the patch fee.
21. Returns: size exchange within 30 days, refund within 14 days; socks and underwear can't be returned.
22. Unpaid orders hold stock for **30 minutes**.
23. Online safety buffer: **1 unit per size per store** is never sold online.
24. Riel rate: **4100** per dollar.
25. Size charts (boots, shirts, balls) are standard industry charts. Check them against the brands you sell.
26. **Whenever you change delivery fees or return rules in the admin, update the help pages** (Delivery and pickup, Returns and exchanges) to match. The help text is written by hand and doesn't update itself.

## Step 7: Stock and content

27. **Count the real stock.** Every imported stock number is an estimate (in stock = 10, limited = 2, out = 0) and is flagged "needs count". Staff must count and correct it on the stock screen before launch.
28. **Real product photos.** Today's photos are AI-generated.
29. **Khmer product names and descriptions.** Product text is English only until you add them.
30. Store opening hours, the "pickup available" switch per store, the home page sections and per-item online buffers have no admin screen yet. Ask a developer when they change (one line each).

## Step 8: Legal

31. **Read and approve the terms, privacy and returns pages** before launch. They are drafts.

## Optional

32. A Google Maps key (`VITE_GOOGLE_MAPS_API_KEY` in the shop build settings) to show a map on the stores page. Without it, each store has an "Open in Google Maps" link.
33. Analytics or an advertising pixel, if you want one. None is installed, so no cookie banner is needed today.
