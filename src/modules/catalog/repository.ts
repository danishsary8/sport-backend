import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { productStock, products } from '../../db/schema.js';
import type { CursorValue } from '../../lib/pagination.js';
import type { ProductListQuery } from './schemas.js';

export type ProductRow = typeof products.$inferSelect;

const SORT_COLUMNS = {
  featured: { column: products.featuredRank, dir: 'asc' },
  newest: { column: products.releasedAt, dir: 'desc' },
  'price-asc': { column: products.priceCents, dir: 'asc' },
  'price-desc': { column: products.priceCents, dir: 'desc' },
  rating: { column: products.rating, dir: 'desc' },
} as const;

export function sortKey(row: ProductRow, sort: ProductListQuery['sort']): CursorValue {
  const value = {
    featured: row.featuredRank,
    newest: row.releasedAt,
    'price-asc': row.priceCents,
    'price-desc': row.priceCents,
    rating: row.rating,
  }[sort];
  return value;
}

/** Keyset pagination: rows after (sort value, slug), slug always ascending as tie-breaker. */
export async function listProducts(
  db: Db,
  query: ProductListQuery,
  after: CursorValue[] | null,
): Promise<ProductRow[]> {
  const { column, dir } = SORT_COLUMNS[query.sort];
  const where: SQL[] = [eq(products.isActive, true)];
  if (query.category) where.push(inArray(products.category, query.category as ProductRow['category'][]));
  if (query.league) where.push(inArray(products.leagueSlug, query.league));
  if (query.team) where.push(inArray(products.teamSlug, query.team));
  if (query.season) where.push(inArray(products.seasonSlug, query.season));
  if (query.kit) where.push(inArray(products.kitType, query.kit as NonNullable<ProductRow['kitType']>[]));
  if (query.brand) where.push(inArray(products.brandSlug, query.brand));
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(products.name, pattern), ilike(products.team, pattern), ilike(products.brand, pattern))!);
  }
  if (after) {
    const [value, slug] = after as [CursorValue, string];
    const beyond = dir === 'asc' ? gt(column, value as never) : lt(column, value as never);
    where.push(or(beyond, and(eq(column, value as never), gt(products.slug, slug)))!);
  }
  return db
    .select()
    .from(products)
    .where(and(...where))
    .orderBy(dir === 'asc' ? asc(column) : desc(column), asc(products.slug))
    .limit(query.limit + 1);
}

export async function findProductBySlug(db: Db, slug: string): Promise<ProductRow | undefined> {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.isActive, true)))
    .limit(1);
  return row;
}

export async function stockBySize(db: Db, productId: string): Promise<{ size: string; quantity: number }[]> {
  return db
    .select({ size: productStock.size, quantity: sql<number>`sum(${productStock.quantity})::int` })
    .from(productStock)
    .where(eq(productStock.productId, productId))
    .groupBy(productStock.size);
}
