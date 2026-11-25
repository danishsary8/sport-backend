import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import catalog from '../../src/db/seed/data/catalog.json' with { type: 'json' };
import { importCatalog, type FrontendProduct } from '../../src/modules/catalog/importer.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
const products = catalog as FrontendProduct[];
const totalSizes = products.reduce((n, p) => n + p.sizes.length, 0);

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const one = async (text: string, values: unknown[] = []) => (await q(text, values)).rows[0];

beforeAll(async () => {
  database = await testDb();
  await resetDb(database);
});
afterAll(closeTestDb);

describe('importCatalog', () => {
  it('imports every product and size', async () => {
    const result = await importCatalog(database.db, products);
    expect(result).toMatchObject({ products: 80, variants: totalSizes, created: 80, updated: 0 });
    expect((await one('select count(*)::int as n from products')).n).toBe(80);
    expect((await one('select count(*)::int as n from variants')).n).toBe(totalSizes);
  });

  it('maps a jersey completely', async () => {
    const p = await one(
      `select p.*, b.name as brand, c.slug as category from products p
       join brands b on b.id = p.brand_id join categories c on c.id = p.category_id
       where p.slug = 'cambodia-national-team-home-jersey-varaman'`,
    );
    expect(p).toMatchObject({ brand: 'Varaman', category: 'jerseys', is_customizable: true, status: 'active' });
    expect(p.attributes.league).toBe('International');
    expect(p.name_i18n).toEqual({ en: 'Cambodia National Team Home Jersey (Varaman Official)' });
    expect(p.search_text.toLowerCase()).toContain('cambodia');

    const v = await q('select size_label, price_cents from variants where product_id = $1 order by size_sort', [p.id]);
    expect(v.rows).toEqual(['S', 'M', 'L', 'XL', 'XXL'].map((size_label) => ({ size_label, price_cents: 3500 })));

    const img = await one('select path from product_images where product_id = $1', [p.id]);
    expect(img.path).toBe('catalog/jersey_cambodia_blue_1795112605589.jpg');
  });

  it('converts stock levels to counts that need checking', async () => {
    const limited = products.find((p) => Object.values(p.branchStock).includes('Limited Stock'))!;
    const [branch] = Object.entries(limited.branchStock).find(([, level]) => level === 'Limited Stock')!;
    const row = await one(
      `select s.on_hand, s.needs_count from stock s join variants v on v.id = s.variant_id
       join products p on p.id = v.product_id where p.slug = $1 and s.branch_id = $2 limit 1`,
      [limited.slug, branch],
    );
    expect(row).toEqual({ on_hand: 2, needs_count: true });

    const out = products.find((p) => Object.values(p.branchStock).includes('Out of Stock'))!;
    const [outBranch] = Object.entries(out.branchStock).find(([, level]) => level === 'Out of Stock')!;
    const outRow = await one(
      `select s.on_hand from stock s join variants v on v.id = s.variant_id
       join products p on p.id = v.product_id where p.slug = $1 and s.branch_id = $2 limit 1`,
      [out.slug, outBranch],
    );
    expect(outRow.on_hand).toBe(0);
    expect((await one("select count(*)::int as n from stock_movements where reason = 'import'")).n).toBeGreaterThan(0);
  });

  it('keeps sale prices as compare-at prices', async () => {
    const sale = await one(
      "select v.price_cents, v.compare_at_cents from variants v join products p on p.id = v.product_id where p.slug = 'puma-ultra-5-carbon-speed-fg' limit 1",
    );
    expect(sale).toEqual({ price_cents: 25000, compare_at_cents: 27500 });
  });

  it('does not import fabricated ratings', async () => {
    const r = await one("select count(*)::int as n from products where attributes ? 'rating' or attributes ? 'reviewCount'");
    expect(r.n).toBe(0);
  });

  it('is idempotent and never overwrites real stock counts', async () => {
    await q(
      `update stock set on_hand = 7, needs_count = false where variant_id =
        (select v.id from variants v join products p on p.id = v.product_id where p.slug = 'cambodia-national-team-home-jersey-varaman' and v.size_label = 'M')
       and branch_id = 'sonthormuk'`,
    );
    const again = await importCatalog(database.db, products);
    expect(again).toMatchObject({ products: 80, created: 0, updated: 80 });
    expect((await one('select count(*)::int as n from variants')).n).toBe(totalSizes);
    const kept = await one(
      `select on_hand from stock s join variants v on v.id = s.variant_id join products p on p.id = v.product_id
       where p.slug = 'cambodia-national-team-home-jersey-varaman' and v.size_label = 'M' and s.branch_id = 'sonthormuk'`,
    );
    expect(kept.on_hand).toBe(7);
  });
});
