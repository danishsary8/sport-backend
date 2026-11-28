import { eq, sql, type SQL } from 'drizzle-orm';
import { toNinety } from '../catalog/price.js';
import type { Db } from '../../db/client.js';
import { variants } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

export const CSV_COLUMNS = ['sku', 'product_slug', 'product_name', 'brand', 'category', 'product_status', 'color', 'size', 'price_usd', 'compare_at_usd', 'variant_status'] as const;
const VARIANT_STATUSES = ['active', 'inactive'];

/** RFC 4180 field; a text cell that a spreadsheet would run as a formula gets a leading apostrophe. */
function cell(value: string, text = true): string {
  const safe = text && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

/** One row per variant: everything staff need to review prices in a spreadsheet. */
export async function exportProductsCsv(db: Db, where: SQL = sql`true`): Promise<string> {
  const rows = await db.execute<{
    sku: string; slug: string; name: string; brand: string; category: string; product_status: string;
    color: string; size: string; price_cents: number; compare_at_cents: number | null; variant_status: string;
  }>(sql`
    select v.sku, products.slug, products.name_i18n->>'en' as name, b.name as brand, categories.slug as category, products.status as product_status,
      pc.name as color, v.size_label as size, v.price_cents, v.compare_at_cents, v.status as variant_status
    from variants v join products on products.id = v.product_id join brands b on b.id = products.brand_id
    join categories on categories.id = products.category_id join product_colors pc on pc.id = v.color_id
    where ${where}
    order by products.slug, pc.sort, v.size_sort, v.sku`);
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows.rows) {
    lines.push(
      [cell(r.sku), cell(r.slug), cell(r.name), cell(r.brand), cell(r.category), cell(r.product_status), cell(r.color), cell(r.size), dollars(r.price_cents), dollars(r.compare_at_cents), cell(r.variant_status)].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export const CATALOG_COLUMNS = ['name', 'brand', 'category', 'colour', 'colour_hex', 'sizes', 'price', 'compare_at', 'description', 'main_photo', 'hover_photo', 'slug', 'status'] as const;

/**
 * One row per product colour, in the new-product import columns (sizes joined with "|"), plus slug and status.
 * Price is the lowest size price for that colour; photos are that colour's first two (or the product's).
 */
export async function exportCatalogCsv(db: Db, where: SQL = sql`true`): Promise<string> {
  const rows = await db.execute<{
    name: string; brand: string; category: string; colour: string; hex: string | null; sizes: string[]; price: number; compare_at: number | null;
    description: string | null; photos: string[] | null; slug: string; status: string;
  }>(sql`
    select products.name_i18n->>'en' as name, b.name as brand, categories.slug as category, pc.name as colour, pc.swatch_hex as hex,
      array_agg(v.size_label order by v.size_sort, v.size_label) as sizes,
      min(v.price_cents)::int as price, min(v.compare_at_cents)::int as compare_at,
      products.description_i18n->>'en' as description,
      (select array_agg(i.path order by (i.color_id = pc.id) desc nulls last, i.sort, i.id) from product_images i
        where i.product_id = products.id and (i.color_id is null or i.color_id = pc.id)) as photos,
      products.slug, products.status
    from product_colors pc join products on products.id = pc.product_id join brands b on b.id = products.brand_id
    join categories on categories.id = products.category_id join variants v on v.color_id = pc.id
    where ${where}
    group by products.id, b.name, categories.slug, pc.id
    order by products.slug, pc.sort, pc.name`);
  const lines = [CATALOG_COLUMNS.join(',')];
  for (const r of rows.rows) {
    lines.push(
      [
        cell(r.name), cell(r.brand), cell(r.category), cell(r.colour), cell(r.hex ?? ''), cell(r.sizes.join('|')), dollars(r.price), dollars(r.compare_at),
        cell(r.description ?? ''), cell(r.photos?.[0] ?? ''), cell(r.photos?.[1] ?? ''), cell(r.slug), cell(r.status),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const MONEY = /^\d{1,6}(\.\d{1,2})?$/;
const toCents = (v: string) => Math.round(Number(v) * 100);

export interface ImportResult {
  applied: boolean;
  changes: { sku: string; field: 'price_usd' | 'compare_at_usd' | 'variant_status'; from: string; to: string }[];
  errors: { line: number; sku: string; message: string }[];
}

/**
 * Updates prices, compare-at prices and sale status of existing SKUs from a CSV in the export format.
 * Nothing else changes. Without `apply` it only previews; with errors it applies nothing.
 */
export async function importProductsCsv(db: Db, text: string, apply: boolean): Promise<ImportResult> {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header || CSV_COLUMNS.some((c, i) => header[i] !== c)) {
    throw new AppError('invalid_csv', 400, `The first row must be: ${CSV_COLUMNS.join(',')}`);
  }
  const at = (r: string[], c: (typeof CSV_COLUMNS)[number]) => (r[CSV_COLUMNS.indexOf(c)] ?? '').trim();
  const result: ImportResult = { applied: false, changes: [], errors: [] };
  const updates: { id: string; priceCents: number; compareAtCents: number | null; status: 'active' | 'inactive' }[] = [];

  for (const [index, r] of rows.slice(1).entries()) {
    const line = index + 2;
    const sku = at(r, 'sku');
    const fail = (message: string) => result.errors.push({ line, sku, message });
    const [current] = sku ? await db.select().from(variants).where(eq(variants.sku, sku)) : [];
    if (!current) {
      fail('Unknown SKU (this import only changes existing sizes)');
      continue;
    }
    const price = at(r, 'price_usd');
    const compare = at(r, 'compare_at_usd');
    const status = at(r, 'variant_status');
    if (!MONEY.test(price)) {
      fail('price_usd must be a dollar amount like 45 or 45.50');
      continue;
    }
    if (compare && !MONEY.test(compare)) {
      fail('compare_at_usd must be empty or a dollar amount');
      continue;
    }
    if (!VARIANT_STATUSES.includes(status)) {
      fail(`variant_status must be one of ${VARIANT_STATUSES.join(', ')}`);
      continue;
    }
    const typed = toCents(price);
    const priceCents = toNinety(typed);
    const compareAtCents = compare ? toCents(compare) : null;
    if (typed <= 0) {
      fail('price_usd must be more than 0');
      continue;
    }
    if (compareAtCents !== null && compareAtCents <= priceCents) {
      fail('compare_at_usd must be higher than price_usd (or empty)');
      continue;
    }
    if (priceCents !== current.priceCents) result.changes.push({ sku, field: 'price_usd', from: dollars(current.priceCents), to: dollars(priceCents) });
    if (compareAtCents !== current.compareAtCents) result.changes.push({ sku, field: 'compare_at_usd', from: dollars(current.compareAtCents), to: dollars(compareAtCents) });
    if (status !== current.status) result.changes.push({ sku, field: 'variant_status', from: current.status, to: status });
    updates.push({ id: current.id, priceCents, compareAtCents, status: status as 'active' | 'inactive' });
  }

  if (apply && result.errors.length === 0) {
    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx.update(variants).set({ priceCents: u.priceCents, compareAtCents: u.compareAtCents, status: u.status }).where(eq(variants.id, u.id));
      }
    });
    result.applied = true;
  }
  return result;
}
