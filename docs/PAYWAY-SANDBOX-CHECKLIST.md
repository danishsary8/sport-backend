# ABA PayWay sandbox checklist

PayWay's developer documentation could not be reached while this integration was built, so it follows PayWay's published Checkout and QR API from memory. Every field name, URL and hash order lives in **one file**, `src/modules/payments/payway/mapping.ts`, marked `VERIFY AGAINST PAYWAY SANDBOX`. Work through this list once with sandbox credentials before taking real money. Each item says what the code assumes, how to check it and where to change it.

## 0. Set up

1. Get sandbox credentials from ABA (merchant id + API key) and ask them for the current API documentation (Checkout / QR / Check transaction / Close transaction / Pushback).
2. Run the API against the sandbox:
   ```bash
   NODE_ENV=development DATABASE_URL=… COOKIE_SECRET=… \
   PAYWAY_MERCHANT_ID=<sandbox id> PAYWAY_API_KEY=<sandbox key> \
   PAYWAY_BASE_URL=https://checkout-sandbox.payway.com.kh \
   PAYWAY_RETURN_URL=https://<public tunnel>/v1/webhooks/payway \
   PAYWAY_CONTINUE_URL=http://localhost:5173/checkout/return \
   npm run dev
   ```
   PayWay must be able to reach `PAYWAY_RETURN_URL`. Use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`) and register the URL with ABA if they require it.
3. Place an order from the shop (or with `curl`), pay with the ABA sandbox app or test card, and watch the API log plus `GET /v1/admin/payments/webhooks`.

## 1. Request signing (hash)

| Assumption | How to check | Where |
|---|---|---|
| `hash = base64(HMAC-SHA512(concatenated values, API key))` | A KHQR request returns a QR, not "wrong hash" | `payway/hash.ts` |
| KHQR field order: `req_time, merchant_id, tran_id, amount, items, first_name, last_name, email, phone, purchase_type, payment_option, callback_url, return_deeplink, currency, custom_fields, return_params, payout, lifetime, qr_image_template` | Same; compare with the docs' hash string | `QR_FIELDS` |
| Purchase (card) field order: see `PURCHASE_FIELDS` | The card page opens with no signature error | `PURCHASE_FIELDS` |
| Check/close order: `req_time, merchant_id, tran_id` | Check transaction returns data | `CHECK_FIELDS` |
| `req_time` is `YYYYMMDDHHmmss` in **UTC** | If PayWay rejects the time, try Asia/Phnom_Penh (UTC+7) | `reqTime()` in `payway/client.ts` |

## 2. Values

| Assumption | Check |
|---|---|
| `amount` is dollars with 2 decimals (`"12.50"`), currency `USD` | The QR shows the right amount |
| `tran_id` is the order number without dashes, plus the attempt: `SC2611ABCDE-1` (max 20 chars, `[A-Za-z0-9-]`) | Accepted; it appears in the PayWay portal |
| `phone` is sent as E.164 (`+85512345678`) | If rejected, send the local form `012345678` (`customer.phone` in `createTransaction`) |
| `items` is base64 of JSON `[{name, quantity, price}]` | The portal shows the items |
| `callback_url` / `return_url` are base64 of the webhook URL | The webhook is called |
| `lifetime` is in minutes (the time left on the hold, at least 3) | An unpaid QR stops working after the hold |
| `payment_option`: `abapay_khqr` for KHQR, `cards` for card | Both flows open |

## 3. Responses

| Assumption | Check | Where |
|---|---|---|
| KHQR answer has `status.code === "0"`, `qrString`, `abapay_deeplink` | The shop renders a scannable QR (scan it with the ABA app) and the deeplink opens the app on a phone | `createTransaction` |
| Check transaction answers `data.payment_status` ∈ `APPROVED, PENDING, DECLINED, REFUNDED, CANCELLED` (plus `PRE_AUTH`) and `data.total_amount` in dollars | Poll a pending, a paid and a cancelled transaction | `STATUS_MAP` |
| **An unknown transaction** (a card checkout the shopper never opened) answers without `payment_status`, and is treated as **pending** so the order expires normally | Create a card attempt, don't open it, call check | `checkTransaction` |
| Close transaction stops an old QR from being paid | Switch method, then try to pay the first QR | `cancelTransaction` |

## 4. Pushback (webhook)

| Assumption | Check |
|---|---|
| JSON body `{tran_id, apv, status}`; `status: "0"` means success | Look at the stored payload in `GET /v1/admin/payments/webhooks` |
| PayWay may or may not sign the pushback; if a `hash` field is present it is checked as `HMAC-SHA512(tran_id + apv + status)` | Compare with the docs; adjust `PUSHBACK_HASH_FIELDS` |
| Form-encoded bodies are also accepted | Note which one PayWay sends |
| **Trust:** a pushback alone never marks an order paid; the API always re-checks with check-transaction | Send a fake pushback with `curl`: the order must stay unpaid and the event is stored as `rejected` |

## 5. End-to-end runs

Each of these must give exactly the result shown. Check the order page in the admin area and the stock screen.

1. **KHQR paid on time:** the order becomes *confirmed* (or *printing* for a printed shirt). Stock leaves the shelf; the customer email and the ops Telegram arrive; a member earns points.
2. **KHQR not paid:** after 30 minutes the order is *expired* and the stock is back on sale.
3. **Paid after expiry (pay an expired QR if the sandbox allows):** the order is revived if stock remains; otherwise it is flagged "needs refund" with an urgent Telegram.
4. **Switch KHQR → card:** the first QR stops working and the card payment confirms the order.
5. **Card declined:** the order stays awaiting payment and the shopper can retry.
6. **Refund:** refund in the PayWay portal, then mark the order refunded in the admin area.

When everything passes, delete the `VERIFY AGAINST PAYWAY SANDBOX` marker, switch `PAYWAY_BASE_URL` to `https://checkout.payway.com.kh` with the production credentials, and make one small real payment before launch.
