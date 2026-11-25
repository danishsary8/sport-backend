import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { memberApp } from '../helpers/app.js';
import { CATALOG, setProductStock, withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let app: ReturnType<typeof memberApp>['app'];

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  app = memberApp(database).app;
});
afterAll(closeTestDb);

const list = (query = '') => request(app).get(`/v1/catalog/products${query}`);
const facets = (query = '') => request(app).get(`/v1/catalog/filters${query}`);
type Card = { slug: string; brand: { slug: string }; category: string; priceCents: number; compareAtCents: number | null; discountPct: number | null; sizes: string[]; availability: string; lowStockCount: number | null; imageUrl: string };
const cards = (res: { body: { products: Card[] } }) => res.body.products;

describe('GET /v1/catalog/products', () => {
  it('returns the first page of active products with cache headers', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 80, page: 1, pageSize: 24 });
    expect(cards(res)).toHaveLength(24);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(cards(res)[0]!.imageUrl).toMatch(/^\/assets\/catalog\/.+\.jpg$/);
  });

  it('filters by category', async () => {
    const res = await list('?category=jerseys&pageSize=48');
    expect(res.body.total).toBe(CATALOG.filter((p) => p.category === 'jerseys').length);
    expect(cards(res).every((c) => c.category === 'jerseys')).toBe(true);
  });

  it('treats repeated values as OR', async () => {
    const res = await list('?brand=nike&brand=adidas&pageSize=48');
    expect(res.body.total).toBeGreaterThan(0);
    expect(new Set(cards(res).map((c) => c.brand.slug))).toEqual(new Set(['nike', 'adidas']));
  });

  it('filters by size', async () => {
    const res = await list(`?size=${encodeURIComponent('EU 42')}&pageSize=48`);
    expect(res.body.total).toBeGreaterThan(0);
    expect(cards(res).every((c) => c.sizes.includes('EU 42'))).toBe(true);
  });

  it('filters by price range in cents', async () => {
    const res = await list('?priceMin=3000&priceMax=4000&pageSize=48');
    expect(res.body.total).toBeGreaterThan(0);
    expect(cards(res).every((c) => c.priceCents >= 3000 && c.priceCents <= 4000)).toBe(true);
  });

  it('sorts by price', async () => {
    const prices = cards(await list('?sort=price_asc&pageSize=48')).map((c) => c.priceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const desc = cards(await list('?sort=price_desc&pageSize=48')).map((c) => c.priceCents);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  it('puts discounted products first when sorting by discount', async () => {
    const res = cards(await list('?sort=discount'));
    expect(res[0]!.compareAtCents).not.toBeNull();
    expect(res[0]!.discountPct).toBeGreaterThan(0);
  });

  it('searches names', async () => {
    const res = await list('?q=cambodia');
    expect(cards(res).map((c) => c.slug)).toContain('cambodia-national-team-home-jersey-varaman');
  });

  it('survives LIKE wildcards and quotes in the search', async () => {
    const res = await list(`?q=${encodeURIComponent("%_'\\")}`);
    expect(res.status).toBe(200);
  });

  it('returns an empty page past the end with the real total', async () => {
    const res = await list('?page=999');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ products: [], total: 80 });
  });

  it('rejects bad paging, ranges and sorts', async () => {
    expect((await list('?pageSize=1000')).status).toBe(400);
    expect((await list('?page=0')).status).toBe(400);
    expect((await list('?priceMin=5000&priceMax=100')).status).toBe(400);
    expect((await list('?priceMin=-1')).status).toBe(400);
    expect((await list('?sort=nope')).status).toBe(400);
  });

  it('shows sold-out products as out, and hides them with inStockOnly', async () => {
    const slug = 'cambodia-national-team-home-jersey-varaman';
    await setProductStock(database, slug, 0);
    const all = cards(await list('?q=cambodia&pageSize=48'));
    expect(all.find((c) => c.slug === slug)?.availability).toBe('out');
    const inStock = cards(await list('?q=cambodia&inStockOnly=true&pageSize=48'));
    expect(inStock.map((c) => c.slug)).not.toContain(slug);
    await setProductStock(database, slug, 10);
  });

  it('hides draft products', async () => {
    await database.pool.query("update products set status = 'draft' where slug = 'cambodia-national-team-home-jersey-varaman'");
    const res = await list('?q=cambodia&pageSize=48');
    expect(cards(res).map((c) => c.slug)).not.toContain('cambodia-national-team-home-jersey-varaman');
    await database.pool.query("update products set status = 'active' where slug = 'cambodia-national-team-home-jersey-varaman'");
  });

  it('never reveals a stock count above 3', async () => {
    const res = await list('?pageSize=48');
    for (const c of cards(res)) {
      if (c.lowStockCount !== null) expect(c.lowStockCount).toBeLessThanOrEqual(3);
      expect(JSON.stringify(c)).not.toMatch(/onHand|on_hand|reserved/);
    }
  });
});

describe('GET /v1/catalog/filters', () => {
  type Facet = { key: string; options?: { value: string; count: number; selected: boolean }[]; range?: { buckets: { count: number }[] } };
  const facet = (res: { body: { facets: Facet[] } }, key: string) => res.body.facets.find((f) => f.key === key)!;

  it('counts brands within the selected category only', async () => {
    const res = await facets('?category=boots');
    const bootBrandNames = new Set(CATALOG.filter((p) => p.category === 'boots').map((p) => p.brand));
    const brandOptions = facet(res, 'brand').options! as unknown as { value: string; label: string; count: number }[];
    expect(brandOptions.length).toBe(bootBrandNames.size);
    for (const o of brandOptions) expect(bootBrandNames.has(o.label)).toBe(true);
    expect(brandOptions.reduce((n, o) => n + o.count, 0)).toBe(res.body.total);
  });

  it('keeps other categories selectable with their counts', async () => {
    const res = await facets('?category=boots');
    const categories = facet(res, 'category').options!;
    expect(categories.find((o) => o.value === 'boots')).toMatchObject({ selected: true });
    expect(categories.find((o) => o.value === 'jerseys')!.count).toBeGreaterThan(0);
  });

  it('still returns facets when nothing matches', async () => {
    // Mizuno only makes boots here: the combination is empty, but dropping either filter isn't.
    const res = await facets('?brand=mizuno&category=balls');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(facet(res, 'category').options!.find((o) => o.value === 'boots')!.count).toBeGreaterThan(0);
    expect(facet(res, 'brand').options!.find((o) => o.value === 'molten')!.count).toBeGreaterThan(0);
    expect(facet(res, 'brand').options!.find((o) => o.value === 'mizuno')).toMatchObject({ selected: true, count: 0 });
  });

  it('has price buckets that add up to the total', async () => {
    const res = await facets('?category=jerseys');
    const buckets = facet(res, 'price').range!.buckets;
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(res.body.total);
  });
});
