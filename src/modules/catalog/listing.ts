import { sql, type SQL } from 'drizzle-orm';
import { continentSql, seasonSql } from './derived.js';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { langSchema } from './i18n.js';
import { searchNeedle } from './searchText.js';

/** A query param that may repeat (?brand=a&brand=b) → string[]. */
const many = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().max(80)).max(30))
  .optional();

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

/** A cleared form field arrives as '' — treat it as not set. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const cents = z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(10_000_000).optional());
const optionalText = z.preprocess(blankToUndefined, z.string().trim().max(80).optional());

export const TAGS = ['new', 'best_seller', 'limited', 'signature', 'retro', 'ucl', 'sale'] as const;
const manyTags = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(TAGS)).max(TAGS.length))
  .optional();

export const SORTS = ['popular', 'best_selling', 'new', 'price_asc', 'price_desc', 'discount'] as const;
/** discount=1|2|3 → at least 10%, 30%, 50% off. */
export const DISCOUNT_BANDS: Record<string, number> = { '1': 10, '2': 30, '3': 50 };

export const catalogFilterShape = {
  category: optionalText,
  collection: optionalText,
  brand: many,
  size: many,
  color: many,
  league: many,
  surface: many,
  kitType: many,
  garmentType: many,
  /** "2026/27"-style seasons (repeatable, OR). */
  season: many,
  /** National-team continent: europe | south-america | north-america | africa | asia | oceania (repeatable, OR). */
  continent: many,
  /** new | best_seller | limited | signature | retro | ucl | sale (repeatable, OR). */
  tag: manyTags,
  priceMin: cents,
  priceMax: cents,
  discount: z.enum(['1', '2', '3']).optional(),
  inStockOnly: bool,
  q: z.string().trim().max(100).optional(),
};

export const catalogQuerySchema = z
  .object({
    ...catalogFilterShape,
    sort: z.enum(SORTS).default('popular'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(48).default(24),
    lang: langSchema,
  })
  .refine((v) => v.priceMin === undefined || v.priceMax === undefined || v.priceMin <= v.priceMax, {
    message: 'priceMin must not exceed priceMax',
    path: ['priceMin'],
  });

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type CatalogFilters = Omit<CatalogQuery, 'sort' | 'page' | 'pageSize' | 'lang' | 'collection'>;
export type FilterKey = keyof CatalogFilters;


/** Merges a collection's saved rule under the explicit params (explicit params win). */
export async function resolveFilters(db: Db, query: CatalogQuery): Promise<CatalogFilters> {
  const { collection, sort: _s, page: _p, pageSize: _ps, lang: _l, ...explicit } = query;
  if (!collection) return explicit;
  const result = await db.execute<{ rule: unknown }>(
    sql`select rule from collections where slug = ${collection} and active`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 404, 'Collection not found');
  // A saved rule with a bad field (e.g. a typo in the admin) shouldn't break the page: skip that field.
  const merged: Record<string, unknown> = {};
  const shape = catalogFilterShape as Record<string, z.ZodType>;
  for (const [key, value] of Object.entries((row.rule as Record<string, unknown>) ?? {})) {
    const parsed = shape[key]?.safeParse(value);
    if (parsed?.success && parsed.data !== undefined) merged[key] = parsed.data;
  }
  for (const [k, v] of Object.entries(explicit)) if (v !== undefined) merged[k] = v;
  return merged as CatalogFilters;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Current global online safety buffer (units held back per variant per branch). */
export async function safetyBuffer(db: Db | import('../../db/exec.js').Tx): Promise<number> {
  const r = await db.execute<{ units: number | null }>(
    sql`select (value->>'units')::int as units from settings where key = 'online_safety_buffer'`,
  );
  return r.rows[0]?.units ?? 1;
}

/**
 * Per active product: cheapest active variant price (+ its compare-at), online units, sizes.
 * Exposed as relation `pa` (product aggregates), joined to products p, brands b, categories c.
 */
export function aggregatesCte(buffer: number): SQL {
  return sql`
    vo as (
      select v.id as variant_id, v.product_id, v.size_label, v.size_sort, v.price_cents, v.compare_at_cents,
        coalesce(sum(greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))), 0)::int as units
      from variants v
      left join stock s on s.variant_id = v.id
      where v.status = 'active'
      group by v.id
    ),
    pa as (
      select product_id,
        min(price_cents)::int as price,
        (array_agg(compare_at_cents order by price_cents, size_sort))[1] as compare_at,
        sum(units)::int as units,
        array_agg(distinct size_label) as sizes
      from vo group by product_id
    ),
    base as (
      select p.*, b.slug as brand_slug, b.name as brand_name, c.slug as category_slug, c.name_i18n as category_name,
        pa.price, pa.compare_at, pa.units, pa.sizes, ${seasonSql} as season, ${continentSql} as continent,
        case when pa.compare_at is not null and pa.compare_at > pa.price
          then round((pa.compare_at - pa.price) * 100.0 / pa.compare_at)::int end as discount_pct
      from products p
      join brands b on b.id = p.brand_id
      join categories c on c.id = p.category_id
      join pa on pa.product_id = p.id
      where p.status = 'active'
    )`;
}

/** WHERE conditions over `base` for the given filters, optionally ignoring one (for its facet). */
export function filterConditions(f: CatalogFilters, exclude?: FilterKey): SQL {
  const parts: SQL[] = [sql`true`];
  const use = (key: FilterKey) => key !== exclude && f[key] !== undefined;

  if (use('category')) parts.push(sql`base.category_slug = ${f.category}`);
  if (use('brand') && f.brand!.length) parts.push(sql`base.brand_slug in ${f.brand}`);
  if (use('size') && f.size!.length) {
    parts.push(sql`exists (select 1 from variants v where v.product_id = base.id and v.status = 'active' and v.size_label in ${f.size})`);
  }
  if (use('color') && f.color!.length) {
    const lowered = f.color!.map((c) => c.toLowerCase());
    parts.push(sql`exists (select 1 from product_colors pc where pc.product_id = base.id and lower(pc.name) in ${lowered})`);
  }
  if (use('tag') && f.tag!.length) {
    const tagSql: Record<string, SQL> = {
      new: sql`(base.flags->>'newArrival')::boolean`,
      best_seller: sql`(base.flags->>'bestSeller')::boolean`,
      limited: sql`(base.flags->>'limitedEdition')::boolean`,
      signature: sql`(base.flags->>'signatureEdition')::boolean`,
      retro: sql`(base.attributes->>'isRetro')::boolean`,
      ucl: sql`(base.attributes->>'isChampionsLeague')::boolean`,
      sale: sql`base.discount_pct > 0`,
    };
    const known = f.tag!.map((t) => tagSql[t]).filter((x): x is SQL => x !== undefined);
    parts.push(known.length ? sql`(${sql.join(known.map((k) => sql`coalesce(${k}, false)`), sql` or `)})` : sql`false`);
  }
  for (const key of ['league', 'surface', 'kitType', 'garmentType'] as const) {
    if (use(key) && f[key]!.length) parts.push(sql`base.attributes->>${key} in ${f[key]}`);
  }
  if (use('season') && f.season!.length) parts.push(sql`base.season in ${f.season}`);
  if (use('continent') && f.continent!.length) parts.push(sql`base.continent in ${f.continent}`);
  if (use('priceMin')) parts.push(sql`base.price >= ${f.priceMin}`);
  if (use('priceMax')) parts.push(sql`base.price <= ${f.priceMax}`);
  if (use('discount')) parts.push(sql`coalesce(base.discount_pct, 0) >= ${DISCOUNT_BANDS[f.discount!]}`);
  if (use('inStockOnly') && f.inStockOnly) parts.push(sql`base.units > 0`);
  if (f.q && exclude !== 'q') {
    const needle = searchNeedle(f.q);
    const pattern = `%${escapeLike(needle)}%`;
    parts.push(sql`(base.search_text like ${pattern} or word_similarity(${needle}, base.search_text) >= 0.5)`);
  }
  return sql.join(parts, sql` and `);
}

/**
 * Units of a product sold in the last 90 days (paid, uncancelled online orders plus counter sales), plus its
 * starting sales from `sales_baseline`.
 */
export function unitsSold(productId: SQL): SQL {
  return sql`(
    coalesce((select sb.units from sales_baseline sb where sb.product_id = ${productId}), 0)
    +
    coalesce((select sum(i.qty) from order_items i
      join variants v on v.id = i.variant_id
      join orders o on o.id = i.order_id
      where v.product_id = ${productId} and o.payment_status = 'paid' and o.status not in ('cancelled', 'expired')
        and o.paid_at > now() - interval '90 days'), 0)
    + coalesce((select -sum(m.delta_on_hand) from stock_movements m
      join variants v on v.id = m.variant_id
      where v.product_id = ${productId} and m.reason = 'store_sale' and m.created_at > now() - interval '90 days'), 0)
  )`;
}

export function orderBy(sort: CatalogQuery['sort'], q: string | undefined): SQL {
  const relevance = q ? sql`word_similarity(${searchNeedle(q)}, base.search_text) desc, ` : sql``;
  switch (sort) {
    case 'new':
      // Newest first: the products most recently added to the shop.
      return sql`base.created_at desc, base.slug`;
    case 'best_selling':
      // Units actually sold in the last 90 days (paid online orders that were not cancelled, plus counter
      // sales). Until a product has sales, the hand-picked "best seller" flag and then "featured" order it.
      return sql`${unitsSold(sql`base.id`)} desc, coalesce((base.flags->>'bestSeller')::boolean, false) desc,
        coalesce((base.flags->>'featured')::boolean, false) desc, base.created_at desc, base.slug`;
    case 'price_asc':
      return sql`base.price asc, base.slug`;
    case 'price_desc':
      return sql`base.price desc, base.slug`;
    case 'discount':
      return sql`base.discount_pct desc nulls last, base.slug`;
    default:
      return sql`${relevance}coalesce((base.flags->>'bestSeller')::boolean, false) desc, coalesce((base.flags->>'featured')::boolean, false) desc, base.created_at desc, base.slug`;
  }
}

export interface ListedRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name_i18n: { en: string; km?: string };
  flags: Record<string, boolean>;
  brand_slug: string;
  brand_name: string;
  category_slug: string;
  price: number;
  compare_at: number | null;
  discount_pct: number | null;
  units: number;
  sizes: string[];
  colors: { name: string; swatchHex: string | null }[] | null;
  images: string[] | null;
}

/** Columns a ProductCard needs, selected from `base`. */
export const cardColumns = sql`
  base.id, base.slug, base.name_i18n, base.flags, base.brand_slug, base.brand_name, base.category_slug,
  base.price, base.compare_at, base.discount_pct, base.units,
  (select array_agg(sz.size_label order by sz.s, sz.size_label) from (select v.size_label, min(v.size_sort) as s from variants v where v.product_id = base.id and v.status = 'active' group by v.size_label) sz) as sizes,
  (select json_agg(json_build_object('name', pc.name, 'swatchHex', pc.swatch_hex) order by pc.sort, pc.name) from product_colors pc where pc.product_id = base.id) as colors,
  (select array_agg(pi.path order by pi.sort, pi.id) from product_images pi where pi.product_id = base.id) as images`;

export async function listProducts(
  db: Db,
  filters: CatalogFilters,
  opts: { sort: CatalogQuery['sort']; page: number; pageSize: number; buffer: number },
): Promise<{ rows: ListedRow[]; total: number }> {
  const where = filterConditions(filters);
  const cte = aggregatesCte(opts.buffer);
  const [rows, count] = await Promise.all([
    db.execute<ListedRow>(sql`
      with ${cte}
      select ${cardColumns} from base
      where ${where}
      order by ${orderBy(opts.sort, filters.q)}
      limit ${opts.pageSize} offset ${(opts.page - 1) * opts.pageSize}`),
    db.execute<{ n: number }>(sql`with ${cte} select count(*)::int as n from base where ${where}`),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.n ?? 0 };
}
