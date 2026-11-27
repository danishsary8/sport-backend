# Bakong KHQR setup

With Bakong, customers pay a KHQR with **any Cambodian banking app** (ABA, ACLEDA, Wing, Canadia…). The
shop makes the QR itself and asks Bakong's Open API whether it was paid. There is no card payment and no
webhook: the payment page and the per-minute job check by the QR's md5.

The code lives in `src/modules/payments/bakong/`. The QR builder matches the National Bank of Cambodia's
`bakong-khqr` SDK byte for byte (`test/unit/bakongKhqr.test.ts`). The **check API** follows Bakong's Open API
documentation and is marked `VERIFY AGAINST BAKONG`: confirm it with the real-money test in step 4.

## 1. What you need

| Setting | What it is | Where it comes from |
|---|---|---|
| `BAKONG_TOKEN` | API token for checking payments | Register at **api-bakong.nbc.gov.kh** (Bakong Open API) with your email. A token from another project works too, but if it expires or is revoked both projects stop confirming payments. |
| `BAKONG_ACCOUNT_ID` | The shop's account that **receives the money**, e.g. `sportcastle@aba` | In your bank app (ABA: Profile → your Bakong ID / KHQR). **Must be the shop's own account**: the money goes wherever this points. |
| `BAKONG_MERCHANT_NAME` | Name the payer sees, plain English, max 25 characters | e.g. `Sport Heaven` |
| `BAKONG_MERCHANT_CITY` | Optional, max 15 characters | Default `Phnom Penh` |

## 2. Turn it on (Render → sport-castle-api → Environment)

1. Add `BAKONG_TOKEN`, `BAKONG_ACCOUNT_ID` and `BAKONG_MERCHANT_NAME`.
2. Change `PAYMENT_METHODS_CASH_ONLY` to `false`.
3. Leave the `PAYWAY_*` settings empty (if PayWay is set, it is used instead).
4. Save and deploy. The log shows `Online payments` with `provider: "bakong"` and `methods: ["aba_khqr"]`.
5. In the admin area, Settings → Payment methods: KHQR on (card is never offered with Bakong).

## 3. Renew the token

Bakong tokens expire (typically after 90 days). When it expires, payments still arrive in the bank account
but the shop can no longer confirm them: orders get the "payment unverified" alert and stay held for a grace
period. Put a reminder in your calendar and renew the token at api-bakong.nbc.gov.kh before it expires.

## 4. Real-money test (do this once before taking orders)

1. Place an order for delivery on the live shop and choose KHQR.
2. Scan the QR with your phone's banking app. Check the name and amount, then pay (a $0.50 test product is
   easiest; you can add one in the admin and hide it afterwards).
3. Within a few seconds the payment page should say paid, and the order shows **confirmed** in the admin area.
4. If it stays on "waiting": open Render's logs. A `payment_provider_error` means Bakong refused the request:
   - **401**: the token is wrong or expired.
   - **403 / timeout**: Bakong's API may only answer requests from Cambodia. Set `BAKONG_API_URL` to a small
     relay hosted in Cambodia that forwards `POST /v1/check_transaction_by_md5` to api-bakong.nbc.gov.kh.
5. Refund the test payment from your bank app.

## How it behaves

- Each payment attempt gets a fresh QR that expires when the order's hold ends (30 minutes); apps refuse it after that.
- An order is confirmed only when Bakong reports the payment to **this** account with the order's exact USD amount.
  A different amount, or a payment after the order expired, is flagged for staff (`needs_refund`), as with PayWay.
- Bakong cannot withdraw a QR, so "Pay another way" only expires the old one at its end time; a late payment on it is flagged.
