import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
const JERSEY = 'cambodia-national-team-home-jersey-varaman';
const BOOT = 'puma-ultra-5-carbon-speed-fg';
const v: Record<string, string> = {};
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  v.jersey = (await q("select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 and v.size_label = 'M'", [JERSEY])).rows[0].id;
  v.boot = (await q('select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 order by v.size_sort limit 1', [BOOT])).rows[0].id;
});
afterAll(closeTestDb);

let member: string;
beforeEach(async () => {
  await q('delete from carts');
  await q("delete from users where firebase_uid like 'merge-%'");
  await setProductStock(database, JERSEY, 10);
  await setProductStock(database, BOOT, 10);
  ctx = memberApp(database);
  member = ctx.fake.token({ uid: 'merge-member', phone: '+85512345678' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(member));
  await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send({ variantId: v.jersey, qty: 1 });
});

/** A guest with jersey M × 2 and a boot; returns the raw Cookie header. */
async function guestCart(extra?: (agent: ReturnType<typeof request.agent>) => Promise<unknown>) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/v1/cart/items').send({ variantId: v.jersey, qty: 2 });
  await agent.post('/v1/cart/items').send({ variantId: v.boot, qty: 1 });
  if (extra) await extra(agent);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

const memberCart = async () => (await request(ctx.app).get('/v1/cart').set(bearer(member))).body.cart;
const qtyOf = (cart: { lines: { sku: string; qty: number; productSlug: string }[] }, slug: string) =>
  cart.lines.filter((l) => l.productSlug === slug).reduce((s, l) => s + l.qty, 0);

describe('merging the guest bag at sign-in', () => {
  it('adds guest items to the member bag, deletes the guest bag and clears the cookie', async () => {
    const cookie = await guestCart();
    const res = await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.cartMerged).toEqual({ mergedLines: 2, cappedLines: 0 });
    expect(String(res.headers['set-cookie'])).toMatch(/sc_cart=;.*Expires=Thu, 01 Jan 1970/);
    const cart = await memberCart();
    expect(qtyOf(cart, JERSEY)).toBe(3);
    expect(qtyOf(cart, BOOT)).toBe(1);
    expect((await q('select count(*)::int as n from carts where guest_token is not null')).rows[0].n).toBe(0);
  });

  it('caps merged quantities at what can be sold', async () => {
    const cookie = await guestCart();
    await setProductStock(database, JERSEY, 0, 'M');
    await q("update stock set on_hand = 3 where variant_id = $1 and branch_id = 'sonthormuk'", [v.jersey]); // 2 online
    const res = await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect(res.body.cartMerged).toEqual({ mergedLines: 2, cappedLines: 1 });
    expect(qtyOf(await memberCart(), JERSEY)).toBe(2);
  });

  it('never merges the same guest bag twice', async () => {
    const cookie = await guestCart();
    await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    const again = await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect(again.body.cartMerged).toBeUndefined();
    expect(qtyOf(await memberCart(), JERSEY)).toBe(3);
  });

  it('stays correct when two sign-ins race with the same cookie', async () => {
    const cookie = await guestCart();
    await Promise.all([
      request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie),
      request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie),
    ]);
    expect(qtyOf(await memberCart(), JERSEY)).toBe(3);
  });

  it('brings the guest promo code across when the member has none', async () => {
    const cookie = await guestCart((agent) => agent.put('/v1/cart/promo').send({ code: 'castle10' }));
    await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect((await memberCart()).promoCode).toBe('CASTLE10');
  });

  it('refuses deleted accounts before touching the guest bag', async () => {
    const cookie = await guestCart();
    await q("update users set deleted_at = now() where firebase_uid = 'merge-member'");
    const res = await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect((await q('select count(*)::int as n from carts where guest_token is not null')).rows[0].n).toBe(1);
  });

  it('keeps a merged bag within 50 items in total', async () => {
    const jerseyL = (await q("select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 and v.size_label = 'L'", [JERSEY])).rows[0].id;
    await request(ctx.app).patch(`/v1/cart/items/${(await memberCart()).lines[0].id}`).set(bearer(member)).send({ qty: 20 });
    const agent = request.agent(ctx.app);
    const res = await agent.post('/v1/cart/items').send({ variantId: jerseyL, qty: 20 });
    await agent.post('/v1/cart/items').send({ variantId: v.boot, qty: 20 });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const merged = await request(ctx.app).post('/v1/auth/session').set(bearer(member)).set('Cookie', cookie);
    expect(merged.body.cartMerged.cappedLines).toBeGreaterThan(0);
    const units = (await memberCart()).lines.reduce((s: number, l: { qty: number }) => s + l.qty, 0);
    expect(units).toBe(50);
  });
});

describe('lowering quantities in an over-full bag', () => {
  it('always allows reducing a quantity', async () => {
    const cart = await memberCart();
    const lineId = cart.lines[0].id;
    // Simulate a bag that is over the total limit (e.g. limits tightened later).
    await q('update cart_items set qty = 20 where id = $1', [lineId]);
    const jerseyL = (await q("select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 and v.size_label = 'L'", [JERSEY])).rows[0].id;
    const xl = (await q("select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 and v.size_label = 'XL'", [JERSEY])).rows[0].id;
    await q(`insert into cart_items (cart_id, variant_id, qty) values ($1, $2, 20), ($1, $3, 20)`, [cart.id, jerseyL, xl]);
    const res = await request(ctx.app).patch(`/v1/cart/items/${lineId}`).set(bearer(member)).send({ qty: 19 });
    expect(res.status).toBe(200);
  });
});
