# Decisions taken for you overnight

You asked not to be woken. Wherever the spec left a choice open, the builder picked the safest sensible option and wrote it here.
Format: **decision** — why — what changes if you disagree.

## Stage 0 — Bootstrap

- [Stage 0] **Database seeding loads the address list (provinces, districts, communes) before delivery rates.** — a brand-new database could not be seeded otherwise. — Nothing to decide; this is a bug fix.
- [Stage 0] **Custom print rules stay as the shop has them today: names up to 14 characters, numbers 1–99, and the "only N left" number is returned under `details.available`.** — this matches the current storefront; the design document said 12 characters / 0–99 and has been updated to match. — If you want 12 characters or number 0, it is one setting change and a small code change.

## Stage 1 — Checkout, orders and payments

- [Stage 1] **ABA PayWay is wired from its published API shape, not from the live docs** (the docs site was unreachable from the build machine). Every field name is in one file (`src/modules/payments/payway/mapping.ts`). — It lets everything else be finished and tested against a stand-in. — If the sandbox disagrees, only that file changes; see OWNER-TODO #1.
- [Stage 1] **A PayWay webhook alone never marks an order paid.** The server always asks PayWay's signed "check transaction" API first. — Webhooks can be forged; the check can't. — Payment confirmation takes one extra call (well under a second).
- [Stage 1] **Stock is held for 30 minutes after an order is placed** (48 hours for cash on pickup, which is off by default). Unpaid orders then expire and the stock goes back on sale. — Spec default. — Change `reservation_minutes` / `cash_on_pickup_hours` in settings.
- [Stage 1] **If a payment arrives after the order expired**, the order is revived when the stock is still there; otherwise it is flagged "needs refund" and ops get an urgent Telegram message. A second payment for the same order, or a payment of the wrong amount, is flagged the same way. — No customer money is ever silently kept. — Refunds are done by hand in the PayWay portal (spec).
- [Stage 1] **Points: 10 per $1 of the order total excluding delivery; lifetime spend counts the same amount.** Only members with a verified phone earn. — Spec §13 excludes shipping; using the same base for tier spend keeps the two consistent. — If tier spend should include delivery, it is a one-line change.
- [Stage 1] **A delivery line can be split across stores** (most stock first, Sonthormuk on ties); pickup takes everything from the chosen store. — Spec §11. — Staff see a per-store pick list (phase 6).
- [Stage 1] **Guests reach their order with a private link token valid for 24 hours**; switching payment method also needs their phone number. Members just sign in. — Keeps phone numbers out of web addresses and logs. — Guests can always track later with order number + phone (phase 6).
- [Stage 1] **Production refuses to start without PayWay credentials**, unless the shop runs cash-on-pickup only (`PAYMENT_METHODS_CASH_ONLY=true`). — Prevents a live shop taking orders it can't charge. — Development uses a fake payment provider with an "approve test payment" button.
- [Stage 1] **The per-minute background job runs on one server at a time**, and also deletes guest bags untouched for 60 days. — Spec §16; closes a phase 4 leftover. — Set `JOBS_ENABLED=false` on extra servers if you prefer.

## Frontend clean-up (done during Stage 1)

- [Stage 1] **TypeScript in the shop app is pinned to 6.0.** — The linter (typescript-eslint) doesn't support 7 yet. — Upgrade when it does.
- [Stage 1] **The Google Map only appears when a Maps key is set**; otherwise branches show as a plain list and the "quota exceeded" banner is gone. — Customers should never see a developer warning. — Add `VITE_GOOGLE_MAPS_API_KEY` to get the map.
- [Stage 1] **Product photos are converted to WebP/AVIF in up to three widths**, without upscaling (most originals are only about 1,000 px wide). — Faster pages on phones. — Supply larger real photos and re-run `npm run images`.

## Stage 2 — After the order (tracking, staff order desk, returns, loyalty, questions)

- [Stage 2] **Order tracking shows only a masked name ("Sok D."), the last 3 phone digits and the commune/district/province**, never the street or full phone. — Anyone with the number + phone can look; less is safer. — Members see everything in their account.
- [Stage 2] **Staff tied to a store only see orders that ship from, or are picked up at, their store.** Admins and staff without a store see all. — Spec's branch-scoped staff. — Change a staff member's store in admin → users.
- [Stage 2] **Staff can't confirm or print an unpaid order, and can't expire or revive orders by hand**; expiry is automatic, and a late payment revives an order with its stock. — Prevents stock mistakes at the counter. — none.
- [Stage 2] **Cancelling a paid order puts the items back on the shelf, takes back its points, frees the promo code and sends you an urgent "refund needed" Telegram.** You refund in the PayWay portal, then press "Mark refunded". — Spec: refunds are manual in phase 1. — none.
- [Stage 2] **Cash at the counter works for any unpaid pickup order** (also a KHQR order whose customer decides to pay cash). It completes the order and closes the QR. — Real shop behaviour. — none.
- [Stage 2] **Returns:** size exchanges up to 30 days and refunds/store credit up to 14 days after delivery or pickup. Printed shirts and socks/underwear (matched by category, garment type or a word like "socks" in the product's web address) can't be returned. The refund is exactly what was paid for those items; several partial refunds never add up to more than the line cost. — Spec. — Change the windows/list in the `return_rules` setting.
- [Stage 2] **Store credit is recorded as "store credit to issue" on the order** (no wallet yet; spec non-goal), and the points earned on that amount are taken back, as for refunds. — Customer already got the value. — When a wallet is built, this becomes automatic.
- [Stage 2] **The new size for an exchange is held as soon as the customer asks**, and stays held until staff decide (no automatic timeout). — The customer was promised that size. — Open returns show on the admin overview so they don't get forgotten.
- [Stage 2] **Points: an admin can add or remove points with a note** (never below zero), and every change is recorded with who did it. — Spec. — none.
- [Stage 2] **Product questions appear only after staff answer and publish them.** — Avoids spam on product pages. — none.
- [Stage 2] **The system health PDF is made in the browser (admin dashboard), not on the server.** — Keeps a heavy library off the API. — none.

## Stage 3 — Hardening

- [Stage 3] **Rate limits (per minute): 300 requests per address overall, 10 orders per address and 5 per member, 20 sign-ins, 10 tracking lookups, 5 questions, 60 PayWay callbacks.** The overall limit is above the spec's 120 because Cambodian mobile networks put many customers behind one address. — Real shoppers shouldn't be blocked. — Lower it in `src/middleware/rateLimit.ts` if you see abuse.
- [Stage 3] **Search ignores accents** ("Mbappe" finds "Mbappé"). — Customers type without accents. — none.
- [Stage 3] **The filters (brand, size, colour, …) are computed in one go in memory**: identical results, no database overload. — Fine up to several thousand products. — Revisit if the catalogue grows past that.
- [Stage 3] **A test sign-in exists for automated tests only; the server refuses to start in production with it switched on.** — End-to-end tests need it. — Never turn on `AUTH_TEST_MODE` on a public server.
- [Stage 3] **Proof under load:** 50 people buying the last 10 units at the same moment produce exactly 10 orders and 40 "sold out" answers, with no errors. — Spec. — none.

## Stage 4 — Completeness audit

- [Stage 4] **Deleting an account waits until the person's orders are finished**, then removes their name, phone, email and street from those orders (amounts and items stay for your accounts). — Staff must still be able to reach a customer whose parcel is on the way. — none.
- [Stage 4] **Product pages show a size guide** (boots, shirts, balls) from a setting you can edit. The charts are standard ones; check them (OWNER-TODO). — Fewer wrong-size returns. — Edit the `size_guides` setting.
- [Stage 4] **Prices can be exported to a spreadsheet and imported back.** The import only changes the price, the "was" price and on/off for existing sizes, always shows a preview first, and changes nothing if any row is wrong. — Safe bulk price changes for sales. — New products are still created in the admin.
- [Stage 4] **When a counter sale is refused because an online order holds the last unit, staff see that order's number.** — Spec §14. — none.
