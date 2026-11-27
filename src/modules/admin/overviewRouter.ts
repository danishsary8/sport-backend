import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { assetUrl } from '../catalog/view.js';
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
        (select count(*) from orders o where o.payment_status = 'paid' and o.status not in ('cancelled', 'expired') and o.paid_at >= (${today})::timestamp at time zone 'Asia/Phnom_Penh' ${orderScopeSql})::int as paid_today,
        (select coalesce(sum(o.total_cents), 0) from orders o where o.payment_status = 'paid' and o.status not in ('cancelled', 'expired') and o.paid_at >= (${today})::timestamp at time zone 'Asia/Phnom_Penh' ${orderScopeSql})::int as revenue_today,
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

  const salesQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(14) });

  /**
   * Takings for the charts: one bucket per Phnom Penh day (empty days included), totals against the period
   * before, best sellers and takings by category. Paid, not cancelled or expired, by payment day.
   */
  router.get('/admin/overview/sales', ...ctx.member, requireRole('staff', 'admin'), validate({ query: salesQuery }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { days } = req.query as unknown as z.infer<typeof salesQuery>;
    const branch = orderScope(req.user!).branchId;
    const scope = branch
      ? sql`and (exists (select 1 from order_item_allocations a join order_items i on i.id = a.order_item_id where i.order_id = o.id and a.branch_id = ${branch}) or o.pickup_branch_id = ${branch})`
      : sql``;
    const today = sql`(now() at time zone 'Asia/Phnom_Penh')::date`;
    // Ranges are on paid_at itself so orders_paid_at_idx serves them.
    const dayStart = (back: number) => sql`((${today} - ${back}::int)::timestamp at time zone 'Asia/Phnom_Penh')`;
    const sold = sql`o.payment_status = 'paid' and o.status not in ('cancelled', 'expired') ${scope}`;
    const current = sql`o.paid_at >= ${dayStart(days - 1)}`;
    // The period before stops at the same time of day as now, so a half-finished today is compared fairly.
    const before = sql`o.paid_at >= ${dayStart(days * 2 - 1)} and o.paid_at < now() - make_interval(days => ${days}::int)`;
    // Staff see only line items their store handled, not whole multi-store orders.
    const itemScope = branch
      ? sql`and (exists (select 1 from order_item_allocations a where a.order_item_id = oi.id and a.branch_id = ${branch}) or o.pickup_branch_id = ${branch})`
      : sql``;

    const [series, totals, top, byCategory] = await Promise.all([
      db.execute<{ date: string; paid_orders: number; revenue_cents: number }>(sql`
        select to_char(d, 'YYYY-MM-DD') as date, count(o.id)::int as paid_orders, coalesce(sum(o.total_cents), 0)::int as revenue_cents
        from generate_series(${today} - ${days - 1}::int, ${today}, interval '1 day') d
        left join orders o on o.paid_at >= (d::date::timestamp at time zone 'Asia/Phnom_Penh') and o.paid_at < ((d::date + 1)::timestamp at time zone 'Asia/Phnom_Penh') and ${sold}
        group by d order by d`),
      db.execute<{ period: string; paid_orders: number; revenue_cents: number }>(sql`
        select case when ${current} then 'now' else 'before' end as period,
          count(*)::int as paid_orders, coalesce(sum(o.total_cents), 0)::int as revenue_cents
        from orders o where ${sold} and (${current} or (${before})) group by 1`),
      db.execute<{ product_id: string; name: string; image: string | null; qty: number; revenue_cents: number }>(sql`
        select p.id as product_id, p.name_i18n->>'en' as name,
          (select i.path from product_images i where i.product_id = p.id order by i.sort, i.id limit 1) as image,
          sum(oi.qty)::int as qty, sum(oi.line_total_cents)::int as revenue_cents
        from orders o join order_items oi on oi.order_id = o.id join variants v on v.id = oi.variant_id join products p on p.id = v.product_id
        where ${sold} and ${current} ${itemScope}
        group by p.id order by revenue_cents desc, qty desc limit 5`),
      db.execute<{ slug: string; name: string; revenue_cents: number }>(sql`
        select c.slug, c.name_i18n->>'en' as name, sum(oi.line_total_cents)::int as revenue_cents
        from orders o join order_items oi on oi.order_id = o.id join variants v on v.id = oi.variant_id
          join products p on p.id = v.product_id join categories c on c.id = p.category_id
        where ${sold} and ${current} ${itemScope}
        group by c.slug, c.name_i18n order by revenue_cents desc`),
    ]);
    const period = (name: string) => {
      const r = totals.rows.find((t) => t.period === name);
      const paidOrders = r?.paid_orders ?? 0;
      const revenueCents = r?.revenue_cents ?? 0;
      return { paidOrders, revenueCents, averageOrderCents: paidOrders ? Math.round(revenueCents / paidOrders) : 0 };
    };
    res.json({
      days: series.rows.map((r) => ({ date: r.date, paidOrders: r.paid_orders, revenueCents: r.revenue_cents })),
      totals: period('now'),
      previous: period('before'),
      topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, imageUrl: assetUrl(ctx.config.assetBaseUrl, r.image), qty: r.qty, revenueCents: r.revenue_cents })),
      byCategory: byCategory.rows.map((r) => ({ slug: r.slug, name: r.name, revenueCents: r.revenue_cents })),
      branch,
    });
  });

  return router;
}
