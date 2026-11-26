import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';
import {
  loyaltyLedger,
  orderEvents,
  orderItemAllocations,
  orderItems,
  orders,
  payments,
  promotionRedemptions,
  promotions,
  users,
  type OrderRow,
  type OrderStatus,
  type ProductSnapshot,
  type UserRow,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import type { Lang } from '../catalog/i18n.js';
import { pick } from '../catalog/i18n.js';
import { awardLoyalty, reverseLoyalty } from '../loyalty/award.js';
import { recordEvent } from './events.js';
import { enqueueOrderNotifications } from '../notifications/outbox.js';
import { loadOrderView } from './load.js';
import { transitionOrder, assertStaffTransition } from './transition.js';
import type { OrderView } from './view.js';
import { loadRules } from '../pricing/context.js';
import type { PaymentProvider } from '../payments/provider.js';
import { commitAllocations, releaseAllocations, restockAllocations } from '../stock/locking.js';

/** Branch-tied staff see only orders touching their branch; admins and other staff see all (null). */
export function orderScope(user: UserRow): { branchId: string | null } {
  return { branchId: user.role === 'staff' && user.staffBranchId ? user.staffBranchId : null };
}

/** SQL: the order (alias "orders") involves this branch, by allocation or as its pickup store. */
function touchesBranch(branchId: string): SQL {
  return sql`(exists (select 1 from order_item_allocations a join order_items i on i.id = a.order_item_id
    where i.order_id = "orders"."id" and a.branch_id = ${branchId}) or "orders"."pickup_branch_id" = ${branchId})`;
}

export interface AdminOrderFilters {
  q?: string;
  status?: OrderStatus;
  branch?: string;
  from?: string;
  to?: string;
  needsRefund?: boolean;
  page: number;
  pageSize: number;
}

export async function listAdminOrders(db: Db, scope: { branchId: string | null }, f: AdminOrderFilters) {
  const where: SQL[] = [];
  if (scope.branchId) where.push(touchesBranch(scope.branchId));
  if (f.branch) where.push(touchesBranch(f.branch));
  if (f.status) where.push(sql`"orders"."status" = ${f.status}`);
  if (f.needsRefund !== undefined) where.push(sql`"orders"."needs_refund" = ${f.needsRefund}`);
  // Dates are shop days in Phnom Penh time.
  if (f.from) where.push(sql`"orders"."created_at" >= (${f.from}::date)::timestamp at time zone 'Asia/Phnom_Penh'`);
  if (f.to) where.push(sql`"orders"."created_at" < ((${f.to}::date + 1)::timestamp at time zone 'Asia/Phnom_Penh')`);
  if (f.q) {
    const term = f.q.trim();
    const digits = term.replace(/\D/g, '');
    const byNumber = sql`"orders"."number" ilike ${`${term.replace(/[%_\\]/g, '')}%`}`;
    where.push(digits.length >= 3 ? sql`(${byNumber} or regexp_replace("orders"."contact_phone_e164", '\\D', '', 'g') like ${`%${digits}%`})` : byNumber);
  }
  const cond = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const total = await db.execute<{ n: number }>(sql`select count(*)::int as n from orders ${cond}`);
  const rows = await db.execute<{
    number: string; status: string; payment_status: string; payment_method: string; fulfillment: string;
    contact_name: string; contact_phone_e164: string; total_cents: number; needs_refund: boolean; created_at: Date; branches: string[] | null;
  }>(sql`
    select number, status, payment_status, payment_method, fulfillment, contact_name, contact_phone_e164, total_cents, needs_refund, created_at,
      coalesce((select array_agg(distinct a.branch_id order by a.branch_id) from order_item_allocations a join order_items i on i.id = a.order_item_id where i.order_id = "orders"."id"),
        case when pickup_branch_id is null then '{}'::text[] else array[pickup_branch_id] end) as branches
    from orders ${cond}
    order by created_at desc, id desc
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}`);
  return {
    orders: rows.rows.map((r) => ({
      number: r.number,
      status: r.status,
      paymentStatus: r.payment_status,
      paymentMethod: r.payment_method,
      fulfillment: r.fulfillment,
      contactName: r.contact_name,
      contactPhone: r.contact_phone_e164,
      totalCents: r.total_cents,
      needsRefund: r.needs_refund,
      branches: r.branches ?? [],
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total: total.rows[0]?.n ?? 0,
    page: f.page,
    pageSize: f.pageSize,
  };
}

const notFound = () => new AppError('order_not_found', 404, 'Order not found');

async function inScope(db: Db | Tx, order: OrderRow, scope: { branchId: string | null }): Promise<boolean> {
  if (!scope.branchId) return true;
  const r = await db.execute<{ ok: boolean }>(sql`select ${touchesBranch(scope.branchId)} as ok from orders where "orders"."id" = ${order.id}`);
  return r.rows[0]?.ok === true;
}

export interface AdminOrderDetail {
  order: OrderView;
  needsRefund: boolean;
  events: { at: string; from: string | null; to: string | null; kind: string; actor: string; actorName: string | null; note: string | null }[];
  payments: { attempt: number; method: string; status: string; amountCents: number; tranId: string; createdAt: string; updatedAt: string }[];
  allocations: { orderItemId: string; branchId: string; qty: number }[];
  pickList: Record<string, { sku: string; name: string; size: string; color: string; qty: number; customPrint: unknown }[]>;
}

export async function adminOrderDetail(db: Db, number: string, scope: { branchId: string | null }, opts: { lang: Lang; assetBase: string }): Promise<AdminOrderDetail> {
  const [order] = await db.select().from(orders).where(eq(orders.number, number.toUpperCase()));
  if (!order || !(await inScope(db, order, scope))) throw notFound();
  const [{ order: view }, events, pays, items, allocs] = await Promise.all([
    loadOrderView(db, order, opts),
    db
      .select({ e: orderEvents, actorName: users.fullName })
      .from(orderEvents)
      .leftJoin(users, sql`${users.id}::text = ${orderEvents.actor}`)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.id)),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.attempt)),
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    db
      .select({ orderItemId: orderItemAllocations.orderItemId, branchId: orderItemAllocations.branchId, qty: orderItemAllocations.qty })
      .from(orderItemAllocations)
      .innerJoin(orderItems, eq(orderItems.id, orderItemAllocations.orderItemId))
      .where(eq(orderItems.orderId, order.id)),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const pickList: AdminOrderDetail['pickList'] = {};
  for (const a of allocs) {
    if (scope.branchId && a.branchId !== scope.branchId) continue;
    const item = itemById.get(a.orderItemId)!;
    const s = item.productSnapshot as ProductSnapshot;
    (pickList[a.branchId] ??= []).push({ sku: s.sku, name: pick(s.name, opts.lang) ?? s.slug, size: s.size, color: s.color, qty: a.qty, customPrint: item.customPrint });
  }
  return {
    order: view,
    needsRefund: order.needsRefund,
    events: events.map(({ e, actorName }) => ({ at: e.createdAt.toISOString(), from: e.fromStatus, to: e.toStatus, kind: e.kind, actor: e.actor, actorName, note: e.note })),
    payments: pays.map((p) => ({ attempt: p.attempt, method: p.method, status: p.status, amountCents: p.amountCents, tranId: p.providerTranId, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })),
    allocations: scope.branchId ? allocs.filter((a) => a.branchId === scope.branchId) : allocs,
    pickList,
  };
}

async function allocationsOf(tx: Tx, orderId: string) {
  return tx
    .select({ variantId: orderItems.variantId, branchId: orderItemAllocations.branchId, qty: orderItemAllocations.qty })
    .from(orderItemAllocations)
    .innerJoin(orderItems, eq(orderItems.id, orderItemAllocations.orderItemId))
    .where(eq(orderItems.orderId, orderId));
}

/** Locks payments then the order (the shared lock order), checks scope, and runs a staff action. */
export async function withStaffOrder<T>(db: Db, number: string, scope: { branchId: string | null }, fn: (tx: Tx, order: OrderRow) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [found] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.number, number.toUpperCase()));
    if (!found) throw notFound();
    await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, found.id)).orderBy(asc(payments.attempt)).for('update');
    const [order] = await tx.select().from(orders).where(eq(orders.id, found.id)).for('update');
    if (!order || !(await inScope(tx, order, scope))) throw notFound();
    return fn(tx, order);
  });
}

/**
 * Cancels an order. Unpaid: the held stock, the promo use and open payment attempts are released.
 * Paid but not dispatched: the units go back on the shelf, the order's points are taken back and the
 * order is flagged for a refund (done by hand in the PayWay portal). Returns provider attempts to close.
 */
export async function cancelOrder(tx: Tx, order: OrderRow, actor: string, reason: string): Promise<string[]> {
  assertStaffTransition(order, 'cancelled');
  const allocs = await allocationsOf(tx, order.id);
  let toClose: string[] = [];
  if (order.paymentStatus === 'unpaid') {
    // Promotion before stock: the lock order every checkout path uses.
    if (order.promotionId) {
      await tx.update(promotions).set({ usedCount: sql`greatest(0, ${promotions.usedCount} - 1)` }).where(eq(promotions.id, order.promotionId));
    }
    await releaseAllocations(tx, allocs, order.number);
    toClose = (
      await tx
        .update(payments)
        .set({ status: 'cancelled', updatedAt: sql`now()` })
        .where(and(eq(payments.orderId, order.id), eq(payments.status, 'pending')))
        .returning({ tranId: payments.providerTranId })
    ).map((p) => p.tranId);
  } else {
    const alreadyRefunded = order.paymentStatus === 'refunded';
    if (order.promotionId) {
      // The code wasn't really used: give the use back so a one-per-customer code works again.
      const removed = await tx.delete(promotionRedemptions).where(eq(promotionRedemptions.orderId, order.id)).returning({ id: promotionRedemptions.id });
      if (removed.length > 0) {
        await tx.update(promotions).set({ usedCount: sql`greatest(0, ${promotions.usedCount} - 1)` }).where(eq(promotions.id, order.promotionId));
      }
    }
    await restockAllocations(tx, allocs, order.number, 'order_cancel', /^[0-9a-f-]{36}$/.test(actor) ? actor : null);
    if (order.userId) {
      const [earned] = await tx
        .select({ delta: loyaltyLedger.delta })
        .from(loyaltyLedger)
        .where(and(eq(loyaltyLedger.orderId, order.id), eq(loyaltyLedger.reason, 'order_paid')));
      if (earned) {
        const rules = (await loadRules(tx)).loyalty;
        await reverseLoyalty(tx, order.userId, earned.delta, Math.max(0, order.totalCents - order.shippingCents), 'order_cancelled', order.id, rules, `Order ${order.number} cancelled`);
      }
    }
    if (!alreadyRefunded) {
      await tx.update(orders).set({ needsRefund: true }).where(eq(orders.id, order.id));
      await recordEvent(tx, { orderId: order.id, kind: 'flag', actor, note: 'Needs refund: paid order cancelled' });
      await enqueueOrderNotifications(tx, 'needs_refund', order.id, { reason: `paid order cancelled: ${reason}` });
    }
  }
  await transitionOrder(tx, order, 'cancelled', actor, reason);
  return toClose;
}

/**
 * A pickup order paid in cash at the counter (cash-on-pickup, or a KHQR order the shopper pays in cash
 * instead): stock leaves the shelf, points are awarded, open QR codes are closed and the order is
 * completed. The customer gets one "completed" message. Returns provider attempts to close.
 */
export async function collectCash(tx: Tx, order: OrderRow, actor: string): Promise<string[]> {
  if (order.fulfillment !== 'pickup' || order.paymentStatus !== 'unpaid' || !['pending_payment', 'awaiting_pickup_payment', 'ready_for_pickup'].includes(order.status)) {
    throw new AppError('invalid_transition', 409, 'Only unpaid pickup orders can be paid in cash at the counter');
  }
  await commitAllocations(tx, await allocationsOf(tx, order.id), order.number);
  const [paid] = await tx
    .update(orders)
    .set({ paymentStatus: 'paid', paymentMethod: 'cash_on_pickup', paidAt: sql`now()`, reservedUntil: null, updatedAt: sql`now()` })
    .where(eq(orders.id, order.id))
    .returning();
  if (order.promotionId) {
    await tx
      .insert(promotionRedemptions)
      .values({ promotionId: order.promotionId, userId: order.userId, orderId: order.id, contactPhoneE164: order.contactPhoneE164 })
      .onConflictDoNothing();
  }
  await awardLoyalty(tx, paid!, (await loadRules(tx)).loyalty);
  const toClose = (
    await tx
      .update(payments)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(and(eq(payments.orderId, order.id), eq(payments.status, 'pending')))
      .returning({ tranId: payments.providerTranId })
  ).map((p) => p.tranId);
  await recordEvent(tx, { orderId: order.id, kind: 'payment', actor, note: 'Paid in cash at the counter' });
  let current = paid!;
  if (current.status === 'pending_payment') current = await transitionOrder(tx, current, 'confirmed', actor, undefined, { notify: false });
  if (current.status !== 'ready_for_pickup') current = await transitionOrder(tx, current, 'ready_for_pickup', actor, undefined, { notify: false });
  await transitionOrder(tx, current, 'completed', actor);
  return toClose;
}

export async function markRefunded(tx: Tx, order: OrderRow, actor: string, note?: string): Promise<void> {
  if (order.paymentStatus !== 'paid') throw new AppError('invalid_transition', 409, 'Only a paid order can be marked refunded');
  // A cancelled or expired order was refunded in full; otherwise the refund was for returned items and
  // the rest of the order stays paid.
  const whole = order.status === 'cancelled' || order.status === 'expired';
  await tx
    .update(orders)
    .set({ ...(whole ? { paymentStatus: 'refunded' as const } : {}), needsRefund: false, updatedAt: sql`now()` })
    .where(eq(orders.id, order.id));
  await recordEvent(tx, { orderId: order.id, kind: 'payment', actor, note: note ? `Refunded: ${note}` : 'Refunded' });
}

export async function clearRefundFlag(tx: Tx, order: OrderRow, actor: string, note: string): Promise<void> {
  if (!order.needsRefund) throw new AppError('invalid_transition', 409, 'This order is not flagged for a refund');
  await tx.update(orders).set({ needsRefund: false, updatedAt: sql`now()` }).where(eq(orders.id, order.id));
  await recordEvent(tx, { orderId: order.id, kind: 'flag', actor, note: `Refund flag cleared: ${note}` });
}

export async function closeProviderAttempts(provider: PaymentProvider, tranIds: string[]): Promise<void> {
  for (const id of tranIds) await provider.cancelTransaction(id).catch(() => {});
}

