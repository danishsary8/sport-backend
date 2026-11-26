# Things only you can do

Nothing here blocks the build: the software runs on test stand-ins until you supply each item. Do them in any order; each says where the value goes.

## Accounts & keys

1. **ABA PayWay merchant account.** Get sandbox and production `PAYWAY_MERCHANT_ID` and `PAYWAY_API_KEY`, register the webhook URL (`https://<api-domain>/v1/webhooks/payway`), and confirm which methods your contract includes (KHQR, card, ACLEDA, Wing). Then run through `docs/PAYWAY-SANDBOX-CHECKLIST.md` to confirm the field mapping (the code is marked `VERIFY AGAINST PAYWAY SANDBOX` where it depends on it).
2. **Firebase.** A project on the Blaze plan (SMS is billed per message), Phone and Google sign-in turned on, your domains authorised. Backend: `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`. Frontend: the `VITE_FIREBASE_*` web config.
3. **Admin bootstrap.** Put your own phone number in `BOOTSTRAP_ADMIN_PHONES` (e.g. `+85512345678`); it becomes admin the first time you sign in.
4. **Notifications.** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` for the shop's ops chat; `RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL` and a verified sending domain for customer emails.

## Prices & policies (confirm or change)

5. Province courier fee: **$3.00 placeholder** (change in admin → delivery rates).
6. Silver members get 10% off all five categories (boots, jerseys, F1, balls, essentials).
7. Custom print: names up to 14 characters, numbers 1–99, $8 + patch fee.
8. Returns: size exchange within 30 days, refund within 14 days; socks and underwear can't be returned.
9. Orders hold stock for **30 minutes** while the customer pays.
10. Online safety buffer: **1 unit per size per branch** is never sold online.
11. Riel rate **4100** per dollar.

13a. **Size charts** shown on product pages (boots EU/UK/US/cm, shirts S–XXL chest/length, balls 3/4/5) are standard industry charts. Check them against the brands you sell and correct them in the `size_guides` setting.

## Stock

12. **Count the real stock.** Every imported stock number is an estimate (In Stock = 10, Limited = 2, Out = 0) and flagged "needs count". Staff must count and correct it on the stock screen before launch.

## Hosting & domain

13. Host the API on the same site as the shop (e.g. `api.example.com` + `example.com`) so the bag cookie works.
14. Postgres 16 with the `pg_trgm` and `unaccent` extensions; set `CORS_ORIGINS`, `COOKIE_SECRET` (random, 32+ characters) and `ASSET_BASE_URL` (the CDN for product photos), and upload the optimised photos there.
15. A domain name.

## Content

- Store opening hours, the "pickup available" switch per store, the home-page sections and per-item online stock buffers have no admin screen yet; tell a developer when they change (one SQL line each).

16. Real product photos (today's are AI-generated).
17. Khmer translations of product names and descriptions.

## Legal

18. Read and approve the legal pages (terms, privacy, returns) before launch.

## Optional

19. A Google Maps key for the branch map (`VITE_GOOGLE_MAPS_API_KEY`); without it the site shows a plain list.
20. Choose analytics / an advertising pixel, if any (none is installed).
