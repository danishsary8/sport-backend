import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';
import {
  branches,
  loyaltyLedger,
  orderItemAllocations,
  orderItems,
  orders,
  products,
  rmaItems,
  rmaRequests,
  RMA_RESOLUTIONS,
  variants,
  type OrderItemRow,
  type ProductSnapshot,
  type RmaRequestRow,
  type UserRow,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { pick, type Lang } from '../catalog/i18n.js';
import { planAllocations } from '../checkout/allocation.js';
import { pgCode } from '../checkout/serializable.js';
import { reverseLoyalty } from '../loyalty/award.js';
import { enqueueOrderNotifications, enqueueRmaNotification } from '../notifications/outbox.js';
import { recordEvent } from '../orders/events.js';
import { loadRules } from '../pricing/context.js';
import { settingNumber } from '../settings/payments.js';
import { commitAllocations, releaseAllocations, reserveAllocations, restockAllocations } from '../stock/locking.js';
import { isNonReturnable, loadReturnRules, newRmaNumber, refundForLine, returnWindowOpen } from './rules.js';

export const rmaCreateSchema = z.object({
  orderNumber: z.string().trim().max(40),
  resolution: z.enum(RMA_RESOLUTIONS),
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        qty: z.number().int().min(1).max(20),
        reason: z.string().trim().min(1).max(300),
        exchangeVariantId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type RmaCreateInput = z.infer<typeof rmaCreateSchema>;

export type ReturnProblem =
  | 'window_closed'
  | 'custom_print'
  | 'non_returnable'
  | 'qty_exceeded'
  | 'not_delivered'
  | 'not_in_order'
  | 'exchange_variant_invalid'
  | 'exchange_out_of_stock';

export interface RmaView {
  number: string;
  orderNumber: string;
  resolution: string;
  status: string;
  refundCents: number;
  note: string | null;
  items: { orderItemId: string; name: string; size: string; qty: number; reason: string; refundCents: number; exchangeSize: string | null }[];
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

const notFound = () => new AppError('return_not_found', 404, 'Return not found');

async function rmaViews(db: Db | Tx, rows: RmaRequestRow[], lang: Lang): Promise<RmaView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = await db
    .select({ item: rmaItems, snapshot: orderItems.productSnapshot, exchangeSize: variants.sizeLabel })
    .from(rmaItems)
    .innerJoin(orderItems, eq(orderItems.id, rmaItems.orderItemId))
    .leftJoin(variants, eq(variants.id, rmaItems.exchangeVariantId))
    .where(inArray(rmaItems.rmaId, ids));
  const numbers = await db.select({ id: orders.id, number: orders.number }).from(orders).where(inArray(orders.id, [...new Set(rows.map((r) => r.orderId))]));
  const numberOf = new Map(numbers.map((n) => [n.id, n.number]));
  return rows.map((r) => ({
    number: r.number,
    orderNumber: numberOf.get(r.orderId) ?? '',
    resolution: r.resolution,
    status: r.status,
    refundCents: r.refundCents,
    note: r.note,
    items: items
      .filter((i) => i.item.rmaId === r.id)
      .map((i) => {
        const s = i.snapshot as ProductSnapshot;
        return { orderItemId: i.item.orderItemId, name: pick(s.name, lang) ?? s.slug, size: s.size, qty: i.item.qty, reason: i.item.reason, refundCents: i.item.refundCents, exchangeSize: i.exchangeSize ?? null };
      }),
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
  }));
}

/** Online-sellable units of one variant per branch (after the safety buffer). */
async function variantBranches(tx: Tx, variantId: string) {
  const buffer = await settingNumber(tx, 'online_safety_buffer', 'units', 1);
  const rows = await tx.execute<{ branch_id: string; sort: number; available: number }>(sql`
    select s.branch_id, b.sort, greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))::int as available
    from stock s join branches b on b.id = s.branch_id where s.variant_id = ${variantId}`);
  return rows.rows.map((r) => ({ branchId: r.branch_id, sort: r.sort, available: r.available }));
}

/** A member asks to return lines of a delivered order. Amounts and eligibility are decided here, never by the client. */
export async function createRma(db: Db, user: UserRow, input: RmaCreateInput, now: Date, lang: Lang = 'en'): Promise<RmaView> {
  const view = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.number, input.orderNumber.toUpperCase()), eq(orders.userId, user.id)))
      .for('update');
    if (!order) throw new AppError('order_not_found', 404, 'Order not found');
    const rules = await loadReturnRules(tx);
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const delivered = order.deliveredAt && (order.status === 'delivered' || order.status === 'completed') ? order.deliveredAt : null;

    const already = await tx.execute<{ order_item_id: string; qty: number }>(sql`
      select i.order_item_id, sum(i.qty)::int as qty from rma_items i join rma_requests r on r.id = i.rma_id
      where r.order_id = ${order.id} and r.status in ('requested', 'approved') group by i.order_item_id`);
    const used = new Map(already.rows.map((r) => [r.order_item_id, r.qty]));
    const requested = new Map<string, number>();

    const problems: { orderItemId: string; reason: ReturnProblem }[] = [];
    const accepted: { line: (typeof input.items)[number]; item: OrderItemRow; refund: number; exchange?: { branchId: string; qty: number }[] }[] = [];
    for (const line of input.items) {
      const item = byId.get(line.orderItemId);
      const fail = (reason: ReturnProblem) => problems.push({ orderItemId: line.orderItemId, reason });
      if (!item) {
        fail('not_in_order');
        continue;
      }
      const snap = item.productSnapshot as ProductSnapshot;
      if (!delivered) {
        fail('not_delivered');
        continue;
      }
      if (!returnWindowOpen(input.resolution, delivered, now, rules)) {
        fail('window_closed');
        continue;
      }
      if (item.customPrint) {
        fail('custom_print');
        continue;
      }
      const [product] = await tx.select({ attributes: products.attributes }).from(products).where(eq(products.id, snap.productId));
      const garmentType = (product?.attributes as { garmentType?: unknown } | undefined)?.garmentType;
      if (isNonReturnable({ categorySlug: snap.categorySlug, productSlug: snap.slug, garmentType: typeof garmentType === 'string' ? garmentType : null }, rules)) {
        fail('non_returnable');
        continue;
      }
      const total = (used.get(item.id) ?? 0) + (requested.get(item.id) ?? 0) + line.qty;
      if (total > item.qty) {
        fail('qty_exceeded');
        continue;
      }
      requested.set(item.id, (requested.get(item.id) ?? 0) + line.qty);

      if (input.resolution === 'size_exchange') {
        const [target] = line.exchangeVariantId
          ? await tx
              .select({ id: variants.id, productId: variants.productId, price: variants.priceCents, status: variants.status })
              .from(variants)
              .where(eq(variants.id, line.exchangeVariantId))
          : [];
        if (!target || target.productId !== snap.productId || target.id === item.variantId || target.price !== item.unitPriceCents || target.status !== 'active') {
          fail('exchange_variant_invalid');
          continue;
        }
        const plan = planAllocations([{ lineId: line.orderItemId, variantId: target.id, qty: line.qty, branches: await variantBranches(tx, target.id) }], { fulfillment: 'delivery' });
        if (!plan.ok) {
          fail('exchange_out_of_stock');
          continue;
        }
        accepted.push({ line, item, refund: 0, exchange: plan.allocations.map((a) => ({ branchId: a.branchId, qty: a.qty })) });
      } else {
        accepted.push({ line, item, refund: refundForLine(item.lineTotalCents, item.qty, line.qty) });
      }
    }
    if (problems.length > 0) throw new AppError('return_not_allowed', 400, "Some items can't be returned", problems);

    const refundCents = accepted.reduce((s, a) => s + a.refund, 0);
    let rma: RmaRequestRow | undefined;
    for (let i = 0; i < 5 && !rma; i++) {
      try {
        [rma] = await tx.transaction((sp) =>
          sp.insert(rmaRequests).values({ number: newRmaNumber(now), orderId: order.id, userId: user.id, resolution: input.resolution, refundCents, note: input.note ?? null }).returning(),
        );
      } catch (error) {
        if (pgCode(error) !== '23505') throw error;
      }
    }
    if (!rma) throw new Error('Could not allocate a return number');
    for (const a of accepted) {
      // An exchange split across stores is stored as one row per store.
      const parts = a.exchange ?? [{ branchId: null as string | null, qty: a.line.qty }];
      for (const part of parts) {
        await tx.insert(rmaItems).values({
          rmaId: rma.id,
          orderItemId: a.item.id,
          qty: part.qty,
          reason: a.line.reason,
          exchangeVariantId: a.exchange ? a.line.exchangeVariantId! : null,
          exchangeBranchId: part.branchId,
          refundCents: a.exchange ? 0 : a.refund,
        });
      }
      if (a.exchange) {
        await reserveAllocations(tx, a.exchange.map((p) => ({ variantId: a.line.exchangeVariantId!, branchId: p.branchId, qty: p.qty })), rma.number, 'exchange_reserve');
      }
    }
    await recordEvent(tx, { orderId: order.id, kind: 'note', actor: 'customer', note: `Return ${rma.number} requested (${input.resolution.replace('_', ' ')})` });
    await enqueueRmaNotification(tx, 'rma_requested', rma.id);
    return (await rmaViews(tx, [rma], lang))[0]!;
  });
  return view;
}

export async function listMemberRmas(db: Db, userId: string, lang: Lang): Promise<RmaView[]> {
  const rows = await db.select().from(rmaRequests).where(eq(rmaRequests.userId, userId)).orderBy(desc(rmaRequests.createdAt));
  return rmaViews(db, rows, lang);
}

/** Staff tied to a branch handle returns of orders that touched their branch. */
function rmaScope(branchId: string | null) {
  return branchId
    ? sql`(exists (select 1 from order_item_allocations a join order_items i on i.id = a.order_item_id
        where i.order_id = "rma_requests"."order_id" and a.branch_id = ${branchId})
        or exists (select 1 from orders o where o.id = "rma_requests"."order_id" and o.pickup_branch_id = ${branchId}))`
    : sql`true`;
}

export async function listAdminRmas(db: Db, branchId: string | null, f: { status?: string; page: number; pageSize: number }, lang: Lang) {
  const cond = sql`${rmaScope(branchId)} ${f.status ? sql`and "rma_requests"."status" = ${f.status}` : sql``}`;
  const total = await db.execute<{ n: number }>(sql`select count(*)::int as n from rma_requests where ${cond}`);
  const rows = await db
    .select()
    .from(rmaRequests)
    .where(cond)
    .orderBy(desc(rmaRequests.createdAt))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { returns: await rmaViews(db, rows, lang), total: total.rows[0]?.n ?? 0, page: f.page, pageSize: f.pageSize };
}

export async function adminRma(db: Db, branchId: string | null, number: string, lang: Lang): Promise<RmaView> {
  const [row] = await db.select().from(rmaRequests).where(and(eq(rmaRequests.number, number.toUpperCase()), rmaScope(branchId)));
  if (!row) throw notFound();
  return (await rmaViews(db, [row], lang))[0]!;
}

/**
 * Staff decision. Approve: returned units go back on the shelf; refunds/store credit take back the points
 * they earned and flag the money owed; exchanges hand over the held size. Reject: the held size is released.
 */
export async function decideRma(
  db: Db,
  actor: UserRow,
  number: string,
  d: { decision: 'approve' | 'reject'; branchId?: string; note?: string },
  staffBranchId: string | null,
  lang: Lang = 'en',
): Promise<RmaView> {
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(rmaRequests).where(and(eq(rmaRequests.number, number.toUpperCase()), rmaScope(staffBranchId)));
    if (!found) throw notFound();
    const [order] = await tx.select().from(orders).where(eq(orders.id, found.orderId)).for('update');
    const [rma] = await tx.select().from(rmaRequests).where(eq(rmaRequests.id, found.id)).for('update');
    if (!rma || !order) throw notFound();
    if (rma.status !== 'requested') throw new AppError('return_already_decided', 409, `This return was already ${rma.status}`);
    const items = await tx.select().from(rmaItems).where(eq(rmaItems.rmaId, rma.id)).orderBy(asc(rmaItems.id));
    const exchangeAllocs = items
      .filter((i) => i.exchangeVariantId && i.exchangeBranchId)
      .map((i) => ({ variantId: i.exchangeVariantId!, branchId: i.exchangeBranchId!, qty: i.qty }));

    if (d.decision === 'reject') {
      if (exchangeAllocs.length) await releaseAllocations(tx, exchangeAllocs, rma.number, 'exchange_release');
    } else {
      // Returned units go back on the shelf at the deciding staff member's store, else the chosen store,
      // else the store the item was sent from.
      const chosen = staffBranchId ?? d.branchId ?? null;
      if (chosen) {
        const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, chosen));
        if (!b) throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'branchId', message: 'Unknown branch' }]);
      }
      const restock = [];
      for (const item of items) {
        const [oi] = await tx.select({ variantId: orderItems.variantId }).from(orderItems).where(eq(orderItems.id, item.orderItemId));
        const [sentFrom] = await tx
          .select({ branchId: orderItemAllocations.branchId })
          .from(orderItemAllocations)
          .where(eq(orderItemAllocations.orderItemId, item.orderItemId))
          .orderBy(asc(orderItemAllocations.branchId))
          .limit(1);
        restock.push({ variantId: oi!.variantId, branchId: chosen ?? sentFrom?.branchId ?? order.pickupBranchId ?? 'sonthormuk', qty: item.qty });
      }
      await restockAllocations(tx, restock, rma.number, 'rma_restock', actor.id);

      if (rma.resolution === 'size_exchange') {
        if (exchangeAllocs.length) await commitAllocations(tx, exchangeAllocs, rma.number, 'exchange_commit');
      } else {
        if (order.userId && rma.refundCents > 0) {
          const [earned] = await tx
            .select({ id: loyaltyLedger.id })
            .from(loyaltyLedger)
            .where(and(eq(loyaltyLedger.orderId, order.id), eq(loyaltyLedger.reason, 'order_paid')));
          if (earned) {
            const rules = (await loadRules(tx)).loyalty;
            await reverseLoyalty(tx, order.userId, Math.floor((rma.refundCents * rules.pointsPerUsd) / 100), rma.refundCents, 'rma_reversal', order.id, rules, `Return ${rma.number}`);
          }
        }
        const money = `$${(rma.refundCents / 100).toFixed(2)}`;
        if (rma.resolution === 'refund') {
          await tx.update(orders).set({ needsRefund: true, updatedAt: sql`now()` }).where(eq(orders.id, order.id));
          await recordEvent(tx, { orderId: order.id, kind: 'flag', actor: actor.id, note: `Needs refund: return ${rma.number} approved (${money})` });
          await enqueueOrderNotifications(tx, 'needs_refund', order.id, { reason: `return ${rma.number} approved: refund ${money}` });
        } else {
          await recordEvent(tx, { orderId: order.id, kind: 'flag', actor: actor.id, note: `Store credit to issue: ${money} (return ${rma.number})` });
        }
      }
    }
    const [decided] = await tx
      .update(rmaRequests)
      .set({ status: d.decision === 'approve' ? 'approved' : 'rejected', decidedBy: actor.id, decidedAt: sql`now()`, decisionNote: d.note ?? null })
      .where(eq(rmaRequests.id, rma.id))
      .returning();
    await recordEvent(tx, { orderId: order.id, kind: 'note', actor: actor.id, note: `Return ${rma.number} ${decided!.status}${d.note ? `: ${d.note}` : ''}` });
    await enqueueRmaNotification(tx, 'rma_decided', rma.id);
    return (await rmaViews(tx, [decided!], lang))[0]!;
  });
}
