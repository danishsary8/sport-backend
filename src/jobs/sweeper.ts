import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { carts, orderItemAllocations, orderItems, orders, payments, promotions, type OrderStatus } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
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
const EXPIRABLE: OrderStatus[] = ['pending_payment', 'awaiting_pickup_payment'];
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
    await releaseAllocations(tx, allocations, order.number);
    assertTransition(order.status, 'expired');
    await tx.update(orders).set({ status: 'expired', reservedUntil: null, updatedAt: sql`now()` }).where(eq(orders.id, orderId));
    if (order.promotionId) {
      await tx.update(promotions).set({ usedCount: sql`greatest(0, ${promotions.usedCount} - 1)` }).where(eq(promotions.id, order.promotionId));
    }
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

/** One pass of the background work. Only one instance runs it at a time (Postgres advisory lock). */
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = { locked: false, checked: 0, expired: 0, notifications: { sent: 0, failed: 0, skipped: 0 }, guestCartsDeleted: 0 };
  const { db } = deps.database;
  const client = await deps.database.pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [JOBS_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return result;
    result.locked = true;
    try {
      const now = deps.now();

      try {
        const due = await db
          .select({ payment: payments })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(and(inArray(payments.status, ['pending', 'cancelled']), eq(orders.status, 'pending_payment')))
          .orderBy(sql`${payments.lastCheckedAt} asc nulls first`)
          .limit(50);
        for (const { payment } of due) {
          await refreshPayment({ db, payments: deps.payments, now: deps.now }, payment, { minIntervalMs: 30_000, source: 'sweeper' });
          result.checked += 1;
        }
      } catch (error) {
        deps.logger.error({ err: error }, 'Sweeper: payment checks failed');
      }

      try {
        const expiring = await db
          .select({ id: orders.id })
          .from(orders)
          .where(and(inArray(orders.status, EXPIRABLE), isNotNull(orders.reservedUntil), lt(orders.reservedUntil, now)))
          .orderBy(asc(orders.reservedUntil))
          .limit(100);
        for (const o of expiring) {
          try {
            if (await expireOrder(deps, o.id)) result.expired += 1;
          } catch (error) {
            deps.logger.error({ err: error, orderId: o.id }, 'Sweeper: could not expire order');
          }
        }
      } catch (error) {
        deps.logger.error({ err: error }, 'Sweeper: expiry failed');
      }

      try {
        result.notifications = await processOutbox(db, deps.notifiers, now);
      } catch (error) {
        deps.logger.error({ err: error }, 'Sweeper: notifications failed');
      }

      try {
        const deleted = await db
          .delete(carts)
          .where(and(isNotNull(carts.guestToken), lt(carts.updatedAt, new Date(now.getTime() - GUEST_CART_DAYS * 86_400_000))))
          .returning({ id: carts.id });
        result.guestCartsDeleted = deleted.length;
      } catch (error) {
        deps.logger.error({ err: error }, 'Sweeper: guest cart cleanup failed');
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [JOBS_LOCK_KEY]);
    }
    return result;
  } finally {
    client.release();
  }
}

/** Runs sweepOnce every interval (default 1 minute). stop() waits for a run in progress. */
export function startScheduler(deps: SweepDeps & { intervalMs?: number }): { stop(): Promise<void>; runNow(): Promise<void> } {
  let current: Promise<void> | null = null;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (current) return current;
    if (stopped) return Promise.resolve();
    current = sweepOnce(deps)
      .then((r) => {
        if (r.expired || r.checked || r.notifications.sent || r.notifications.failed || r.guestCartsDeleted) deps.logger.info({ sweep: r }, 'Sweeper run');
      })
      .catch((error: unknown) => deps.logger.error({ err: error }, 'Sweeper run failed'))
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
      if (current) await current;
    },
  };
}
