import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
let variantId: string;

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);

beforeEach(async () => {
  await resetDb(database);
  const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
  const brand = await q("insert into brands (slug, name) values ('acme', 'Acme') returning id");
  const cat = await q("select id from categories where slug = 'boots'");
  const product = await q(
    `insert into products (slug, brand_id, category_id, name_i18n) values ('p1', $1, $2, '{"en":"P1"}') returning id`,
    [brand.rows[0].id, cat.rows[0].id],
  );
  const color = await q("insert into product_colors (product_id, name) values ($1, 'Black') returning id", [product.rows[0].id]);
  const variant = await q(
    "insert into variants (product_id, color_id, size_label, size_sort, sku, price_cents) values ($1, $2, 'EU 42', 420, 'P1-42', 5000) returning id",
    [product.rows[0].id, color.rows[0].id],
  );
  variantId = variant.rows[0].id;
});

const insertStock = (onHand: number, reserved: number) =>
  database.pool.query("insert into stock (variant_id, branch_id, on_hand, reserved) values ($1, 'sonthormuk', $2, $3)", [
    variantId,
    onHand,
    reserved,
  ]);

describe('catalog schema', () => {
  it('rejects negative stock', async () => {
    await expect(insertStock(-1, 0)).rejects.toThrow();
  });

  it('rejects reserving more than is on hand', async () => {
    await expect(insertStock(3, 5)).rejects.toThrow();
    await expect(insertStock(5, 3)).resolves.toBeDefined();
  });

  it('enforces unique SKUs', async () => {
    const v = await database.pool.query('select product_id, color_id from variants where id = $1', [variantId]);
    await expect(
      database.pool.query(
        "insert into variants (product_id, color_id, size_label, size_sort, sku, price_cents) values ($1, $2, 'EU 43', 430, 'P1-42', 5000)",
        [v.rows[0].product_id, v.rows[0].color_id],
      ),
    ).rejects.toThrow();
  });

  it('requires a compare-at price above the price', async () => {
    await expect(database.pool.query('update variants set compare_at_cents = 5000 where id = $1', [variantId])).rejects.toThrow();
    await expect(database.pool.query('update variants set compare_at_cents = 6000 where id = $1', [variantId])).resolves.toBeDefined();
  });

  it('has the search extensions', async () => {
    const r = await database.pool.query('select extname from pg_extension');
    const names = r.rows.map((x) => x.extname);
    expect(names).toEqual(expect.arrayContaining(['pg_trgm', 'unaccent']));
  });

  it('seeds categories and the online safety buffer', async () => {
    const cats = await database.pool.query('select slug from categories order by sort');
    expect(cats.rows.map((c) => c.slug)).toEqual(['boots', 'jerseys', 'balls', 'jackets', 'f1', 'essentials']);
    const s = await database.pool.query("select value from settings where key = 'online_safety_buffer'");
    expect(s.rows[0]?.value).toEqual({ units: 1 });
  });
});
