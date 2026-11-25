import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { buildFacets } from '../../src/modules/catalog/facets.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { staffToken } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';
import { FACET_CASES } from '../helpers/facetCases.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const NEW_KEYS = new Set(['color', 'tag', 'garmentType']);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'cat-admin', 'admin');
});
afterAll(closeTestDb);

describe('filters', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/facets.json', import.meta.url), 'utf8')) as Record<string, { total: number; facets: { key: string }[] }>;

  for (const [name, filters] of Object.entries(FACET_CASES)) {
    it(`gives the same facets as before for "${name}", in at most 2 queries`, async () => {
      const spy = vi.spyOn(database.pool, 'query');
      const result = await buildFacets(database.db, filters, 'en', 1);
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      expect(calls).toBeLessThanOrEqual(2);
      expect({ total: result.total, facets: result.facets.filter((f) => !NEW_KEYS.has(f.key)) }).toEqual(fixture[name]);
    });
  }

  it('adds colour, tag and garment type facets', async () => {
    const res = await request(ctx.app).get('/v1/catalog/filters').expect(200);
    const keys = res.body.facets.map((f: { key: string }) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['color', 'tag']));
    const tag = res.body.facets.find((f: { key: string }) => f.key === 'tag');
    expect(tag.options.map((o: { value: string }) => o.value)).toEqual(expect.arrayContaining(['new', 'sale']));
  });

  it('refuses an unknown tag', async () => {
    const res = await request(ctx.app).get('/v1/catalog/products?tag=bogus').expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('product cards', () => {
  it('lists each size once, in size order, even for products in several colours', async () => {
    const created = await request(ctx.app)
      .post('/v1/admin/products')
      .set(bearer(admin))
      .send({
        slug: 'two-colour-tee',
        brandSlug: 'nike',
        categorySlug: 'essentials',
        name: { en: 'Two Colour Tee' },
        status: 'active',
        colors: [{ name: 'Black' }, { name: 'White' }],
        variants: [
          { color: 'Black', size: 'L', priceCents: 1000 },
          { color: 'Black', size: 'M', priceCents: 1000 },
          { color: 'White', size: 'M', priceCents: 1000 },
          { color: 'White', size: 'L', priceCents: 1000 },
        ],
      })
      .expect(201);
    expect(created.body.product.slug).toBe('two-colour-tee');
    const res = await request(ctx.app).get('/v1/catalog/products?q=two%20colour%20tee').expect(200);
    const card = res.body.products.find((p: { slug: string }) => p.slug === 'two-colour-tee');
    expect(card.sizes).toEqual(['M', 'L']);
  });
});

describe('search', () => {
  it('ignores accents in both directions', async () => {
    await q(`update products set name_i18n = jsonb_set(name_i18n, '{en}', '"Kylian Mbappé Pro Jersey"') where slug = (select slug from products order by slug limit 1)`);
    await request(ctx.app).post(`/v1/admin/products/${(await q('select id from products order by slug limit 1')).rows[0].id}/variants`).set(bearer(admin)).send({});
    const id = (await q('select id from products order by slug limit 1')).rows[0].id;
    await request(ctx.app).patch(`/v1/admin/products/${id}`).set(bearer(admin)).send({ name: { en: 'Kylian Mbappé Pro Jersey' } }).expect(200);
    const plain = await request(ctx.app).get('/v1/search/suggest?q=mbappe').expect(200);
    const accented = await request(ctx.app).get('/v1/search/suggest?q=Mbappé').expect(200);
    expect(JSON.stringify(plain.body)).toContain('Mbapp');
    expect(JSON.stringify(accented.body)).toContain('Mbapp');
    const listing = await request(ctx.app).get('/v1/catalog/products?q=mbappe').expect(200);
    expect(listing.body.total).toBeGreaterThan(0);
  });
});

describe('admin product data', () => {
  const base = {
    brandSlug: 'nike',
    categorySlug: 'essentials',
    name: { en: 'Hardening Bib' },
    colors: [{ name: 'Volt' }],
    variants: [{ color: 'Volt', size: 'M', priceCents: 900 }],
  };

  it('refuses colours that only differ in case', async () => {
    const res = await request(ctx.app).post('/v1/admin/products').set(bearer(admin)).send({ ...base, slug: 'dup-colour', colors: [{ name: 'Volt' }, { name: 'volt' }] }).expect(400);
    expect(res.body.error.code).toBe('color_exists');
  });

  it('refuses unsafe image paths and images for unknown colours', async () => {
    for (const path of ['../etc/passwd', 'https://evil.example/x.jpg', '/abs/path.jpg', 'catalog/a b.jpg']) {
      await request(ctx.app).post('/v1/admin/products').set(bearer(admin)).send({ ...base, slug: `bad-img-${Math.random().toString(36).slice(2, 7)}`, images: [{ path }] }).expect(400);
    }
    const unknown = await request(ctx.app).post('/v1/admin/products').set(bearer(admin)).send({ ...base, slug: 'img-colour', images: [{ path: 'catalog/x.jpg', color: 'Pink' }] }).expect(400);
    expect(JSON.stringify(unknown.body)).toContain('Pink');
  });
});

describe('wishlist', () => {
  it('rejects a product with no sizes on sale', async () => {
    const member = ctx.fake.token({ uid: 'wish-hard', phone: '+85512009200' });
    const slug = (await q("select slug from products where status = 'active' order by slug desc limit 1")).rows[0].slug;
    await q("update variants set status = 'inactive' where product_id = (select id from products where slug = $1)", [slug]);
    try {
      await request(ctx.app).put(`/v1/me/wishlist/${slug}`).set(bearer(member)).expect(404);
    } finally {
      await q("update variants set status = 'active' where product_id = (select id from products where slug = $1)", [slug]);
    }
  });

  it('never goes past the cap, even with parallel adds', async () => {
    const member = ctx.fake.token({ uid: 'wish-cap', phone: '+85512009201' });
    await request(ctx.app).get('/v1/me').set(bearer(member)).expect(200);
    const userId = (await q("select id from users where firebase_uid = 'wish-cap'")).rows[0].id;
    const products = (await q("select id from products where status = 'active' order by slug limit 12")).rows;
    for (const p of products.slice(0, 8)) await q('insert into wishlist_items (user_id, product_id) values ($1, $2)', [userId, p.id]);
    const { addToWishlist } = await import('../../src/modules/wishlist/router.js');
    const results = await Promise.allSettled(products.slice(8).map((p) => addToWishlist(database.db, userId, p.id, 9)));
    expect((await q('select count(*)::int as n from wishlist_items where user_id = $1', [userId])).rows[0].n).toBe(9);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
  });
});

describe('stock reads for branch staff', () => {
  it('shows a branch-tied staff member only their branch', async () => {
    const sensok = await staffToken(ctx.app, database, ctx.fake, 'stock-sensok', 'staff', 'sensok');
    const productId = (await q('select id from products order by slug limit 1')).rows[0].id;
    const res = await request(ctx.app).get(`/v1/admin/stock?productId=${productId}`).set(bearer(sensok)).expect(200);
    expect(res.body.stock.length).toBeGreaterThan(0);
    expect(new Set(res.body.stock.map((s: { branchId: string }) => s.branchId))).toEqual(new Set(['sensok']));
    const variantId = res.body.stock[0].variantId;
    const moves = await request(ctx.app).get(`/v1/admin/stock/movements?variantId=${variantId}`).set(bearer(sensok)).expect(200);
    expect(moves.body.movements.every((m: { branchId: string }) => m.branchId === 'sensok')).toBe(true);
  });
});
