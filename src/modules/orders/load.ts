import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, orderEvents, orderItems, payments, products, type OrderItemRow, type OrderRow, type ProductSnapshot } from '../../db/schema/index.js';
import { isNonReturnable, loadReturnRules } from '../rma/rules.js';
import type { Lang } from '../catalog/i18n.js';
import { orderView, paymentView, type OrderView, type PaymentView, type ReturnInfo } from './view.js';

/** The customer view of an order with its timeline and latest payment attempt. */
export async function loadOrderView(db: Db, order: OrderRow, opts: { lang: Lang; assetBase: string }): Promise<{ order: OrderView; payment: PaymentView | null }> {
  const [items, events, branchRows, latest] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.id),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(orderEvents.id),
    order.pickupBranchId ? db.select({ name: branches.name }).from(branches).where(eq(branches.id, order.pickupBranchId)) : Promise.resolve([]),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.attempt)).limit(1),
  ]);
  const returns = await returnInfo(db, order, items);
  return {
    order: orderView(order, items, { ...opts, pickupBranchName: branchRows[0]?.name ?? null, events, returns }),
    payment: latest[0] ? paymentView(latest[0]) : null,
  };
}

const DAY_MS = 86_400_000;

/** Return deadlines and per-line returnable units, with the same rules the returns endpoint enforces. */
async function returnInfo(db: Db, order: OrderRow, items: OrderItemRow[]): Promise<ReturnInfo> {
  const delivered = order.deliveredAt && (order.status === 'delivered' || order.status === 'completed') ? order.deliveredAt : null;
  if (!delivered || items.length === 0) return { window: null, returnable: new Map() };
  const rules = await loadReturnRules(db);
  const window = {
    exchangeUntil: new Date(delivered.getTime() + rules.exchangeDays * DAY_MS).toISOString(),
    refundUntil: new Date(delivered.getTime() + rules.refundDays * DAY_MS).toISOString(),
  };
  const open = Date.now() <= delivered.getTime() + Math.max(rules.exchangeDays, rules.refundDays) * DAY_MS + DAY_MS - 1;
  const snaps = items.map((i) => i.productSnapshot as ProductSnapshot);
  const [productRows, used] = await Promise.all([
    db.select({ id: products.id, attributes: products.attributes }).from(products).where(inArray(products.id, [...new Set(snaps.map((s) => s.productId))])),
    db.execute<{ order_item_id: string; qty: number }>(sql`
      select i.order_item_id, sum(i.qty)::int as qty from rma_items i join rma_requests r on r.id = i.rma_id
      where r.order_id = ${order.id} and r.status in ('requested', 'approved') group by i.order_item_id`),
  ]);
  const garment = new Map(productRows.map((p) => [p.id, (p.attributes as { garmentType?: unknown } | null)?.garmentType]));
  const usedBy = new Map(used.rows.map((r) => [r.order_item_id, r.qty]));
  const returnable = new Map<string, number>();
  for (const [idx, item] of items.entries()) {
    const snap = snaps[idx]!;
    const g = garment.get(snap.productId);
    const blocked = !open || item.customPrint !== null || isNonReturnable({ categorySlug: snap.categorySlug, productSlug: snap.slug, garmentType: typeof g === 'string' ? g : null }, rules);
    returnable.set(item.id, blocked ? 0 : Math.max(0, item.qty - (usedBy.get(item.id) ?? 0)));
  }
  return { window, returnable };
}
