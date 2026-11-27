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
