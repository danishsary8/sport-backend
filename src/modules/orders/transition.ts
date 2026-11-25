import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/exec.js';
import { orders, type OrderRow, type OrderStatus } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { enqueueOrderNotifications } from '../notifications/outbox.js';
import { recordEvent } from './events.js';
import { canTransition } from './statusMachine.js';

const NEEDS_PAYMENT: OrderStatus[] = ['out_for_delivery', 'delivered', 'completed'];
const TELL_CUSTOMER: OrderStatus[] = ['printing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled'];

const refuse = (order: OrderRow, to: OrderStatus, why: string) =>
  new AppError('invalid_transition', 409, why, { from: order.status, to });

/** Checks whether staff may move the order to `to` right now; throws invalid_transition otherwise. */
export function assertStaffTransition(order: OrderRow, to: OrderStatus): void {
  if (!canTransition(order.status, to)) {
    throw refuse(order, to, `An order can't go from ${order.status.replaceAll('_', ' ')} to ${to.replaceAll('_', ' ')}`);
  }
  if (NEEDS_PAYMENT.includes(to) && order.paymentStatus !== 'paid') throw refuse(order, to, 'This order has not been paid yet');
  if (to === 'ready_for_pickup' && order.fulfillment !== 'pickup') throw refuse(order, to, 'This order is for delivery, not pickup');
  if (to === 'out_for_delivery' && order.fulfillment !== 'delivery') throw refuse(order, to, 'This order is for pickup, not delivery');
}

/**
 * The one way staff change an order's status: guards, the timeline event (with the actor), the delivery
 * stamp that starts return windows, and the customer notification. The caller holds the order row lock.
 */
export async function transitionOrder(tx: Tx, order: OrderRow, to: OrderStatus, actor: string, note?: string): Promise<OrderRow> {
  assertStaffTransition(order, to);
  const stampDelivery = !order.deliveredAt && (to === 'delivered' || (to === 'completed' && order.fulfillment === 'pickup'));
  const [updated] = await tx
    .update(orders)
    .set({ status: to, updatedAt: sql`now()`, ...(stampDelivery ? { deliveredAt: sql`now()` } : {}), ...(to === 'cancelled' ? { reservedUntil: null } : {}) })
    .where(eq(orders.id, order.id))
    .returning();
  await recordEvent(tx, { orderId: order.id, from: order.status, to, kind: 'status', actor, note });
  if (TELL_CUSTOMER.includes(to)) await enqueueOrderNotifications(tx, 'status_changed', order.id);
  return updated!;
}
