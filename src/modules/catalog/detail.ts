import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { availabilityOf, type Availability } from './availability.js';
import { pick, type Lang } from './i18n.js';
import { aggregatesCte, cardColumns, type ListedRow } from './listing.js';
import { assetUrl, toCard, type ProductCard } from './view.js';

export interface VariantView {
  id: string;
  size: string;
  color: string;
  sku: string;
  priceCents: number;
  compareAtCents: number | null;
  availability: Availability;
  lowStockCount: number | null;
  byBranch: Record<string, Availability>;
}

export interface ProductDetail extends ProductCard {
  shortName: string | null;
  description: string | null;
  highlights: string[];
  specs: Record<string, string>;
  attributes: Record<string, unknown>;
  isCustomizable: boolean;
  heroTagline: string | null;
  images: { url: string; alt: string | null; colorName: string | null }[];
  variants: VariantView[];
  related: ProductCard[];
  /** The size chart for this product's category, or null. Content lives in the `size_guides` setting. */
  sizeGuide: SizeGuideView | null;
}

export interface SizeGuideView {
  title: string;
  columns: string[];
  rows: string[][];
  note: string | null;
}

interface SizeGuideSetting {
  title: { en: string; km?: string };
  columns: string[];
  rows: string[][];
  note?: { en: string; km?: string } | null;
}

interface DetailRow extends ListedRow {
  short_name_i18n: { en: string; km?: string } | null;
  description_i18n: { en: string; km?: string } | null;
  highlights: string[];
  specs: Record<string, string>;
  attributes: Record<string, unknown>;
  is_customizable: boolean;
  hero_tagline: string | null;
  league: string | null;
}

const perBranch = (units: number): Availability => availabilityOf(units).availability;

async function sizeGuideFor(db: Db, category: string, lang: Lang): Promise<SizeGuideView | null> {
  const r = await db.execute<{ guide: SizeGuideSetting | null }>(sql`select value->${category} as guide from settings where key = 'size_guides'`);
  const g = r.rows[0]?.guide;
  if (!g || !Array.isArray(g.columns) || !Array.isArray(g.rows)) return null;
  return { title: pick(g.title, lang) ?? '', columns: g.columns.map(String), rows: g.rows.map((row) => row.map(String)), note: g.note ? pick(g.note, lang) : null };
}

export async function productDetail(db: Db, slug: string, lang: Lang, assetBase: string, buffer: number): Promise<ProductDetail> {
  const cte = aggregatesCte(buffer);
  const found = await db.execute<DetailRow>(sql`
    with ${cte}
    select ${cardColumns}, base.short_name_i18n, base.description_i18n, base.highlights, base.specs,
      base.attributes, base.is_customizable, base.hero_tagline, base.attributes->>'league' as league
    from base where base.slug = ${slug}`);
  const row = found.rows[0];
  if (!row) throw new AppError('not_found', 404, 'Product not found');

  const [variantRows, imageRows, branchRows, related] = await Promise.all([
    db.execute<{ id: string; size_label: string; color: string; sku: string; price_cents: number; compare_at_cents: number | null; branch_id: string | null; units: number | null }>(sql`
      select v.id, v.size_label, pc.name as color, v.sku, v.price_cents, v.compare_at_cents, v.size_sort, s.branch_id,
        greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))::int as units
      from variants v
      join product_colors pc on pc.id = v.color_id
      left join stock s on s.variant_id = v.id
      where v.product_id = ${row.id} and v.status = 'active'
      order by v.size_sort, pc.sort, v.id`),
    db.execute<{ path: string; alt: string | null; color: string | null }>(sql`
      select pi.path, pi.alt, pc.name as color from product_images pi
      left join product_colors pc on pc.id = pi.color_id
      where pi.product_id = ${row.id} order by pi.sort, pi.id`),
    db.execute<{ id: string }>(sql`select id from branches order by sort`),
    db.execute<ListedRow>(sql`
      with ${cte}
      select ${cardColumns} from base
      where base.category_slug = ${row.category_slug} and base.id <> ${row.id}
      order by (base.brand_slug = ${row.brand_slug}) desc,
        (base.attributes->>'league' is not distinct from ${row.league}) desc,
        coalesce((base.flags->>'bestSeller')::boolean, false) desc, base.slug
      limit 8`),
  ]);

  const variants = new Map<string, VariantView & { total: number }>();
  for (const v of variantRows.rows) {
    let view = variants.get(v.id);
    if (!view) {
      view = {
        id: v.id,
        size: v.size_label,
        color: v.color,
        sku: v.sku,
        priceCents: v.price_cents,
        compareAtCents: v.compare_at_cents,
        availability: 'out',
        lowStockCount: null,
        byBranch: Object.fromEntries(branchRows.rows.map((b) => [b.id, 'out' as Availability])),
        total: 0,
      };
      variants.set(v.id, view);
    }
    if (v.branch_id) {
      view.byBranch[v.branch_id] = perBranch(v.units ?? 0);
      view.total += v.units ?? 0;
    }
  }

  return {
    ...toCard(row, lang, assetBase),
    shortName: pick(row.short_name_i18n, lang),
    description: pick(row.description_i18n, lang),
    highlights: row.highlights,
    specs: row.specs,
    attributes: row.attributes,
    isCustomizable: row.is_customizable,
    heroTagline: row.hero_tagline,
    images: imageRows.rows.map((i) => ({ url: assetUrl(assetBase, i.path)!, alt: i.alt, colorName: i.color })),
    variants: [...variants.values()].map(({ total, ...v }) => ({ ...v, ...availabilityOf(total) })),
    related: related.rows.map((r) => toCard(r, lang, assetBase)),
    sizeGuide: await sizeGuideFor(db, row.category_slug, lang),
  };
}
