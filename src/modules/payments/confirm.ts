import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';
import {
  orderItemAllocations,
  orderItems,
  orders,
  payments,
  promotionRedemptions,
  promotions,
  type OrderRow,
  type OrderStatus,
  type PaymentRow,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { planAllocations } from '../checkout/allocation.js';
import { awardLoyalty } from '../loyalty/award.js';
import { enqueueOrderNotifications } from '../notifications/outbox.js';
import { recordEvent } from '../orders/events.js';
import { assertTransition } from '../orders/statusMachine.js';
import { loadRules } from '../pricing/context.js';
import { settingNumber } from '../settings/payments.js';
import { commitAllocations, reserveAllocations } from '../stock/locking.js';
import type { TransactionCheck } from './provider.js';

export type ConfirmResult = 'approved' | 'already' | 'pending' | 'declined' | 'unknown' | 'needs_refund';
export type ConfirmSource = 'webhook' | 'poll' | 'sweeper' | 'dev';

async function allocationsOf(tx: Tx, orderId: string) {
  return tx
    .select({ variantId: orderItems.variantId, branchId: orderItemAllocations.branchId, qty: orderItemAllocations.qty })
    .from(orderItemAllocations)
    .innerJoin(orderItems, eq(orderItems.id, orderItemAllocations.orderItemId))
    .where(eq(orderItems.orderId, orderId));
}

async function flagRefund(tx: Tx, order: OrderRow, reason: string, markPaid: boolean, paidCents?: number): Promise<'needs_refund'> {
  await tx
    .update(orders)
    .set({ needsRefund: true, ...(markPaid ? { paymentStatus: 'paid' as const, paidAt: sql`now()` } : {}), updatedAt: sql`now()` })
    .where(eq(orders.id, order.id));
  await recordEvent(tx, { orderId: order.id, kind: 'flag', actor: 'system', note: `Needs refund: ${reason}` });
  await enqueueOrderNotifications(tx, 'needs_refund', order.id, { reason, ...(paidCents !== undefined ? { paidCents } : {}) });
  return 'needs_refund';
}

/** Expired order paid anyway: plan and hold the stock again from what is available now. */
async function reReserve(tx: Tx, order: OrderRow): Promise<boolean> {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const buffer = await settingNumber(tx, 'online_safety_buffer', 'units', 1);
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const rows = await tx.execute<{ variant_id: string; branch_id: string; sort: number; available: number }>(sql`
    select s.variant_id, s.branch_id, b.sort, greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))::int as available
    from stock s join branches b on b.id = s.branch_id where s.variant_id in ${variantIds}`);
  const plan = planAllocations(
    items.map((i) => ({
      lineId: i.id,
      variantId: i.variantId,
      qty: i.qty,
      branches: rows.rows.filter((r) => r.variant_id === i.variantId).map((r) => ({ branchId: r.branch_id, sort: r.sort, available: r.available })),
    })),
    order.fulfillment === 'pickup' ? { fulfillment: 'pickup', branchId: order.pickupBranchId! } : { fulfillment: 'delivery' },
  );
  if (!plan.ok) return false;
  // Promotion before stock: the same lock order as order placement.
  if (order.promotionId) await tx.update(promotions).set({ usedCount: sql`${promotions.usedCount} + 1` }).where(eq(promotions.id, order.promotionId));
  try {
    await tx.transaction(async (sp) => {
      await reserveAllocations(sp, plan.allocations, order.number);
      await sp.delete(orderItemAllocations).where(
        sql`${orderItemAllocations.orderItemId} in (select id from order_items where order_id = ${order.id})`,
      );
      await sp.insert(orderItemAllocations).values(plan.allocations.map((a) => ({ orderItemId: a.lineId, branchId: a.branchId, qty: a.qty })));
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'stock_changed') {
      if (order.promotionId) await tx.update(promotions).set({ usedCount: sql`greatest(0, ${promotions.usedCount} - 1)` }).where(eq(promotions.id, order.promotionId));
      return false;
    }
    throw error;
  }
  return true;
}

async function fulfil(tx: Tx, order: OrderRow, payment: PaymentRow, now: Date): Promise<void> {
  await commitAllocations(tx, await allocationsOf(tx, order.id), order.number);
  const printed = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), sql`${orderItems.customPrint} is not null`))
    .limit(1);
  const to: OrderStatus = printed.length > 0 ? 'printing' : 'confirmed';
  assertTransition(order.status, to);
  const [paid] = await tx
    .update(orders)
    .set({ status: to, paymentStatus: 'paid', paymentMethod: payment.method, paidAt: now, reservedUntil: null, updatedAt: sql`now()` })
    .where(eq(orders.id, order.id))
    .returning();
  if (order.promotionId) {
    await tx
      .insert(promotionRedemptions)
      .values({ promotionId: order.promotionId, userId: order.userId, orderId: order.id, contactPhoneE164: order.contactPhoneE164 })
      .onConflictDoNothing();
  }
  await awardLoyalty(tx, paid!, (await loadRules(tx)).loyalty);
  await recordEvent(tx, { orderId: order.id, from: order.status, to, kind: 'status', actor: 'system', note: `Paid by ${payment.method}` });
  await enqueueOrderNotifications(tx, 'payment_received', order.id);
  await tx
    .update(payments)
    .set({ status: 'cancelled', updatedAt: sql`now()` })
    .where(and(eq(payments.orderId, order.id), eq(payments.status, 'pending'), ne(payments.id, payment.id)));
}

/**
 * The single place a provider's answer changes an order. Idempotent: payment row first, then order,
 * both locked, so the webhook, the poll and the sweeper can all call it at once.
 */
export async function applyProviderResult(deps: { db: Db; now: () => Date }, tranId: string, check: TransactionCheck, source: ConfirmSource): Promise<ConfirmResult> {
  return deps.db.transaction(async (tx) => {
    const [found] = await tx.select({ id: payments.id, orderId: payments.orderId }).from(payments).where(eq(payments.providerTranId, tranId));
    if (!found) return 'unknown';
    // Lock every attempt of the order in attempt order, then the order: the same order expiry and staff
    // actions use, so two attempts confirmed at once can't deadlock.
    await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, found.orderId)).orderBy(asc(payments.attempt)).for('update');
    const [payment] = await tx.select().from(payments).where(eq(payments.id, found.id));
    if (!payment) return 'unknown';
    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update');
    if (!order) return 'unknown';
    const now = deps.now();

    if (check.status === 'pending') {
      await tx.update(payments).set({ lastCheckedAt: now }).where(eq(payments.id, payment.id));
      return 'pending';
    }
    if (check.status !== 'approved') {
      if (payment.status === 'pending') {
        await tx.update(payments).set({ status: check.status, lastCheckedAt: now, updatedAt: sql`now()` }).where(eq(payments.id, payment.id));
      }
      return 'declined';
    }

    if (payment.status === 'approved') return 'already';
    await tx
      .update(payments)
      .set({ status: 'approved', lastCheckedAt: now, raw: { source, check: check.raw ?? null }, updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));
    await recordEvent(tx, { orderId: order.id, kind: 'payment', actor: 'system', note: `Payment ${payment.providerTranId} approved (${source})` });

    if (check.amountCents !== null && check.amountCents !== payment.amountCents) {
      return flagRefund(tx, order, `paid ${(check.amountCents / 100).toFixed(2)} but the order total is ${(payment.amountCents / 100).toFixed(2)}`, false, check.amountCents);
    }
    if (order.paymentStatus === 'paid') return flagRefund(tx, order, `paid twice (attempt ${payment.attempt})`, false);
    if (order.status === 'pending_payment') {
      await fulfil(tx, order, payment, now);
      return 'approved';
    }
    if (order.status === 'expired' && (await reReserve(tx, order))) {
      await fulfil(tx, order, payment, now);
      return 'approved';
    }
    return flagRefund(tx, order, order.status === 'expired' ? 'paid after the order expired; the items are no longer in stock' : `paid while the order was ${order.status}`, true);
  });
}
