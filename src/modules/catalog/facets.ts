import { sql } from 'drizzle-orm';
import { bySeasonDesc, CONTINENTS, seasonLabel } from './derived.js';
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

interface FacetRow extends Record<string, unknown> {
  id: string;
  category_slug: string;
  brand_slug: string;
  brand_name: string;
  attributes: Record<string, unknown> | null;
  flags: Record<string, unknown> | null;
  price: number;
  d: number;
  season: string | null;
  continent: string | null;
  units: number;
  q_ok: boolean;
  sizes: { label: string; sort: number }[] | null;
  colors: string[] | null;
}

const truthy = (v: unknown) => v === true || v === 'true';
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Same tags as the listing filter. */
export const TAG_LABELS: Record<string, string> = {
  new: 'New in',
  best_seller: 'Best sellers',
  limited: 'Limited edition',
  signature: 'Signature edition',
  retro: 'Retro',
  ucl: 'Champions League',
  sale: 'On sale',
};

function tagsOf(r: FacetRow): string[] {
  const f = r.flags ?? {};
  const a = r.attributes ?? {};
  const on: Record<string, boolean> = {
    new: truthy(f.newArrival),
    best_seller: truthy(f.bestSeller),
    limited: truthy(f.limitedEdition),
    signature: truthy(f.signatureEdition),
    retro: truthy(a.isRetro),
    ucl: truthy(a.isChampionsLeague),
    sale: r.d > 0,
  };
  return Object.keys(TAG_LABELS).filter((t) => on[t]);
}

/** The listing filter (filterConditions) applied in memory, optionally ignoring one filter. */
function matches(r: FacetRow, f: CatalogFilters, exclude?: FilterKey): boolean {
  const use = (key: FilterKey) => key !== exclude && f[key] !== undefined;
  if (use('category') && r.category_slug !== f.category) return false;
  if (use('brand') && f.brand!.length && !f.brand!.includes(r.brand_slug)) return false;
  if (use('size') && f.size!.length && !(r.sizes ?? []).some((s) => f.size!.includes(s.label))) return false;
  if (use('color') && f.color!.length) {
    const wanted = f.color!.map((c) => c.toLowerCase());
    if (!(r.colors ?? []).some((c) => wanted.includes(c.toLowerCase()))) return false;
  }
  if (use('tag') && f.tag!.length && !tagsOf(r).some((t) => (f.tag as string[]).includes(t))) return false;
  for (const key of ['league', 'surface', 'kitType', 'garmentType'] as const) {
    if (use(key) && f[key]!.length && !f[key]!.includes(text(r.attributes?.[key]) ?? '\u0000')) return false;
  }
  if (use('season') && f.season!.length && !f.season!.includes(r.season ?? '\u0000')) return false;
  if (use('continent') && f.continent!.length && !f.continent!.includes(r.continent ?? '\u0000')) return false;
  if (use('priceMin') && r.price < f.priceMin!) return false;
  if (use('priceMax') && r.price > f.priceMax!) return false;
  if (use('discount') && r.d < DISCOUNT_BANDS[f.discount!]!) return false;
  if (use('inStockOnly') && f.inStockOnly && r.units <= 0) return false;
  if (f.q && !r.q_ok) return false;
  return true;
}

const collator = new Intl.Collator('en');

/** Counts per value over the rows that pass every filter but `exclude`, sorted by label. */
function countBy(rows: FacetRow[], f: CatalogFilters, exclude: FilterKey, valuesOf: (r: FacetRow) => { value: string; label: string }[]) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    if (!matches(r, f, exclude)) continue;
    for (const { value, label } of valuesOf(r)) {
      const e = counts.get(value) ?? { label, count: 0 };
      e.count += 1;
      counts.set(value, e);
    }
  }
  return [...counts.entries()].map(([value, e]) => ({ value, label: e.label, count: e.count })).sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value));
}

/**
 * Facets for the current filters. Each facet's counts apply every active filter except its own,
 * so customers can always see (and switch to) the alternatives — even when nothing matches.
 * Two queries: the active catalogue (one row per product) and the category list; counting is in memory.
 */
export async function buildFacets(db: Db, f: CatalogFilters, lang: Lang, buffer: number): Promise<{ total: number; facets: Facet[] }> {
  const cte = aggregatesCte(buffer);
  const qOk = f.q ? filterConditions({ q: f.q } as CatalogFilters) : sql`true`;
  const [productRows, categoryRows] = await Promise.all([
    db.execute<FacetRow>(sql`
      with ${cte}
      select base.id, base.category_slug, base.brand_slug, base.brand_name, base.attributes, base.flags, base.price, base.season, base.continent,
        coalesce(base.discount_pct, 0) as d, base.units, (${qOk}) as q_ok,
        (select json_agg(json_build_object('label', v.size_label, 'sort', v.size_sort)) from variants v where v.product_id = base.id and v.status = 'active') as sizes,
        (select array_agg(pc.name order by pc.sort) from product_colors pc where pc.product_id = base.id) as colors
      from base`),
    db.execute<{ slug: string; name: { en: string; km?: string }; sort: number }>(sql`select slug, name_i18n as name, sort from categories order by sort`),
  ]);
  const rows = productRows.rows;

  const sizeCounts = new Map<string, { count: number; sort: number }>();
  for (const r of rows) {
    if (!matches(r, f, 'size')) continue;
    const seen = new Set<string>();
    for (const s of r.sizes ?? []) {
      const e = sizeCounts.get(s.label) ?? { count: 0, sort: s.sort };
      if (!seen.has(s.label)) e.count += 1;
      e.sort = Math.min(e.sort, s.sort);
      seen.add(s.label);
      sizeCounts.set(s.label, e);
    }
  }
  const sizes = [...sizeCounts.entries()]
    .sort((a, b) => a[1].sort - b[1].sort || collator.compare(a[0], b[0]))
    .map(([value, e]) => ({ value, label: value, count: e.count }));

  const attribute = (key: 'league' | 'surface' | 'kitType' | 'garmentType') =>
    countBy(rows, f, key, (r) => {
      const v = text(r.attributes?.[key]);
      return v === null ? [] : [{ value: v, label: v }];
    });

  const checkbox = (key: string, label: string, options: { value: string; label: string; count: number }[], selected: string[] = []): Facet => ({
    key,
    label,
    type: 'checkbox',
    options: mergeSelected(
      options.map((r) => ({ value: r.value, label: r.label, count: r.count, selected: selected.includes(r.value) })),
      selected,
    ),
  });

  const priceList = rows.filter((r) => matches(r, { ...f, priceMin: undefined, priceMax: undefined })).map((r) => r.price);
  const discounts = rows.filter((r) => matches(r, f, 'discount')).map((r) => r.d);
  const colorOptions = countBy(rows, f, 'color', (r) => [...new Map((r.colors ?? []).map((c) => [c.toLowerCase(), c])).entries()].map(([value, label]) => ({ value, label })));
  const tagOptions = Object.keys(TAG_LABELS)
    .map((t) => ({ value: t, label: TAG_LABELS[t]!, count: rows.filter((r) => matches(r, f, 'tag') && tagsOf(r).includes(t)).length }))
    .filter((o) => o.count > 0 || ((f.tag ?? []) as string[]).includes(o.value));

  const all: Facet[] = [
    {
      key: 'category',
      label: 'Category',
      type: 'radio',
      options: categoryRows.rows
        .map((c) => ({ value: c.slug, label: pick(c.name, lang) ?? c.slug, count: rows.filter((r) => r.category_slug === c.slug && matches(r, f, 'category')).length, selected: c.slug === f.category }))
        .filter((o) => o.count > 0 || o.selected),
    },
    checkbox('brand', 'Brand', countBy(rows, f, 'brand', (r) => [{ value: r.brand_slug, label: r.brand_name }]), f.brand),
    checkbox('size', 'Size', sizes, f.size),
    checkbox('color', 'Colour', colorOptions, (f.color ?? []).map((c) => c.toLowerCase())),
    checkbox('league', 'League', attribute('league'), f.league),
    checkbox('surface', 'Surface', attribute('surface'), f.surface),
    checkbox('kitType', 'Kit', attribute('kitType'), f.kitType),
    checkbox('garmentType', 'Type', attribute('garmentType'), f.garmentType),
    checkbox(
      'continent',
      'Continent',
      countBy(rows, f, 'continent', (r) => (r.continent ? [{ value: r.continent, label: CONTINENTS.find((c) => c.value === r.continent)?.label ?? r.continent }] : [])).sort(
        (a, b) => CONTINENTS.findIndex((c) => c.value === a.value) - CONTINENTS.findIndex((c) => c.value === b.value),
      ),
      f.continent,
    ),
    checkbox(
      'season',
      'Season',
      countBy(rows, f, 'season', (r) => (r.season ? [{ value: r.season, label: seasonLabel(r.season) }] : [])).sort((a, b) => bySeasonDesc(a.value, b.value)),
      f.season,
    ),
    checkbox('tag', 'Highlights', tagOptions, f.tag as string[] | undefined),
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
        count: discounts.filter((d) => d >= pct).length,
        selected: f.discount === value,
      })),
    },
    {
      key: 'inStockOnly',
      label: 'Availability',
      type: 'checkbox',
      options: [{ value: 'true', label: 'In stock', count: rows.filter((r) => matches(r, f, 'inStockOnly') && r.units > 0).length, selected: f.inStockOnly === true }],
    },
  ];
  const facets = all.filter((facet) => facet.type !== 'checkbox' || (facet.options?.length ?? 0) > 0);
  return { total: rows.filter((r) => matches(r, f)).length, facets };
}

/** Keeps selected values visible even when the other filters leave them with no matches. */
function mergeSelected(options: FacetOption[], selected: string[]): FacetOption[] {
  const present = new Set(options.map((o) => o.value));
  return [...options, ...selected.filter((s) => !present.has(s)).map((s) => ({ value: s, label: s, count: 0, selected: true }))];
}
