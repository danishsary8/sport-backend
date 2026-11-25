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
