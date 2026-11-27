import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
  admin = ctx.fake.token({ uid: 'list-admin', phone: '+85511110009' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(admin));
  await q("update users set role = 'admin' where firebase_uid = 'list-admin'");
});
afterAll(closeTestDb);

describe('GET /v1/admin/products (management list)', () => {
  it('gives each row its photos, price range, sizes, stock, brand and category', async () => {
    const slug = (await q("select p.slug from products p join categories c on c.id = p.category_id where c.slug = 'boots' order by p.slug limit 1")).rows[0].slug as string;
    await setProductStock(database, slug, 2);
    const res = await request(ctx.app).get('/v1/admin/products').query({ q: slug, pageSize: 5 }).set(bearer(admin)).expect(200);
    const row = res.body.products.find((p: { slug: string }) => p.slug === slug);
    expect(row).toMatchObject({ categorySlug: 'boots', brandName: expect.any(String), imageCount: expect.any(Number) });
    expect(row.imageUrl).toMatch(/^\/assets\/catalog\/.+\.jpg$/);
    expect(row.priceMinCents).toBeGreaterThan(0);
    expect(row.priceMaxCents).toBeGreaterThanOrEqual(row.priceMinCents);
    expect(row.variantCount).toBeGreaterThan(0);
    const branches = Number((await q('select count(*) from branches')).rows[0].count);
    expect(row.onHand).toBe(2 * row.variantCount * branches);
  });

  it('filters by category', async () => {
    const res = await request(ctx.app).get('/v1/admin/products').query({ category: 'balls', pageSize: 100 }).set(bearer(admin)).expect(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.every((p: { categorySlug: string }) => p.categorySlug === 'balls')).toBe(true);
  });

  it('resolves photo URLs on the product view', async () => {
    const id = (await q('select product_id from product_images limit 1')).rows[0].product_id as string;
    const res = await request(ctx.app).get(`/v1/admin/products/${id}`).set(bearer(admin)).expect(200);
    expect(res.body.product.images[0].url).toMatch(/^\/assets\//);
  });
});
