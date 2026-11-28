import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { orders, payments, paymentWebhookEvents, type OrderRow, type PaymentRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { validate } from '../../middleware/validate.js';
import { langSchema } from '../catalog/i18n.js';
import { startPaymentAttempt } from '../checkout/paymentAttempt.js';
import { cancelOrder, withStaffOrder } from '../orders/admin.js';
import { findOrderForAccess } from '../orders/access.js';
import { loadOrderView } from '../orders/load.js';
import { paymentView } from '../orders/view.js';
import { availablePaymentMethods, paymentMethodsEnabled } from '../settings/payments.js';
import { refreshPayment } from './check.js';
import { applyProviderResult } from './confirm.js';

const noStore: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

async function latestPayment(ctx: AppContext, orderId: string): Promise<PaymentRow | undefined> {
  const [p] = await ctx.database.db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.attempt)).limit(1);
  return p;
}

/** Customer-facing order + payment routes (member owner, or guest with the order access token). */
export function orderPaymentsRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const now = () => new Date();
  const access = (req: Request, extra: { token?: string; phone?: string | null; requirePhone?: boolean } = {}) =>
    findOrderForAccess(db, String(req.params.number), { user: req.user, token: extra.token ?? req.get('x-order-token') ?? undefined, ...extra }, ctx.config.cookieSecret, now());

  router.get('/orders/:number', noStore, ...ctx.guestOrMember, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    const order = await access(req);
    res.json(await loadOrderView(db, order, { lang: (req.query as { lang: 'en' | 'km' }).lang, assetBase: ctx.config.assetBaseUrl }));
  });

  router.get('/orders/:number/payment-status', noStore, ...ctx.guestOrMember, async (req, res) => {
    let order: OrderRow = await access(req);
    let payment = await latestPayment(ctx, order.id);
    if (payment?.status === 'pending' && order.status === 'pending_payment') {
      payment = await refreshPayment({ db, payments: ctx.payments, now, logger: ctx.logger }, payment);
      order = await access(req);
    }
    res.json({
      status: order.status,
      paymentStatus: order.paymentStatus,
      latestPayment: payment ? paymentView(payment) : null,
      reservedUntil: order.reservedUntil?.toISOString() ?? null,
    });
  });

  router.post(
    '/orders/:number/payments',
    noStore,
    ...ctx.guestOrMember,
    validate({
      body: z.object({
        method: z.enum(['aba_khqr', 'card', 'acleda', 'wing']),
        contactPhone: z.string().trim().max(40).optional(),
        orderAccessToken: z.string().trim().max(200).optional(),
      }),
    }),
    async (req, res) => {
      const body = req.body as { method: 'aba_khqr' | 'card' | 'acleda' | 'wing'; contactPhone?: string; orderAccessToken?: string };
      const order = await access(req, {
        token: body.orderAccessToken ?? req.get('x-order-token') ?? undefined,
        phone: body.contactPhone ? normalizePhone(body.contactPhone) : null,
        requirePhone: true,
      });
      if (!availablePaymentMethods(await paymentMethodsEnabled(db, ctx.config.paymentsCashOnly, ctx.payments.methods), order.fulfillment).includes(body.method)) {
        throw new AppError('payment_method_unavailable', 400, 'That payment method is not available for this order');
      }
      const payment = await startPaymentAttempt({ db, payments: ctx.payments, now }, order.id, body.method);
      res.status(201).json({ payment });
    },
  );

  // The owner may cancel an order that is not paid yet: the stock, the promo use and the QR are released at once.
  router.post(
    '/orders/:number/cancel',
    noStore,
    ...ctx.guestOrMember,
    validate({ body: z.object({ contactPhone: z.string().trim().max(40).optional(), orderAccessToken: z.string().trim().max(200).optional() }) }),
    async (req, res) => {
      const body = req.body as { contactPhone?: string; orderAccessToken?: string };
      const found = await access(req, {
        token: body.orderAccessToken ?? req.get('x-order-token') ?? undefined,
        phone: body.contactPhone ? normalizePhone(body.contactPhone) : null,
        requirePhone: true,
      });
      const toClose = await withStaffOrder(db, found.number, { branchId: null }, async (tx, order) => {
        if (order.paymentStatus !== 'unpaid' || !['pending_payment', 'awaiting_pickup_payment'].includes(order.status)) {
          throw new AppError('order_not_cancellable', 409, 'This order can no longer be cancelled here. Contact the shop.');
        }
        return cancelOrder(tx, order, 'customer', 'Cancelled by the customer');
      });
      for (const tranId of toClose) await ctx.payments.cancelTransaction(tranId).catch(() => {});
      const [fresh] = await db.select().from(orders).where(eq(orders.id, found.id));
      res.json(await loadOrderView(db, fresh!, { lang: 'en', assetBase: ctx.config.assetBaseUrl }));
    },
  );

  return router;
}

/** Bodies a payment pushback may have; anything larger is refused before parsing. */
export const WEBHOOK_BODY_LIMIT = '16kb';
const STALE_RECEIVED_MS = 60_000;
const WEBHOOK_CHECK_INTERVAL_MS = 2_000;

/** PayWay pushback. Not rate limited; never trusted on its own: every claim is re-checked with the provider. */
export function webhookRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const now = () => new Date();

  // VERIFY AGAINST PAYWAY SANDBOX: pushbacks are JSON; form-encoded bodies are accepted too, just in case.
  // Not behind the general limiter, but one address can't flood it either.
  router.post('/webhooks/payway', ctx.routeLimit('webhook', 60), express.urlencoded({ extended: false, limit: WEBHOOK_BODY_LIMIT }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const v = ctx.payments.verifyWebhook(raw, headers);

    const [stored] = await db
      .insert(paymentWebhookEvents)
      .values({ provider: ctx.payments.name, eventId: v.eventId, signatureValid: v.valid, processingStatus: 'received', tranId: v.tranId, payload: v.payload })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id });
    let eventId = stored?.id;
    if (!eventId) {
      // A redelivery: process it again only if the first attempt failed or never finished.
      const [retry] = await db
        .update(paymentWebhookEvents)
        .set({ processingStatus: 'received', receivedAt: now() })
        .where(
          sql`${paymentWebhookEvents.provider} = ${ctx.payments.name} and ${paymentWebhookEvents.eventId} = ${v.eventId}
            and (${paymentWebhookEvents.processingStatus} = 'failed'
              or (${paymentWebhookEvents.processingStatus} = 'received' and ${paymentWebhookEvents.receivedAt} < ${new Date(Date.now() - STALE_RECEIVED_MS)}))`,
        )
        .returning({ id: paymentWebhookEvents.id });
      if (!retry) {
        res.json({ ok: true });
        return;
      }
      eventId = retry.id;
    }
    const finish = (status: 'processed' | 'ignored' | 'rejected' | 'failed', error?: string) =>
      db.update(paymentWebhookEvents).set({ processingStatus: status, error: error ?? null, processedAt: now() }).where(eq(paymentWebhookEvents.id, eventId!));

    if (!v.valid || !v.tranId) {
      await finish('rejected', v.reason ?? 'invalid');
      ctx.logger.warn({ provider: ctx.payments.name, reason: v.reason }, 'Rejected payment webhook');
      throw new AppError('invalid_signature', 401, 'Invalid webhook');
    }
    try {
      const [payment] = await db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.providerTranId, v.tranId));
      if (!payment) {
        await finish('ignored', 'unknown_transaction');
        res.json({ ok: true });
        return;
      }
      // One provider check per payment per couple of seconds, however many pushbacks arrive. A pushback
      // that lands inside the window waits it out once rather than being dropped.
      const claim = () =>
        db
          .update(payments)
          .set({ lastCheckedAt: now() })
          .where(
            and(
              eq(payments.id, payment.id),
              // Anything not yet approved: a cancelled or expired attempt can still be paid late.
              inArray(payments.status, ['pending', 'cancelled', 'expired', 'declined']),
              or(isNull(payments.lastCheckedAt), lt(payments.lastCheckedAt, new Date(Date.now() - WEBHOOK_CHECK_INTERVAL_MS))),
            ),
          )
          .returning({ id: payments.id });
      if (payment.status === 'approved' || payment.status === 'refunded') {
        await finish('ignored', `already_${payment.status}`);
        res.json({ ok: true });
        return;
      }
      let claimed = await claim();
      if (claimed.length === 0) {
        await new Promise((r) => setTimeout(r, WEBHOOK_CHECK_INTERVAL_MS));
        claimed = await claim();
      }
      if (claimed.length === 0) {
        // Still busy: store as failed so PayWay's redelivery is processed (the poll and sweeper also cover it).
        await finish('failed', 'throttled');
        res.json({ ok: true });
        return;
      }
      let check;
      try {
        check = await ctx.payments.checkTransaction(v.tranId);
      } catch (error) {
        await finish('failed', error instanceof Error ? error.message.slice(0, 200) : 'check failed');
        throw new AppError('payment_provider_error', 503, 'Could not confirm the payment yet');
      }
      if (v.claimedStatus === 'approved' && check.status !== 'approved') {
        await finish('rejected', 'status_mismatch');
        ctx.logger.warn({ provider: ctx.payments.name, tranId: v.tranId, checked: check.status }, 'Webhook claimed a payment the provider does not confirm');
        res.json({ ok: true });
        return;
      }
      await applyProviderResult({ db, now }, v.tranId, check, 'webhook');
      await finish('processed');
      res.json({ ok: true });
    } catch (error) {
      if (!(error instanceof AppError)) await finish('failed', error instanceof Error ? error.message.slice(0, 200) : 'processing failed').catch(() => {});
      throw error;
    }
  });

  return router;
}
