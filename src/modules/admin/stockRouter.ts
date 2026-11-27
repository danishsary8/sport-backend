import { sql } from 'drizzle-orm';
import type { UserRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { escapeLike, safetyBuffer } from '../catalog/listing.js';
import { assetUrl } from '../catalog/view.js';
import { adjustStock, countStock, recordSale, restockStock, transferStock } from '../stock/service.js';
import { assertBranchAccess, assertBranchExists, branchFor } from './branchAccess.js';

const uuid = z.string().uuid();
const branchId = z.string().trim().min(1).max(40);

/** null for admins and unscoped staff; the staff member's branch otherwise. */
function scopedBranch(user: UserRow): string | null {
  return user.role === 'staff' && user.staffBranchId ? user.staffBranchId : null;
}

export function adminStockRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const staff = [...ctx.member, requireRole('staff', 'admin')];

  router.use('/admin/stock', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/admin/stock/lookup',
    ...staff,
    validate({ query: z.object({ q: z.string().trim().min(1).max(80), branchId: branchId.optional() }) }),
    async (req, res) => {
      const { q, branchId: requested } = req.query as unknown as { q: string; branchId?: string };
      const branch = branchFor(req.user!, requested);
      await assertBranchExists(db, branch);
      const pattern = `%${escapeLike(q.toLowerCase())}%`;
      const rows = await db.execute<{
        product_id: string; slug: string; name: string; variant_id: string; sku: string; size: string; color: string;
        on_hand: number | null; reserved: number | null;
      }>(sql`
        with hits as (
          select distinct p.id from products p join variants v on v.product_id = p.id
          where lower(v.sku) like ${pattern} or p.search_text like ${pattern}
          limit 20)
        select p.id as product_id, p.slug, p.name_i18n->>'en' as name, v.id as variant_id, v.sku, v.size_label as size,
          pc.name as color, s.on_hand, s.reserved
        from hits join products p on p.id = hits.id
        join variants v on v.product_id = p.id
        join product_colors pc on pc.id = v.color_id
        left join stock s on s.variant_id = v.id and s.branch_id = ${branch}
        order by p.slug, v.size_sort`);
      const products = new Map<string, { id: string; slug: string; name: string; variants: unknown[] }>();
      for (const r of rows.rows) {
        if (!products.has(r.product_id)) products.set(r.product_id, { id: r.product_id, slug: r.slug, name: r.name, variants: [] });
        const onHand = r.on_hand ?? 0;
        const reserved = r.reserved ?? 0;
        products.get(r.product_id)!.variants.push({
          id: r.variant_id, sku: r.sku, size: r.size, color: r.color, branchId: branch,
          onHand, reserved, available: onHand - reserved,
        });
      }
      res.json({ branchId: branch, products: [...products.values()] });
    },
  );

  /**
   * The stock screen's list: products with every size's numbers at one branch, sorted by name, with
   * filters for what needs attention. "low" matches the overview's count (1 to 3 left to sell online, active
   * products); "out" means nothing free at the branch; "count" means the row is waiting for a shelf count.
   * A product shows when any of its sizes matches the filter, and the response says which sizes do.
   */
  router.get(
    '/admin/stock/list',
    ...staff,
    validate({
      query: z.object({
        branchId: branchId.optional(),
        view: z.enum(['all', 'low', 'out', 'count']).default('all'),
        category: z.string().trim().min(1).max(60).optional(),
        q: z.string().trim().max(80).optional(),
        page: z.coerce.number().int().min(1).max(1000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      }),
    }),
    async (req, res) => {
      const query = req.query as unknown as { branchId?: string; view: 'all' | 'low' | 'out' | 'count'; category?: string; q?: string; page: number; pageSize: number };
      const branch = branchFor(req.user!, query.branchId);
      await assertBranchExists(db, branch);
      const buffer = await safetyBuffer(db);
      const pattern = query.q ? `%${escapeLike(query.q.toLowerCase())}%` : null;
      const rows = sql`
        select p.id as pid, coalesce(s.needs_count, false) as needs_count,
          (p.status = 'active' and greatest(0, coalesce(s.on_hand, 0) - coalesce(s.reserved, 0) - coalesce(s.online_buffer, ${buffer})) between 1 and 3) as is_low,
          (coalesce(s.on_hand, 0) - coalesce(s.reserved, 0) <= 0) as is_out
        from products p
        join variants v on v.product_id = p.id and v.status = 'active'
        left join categories c on c.id = p.category_id
        left join stock s on s.variant_id = v.id and s.branch_id = ${branch}
        where p.status <> 'archived'
          and (${query.category ?? null}::text is null or c.slug = ${query.category ?? null})
          and (${pattern}::text is null or lower(v.sku) like ${pattern} or p.search_text like ${pattern})`;
      const match = { all: sql`true`, low: sql`is_low`, out: sql`is_out`, count: sql`needs_count` }[query.view];
      const counts = await db.execute<{ all: number; low: number; out: number; count: number }>(sql`
        with r as (${rows})
        select count(distinct pid)::int as all, count(*) filter (where is_low)::int as low,
          count(*) filter (where is_out)::int as out, count(*) filter (where needs_count)::int as count
        from r`);
      const page = await db.execute<{ pid: string; total: number }>(sql`
        with r as (${rows}), hits as (select pid from r group by pid having bool_or(${match}))
        select h.pid, count(*) over ()::int as total
        from hits h join products p on p.id = h.pid
        order by p.name_i18n->>'en', p.id
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`);
      const ids = page.rows.map((r) => r.pid);
      const detail = ids.length
        ? await db.execute<{
            product_id: string; slug: string; name: string; status: string; category: string | null; image: string | null;
            variant_id: string; sku: string; size: string; color: string; on_hand: number | null; reserved: number | null;
            online_buffer: number | null; needs_count: boolean | null;
          }>(sql`
            select p.id as product_id, p.slug, p.name_i18n->>'en' as name, p.status, c.name_i18n->>'en' as category,
              (select i.path from product_images i where i.product_id = p.id order by i.sort, i.id limit 1) as image,
              v.id as variant_id, v.sku, v.size_label as size, pc.name as color,
              s.on_hand, s.reserved, s.online_buffer, s.needs_count
            from products p
            join variants v on v.product_id = p.id and v.status = 'active'
            join product_colors pc on pc.id = v.color_id
            left join categories c on c.id = p.category_id
            left join stock s on s.variant_id = v.id and s.branch_id = ${branch}
            where p.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
            order by pc.sort, v.size_sort`)
        : { rows: [] };
      const products = new Map<string, Record<string, unknown> & { variants: unknown[] }>();
      for (const id of ids) products.set(id, { id, variants: [] });
      for (const r of detail.rows) {
        const p = products.get(r.product_id)!;
        Object.assign(p, { slug: r.slug, name: r.name, status: r.status, category: r.category, imageUrl: assetUrl(ctx.config.assetBaseUrl, r.image) });
        const onHand = r.on_hand ?? 0;
        const reserved = r.reserved ?? 0;
        const online = Math.max(0, onHand - reserved - (r.online_buffer ?? buffer));
        p.variants.push({
          id: r.variant_id, sku: r.sku, size: r.size, color: r.color, branchId: branch,
          onHand, reserved, available: onHand - reserved, needsCount: r.needs_count ?? false,
          low: r.status === 'active' && online >= 1 && online <= 3,
        });
      }
      res.json({
        branchId: branch,
        view: query.view,
        page: query.page,
        pageSize: query.pageSize,
        total: page.rows[0]?.total ?? 0,
        counts: counts.rows[0] ?? { all: 0, low: 0, out: 0, count: 0 },
        products: [...products.values()],
      });
    },
  );

  router.get('/admin/stock', ...staff, validate({ query: z.object({ productId: uuid }) }), async (req, res) => {
    const { productId } = req.query as unknown as { productId: string };
    const rows = await db.execute<Record<string, unknown>>(sql`
      select v.id as "variantId", v.sku, v.size_label as size, s.branch_id as "branchId", s.on_hand as "onHand",
        s.reserved, s.online_buffer as "onlineBuffer", s.needs_count as "needsCount", s.updated_at as "updatedAt"
      from variants v join stock s on s.variant_id = v.id
      where v.product_id = ${productId} and (${scopedBranch(req.user!)}::text is null or s.branch_id = ${scopedBranch(req.user!)})
      order by v.size_sort, s.branch_id`);
    res.json({ stock: rows.rows });
  });

  router.get(
    '/admin/stock/movements',
    ...staff,
    validate({ query: z.object({ variantId: uuid, branchId: branchId.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
    async (req, res) => {
      const { variantId, branchId: requested, limit } = req.query as unknown as { variantId: string; branchId?: string; limit: number };
      // Staff tied to a branch only read their own branch's history.
      const scoped = scopedBranch(req.user!);
      if (scoped && requested && requested !== scoped) throw new AppError('forbidden', 403, 'You can only see stock at your own branch');
      const branch = scoped ?? requested;
      const rows = await db.execute<Record<string, unknown>>(sql`
        select m.id, m.branch_id as "branchId", m.delta_on_hand as "deltaOnHand", m.delta_reserved as "deltaReserved",
          m.reason, m.ref_id as "refId", m.note, m.actor_user_id as "actorUserId", m.created_at as "createdAt"
        from stock_movements m
        where m.variant_id = ${variantId} and (${branch ?? null}::text is null or m.branch_id = ${branch ?? null})
        order by m.id desc limit ${limit}`);
      res.json({ movements: rows.rows });
    },
  );

  router.post(
    '/admin/stock/sale',
    ...staff,
    validate({
      body: z.object({
        branchId: branchId.optional(),
        lines: z.array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(999) })).min(1).max(50),
        note: z.string().trim().max(200).optional(),
      }),
    }),
    async (req, res) => {
      const branch = branchFor(req.user!, req.body.branchId);
      await assertBranchExists(db, branch);
      const result = await recordSale(db, { branchId: branch, lines: req.body.lines, note: req.body.note, actorUserId: req.user!.id });
      ctx.logger.info({ saleId: result.saleId, branchId: branch, actorId: req.user!.id }, 'Counter sale recorded');
      res.json(result);
    },
  );

  router.post(
    '/admin/stock/adjust',
    ...staff,
    validate({
      body: z.object({
        variantId: uuid,
        branchId,
        delta: z.number().int().min(-9999).max(9999).refine((d) => d !== 0, 'Must not be zero'),
        note: z.string().trim().min(1).max(200),
      }),
    }),
    async (req, res) => {
      assertBranchAccess(req.user!, req.body.branchId);
      await assertBranchExists(db, req.body.branchId);
      const row = await adjustStock(db, { ...req.body, actorUserId: req.user!.id });
      res.json({ stock: row });
    },
  );

  router.post(
    '/admin/stock/count',
    ...staff,
    validate({
      body: z.object({
        variantId: uuid,
        branchId,
        count: z.number().int().min(0).max(99999),
        note: z.string().trim().max(200).optional(),
      }),
    }),
    async (req, res) => {
      assertBranchAccess(req.user!, req.body.branchId);
      await assertBranchExists(db, req.body.branchId);
      const { stock: row, delta } = await countStock(db, { ...req.body, actorUserId: req.user!.id });
      res.json({ stock: row, delta });
    },
  );

  router.post(
    '/admin/stock/restock',
    ...staff,
    validate({
      body: z.object({
        branchId,
        lines: z.array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(999) })).min(1).max(500),
        note: z.string().trim().max(200).optional(),
      }),
    }),
    async (req, res) => {
      assertBranchAccess(req.user!, req.body.branchId);
      await assertBranchExists(db, req.body.branchId);
      const result = await restockStock(db, { ...req.body, actorUserId: req.user!.id });
      ctx.logger.info({ refId: result.refId, branchId: req.body.branchId, sizes: result.sizes, actorId: req.user!.id }, 'Restock recorded');
      res.json(result);
    },
  );

  router.post(
    '/admin/stock/transfer',
    ...staff,
    validate({
      body: z
        .object({ variantId: uuid, from: branchId, to: branchId, qty: z.number().int().min(1).max(999) })
        .refine((v) => v.from !== v.to, { message: 'Choose two different branches', path: ['to'] }),
    }),
    async (req, res) => {
      assertBranchAccess(req.user!, req.body.from);
      await assertBranchExists(db, req.body.from, 'from');
      await assertBranchExists(db, req.body.to, 'to');
      res.json(await transferStock(db, { ...req.body, actorUserId: req.user!.id }));
    },
  );

  return router;
}
