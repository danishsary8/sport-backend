import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { pick, type Lang } from './i18n.js';
import { aggregatesCte, catalogQuerySchema, escapeLike, listProducts, resolveFilters } from './listing.js';
import { assetUrl, toCard } from './view.js';

type I18nValue = { en: string; km?: string };

export async function suggest(db: Db, q: string, lang: Lang, assetBase: string, buffer: number) {
  const needle = q.toLowerCase();
  const pattern = `%${escapeLike(needle)}%`;
  const cte = aggregatesCte(buffer);
  const [products, brands, categories] = await Promise.all([
    db.execute<{ slug: string; name_i18n: I18nValue; path: string | null; price: number }>(sql`
      with ${cte}
      select base.slug, base.name_i18n, base.price,
        (select pi.path from product_images pi where pi.product_id = base.id order by pi.sort, pi.id limit 1) as path
      from base
      where base.search_text like ${pattern} or word_similarity(${needle}, base.search_text) >= 0.5
      order by (base.search_text like ${pattern}) desc, word_similarity(${needle}, base.search_text) desc,
        coalesce((base.flags->>'bestSeller')::boolean, false) desc, base.slug
      limit 6`),
    db.execute<{ slug: string; name: string }>(sql`
      select b.slug, b.name from brands b
      where (lower(b.name) like ${pattern} or similarity(lower(b.name), ${needle}) >= 0.4)
        and exists (select 1 from products p where p.brand_id = b.id and p.status = 'active')
      order by similarity(lower(b.name), ${needle}) desc, b.name limit 4`),
    db.execute<{ slug: string; name_i18n: I18nValue }>(sql`
      select c.slug, c.name_i18n from categories c
      where lower(c.name_i18n->>'en') like ${pattern} or c.slug like ${pattern}
      order by c.sort limit 3`),
  ]);
  return {
    products: products.rows.map((p) => ({
      slug: p.slug,
      name: pick(p.name_i18n, lang),
      imageUrl: assetUrl(assetBase, p.path),
      priceCents: p.price,
    })),
    brands: brands.rows,
    categories: categories.rows.map((c) => ({ slug: c.slug, name: pick(c.name_i18n, lang) })),
  };
}

export async function menu(db: Db, lang: Lang, buffer: number) {
  const cte = aggregatesCte(buffer);
  const [categories, brands, collections] = await Promise.all([
    db.execute<{ slug: string; name_i18n: I18nValue; n: number }>(sql`
      with ${cte}
      select c.slug, c.name_i18n, count(base.id)::int as n from categories c
      left join base on base.category_slug = c.slug group by c.slug, c.name_i18n, c.sort order by c.sort`),
    db.execute<{ slug: string; name: string; n: number }>(sql`
      with ${cte}
      select base.brand_slug as slug, base.brand_name as name, count(*)::int as n from base
      group by 1, 2 order by 2`),
    db.execute<{ slug: string; name_i18n: I18nValue }>(sql`select slug, name_i18n from collections where active order by sort, slug`),
  ]);
  return {
    categories: categories.rows.map((c) => ({ slug: c.slug, name: pick(c.name_i18n, lang), productCount: c.n })),
    brands: brands.rows.map((b) => ({ slug: b.slug, name: b.name, productCount: b.n })),
    collections: collections.rows.map((c) => ({ slug: c.slug, name: pick(c.name_i18n, lang) })),
  };
}

export async function collectionInfo(db: Db, slug: string, lang: Lang) {
  const r = await db.execute<{ slug: string; name_i18n: I18nValue; description_i18n: I18nValue | null }>(
    sql`select slug, name_i18n, description_i18n from collections where slug = ${slug} and active`,
  );
  const c = r.rows[0];
  if (!c) throw new AppError('not_found', 404, 'Collection not found');
  return { slug: c.slug, name: pick(c.name_i18n, lang), description: pick(c.description_i18n, lang) };
}

/** Active home sections in their time window; product rails get their products resolved. */
export async function home(db: Db, lang: Lang, assetBase: string, buffer: number) {
  const sections = await db.execute<{ id: string; type: string; payload: Record<string, unknown> }>(sql`
    select id, type, payload from home_sections
    where active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
    order by sort, id`);
  return Promise.all(
    sections.rows.map(async (s) => {
      const payload: Record<string, unknown> = { ...s.payload };
      for (const key of ['title', 'subtitle'] as const) {
        if (payload[key] && typeof payload[key] === 'object') payload[key] = pick(payload[key] as I18nValue, lang);
      }
      if (s.type === 'product_rail') {
        const parsed = catalogQuerySchema.safeParse({ ...(payload.query as object), page: '1', pageSize: '12', lang });
        payload.products = [];
        if (parsed.success) {
          try {
            const filters = await resolveFilters(db, parsed.data);
            const { rows } = await listProducts(db, filters, { ...parsed.data, buffer });
            payload.products = rows.map((r) => toCard(r, lang, assetBase));
          } catch (error) {
            // A rail pointing at a retired collection must not take the whole home page down.
            if (!(error instanceof AppError)) throw error;
          }
        }
      }
      return { id: s.id, type: s.type, payload };
    }),
  );
}
