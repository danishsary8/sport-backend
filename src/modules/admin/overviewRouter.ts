import { sql } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../middleware/auth.js';
import { orderScope } from '../orders/admin.js';
import { safetyBuffer } from '../catalog/listing.js';

/** Today's trading and everything waiting on staff, in one call. "Today" is the Phnom Penh day. */
export function adminOverviewRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  router.get('/admin/overview', ...ctx.member, requireRole('staff', 'admin'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const branch = orderScope(req.user!).branchId;
    const buffer = await safetyBuffer(db);
    const orderScopeSql = branch
      ? sql`and (exists (select 1 from order_item_allocations a join order_items i on i.id = a.order_item_id where i.order_id = o.id and a.branch_id = ${branch}) or o.pickup_branch_id = ${branch})`
      : sql``;
    const stockScope = branch ? sql`and s.branch_id = ${branch}` : sql``;
    const today = sql`(now() at time zone 'Asia/Phnom_Penh')::date`;
    const r = await db.execute<Record<string, number>>(sql`
      select
        (select count(*) from orders o where (o.created_at at time zone 'Asia/Phnom_Penh')::date = ${today} ${orderScopeSql})::int as orders_today,
        (select count(*) from orders o where o.payment_status = 'paid' and (o.paid_at at time zone 'Asia/Phnom_Penh')::date = ${today} ${orderScopeSql})::int as paid_today,
        (select coalesce(sum(o.total_cents), 0) from orders o where o.payment_status = 'paid' and (o.paid_at at time zone 'Asia/Phnom_Penh')::date = ${today} ${orderScopeSql})::int as revenue_today,
        (select count(*) from orders o where o.status = 'pending_payment' ${orderScopeSql})::int as pending_payments,
        (select count(*) from orders o where o.needs_refund ${orderScopeSql})::int as needs_refund,
        (select count(*) from orders o where o.status = 'confirmed' ${orderScopeSql})::int as confirmed,
        (select count(*) from orders o where o.status = 'printing' ${orderScopeSql})::int as printing,
        (select count(*) from orders o where o.status = 'ready_for_pickup' ${orderScopeSql})::int as ready_for_pickup,
        (select count(*) from orders o where o.status = 'out_for_delivery' ${orderScopeSql})::int as out_for_delivery,
        (select count(*) from rma_requests r join orders o on o.id = r.order_id where r.status = 'requested' ${orderScopeSql})::int as open_returns,
        (select count(*) from product_questions where status = 'pending')::int as pending_questions,
        (select count(*) from stock s join variants v on v.id = s.variant_id join products p on p.id = v.product_id
          where p.status = 'active' and v.status = 'active' ${stockScope}
          and greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer})) between 1 and 3)::int as low_stock,
        (select count(*) from stock s where s.needs_count ${stockScope})::int as needs_count,
        (select count(*) from notification_outbox where status = 'failed')::int as outbox_failed`);
    const n = r.rows[0]!;
    res.json({
      today: { orders: n.orders_today, paidOrders: n.paid_today, revenueCents: n.revenue_today },
      pendingPayments: n.pending_payments,
      needsRefund: n.needs_refund,
      awaitingFulfilment: { confirmed: n.confirmed, printing: n.printing, readyForPickup: n.ready_for_pickup, outForDelivery: n.out_for_delivery },
      openReturns: n.open_returns,
      pendingQuestions: n.pending_questions,
      lowStockRows: n.low_stock,
      needsCountRows: n.needs_count,
      outboxFailed: n.outbox_failed,
      branch,
    });
  });

  return router;
}
