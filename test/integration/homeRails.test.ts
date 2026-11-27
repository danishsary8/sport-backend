import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { recordSale } from '../../src/modules/stock/service.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { BOOT, JERSEY, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
});
afterAll(closeTestDb);

const slugs = async (query: Record<string, string>) =>
  (await request(memberApp(database).app).get('/v1/catalog/products').query({ pageSize: '48', ...query }).expect(200)).body.products.map((p: { slug: string }) => p.slug);

describe('best selling', () => {
  it('ranks by units actually sold, ahead of the hand-picked flag', async () => {
    await q("delete from stock_movements where reason = 'store_sale'");
    await q("update products set flags = flags - 'bestSeller'");
    const boot = await variantId(database, BOOT, 'EU 42');
    const jersey = await variantId(database, JERSEY, 'M');
    await setStockAt(database, boot, { sonthormuk: 10 });
    await setStockAt(database, jersey, { sonthormuk: 10 });
    await recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: boot, qty: 3 }] });
    await recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: jersey, qty: 1 }] });
    expect((await slugs({ sort: 'best_selling' })).slice(0, 2)).toEqual([BOOT, JERSEY]);
  });

  it('ignores sales older than 90 days', async () => {
    await q("update stock_movements set created_at = now() - interval '120 days' where reason = 'store_sale'");
    const list = await slugs({ sort: 'best_selling' });
    expect(list.slice(0, 2)).not.toEqual([BOOT, JERSEY]);
  });
});

describe('newest', () => {
  it('lists the most recently added products first', async () => {
    await q("update products set created_at = now() + interval '1 minute' where slug = $1", [JERSEY]);
    expect((await slugs({ sort: 'new' }))[0]).toBe(JERSEY);
  });
});

describe('home page rails', () => {
  it('shows Best sellers above the categories and New arrivals below', async () => {
    const home = (await request(memberApp(database).app).get('/v1/catalog/home').expect(200)).body.sections;
    const titles = home.map((s: { type: string; payload: { title: string } }) => `${s.type}:${s.payload.title}`);
    expect(titles.indexOf('product_rail:Best sellers')).toBeLessThan(titles.indexOf('category_grid:Shop by category'));
    expect(titles.indexOf('product_rail:New arrivals')).toBeGreaterThan(titles.indexOf('category_grid:Shop by category'));
  });
});

describe('starting best sellers', () => {
  it('gives the chosen products a head start once, and leaves deleted ones out', async () => {
    const { seedBestSellers } = await import('../../src/db/seed/bestSellers.js');
    await q("delete from settings where key = 'sales_baseline_applied'");
    await q('delete from sales_baseline');
    const first = await seedBestSellers(database.db);
    expect(first.applied).toContain('barcelona-2627-home');
    expect(first.missing).toContain('man-united-9899');
    expect(first.applied).not.toContain('psg-2627-third-ucl');
    const top = await slugs({ sort: 'best_selling' });
    expect(top.slice(0, 2)).toEqual(['fc-barcelona-2026-27-home-authentic-jersey', 'argentina-3-star-champions-edition-jersey']);
    await q("delete from sales_baseline where product_id = (select id from products where slug = 'fc-barcelona-2026-27-home-authentic-jersey')");
    expect((await seedBestSellers(database.db)).applied).toEqual([]);
    expect((await slugs({ sort: 'best_selling' }))[0]).toBe('argentina-3-star-champions-edition-jersey');
  });
});

describe('retired starting best sellers', () => {
  it('removes the head start this seed gave, once, and keeps a row set by hand', async () => {
    const { seedBestSellers } = await import('../../src/db/seed/bestSellers.js');
    await q("update settings set value = value - 'retired' where key = 'sales_baseline_applied'");
    const psg = (await q("select id from products where slug = 'paris-saint-germain-2026-27-third-ucl-edition-jersey'")).rows[0].id;
    await q("insert into sales_baseline (product_id, units, note) values ($1, 58, 'Starting best seller') on conflict (product_id) do update set units = 58, note = 'Starting best seller'", [psg]);
    expect((await seedBestSellers(database.db)).removed).toEqual(['psg-2627-third-ucl']);
    expect((await q('select 1 from sales_baseline where product_id = $1', [psg])).rowCount).toBe(0);
    await q("insert into sales_baseline (product_id, units, note) values ($1, 5, 'Set by hand')", [psg]);
    expect((await seedBestSellers(database.db)).removed).toEqual([]);
    expect((await q('select units from sales_baseline where product_id = $1', [psg])).rows[0].units).toBe(5);
  });
});
