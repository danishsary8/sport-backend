import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { CATALOG, setProductStock, withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let app: ReturnType<typeof memberApp>['app'];
const JERSEY = 'cambodia-national-team-home-jersey-varaman';

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db); // collections + home sections
  app = memberApp(database).app;
});
afterAll(closeTestDb);
beforeEach(async () => {
  await setProductStock(database, JERSEY, 10);
  await database.pool.query("update products set status = 'active' where slug = $1", [JERSEY]);
});

const detail = (slug: string) => request(app).get(`/v1/catalog/products/${slug}`);
type Variant = { size: string; availability: string; lowStockCount: number | null; byBranch: Record<string, string> };

describe('GET /v1/catalog/products/:slug', () => {
  it('returns the product with every size in order and per-branch availability', async () => {
    const res = await detail(JERSEY);
    expect(res.status).toBe(200);
    const p = res.body.product;
    expect(p).toMatchObject({ slug: JERSEY, isCustomizable: true, brand: { name: 'Varaman' } });
    expect(p.variants.map((v: Variant) => v.size)).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
    for (const v of p.variants as Variant[]) {
      expect(Object.keys(v.byBranch).sort()).toEqual(['chomkadong', 'sensok', 'sonthormuk']);
    }
    expect(p.images[0].url).toMatch(/^\/assets\/catalog\//);
    expect(res.headers['cache-control']).toContain('public');
  });

  it('shows low stock per size after the safety buffer', async () => {
    await setProductStock(database, JERSEY, 0, 'M');
    await database.pool.query(
      `update stock s set on_hand = 2 from variants v join products p on p.id = v.product_id
       where s.variant_id = v.id and p.slug = $1 and v.size_label = 'M' and s.branch_id = 'sonthormuk'`,
      [JERSEY],
    );
    const m = (await detail(JERSEY)).body.product.variants.find((v: Variant) => v.size === 'M');
    expect(m).toMatchObject({ availability: 'low', lowStockCount: 1 });
    expect(m.byBranch).toEqual({ sonthormuk: 'low', sensok: 'out', chomkadong: 'out' });
  });

  it('still returns a sold-out product with every size marked out', async () => {
    await setProductStock(database, JERSEY, 0);
    const res = await detail(JERSEY);
    expect(res.status).toBe(200);
    expect(res.body.product.availability).toBe('out');
    expect(res.body.product.variants.every((v: Variant) => v.availability === 'out')).toBe(true);
  });

  it('hides archived products', async () => {
    await database.pool.query("update products set status = 'archived' where slug = $1", [JERSEY]);
    expect((await detail(JERSEY)).status).toBe(404);
    expect((await detail('no-such-product')).status).toBe(404);
  });

  it('suggests related products from the same category', async () => {
    const related = (await detail(JERSEY)).body.product.related;
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(8);
    expect(related.map((r: { slug: string }) => r.slug)).not.toContain(JERSEY);
    expect(related.every((r: { category: string }) => r.category === 'jerseys')).toBe(true);
  });
});

describe('GET /v1/search/suggest', () => {
  it('finds products by partial words', async () => {
    const res = await request(app).get('/v1/search/suggest?q=mess');
    expect(res.status).toBe(200);
    expect(res.body.products.some((p: { name: string }) => /messi/i.test(p.name))).toBe(true);
    expect(res.body.products.length).toBeLessThanOrEqual(6);
  });

  it('finds brands', async () => {
    const res = await request(app).get('/v1/search/suggest?q=nike');
    expect(res.body.brands.map((b: { slug: string }) => b.slug)).toContain('nike');
  });

  it('requires at least two characters', async () => {
    expect((await request(app).get('/v1/search/suggest?q=a')).status).toBe(400);
  });
});

describe('menu, collections and home', () => {
  it('counts every active product once across categories', async () => {
    const res = await request(app).get('/v1/catalog/menu');
    expect(res.status).toBe(200);
    const total = res.body.categories.reduce((n: number, c: { productCount: number }) => n + c.productCount, 0);
    expect(total).toBe(80);
    expect(res.body.collections.map((c: { slug: string }) => c.slug)).toContain('best-sellers');
  });

  it('lists the categories in menu order, with Jackets before F1', async () => {
    const res = await request(app).get('/v1/catalog/menu');
    expect(res.body.categories.map((c: { slug: string }) => c.slug)).toEqual(['boots', 'jerseys', 'balls', 'jackets', 'f1', 'essentials']);
    expect(res.body.categories.find((c: { slug: string }) => c.slug === 'jackets').name).toBe('Jackets');
  });

  it('lists a collection through its saved filter', async () => {
    const res = await request(app).get('/v1/catalog/products?collection=best-sellers&pageSize=48');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(CATALOG.filter((p) => (p as { isBestSeller?: boolean }).isBestSeller).length);
    expect(res.body.products.every((p: { badges: string[] }) => p.badges.includes('best_seller'))).toBe(true);
  });

  it('filters F1 jackets through the garment type', async () => {
    const res = await request(app).get('/v1/catalog/products?collection=f1-jackets&pageSize=48');
    const expected = CATALOG.filter((p) => p.category === 'f1' && p.garmentType === 'jacket').length;
    expect(res.body.total).toBe(expected);
  });

  it('answers 404 for an unknown collection', async () => {
    expect((await request(app).get('/v1/catalog/products?collection=nope')).status).toBe(404);
    expect((await request(app).get('/v1/catalog/collections/nope')).status).toBe(404);
  });

  it('describes a collection', async () => {
    const res = await request(app).get('/v1/catalog/collections/best-sellers');
    expect(res.body.collection).toMatchObject({ slug: 'best-sellers' });
    expect(res.body.collection.name.length).toBeGreaterThan(0);
  });

  it('returns home sections with product rails resolved', async () => {
    const res = await request(app).get('/v1/catalog/home');
    expect(res.status).toBe(200);
    const rail = res.body.sections.find((s: { type: string }) => s.type === 'product_rail');
    expect(rail.payload.products.length).toBeGreaterThan(0);
    expect(rail.payload.products.length).toBeLessThanOrEqual(12);
  });

  it('has browsers check back each time, so a new photo shows on the next home page view', async () => {
    const first = await request(app).get('/v1/catalog/home');
    expect(first.headers['cache-control']).toBe('public, no-cache');
    const etag = first.headers.etag as string;
    // Nothing changed: a cheap 304 with no body.
    await request(app).get('/v1/catalog/home').set('If-None-Match', etag).expect(304);

    const rail = first.body.sections.find((s: { type: string }) => s.type === 'product_rail');
    const card = rail.payload.products[0] as { slug: string; imageUrl: string };
    await database.pool.query(
      `update product_images set path = 'media/00000000-0000-4000-8000-000000000001.jpg'
       where id = (select pi.id from product_images pi join products p on p.id = pi.product_id where p.slug = $1 order by pi.sort, pi.id limit 1)`,
      [card.slug],
    );
    const after = await request(app).get('/v1/catalog/home').set('If-None-Match', etag).expect(200);
    const updated = after.body.sections.find((s: { type: string }) => s.type === 'product_rail').payload.products.find((p: { slug: string }) => p.slug === card.slug);
    expect(updated.imageUrl).toContain('00000000-0000-4000-8000-000000000001');
  });

  it('keeps the home page up when a rail points at a retired or broken collection', async () => {
    await database.pool.query(`insert into collections (slug, name_i18n, rule, active) values
      ('retired', '{"en":"Retired"}', '{"category":"boots"}', false),
      ('broken', '{"en":"Broken"}', '{"priceMin":"abc","category":"boots"}', true)`);
    await database.pool.query(`insert into home_sections (type, sort, payload) values
      ('product_rail', 90, '{"title":{"en":"Old"},"query":{"collection":"retired"}}'),
      ('product_rail', 91, '{"title":{"en":"Typo"},"query":{"collection":"broken"}}')`);
    const res = await request(app).get('/v1/catalog/home');
    expect(res.status).toBe(200);
    expect(res.body.sections.some((s: { payload: { products: unknown[] } }) => s.payload.products?.length > 0)).toBe(true);

    const broken = await request(app).get('/v1/catalog/products?collection=broken&pageSize=48');
    expect(broken.status).toBe(200);
    expect(broken.body.products.every((p: { category: string }) => p.category === 'boots')).toBe(true);
  });
});
