import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { carts, idempotencyKeys, paymentWebhookEvents, orderItemAllocations, orderItems, orders, payments, promotions, type OrderStatus } from '../db/schema/index.js';
import { AppError, safeError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { Notifier } from '../modules/notifications/notifier.js';
import { enqueueOrderNotifications, processOutbox } from '../modules/notifications/outbox.js';
import { recordEvent } from '../modules/orders/events.js';
import { assertTransition } from '../modules/orders/statusMachine.js';
import { refreshPayment } from '../modules/payments/check.js';
import { applyProviderResult } from '../modules/payments/confirm.js';
import type { PaymentProvider } from '../modules/payments/provider.js';
import { releaseAllocations } from '../modules/stock/locking.js';

export const JOBS_LOCK_KEY = 727001;
const GUEST_CART_DAYS = 60;
/** Unpaid orders whose hold can run out (an unpaid pickup order may already be marked ready). */
const EXPIRABLE: OrderStatus[] = ['pending_payment', 'awaiting_pickup_payment', 'ready_for_pickup'];
/** If the payment service can't be reached, a hold ends anyway this long after it was due (ops are alerted). */
export const UNVERIFIED_EXPIRY_GRACE_MS = 2 * 60 * 60 * 1000;

export interface SweepDeps {
  database: Database;
  payments: PaymentProvider;
  notifiers: { telegram: Notifier; email: Notifier };
  logger: Logger;
  now: () => Date;
}

export interface SweepResult {
  locked: boolean;
  checked: number;
  expired: number;
  notifications: { sent: number; failed: number; skipped: number };
  guestCartsDeleted: number;
}

/**
 * Ends an unpaid order whose hold has run out: one last direct check with the provider (a payment that
 * landed wins), then release the stock, give back the promo use, expire the attempts and tell the customer.
 */
export async function expireOrder(deps: Omit<SweepDeps, 'notifiers' | 'logger'>, orderId: string): Promise<boolean> {
  const { db } = deps.database;
  // Every attempt that could still turn out paid, cancelled ones included (an old QR can be paid late).
  const open = await db.select().from(payments).where(and(eq(payments.orderId, orderId), inArray(payments.status, ['pending', 'cancelled'])));
  let unverified = false;
  for (const p of open) {
    try {
      const check = await deps.payments.checkTransaction(p.providerTranId);
      if (check.status !== 'pending') await applyProviderResult({ db, now: deps.now }, p.providerTranId, check, 'sweeper');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      unverified = true;
    }
  }
  if (unverified) {
    // Provider unreachable: keep the hold for a while, then end it anyway so stock can't leak forever.
    const [o] = await db.select({ reservedUntil: orders.reservedUntil }).from(orders).where(eq(orders.id, orderId));
    if (!o?.reservedUntil || o.reservedUntil.getTime() + UNVERIFIED_EXPIRY_GRACE_MS > deps.now().getTime()) return false;
  }

  const cancelled = await db.transaction(async (tx) => {
    // Same lock order as payment confirmation: payments, then the order.
    await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.attempt)).for('update');
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    const now = deps.now();
    if (!order || !EXPIRABLE.includes(order.status) || order.paymentStatus === 'paid' || !order.reservedUntil || order.reservedUntil > now) return null;

    const allocations = await tx
      .select({ variantId: orderItems.variantId, branchId: orderItemAllocations.branchId, qty: orderItemAllocations.qty })
      .from(orderItemAllocations)
      .innerJoin(orderItems, eq(orderItems.id, orderItemAllocations.orderItemId))
      .where(eq(orderItems.orderId, orderId));
    // Promotion before stock: the same lock order as order placement.
    if (order.promotionId) {
      await tx.update(promotions).set({ usedCount: sql`greatest(0, ${promotions.usedCount} - 1)` }).where(eq(promotions.id, order.promotionId));
    }
    await releaseAllocations(tx, allocations, order.number);
    assertTransition(order.status, 'expired');
    await tx.update(orders).set({ status: 'expired', reservedUntil: null, updatedAt: sql`now()` }).where(eq(orders.id, orderId));
    await recordEvent(tx, { orderId, from: order.status, to: 'expired', kind: 'status', actor: 'system', note: 'Payment not received in time' });
    await enqueueOrderNotifications(tx, 'status_changed', orderId);
    if (unverified) {
      await recordEvent(tx, { orderId, kind: 'flag', actor: 'system', note: 'Expired without a payment check: verify in the PayWay portal' });
      await enqueueOrderNotifications(tx, 'payment_unverified', orderId);
    }
    return tx
      .update(payments)
      .set({ status: 'expired', updatedAt: sql`now()` })
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
      .returning({ tranId: payments.providerTranId });
  });
  if (!cancelled) return false;
  for (const p of cancelled) await deps.payments.cancelTransaction(p.tranId).catch(() => {});
  return true;
}

/**
 * Wraps the provider for one run: after the first failure, further calls fail at once, so an outage
 * costs one timeout per run instead of one per order.
 */
function breakerFor(provider: PaymentProvider): PaymentProvider {
  let down = false;
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    if (down) throw new AppError('payment_provider_error', 502, 'Payment service unavailable (skipped for this run)');
    try {
      return await fn(...a);
    } catch (error) {
      if (error instanceof AppError) down = true;
      throw error;
    }
  };
  return {
    name: provider.name,
    createTransaction: guard(provider.createTransaction.bind(provider)),
    checkTransaction: guard(provider.checkTransaction.bind(provider)),
    cancelTransaction: guard(provider.cancelTransaction.bind(provider)),
    verifyWebhook: provider.verifyWebhook.bind(provider),
  };
}

/** One pass of the background work. Only one instance runs it at a time (Postgres advisory lock). */
export async function sweepOnce(input: SweepDeps & { shouldStop?: () => boolean }): Promise<SweepResult> {
  const deps = { ...input, payments: breakerFor(input.payments) };
  const stopping = () => input.shouldStop?.() === true;
  const result: SweepResult = { locked: false, checked: 0, expired: 0, notifications: { sent: 0, failed: 0, skipped: 0 }, guestCartsDeleted: 0 };
  const { db } = deps.database;
  const client = await deps.database.pool.connect();
  let released = false;
  try {
    const lock = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [JOBS_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return result;
    result.locked = true;
    try {
      const now = deps.now();

      // Notifications first: they don't depend on the payment service.
      try {
        result.notifications = await processOutbox(db, deps.notifiers, now);
      } catch (error) {
        deps.logger.error({ err: safeError(error) }, 'Sweeper: notifications failed');
      }

      try {
        const due = await db
          .select({ payment: payments })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(and(inArray(payments.status, ['pending', 'cancelled']), eq(orders.status, 'pending_payment')))
          .orderBy(sql`${payments.lastCheckedAt} asc nulls first`)
          .limit(50);
        for (const { payment } of due) {
          if (stopping()) break;
          await refreshPayment({ db, payments: deps.payments, now: deps.now }, payment, { minIntervalMs: 30_000, source: 'sweeper' });
          result.checked += 1;
        }
        // Safety net for late payments: attempts of orders that expired in the last day, every 10 minutes.
        const late = await db
          .select({ payment: payments })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(and(inArray(payments.status, ['expired', 'cancelled']), eq(orders.status, 'expired'), gt(orders.updatedAt, new Date(now.getTime() - 86_400_000))))
          .orderBy(sql`${payments.lastCheckedAt} asc nulls first`)
          .limit(50);
        for (const { payment } of late) {
          if (stopping()) break;
          await refreshPayment({ db, payments: deps.payments, now: deps.now }, payment, { minIntervalMs: 10 * 60_000, source: 'sweeper' });
          result.checked += 1;
        }
      } catch (error) {
        deps.logger.error({ err: safeError(error) }, 'Sweeper: payment checks failed');
      }

      try {
        const expiring = await db
          .select({ id: orders.id })
          .from(orders)
          .where(and(inArray(orders.status, EXPIRABLE), isNotNull(orders.reservedUntil), lt(orders.reservedUntil, now)))
          .orderBy(asc(orders.reservedUntil))
          .limit(100);
        for (const o of expiring) {
          if (stopping()) break;
          try {
            if (await expireOrder(deps, o.id)) result.expired += 1;
          } catch (error) {
            deps.logger.error({ err: safeError(error), orderId: o.id }, 'Sweeper: could not expire order');
          }
        }
      } catch (error) {
        deps.logger.error({ err: safeError(error) }, 'Sweeper: expiry failed');
      }

      try {
        const deleted = await db
          .delete(carts)
          .where(and(isNotNull(carts.guestToken), lt(carts.updatedAt, new Date(now.getTime() - GUEST_CART_DAYS * 86_400_000))))
          .returning({ id: carts.id });
        result.guestCartsDeleted = deleted.length;
        // Idempotency keys only need to outlive a client's retries (spec: 24 hours).
        await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - 86_400_000)));
        // Webhook records are an audit trail for disputes; 90 days is plenty.
        await db.delete(paymentWebhookEvents).where(lt(paymentWebhookEvents.receivedAt, new Date(now.getTime() - 90 * 86_400_000)));
      } catch (error) {
        deps.logger.error({ err: safeError(error) }, 'Sweeper: guest cart cleanup failed');
      }
    } finally {
      try {
        await client.query('select pg_advisory_unlock($1)', [JOBS_LOCK_KEY]);
      } catch (error) {
        // A session lock survives on a pooled connection: destroy the connection so the lock goes with it.
        deps.logger.error({ err: safeError(error) }, 'Sweeper: could not release the job lock; dropping the connection');
        released = true;
        client.release(true);
      }
    }
    return result;
  } finally {
    if (!released) client.release();
  }
}

/** Runs sweepOnce every interval (default 1 minute). stop() waits for a run in progress. */
export function startScheduler(deps: SweepDeps & { intervalMs?: number; stopTimeoutMs?: number }): { stop(): Promise<void>; runNow(): Promise<void> } {
  let current: Promise<void> | null = null;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (current) return current;
    if (stopped) return Promise.resolve();
    current = sweepOnce({ ...deps, shouldStop: () => stopped })
      .then((r) => {
        if (r.expired || r.checked || r.notifications.sent || r.notifications.failed || r.guestCartsDeleted) deps.logger.info({ sweep: r }, 'Sweeper run');
      })
      .catch((error: unknown) => deps.logger.error({ err: safeError(error) }, 'Sweeper run failed'))
      .finally(() => {
        current = null;
      });
    return current;
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000);
  timer.unref();
  return {
    runNow: tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Wait for the run to reach a safe point, but not for a hung payment-service call.
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, deps.stopTimeoutMs ?? 1_500).unref())]);
    },
  };
}
