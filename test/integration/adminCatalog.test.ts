import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
const t = { admin: '', staffSensok: '', staffAll: '', customer: '' };
let variantId: string;
let sku: string;

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
  t.admin = ctx.fake.token({ uid: 'admin', phone: '+85511111111' });
  t.staffSensok = ctx.fake.token({ uid: 'staff-sensok', phone: '+85522222222' });
  t.staffAll = ctx.fake.token({ uid: 'staff-all', phone: '+85533333333' });
  t.customer = ctx.fake.token({ uid: 'customer', phone: '+85544444444' });
  for (const token of Object.values(t)) await request(ctx.app).post('/v1/auth/session').set(bearer(token));
  await q("update users set role = 'admin' where firebase_uid = 'admin'");
  await q("update users set role = 'staff', staff_branch_id = 'sensok' where firebase_uid = 'staff-sensok'");
  await q("update users set role = 'staff' where firebase_uid = 'staff-all'");
  const v = await q(
    "select v.id, v.sku from variants v join products p on p.id = v.product_id where p.slug = 'cambodia-national-team-home-jersey-varaman' and v.size_label = 'M'",
  );
  variantId = v.rows[0].id;
  sku = v.rows[0].sku;
  await q('update stock set on_hand = 5, reserved = 0 where variant_id = $1', [variantId]);
});
afterAll(closeTestDb);

const api = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, token: string, body?: object) => {
  const r = request(ctx.app)[method](`/v1/admin${path}`).set(bearer(token));
  return body ? r.send(body) : r;
};

describe('access control', () => {
  it('keeps customers out of every staff route', async () => {
    for (const [method, path] of [
      ['get', `/stock/lookup?q=${sku}`],
      ['post', '/stock/sale'],
      ['post', '/stock/adjust'],
      ['get', '/products'],
    ] as const) {
      expect((await api(method, path, t.customer, {})).status).toBe(403);
    }
  });

  it('keeps staff out of product management', async () => {
    expect((await api('get', '/products', t.staffSensok)).status).toBe(403);
    expect((await api('post', '/products', t.staffSensok, {})).status).toBe(403);
  });
});

describe('counter sales', () => {
  it('uses the staff member’s own branch', async () => {
    const res = await api('post', '/stock/sale', t.staffSensok, { lines: [{ variantId, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.saleId).toMatch(/^SALE-/);
    const row = await q("select on_hand from stock where variant_id = $1 and branch_id = 'sensok'", [variantId]);
    expect(row.rows[0].on_hand).toBe(4);
  });

  it('forbids branch-scoped staff from selling at another branch', async () => {
    const res = await api('post', '/stock/sale', t.staffSensok, { branchId: 'sonthormuk', lines: [{ variantId, qty: 1 }] });
    expect(res.status).toBe(403);
  });

  it('requires unscoped staff to say which branch', async () => {
    expect((await api('post', '/stock/sale', t.staffAll, { lines: [{ variantId, qty: 1 }] })).status).toBe(400);
    expect((await api('post', '/stock/sale', t.staffAll, { branchId: 'chomkadong', lines: [{ variantId, qty: 1 }] })).status).toBe(200);
  });

  it('answers 404 for a variant that does not exist', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const sale = await api('post', '/stock/sale', t.staffSensok, { lines: [{ variantId: ghost, qty: 1 }] });
    expect(sale.status).toBe(404);
    const adjust = await api('post', '/stock/adjust', t.staffSensok, { variantId: ghost, branchId: 'sensok', delta: 1, note: 'x' });
    expect(adjust.status).toBe(404);
    const transfer = await api('post', '/stock/transfer', t.staffSensok, { variantId: ghost, from: 'sensok', to: 'sonthormuk', qty: 1 });
    expect(transfer.status).toBe(404);
  });

  it('explains a sale that exceeds the shelf', async () => {
    const res = await api('post', '/stock/sale', t.staffSensok, { lines: [{ variantId, qty: 99 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_stock');
  });
});

describe('stock lookup and history', () => {
  it('finds a variant by SKU with real numbers for the branch', async () => {
    const res = await api('get', `/stock/lookup?q=${encodeURIComponent(sku)}`, t.staffSensok);
    expect(res.status).toBe(200);
    const variant = res.body.products[0].variants.find((v: { id: string }) => v.id === variantId);
    expect(variant).toMatchObject({ sku, branchId: 'sensok' });
    expect(typeof variant.onHand).toBe('number');
  });

  it('shows every branch and the movement history', async () => {
    const productId = (await q("select id from products where slug = 'cambodia-national-team-home-jersey-varaman'")).rows[0].id;
    const res = await api('get', `/stock?productId=${productId}`, t.staffAll);
    expect(res.status).toBe(200);
    expect(res.body.stock.filter((s: { variantId: string }) => s.variantId === variantId)).toHaveLength(3);
    const history = await api('get', `/stock/movements?variantId=${variantId}`, t.staffAll);
    expect(history.body.movements.some((m: { reason: string }) => m.reason === 'store_sale')).toBe(true);
  });

  it('records corrections and transfers', async () => {
    const adjust = await api('post', '/stock/adjust', t.staffSensok, { variantId, branchId: 'sensok', delta: 2, note: 'Recount' });
    expect(adjust.status).toBe(200);
    expect(adjust.body.stock).toMatchObject({ branchId: 'sensok', needsCount: false });
    const transfer = await api('post', '/stock/transfer', t.staffSensok, { variantId, from: 'sensok', to: 'sonthormuk', qty: 1 });
    expect(transfer.status).toBe(200);
    expect(transfer.body.refId).toMatch(/^XFER-/);
    expect((await api('post', '/stock/transfer', t.staffSensok, { variantId, from: 'sonthormuk', to: 'sensok', qty: 1 })).status).toBe(403);
  });
});

describe('admin product management', () => {
  const newProduct = {
    slug: 'test-training-bib',
    brandSlug: 'nike',
    categorySlug: 'essentials',
    name: { en: 'Training Bib' },
    description: { en: 'Mesh bib' },
    colors: [{ name: 'Volt', swatchHex: '#CEFF00' }],
    variants: [
      { color: 'Volt', size: 'M', priceCents: 900 },
      { color: 'Volt', size: 'L', priceCents: 900 },
    ],
    images: [{ path: 'catalog/bib.jpg', color: 'Volt' }],
  };

  it('creates a draft product that stays hidden until activated', async () => {
    const created = await api('post', '/products', t.admin, newProduct);
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ slug: 'test-training-bib', status: 'draft' });
    expect((await request(ctx.app).get('/v1/catalog/products/test-training-bib')).status).toBe(404);

    const id = created.body.product.id;
    expect((await api('patch', `/products/${id}`, t.admin, { status: 'active' })).status).toBe(200);
    const live = await request(ctx.app).get('/v1/catalog/products/test-training-bib');
    expect(live.status).toBe(200);
    expect(live.body.product.availability).toBe('out');

    const variant = live.body.product.variants[0];
    const priced = await api('put', `/products/${id}/variants/${variant.id}`, t.admin, { priceCents: 700, compareAtCents: 900 });
    expect(priced.status).toBe(200);
    const after = await request(ctx.app).get('/v1/catalog/products/test-training-bib');
    expect(after.body.product.priceCents).toBe(700);
  });

  it('sets one price for every size at once, and keeps per-size prices working', async () => {
    const made = await api('post', '/products', t.admin, {
      ...newProduct,
      slug: 'one-price-bib',
      variants: [
        { color: 'Volt', size: 'S', priceCents: 800 },
        { color: 'Volt', size: 'M', priceCents: 900, compareAtCents: 1200 },
        { color: 'Volt', size: 'L', priceCents: 1000 },
      ],
    });
    const id = made.body.product.id as string;
    const res = await api('put', `/products/${id}/prices`, t.admin, { priceCents: 1500, compareAtCents: 2000 });
    expect(res.status).toBe(200);
    expect(res.body.product.variants.map((v: { priceCents: number; compareAtCents: number | null }) => [v.priceCents, v.compareAtCents])).toEqual([
      [1500, 2000],
      [1500, 2000],
      [1500, 2000],
    ]);
    // Clearing the "was" price for all sizes.
    const cleared = await api('put', `/products/${id}/prices`, t.admin, { priceCents: 1400, compareAtCents: null });
    expect(cleared.body.product.variants.every((v: { priceCents: number; compareAtCents: number | null }) => v.priceCents === 1400 && v.compareAtCents === null)).toBe(true);
    // A "was" price that is not above the price is refused and nothing changes.
    const bad = await api('put', `/products/${id}/prices`, t.admin, { priceCents: 1400, compareAtCents: 1400 });
    expect(bad.status).toBe(400);
    // One size can still differ afterwards.
    const one = cleared.body.product.variants[0];
    const single = await api('put', `/products/${id}/variants/${one.id}`, t.admin, { priceCents: 999 });
    expect(single.body.product.variants.find((v: { id: string }) => v.id === one.id).priceCents).toBe(999);
    // Staff cannot change prices.
    expect((await api('put', `/products/${id}/prices`, t.staffAll, { priceCents: 1 })).status).toBe(403);
  });

  it('deletes a product that was never ordered, and refuses one with orders', async () => {
    const made = await api('post', '/products', t.admin, { ...newProduct, slug: 'delete-me-bib' });
    const id = made.body.product.id as string;
    expect((await api('delete', `/products/${id}`, t.staffAll)).status).toBe(403);
    expect((await api('delete', `/products/${id}`, t.admin)).status).toBe(204);
    expect((await q('select count(*)::int as n from products where id = $1', [id])).rows[0].n).toBe(0);
    expect((await q('select count(*)::int as n from variants where product_id = $1', [id])).rows[0].n).toBe(0);
    expect((await api('delete', `/products/${id}`, t.admin)).status).toBe(404);

    // A product with an order line stays: order history must keep pointing at it.
    const ordered = (await q('select product_id from variants where id = $1', [variantId])).rows[0].product_id as string;
    await q(`insert into orders (number, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_status, payment_method, merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing)
      values ('SC-2611-DEL01', 'A', '+85512345678', 'phone', 'delivery', 'confirmed', 'paid', 'aba_khqr', 100, 0, 0, 100, 4100, 0, '{}')`);
    await q(`insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) select id, $1, '{}', 100, 100, 1 from orders where number = 'SC-2611-DEL01'`, [variantId]);
    const refused = await api('delete', `/products/${ordered}`, t.admin);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('This product has orders, so it cannot be deleted. Archive it instead.');
    expect((await q('select count(*)::int as n from products where id = $1', [ordered])).rows[0].n).toBe(1);
    await q("delete from orders where number = 'SC-2611-DEL01'");
  });

  it('rejects a compare-at price that is not above the price', async () => {
    const res = await api('post', '/products', t.admin, {
      ...newProduct,
      slug: 'bad-compare',
      variants: [{ color: 'Volt', size: 'M', priceCents: 900, compareAtCents: 900 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a duplicate slug', async () => {
    const res = await api('post', '/products', t.admin, newProduct);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('slug_taken');
  });

  it('lists every status for admins', async () => {
    const res = await api('get', '/products?status=draft', t.admin);
    expect(res.status).toBe(200);
    expect(res.body.products.every((p: { status: string }) => p.status === 'draft')).toBe(true);
  });
});
