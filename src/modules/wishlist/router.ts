import { and, count, eq, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db } from '../../db/client.js';
import { products, variants, wishlistItems } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { aggregatesCte, cardColumns, safetyBuffer, type ListedRow } from '../catalog/listing.js';
import { toCard } from '../catalog/view.js';

export const WISHLIST_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a product id or slug (the storefront works with slugs); only active products. */
async function activeProductId(db: Db, idOrSlug: string): Promise<string> {
  const match = UUID.test(idOrSlug) ? or(eq(products.id, idOrSlug), eq(products.slug, idOrSlug)) : eq(products.slug, idOrSlug);
  const [row] = await db.select({ id: products.id }).from(products).where(and(match, eq(products.status, 'active')));
  if (!row) throw new AppError('not_found', 404, 'Product not found');
  return row.id;
}

/**
 * Adds a product, never letting the list pass `max`: a per-user transaction lock makes the count and the
 * insert one step. Products with nothing on sale (no active sizes) can't be added.
 */
export async function addToWishlist(db: Db, userId: string, productId: string, max = WISHLIST_MAX): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('wishlist:' || ${userId}))`);
    const [sellable] = await tx.select({ id: variants.id }).from(variants).where(and(eq(variants.productId, productId), eq(variants.status, 'active'))).limit(1);
    if (!sellable) throw new AppError('not_found', 404, 'Product not found');
    const [existing] = await tx
      .select({ p: wishlistItems.productId })
      .from(wishlistItems)
      .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)));
    if (existing) return;
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(wishlistItems).where(eq(wishlistItems.userId, userId));
    if (n >= max) throw new AppError('wishlist_full', 409, `Your wishlist can hold up to ${max} items`);
    await tx.insert(wishlistItems).values({ userId, productId }).onConflictDoNothing();
  });
}

export function wishlistRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  router.use('/me/wishlist', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/me/wishlist', ...ctx.member, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    const { lang } = req.query as unknown as { lang: Lang };
    const buffer = await safetyBuffer(db);
    // `base` only contains active products, so archived/draft items drop out automatically.
    const rows = await db.execute<ListedRow>(sql`
      with ${aggregatesCte(buffer)}
      select ${cardColumns} from base
      join wishlist_items w on w.product_id = base.id and w.user_id = ${req.user!.id}
      order by w.created_at desc, base.slug`);
    res.json({ products: rows.rows.map((r) => toCard(r, lang, ctx.config.assetBaseUrl)) });
  });

  router.put('/me/wishlist/:product', ...ctx.member, async (req, res) => {
    await addToWishlist(db, req.user!.id, await activeProductId(db, String(req.params.product)));
    res.status(204).end();
  });

  router.delete('/me/wishlist/:product', ...ctx.member, async (req, res) => {
    const param = String(req.params.product);
    const match = UUID.test(param)
      ? eq(wishlistItems.productId, param)
      : sql`${wishlistItems.productId} in (select id from products where slug = ${param})`;
    await db.delete(wishlistItems).where(and(eq(wishlistItems.userId, req.user!.id), match));
    res.status(204).end();
  });

  return router;
}
