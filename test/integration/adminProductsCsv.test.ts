import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { staffToken } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

const HEADER = 'sku,product_slug,product_name,brand,category,product_status,color,size,price_usd,compare_at_usd,variant_status';
let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let sku: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const importCsv = (csv: string, apply = false) =>
  request(ctx.app).post(`/v1/admin/products/import${apply ? '?apply=true' : ''}`).set(bearer(admin)).set('content-type', 'text/csv').send(csv);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'csv-admin', 'admin');
});
afterAll(closeTestDb);
beforeEach(async () => {
  sku = (await q("select sku from variants where status = 'active' order by sku limit 1")).rows[0].sku;
  await q('update variants set price_cents = 5000, compare_at_cents = null where sku = $1', [sku]);
});

describe('CSV export', () => {
  it('has one row per size with prices in dollars', async () => {
    const res = await request(ctx.app).get('/v1/admin/products/export.csv').set(bearer(admin)).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines.length - 1).toBe(Number((await q('select count(*)::int as n from variants')).rows[0].n));
    expect(lines.find((l) => l.startsWith(`${sku},`))).toContain(',50.00,,');
  });

  it('defuses spreadsheet formulas in text cells', async () => {
    const id = (await q('select product_id from variants where sku = $1', [sku])).rows[0].product_id;
    const old = (await q('select name_i18n from products where id = $1', [id])).rows[0].name_i18n;
    await q(`update products set name_i18n = '{"en":"=HYPERLINK(\\"x\\")"}' where id = $1`, [id]);
    try {
      const res = await request(ctx.app).get('/v1/admin/products/export.csv').set(bearer(admin)).expect(200);
      expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
    } finally {
      await q('update products set name_i18n = $2 where id = $1', [id, JSON.stringify(old)]);
    }
  });

  it('exports only the products matching the list filters', async () => {
    const res = await request(ctx.app).get('/v1/admin/products/export.csv').query({ category: 'balls', status: 'active' }).set(bearer(admin)).expect(200);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1);
    const expected = Number(
      (await q("select count(*)::int as n from variants v join products p on p.id = v.product_id join categories c on c.id = p.category_id where c.slug = 'balls' and p.status = 'active'")).rows[0].n,
    );
    expect(expected).toBeGreaterThan(0);
    expect(lines).toHaveLength(expected);
    expect(lines.every((l) => l.split(',')[4] === 'balls')).toBe(true);
    const searched = await request(ctx.app).get('/v1/admin/products/export.csv').query({ q: 'zzz-no-such-product' }).set(bearer(admin)).expect(200);
    expect(searched.text.replace(/^\uFEFF/, '').trim().split('\r\n')).toHaveLength(1);
  });

  it('exports whole products in the new-product import columns', async () => {
    const res = await request(ctx.app).get('/v1/admin/products/export.csv').query({ format: 'products', category: 'boots' }).set(bearer(admin)).expect(200);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('name,brand,category,colour,colour_hex,sizes,price,compare_at,description,main_photo,hover_photo,slug,status');
    const colours = Number(
      (await q("select count(*)::int as n from product_colors pc join products p on p.id = pc.product_id join categories c on c.id = p.category_id where c.slug = 'boots' and exists (select 1 from variants v where v.color_id = pc.id)")).rows[0].n,
    );
    expect(lines.length - 1).toBe(colours);
    const slug = (await q("select p.slug from products p join categories c on c.id = p.category_id where c.slug = 'boots' order by p.slug limit 1")).rows[0].slug as string;
    const line = lines.find((l) => l.includes(`,${slug},`))!;
    expect(line).toMatch(/EU \d+(\.\d)?\|EU/);
    expect(line).toMatch(/,catalog\/[^,]+\.jpg,/);
  });

  it('is for admins only', async () => {
    const staff = await staffToken(ctx.app, database, ctx.fake, 'csv-staff', 'staff');
    await request(ctx.app).get('/v1/admin/products/export.csv').set(bearer(staff)).expect(403);
  });
});

describe('CSV import', () => {
  const row = (price: string, compare = '', status = 'active', s = sku) => `${s},x,x,x,x,active,x,x,${price},${compare},${status}`;

  it('previews price changes without applying them', async () => {
    const res = await importCsv(`${HEADER}\n${row('45.00', '50.00')}\n`).expect(200);
    expect(res.body).toMatchObject({ applied: false, errors: [] });
    expect(res.body.changes).toEqual(
      expect.arrayContaining([
        { sku, field: 'price_usd', from: '50.00', to: '45.00' },
        { sku, field: 'compare_at_usd', from: '', to: '50.00' },
      ]),
    );
    expect((await q('select price_cents from variants where sku = $1', [sku])).rows[0].price_cents).toBe(5000);
  });

  it('applies a clean file', async () => {
    const res = await importCsv(`${HEADER}\r\n${row('45.00', '50.00')}\r\n`, true).expect(200);
    expect(res.body.applied).toBe(true);
    expect((await q('select price_cents, compare_at_cents from variants where sku = $1', [sku])).rows[0]).toEqual({ price_cents: 4500, compare_at_cents: 5000 });
  });

  it('applies nothing when any row is wrong, and says why', async () => {
    const res = await importCsv(`${HEADER}\n${row('45.00')}\n${row('12.345', '', 'active', 'NO-SUCH-SKU')}\n${row('40.00', '30.00')}\n${row('-1')}\n${row('10', '', 'deleted')}\n`, true).expect(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5, 6]);
    expect((await q('select price_cents from variants where sku = $1', [sku])).rows[0].price_cents).toBe(5000);
  });

  it('refuses a file with the wrong columns', async () => {
    const res = await importCsv('sku,price\nX,1\n').expect(400);
    expect(res.body.error.code).toBe('invalid_csv');
  });
});
