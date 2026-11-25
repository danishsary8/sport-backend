import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, orderEvents, orderItems, payments, type OrderRow } from '../../db/schema/index.js';
import type { Lang } from '../catalog/i18n.js';
import { orderView, paymentView, type OrderView, type PaymentView } from './view.js';

/** The customer view of an order with its timeline and latest payment attempt. */
export async function loadOrderView(db: Db, order: OrderRow, opts: { lang: Lang; assetBase: string }): Promise<{ order: OrderView; payment: PaymentView | null }> {
  const [items, events, branchRows, latest] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.id),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(orderEvents.id),
    order.pickupBranchId ? db.select({ name: branches.name }).from(branches).where(eq(branches.id, order.pickupBranchId)) : Promise.resolve([]),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.attempt)).limit(1),
  ]);
  return {
    order: orderView(order, items, { ...opts, pickupBranchName: branchRows[0]?.name ?? null, events }),
    payment: latest[0] ? paymentView(latest[0]) : null,
  };
}
