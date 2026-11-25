import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { pick, type Lang } from './i18n.js';
import { aggregatesCte, DISCOUNT_BANDS, filterConditions, type CatalogFilters, type FilterKey } from './listing.js';

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  selected: boolean;
}

export interface Facet {
  key: string;
  label: string;
  type: 'checkbox' | 'radio' | 'range';
  options?: FacetOption[];
  range?: {
    min: number;
    max: number;
    selectedMin: number | null;
    selectedMax: number | null;
    buckets: { label: string; min: number; max: number | null; count: number }[];
  };
}

/** Price buckets in cents. */
const PRICE_BUCKETS: { min: number; max: number | null }[] = [
  { min: 0, max: 2500 },
  { min: 2500, max: 5000 },
  { min: 5000, max: 10000 },
  { min: 10000, max: 20000 },
  { min: 20000, max: null },
];

const usd = (cents: number) => `$${(cents / 100).toFixed(0)}`;

/**
 * Facets for the current filters. Each facet's counts apply every active filter except its own,
 * so customers can always see (and switch to) the alternatives — even when nothing matches.
 */
export async function buildFacets(db: Db, f: CatalogFilters, lang: Lang, buffer: number): Promise<{ total: number; facets: Facet[] }> {
  const cte = aggregatesCte(buffer);
  const where = (exclude?: FilterKey) => filterConditions(f, exclude);

  const grouped = async (exclude: FilterKey, valueSql: ReturnType<typeof sql>, labelSql: ReturnType<typeof sql>, orderSql: ReturnType<typeof sql>) =>
    (
      await db.execute<{ value: string; label: string; count: number }>(sql`
        with ${cte}
        select ${valueSql} as value, ${labelSql} as label, count(*)::int as count
        from base where ${where(exclude)} and ${valueSql} is not null
        group by 1, 2 order by ${orderSql}`)
    ).rows;

  const attribute = (key: 'league' | 'surface' | 'kitType') =>
    grouped(key, sql`base.attributes->>${key}`, sql`base.attributes->>${key}`, sql`2`);

  const [total, categories, brands, sizes, leagues, surfaces, kitTypes, prices, discounts, inStock] = await Promise.all([
    db.execute<{ n: number }>(sql`with ${cte} select count(*)::int as n from base where ${where()}`),
    db.execute<{ value: string; name: { en: string; km?: string }; count: number }>(sql`
      with ${cte}
      select c.slug as value, c.name_i18n as name, count(base.id)::int as count
      from categories c left join base on base.category_slug = c.slug and ${where('category')}
      group by c.slug, c.name_i18n, c.sort order by c.sort`),
    grouped('brand', sql`base.brand_slug`, sql`base.brand_name`, sql`2`),
    db.execute<{ value: string; count: number }>(sql`
      with ${cte}
      select v.size_label as value, count(distinct base.id)::int as count, min(v.size_sort) as s
      from base join variants v on v.product_id = base.id and v.status = 'active'
      where ${where('size')}
      group by v.size_label order by s, v.size_label`),
    attribute('league'),
    attribute('surface'),
    attribute('kitType'),
    db.execute<{ price: number }>(sql`with ${cte} select base.price from base where ${where('priceMin')} and ${filterConditions({ ...f, priceMin: undefined }, 'priceMax')}`),
    db.execute<{ d: number }>(sql`with ${cte} select coalesce(base.discount_pct, 0) as d from base where ${where('discount')}`),
    db.execute<{ n: number }>(sql`with ${cte} select count(*)::int as n from base where ${where('inStockOnly')} and base.units > 0`),
  ]);

  const checkbox = (key: string, label: string, rows: { value: string; label: string; count: number }[], selected: string[] = []): Facet => ({
    key,
    label,
    type: 'checkbox',
    options: mergeSelected(
      rows.map((r) => ({ value: r.value, label: r.label, count: r.count, selected: selected.includes(r.value) })),
      selected,
    ),
  });

  const priceList = prices.rows.map((r) => r.price);
  const all: Facet[] = [
    {
      key: 'category',
      label: 'Category',
      type: 'radio',
      options: categories.rows
        .filter((r) => r.count > 0 || r.value === f.category)
        .map((r) => ({ value: r.value, label: pick(r.name, lang) ?? r.value, count: r.count, selected: r.value === f.category })),
    },
    checkbox('brand', 'Brand', brands, f.brand),
    checkbox('size', 'Size', sizes.rows.map((r) => ({ value: r.value, label: r.value, count: r.count })), f.size),
    checkbox('league', 'League', leagues, f.league),
    checkbox('surface', 'Surface', surfaces, f.surface),
    checkbox('kitType', 'Kit', kitTypes, f.kitType),
    {
      key: 'price',
      label: 'Price',
      type: 'range',
      range: {
        min: priceList.length ? Math.min(...priceList) : 0,
        max: priceList.length ? Math.max(...priceList) : 0,
        selectedMin: f.priceMin ?? null,
        selectedMax: f.priceMax ?? null,
        buckets: PRICE_BUCKETS.map((b) => ({
          label: b.max === null ? `${usd(b.min)}+` : `${usd(b.min)}–${usd(b.max)}`,
          min: b.min,
          max: b.max,
          count: priceList.filter((p) => p >= b.min && (b.max === null || p < b.max)).length,
        })),
      },
    },
    {
      key: 'discount',
      label: 'Discount',
      type: 'radio',
      options: Object.entries(DISCOUNT_BANDS).map(([value, pct]) => ({
        value,
        label: `${pct}% off or more`,
        count: discounts.rows.filter((r) => r.d >= pct).length,
        selected: f.discount === value,
      })),
    },
    {
      key: 'inStockOnly',
      label: 'Availability',
      type: 'checkbox',
      options: [{ value: 'true', label: 'In stock', count: inStock.rows[0]?.n ?? 0, selected: f.inStockOnly === true }],
    },
  ];
  const facets = all.filter((facet) => facet.type !== 'checkbox' || (facet.options?.length ?? 0) > 0);

  return { total: total.rows[0]?.n ?? 0, facets };
}

/** Keeps selected values visible even when the other filters leave them with no matches. */
function mergeSelected(options: FacetOption[], selected: string[]): FacetOption[] {
  const present = new Set(options.map((o) => o.value));
  return [...options, ...selected.filter((s) => !present.has(s)).map((s) => ({ value: s, label: s, count: 0, selected: true }))];
}
