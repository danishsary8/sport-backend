# Where the pre-split code went

`legacy/` held the backend code from before the frontend/backend split. Every file was ported into `src/` or dropped on purpose, and `legacy/` was deleted in phase 6.

| Legacy file | Now | Notes |
|---|---|---|
| `app.ts` | `src/app.ts`, `src/server.ts` | App factory with injected dependencies; graceful shutdown. |
| `routes/apiRouter.ts` — catalog | `src/modules/catalog/*` (phase 3) | Products from Postgres instead of hard-coded data. |
| `routes/apiRouter.ts` — questions | `src/modules/questions/router.ts` (phase 6) | Now moderated: pending until staff answer and publish. |
| `routes/apiRouter.ts` — orders, track | `src/modules/checkout/*`, `src/modules/orders/*`, `src/modules/payments/*` (phases 5–6) | Server-side pricing, stock reservation, real PayWay payments; tracking by number + phone with a masked address. |
| `routes/apiRouter.ts` — account bootstrap/profile/addresses/wishlist | `src/modules/auth`, `account`, `wishlist` (phase 2–3) | `POST /v1/auth/session` replaces "bootstrap". |
| `routes/apiRouter.ts` — account payments (saved cards) | **dropped** | Spec §8: no card vault; PayWay keeps cards if ever needed. |
| `routes/apiRouter.ts` — RMA | `src/modules/rma/*` (phase 6) | Windows, non-returnable items and amounts decided by the server. |
| `routes/adminRouter.ts` — overview | `src/modules/admin/overviewRouter.ts` | Today's sales, payments waiting, refunds owed, returns, questions, low stock. |
| `routes/adminRouter.ts` — orders, order status | `src/modules/orders/admin*.ts` | Status machine, pick lists, cancel, refunds, cash at the counter. |
| `routes/adminRouter.ts` — inventory | `src/modules/admin/stockRouter.ts` (phase 3) | Per-branch stock with an audit trail. |
| `routes/adminRouter.ts` — webhooks log, notifications log + test | `src/modules/admin/logsRouter.ts` | Recipients masked; admin only. |
| `payments/webhookCrypto.ts`, `payments/webhookRouter.ts` | `src/modules/payments/*` | ABA PayWay hash (HMAC-SHA512) + check-transaction; **Stripe dropped** (spec §2). |
| `notifications/notificationService.ts` | `src/modules/notifications/*` | Telegram + Resend behind an outbox with retries. |
| `repositories/adminRepository.ts`, `repositories/storeRepository.ts` | the module services above | Drizzle queries live next to their feature. |
| `validators/schemas.ts` | per-route Zod schemas (`validate()` middleware) | Unknown keys stripped everywhere. |
| `middleware/rateLimit.ts` | `src/middleware/rateLimit.ts` (phase 1) | Plus per-route limits via `ctx.routeLimit`. |
| `health/systemHealthService.ts`, `systemHealthRouter.ts`, `systemHealthTypes.ts` | `src/modules/health/system/*` | Admin-only under `/v1/admin/system-health`; public probes are `/health` and `/ready` only. |
| `health/systemHealthPdfReport.ts` | **dropped server-side** | The admin dashboard builds the PDF in the browser from `/metrics` (copy in `sport-heaven/src/utils/systemHealthPdfReport.ts`). |
| `components/SystemHealthDashboard.tsx` | `sport-heaven/src/components/admin/SystemHealthDashboard.tsx` | React belongs to the frontend; it moves onto `/v1/admin/system-health/*` in the frontend build. |
