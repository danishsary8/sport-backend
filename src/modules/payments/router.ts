import { desc, eq, sql } from 'drizzle-orm';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { payments, paymentWebhookEvents, type OrderRow, type PaymentRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { validate } from '../../middleware/validate.js';
import { langSchema } from '../catalog/i18n.js';
import { startPaymentAttempt } from '../checkout/paymentAttempt.js';
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
      payment = await refreshPayment({ db, payments: ctx.payments, now }, payment);
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
      if (!availablePaymentMethods(await paymentMethodsEnabled(db), order.fulfillment).includes(body.method)) {
        throw new AppError('payment_method_unavailable', 400, 'That payment method is not available for this order');
      }
      const payment = await startPaymentAttempt({ db, payments: ctx.payments, now }, order.id, body.method);
      res.status(201).json({ payment });
    },
  );

  return router;
}

/** PayWay pushback. Not rate limited; never trusted on its own: every claim is re-checked with the provider. */
export function webhookRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const now = () => new Date();

  // VERIFY AGAINST PAYWAY SANDBOX: pushbacks are JSON; form-encoded bodies are accepted too, just in case.
  router.post('/webhooks/payway', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const v = ctx.payments.verifyWebhook(raw, headers);
    let payload: unknown = req.body ?? {};
    if (typeof payload !== 'object' || payload === null) payload = {};

    const [stored] = await db
      .insert(paymentWebhookEvents)
      .values({ provider: ctx.payments.name, eventId: v.eventId, signatureValid: v.valid, processingStatus: 'received', tranId: v.tranId, payload })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id });
    let eventId = stored?.id;
    if (!eventId) {
      const [existing] = await db
        .select({ id: paymentWebhookEvents.id, status: paymentWebhookEvents.processingStatus })
        .from(paymentWebhookEvents)
        .where(sql`${paymentWebhookEvents.provider} = ${ctx.payments.name} and ${paymentWebhookEvents.eventId} = ${v.eventId}`);
      if (!existing || existing.status !== 'failed') {
        res.json({ ok: true });
        return;
      }
      eventId = existing.id;
    }
    const finish = (status: 'processed' | 'ignored' | 'rejected' | 'failed', error?: string) =>
      db.update(paymentWebhookEvents).set({ processingStatus: status, error: error ?? null, processedAt: now() }).where(eq(paymentWebhookEvents.id, eventId!));

    if (!v.valid || !v.tranId) {
      await finish('rejected', v.reason ?? 'invalid');
      ctx.logger.warn({ provider: ctx.payments.name, reason: v.reason }, 'Rejected payment webhook');
      throw new AppError('invalid_signature', 401, 'Invalid webhook');
    }
    const [payment] = await db.select({ id: payments.id }).from(payments).where(eq(payments.providerTranId, v.tranId));
    if (!payment) {
      await finish('ignored', 'unknown_transaction');
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
  });

  return router;
}
