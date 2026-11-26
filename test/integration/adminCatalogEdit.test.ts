import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let productId: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => {
  const r = request(ctx.app)[method](`/v1/admin${path}`).set(bearer(admin));
  return body ? r.send(body) : r;
};

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  ctx = memberApp(database);
  admin = ctx.fake.token({ uid: 'catalog-admin', phone: '+85511110003' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(admin));
  await q("update users set role = 'admin' where firebase_uid = 'catalog-admin'");
  const created = await api('post', '/products', {
    slug: 'edit-test-boot',
    brandSlug: (await q('select slug from brands order by slug limit 1')).rows[0].slug,
    categorySlug: (await q('select slug from categories order by slug limit 1')).rows[0].slug,
    name: { en: 'Edit test boot' },
    colors: [{ name: 'Black', swatchHex: '#000000' }],
    variants: [{ color: 'Black', size: '42', priceCents: 9000 }],
    images: [{ path: 'catalog/a.jpg', color: 'Black', alt: 'Side' }],
  });
  expect(created.status).toBe(201);
  productId = created.body.product.id;
});
afterAll(async () => {
  await q("delete from products where slug = 'edit-test-boot'");
  await q("delete from brands where slug = 'test-brand'");
  await q("delete from categories where slug = 'test-category'");
  await closeTestDb();
});

describe('admin catalogue editing', () => {
  it('adds, renames and removes colours', async () => {
    const added = await api('post', `/products/${productId}/colors`, { name: 'Volt', swatchHex: '#D4FF00' }).expect(201);
    const volt = added.body.product.colors.find((c: { name: string }) => c.name === 'Volt');
    expect(volt).toBeTruthy();
    expect((await api('post', `/products/${productId}/colors`, { name: 'volt' })).status).toBe(409);
    const renamed = await api('patch', `/products/${productId}/colors/${volt.id}`, { name: 'Volt yellow' }).expect(200);
    expect(renamed.body.product.colors.map((c: { name: string }) => c.name)).toContain('Volt yellow');
    await api('delete', `/products/${productId}/colors/${volt.id}`).expect(200);
    const black = renamed.body.product.colors.find((c: { name: string }) => c.name === 'Black');
    const inUse = await api('delete', `/products/${productId}/colors/${black.id}`).expect(409);
    expect(inUse.body.error.code).toBe('color_in_use');
  });

  it('replaces the photo list', async () => {
    const res = await api('put', `/products/${productId}/images`, {
      images: [
        { path: 'catalog/b.jpg', color: 'Black', alt: 'Front' },
        { path: 'catalog/c.jpg', alt: 'Sole' },
      ],
    }).expect(200);
    expect(res.body.product.images.map((i: { path: string }) => i.path)).toEqual(['catalog/b.jpg', 'catalog/c.jpg']);
    expect((await api('put', `/products/${productId}/images`, { images: [{ path: 'catalog/d.jpg', color: 'Pink' }] })).status).toBe(400);
    expect((await api('put', `/products/${productId}/images`, { images: [{ path: '../etc/passwd' }] })).status).toBe(400);
  });

  it('creates brands and categories', async () => {
    await api('post', '/brands', { slug: 'test-brand', name: 'Test Brand' }).expect(201);
    expect((await api('post', '/brands', { slug: 'test-brand', name: 'Again' })).status).toBe(409);
    const parent = (await q('select slug from categories where parent_id is null order by slug limit 1')).rows[0].slug;
    const cat = await api('post', '/categories', { slug: 'test-category', name: { en: 'Test category' }, parentSlug: parent }).expect(201);
    expect(cat.body.category).toMatchObject({ slug: 'test-category' });
    const brands = await api('get', '/brands').expect(200);
    expect(brands.body.brands.map((b: { slug: string }) => b.slug)).toContain('test-brand');
    const cats = await api('get', '/categories').expect(200);
    expect(cats.body.categories.map((c: { slug: string }) => c.slug)).toContain('test-category');
  });
});
