import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { orderItems, orders, payments, type PaymentMethod, type ProductSnapshot } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { tranIdFor } from '../orders/number.js';
import { paymentView, type PaymentView } from '../orders/view.js';
import type { CheckoutDeps } from './placeOrder.js';

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! } : { firstName: full.trim(), lastName: '' };
}

/**
 * Opens payment attempt N+1 for an order awaiting payment and asks the provider for a QR / checkout page.
 * Earlier pending attempts are cancelled (best effort). The amount always comes from the order.
 */
export async function startPaymentAttempt(deps: Pick<CheckoutDeps, 'db' | 'payments' | 'now'>, orderId: string, method: PaymentMethod): Promise<PaymentView> {
  const { db, payments: provider } = deps;
  const { payment, order } = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw new AppError('order_not_found', 404, 'Order not found');
    if (o.status !== 'pending_payment' || o.paymentStatus !== 'unpaid' || (o.reservedUntil && o.reservedUntil <= deps.now())) {
      throw new AppError('order_not_payable', 409, 'This order can no longer be paid');
    }
    const [last] = await tx.select({ attempt: payments.attempt }).from(payments).where(eq(payments.orderId, o.id)).orderBy(desc(payments.attempt)).limit(1);
    const attempt = (last?.attempt ?? 0) + 1;
    const [p] = await tx
      .insert(payments)
      .values({ orderId: o.id, attempt, provider: provider.name, providerTranId: tranIdFor(o.number, attempt), method, amountCents: o.totalCents, status: 'pending' })
      .returning();
    if (o.paymentMethod !== method) await tx.update(orders).set({ paymentMethod: method, updatedAt: sql`now()` }).where(eq(orders.id, o.id));
    return { payment: p!, order: o };
  });

  const items = await db.select({ snapshot: orderItems.productSnapshot, qty: orderItems.qty, lineTotal: orderItems.lineTotalCents }).from(orderItems).where(eq(orderItems.orderId, orderId));
  let created;
  try {
    created = await provider.createTransaction({
      tranId: payment.providerTranId,
      method,
      amountCents: payment.amountCents,
      expiresAt: order.reservedUntil ?? new Date(deps.now().getTime() + 30 * 60_000),
      customer: { ...splitName(order.contactName), phone: order.contactPhoneE164, email: order.contactEmail },
      items: items.map((i) => ({ name: (i.snapshot as ProductSnapshot).name?.en ?? 'Item', qty: i.qty, priceCents: Math.round(i.lineTotal / i.qty) })),
    });
  } catch (error) {
    await db.update(payments).set({ status: 'cancelled', updatedAt: sql`now()` }).where(eq(payments.id, payment.id));
    throw error;
  }
  const [saved] = await db
    .update(payments)
    .set({ instructions: created.instructions as unknown as Record<string, unknown>, raw: created.raw ?? null, updatedAt: sql`now()` })
    .where(eq(payments.id, payment.id))
    .returning();

  // Older QR codes / checkout pages should stop working; if one is paid anyway, confirmation flags a refund.
  // Only OLDER attempts: when two retries race, the newest one must stay payable.
  const older = await db
    .update(payments)
    .set({ status: 'cancelled', updatedAt: sql`now()` })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending'), lt(payments.attempt, payment.attempt)))
    .returning({ tranId: payments.providerTranId });
  for (const o of older) await provider.cancelTransaction(o.tranId).catch(() => {});
  // A newer attempt overtook this one while the provider answered: close this one at the provider too.
  if (saved!.status === 'cancelled') await provider.cancelTransaction(saved!.providerTranId).catch(() => {});
  return paymentView(saved!);
}
