import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { escapeLike } from '../catalog/listing.js';
import { adjustStock, recordSale, transferStock } from '../stock/service.js';
import { assertBranchAccess, assertBranchExists, branchFor } from './branchAccess.js';

const uuid = z.string().uuid();
const branchId = z.string().trim().min(1).max(40);

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

  router.get('/admin/stock', ...staff, validate({ query: z.object({ productId: uuid }) }), async (req, res) => {
    const { productId } = req.query as unknown as { productId: string };
    const rows = await db.execute<Record<string, unknown>>(sql`
      select v.id as "variantId", v.sku, v.size_label as size, s.branch_id as "branchId", s.on_hand as "onHand",
        s.reserved, s.online_buffer as "onlineBuffer", s.needs_count as "needsCount", s.updated_at as "updatedAt"
      from variants v join stock s on s.variant_id = v.id
      where v.product_id = ${productId} order by v.size_sort, s.branch_id`);
    res.json({ stock: rows.rows });
  });

  router.get(
    '/admin/stock/movements',
    ...staff,
    validate({ query: z.object({ variantId: uuid, branchId: branchId.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
    async (req, res) => {
      const { variantId, branchId: branch, limit } = req.query as unknown as { variantId: string; branchId?: string; limit: number };
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
