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

async function variant(slug: string, size?: string): Promise<string> {
  const r = await q(
    `select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 ${size ? 'and v.size_label = $2' : ''} order by v.size_sort limit 1`,
    size ? [slug, size] : [slug],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  v.jerseyM = await variant(JERSEY, 'M');
  v.jerseyL = await variant(JERSEY, 'L');
  v.boot = await variant(BOOT);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q("update products set status = 'active'");
  await setProductStock(database, JERSEY, 10);
  await setProductStock(database, BOOT, 10);
  await q("update variants set price_cents = 3500 where product_id = (select id from products where slug = $1)", [JERSEY]);
  ctx = memberApp(database);
});

const PRINT = { name: 'dara', number: 10, patch: 'cpl' };
type Line = { id: string; size: string; qty: number; maxQty: number; problem: string | null; printFeeCents: number; customPrint: unknown; unitPriceCents: number };

describe('guest cart', () => {
  it('reading an empty cart sets no cookie', async () => {
    const res = await request(ctx.app).get('/v1/cart');
    expect(res.status).toBe(200);
    expect(res.body.cart.lines).toEqual([]);
    expect(res.body.cart.checkoutReady).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('adds items, sets a secure-by-default cookie and prices on the server', async () => {
    const agent = request.agent(ctx.app);
    const res = await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 2, unitPriceCents: 1 });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sc_cart=[^;]+;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const cart = res.body.cart;
    expect(cart.lines).toHaveLength(1);
    expect(cart.pricing).toMatchObject({ merchandiseCents: 7000, shippingCents: 0, totalCents: 7000, totalKhr: 287000 });
    expect(cart.checkoutReady).toBe(true);
    expect(cart.notices).toContain("Items in your bag aren't reserved until you check out");
    expect((await agent.get('/v1/cart')).body.cart.lines).toHaveLength(1);
  });

  it('merges identical lines and keeps printed shirts separate', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 2 });
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 2 });
    const printed = await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1, customPrint: PRINT });
    const lines = printed.body.cart.lines as Line[];
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => !l.customPrint)!.qty).toBe(4);
    expect(lines.find((l) => l.customPrint)).toMatchObject({ printFeeCents: 800, customPrint: { name: 'DARA', number: 10, patch: 'cpl' } });
  });

  it('refuses printing on products that cannot be printed', async () => {
    const res = await request(ctx.app).post('/v1/cart/items').send({ variantId: v.boot, qty: 1, customPrint: PRINT });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_customizable');
  });

  it('refuses more than can be sold online', async () => {
    await setProductStock(database, JERSEY, 2, 'M'); // 3 branches × (2 − buffer 1) = 3 online
    const res = await request(ctx.app).post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 4 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'insufficient_stock', details: { available: 3 } });
  });

  it('refuses unknown or archived products', async () => {
    expect((await request(ctx.app).post('/v1/cart/items').send({ variantId: '00000000-0000-4000-8000-000000000000', qty: 1 })).status).toBe(404);
    await q("update products set status = 'archived' where slug = $1", [BOOT]);
    expect((await request(ctx.app).post('/v1/cart/items').send({ variantId: v.boot, qty: 1 })).status).toBe(404);
  });

  it('changes size, quantity and removes lines', async () => {
    const agent = request.agent(ctx.app);
    const added = await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 });
    const id = added.body.cart.lines[0].id;
    const resized = await agent.patch(`/v1/cart/items/${id}`).send({ variantId: v.jerseyL, qty: 3 });
    expect(resized.status).toBe(200);
    expect(resized.body.cart.lines).toMatchObject([{ size: 'L', qty: 3 }]);
    const lineId = resized.body.cart.lines[0].id;
    expect((await agent.patch(`/v1/cart/items/${lineId}`).send({ variantId: v.boot })).status).toBe(400);
    const removed = await agent.delete(`/v1/cart/items/${lineId}`);
    expect(removed.body.cart.lines).toEqual([]);
  });

  it('applies and explains promo codes', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.boot, qty: 1 });
    const good = await agent.put('/v1/cart/promo').send({ code: ' castle10 ' });
    expect(good.body.cart.promoCode).toBe('CASTLE10');
    expect(good.body.cart.pricing.promo).toEqual({ code: 'CASTLE10', applied: true, message: null });
    const bad = await agent.put('/v1/cart/promo').send({ code: 'nope' });
    expect(bad.body.cart.promoCode).toBe('NOPE');
    expect(bad.body.cart.pricing.promo).toMatchObject({ applied: false, message: "We don't recognise that code" });
    const cleared = await agent.delete('/v1/cart/promo');
    expect(cleared.body.cart.promoCode).toBeNull();
  });

  it('ignores a forged cookie and never shows another guest’s cart', async () => {
    const owner = request.agent(ctx.app);
    const res = await owner.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 });
    const token = String(res.headers['set-cookie']).match(/sc_cart=([^.;]+)\./)![1];
    const forged = await request(ctx.app).get('/v1/cart').set('Cookie', `sc_cart=${token}.forged`);
    expect(forged.body.cart.lines).toEqual([]);
    const stranger = await request(ctx.app).get('/v1/cart');
    expect(stranger.body.cart.lines).toEqual([]);
    expect((await owner.get('/v1/cart')).body.cart.lines).toHaveLength(1);
  });
});

describe('delivery options', () => {
  it('says the delivery price before a method is chosen (the lowest delivery fee; pickup is free)', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 });
    expect((await agent.get('/v1/cart')).body.cart.deliveryFromCents).toBe(200);
    const q = (t: string, p: unknown[] = []) => database.pool.query(t, p);
    await q("update shipping_rates set fee_cents = 150 where method_id = 'pp_rider'");
    try {
      expect((await agent.get('/v1/cart')).body.cart.deliveryFromCents).toBe(150);
    } finally {
      await q("update shipping_rates set fee_cents = 200 where method_id = 'pp_rider'");
    }
  });

  it('prices courier, pickup and unavailable choices', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 });
    expect((await agent.get('/v1/cart?provinceCode=17&shippingMethodId=province_courier')).body.cart.pricing.shippingCents).toBe(200);
    expect((await agent.get('/v1/cart?fulfillment=pickup&pickupBranchId=sensok')).body.cart.pricing.shippingCents).toBe(0);
    const bad = (await agent.get('/v1/cart?provinceCode=17&shippingMethodId=pp_rider')).body.cart;
    expect(bad.pricing.shippingCents).toBeNull();
    expect(bad.checkoutReady).toBe(false);
  });
});

describe('member cart', () => {
  it('keeps a separate cart for a signed-in member and gives Silver members their discount', async () => {
    const token = ctx.fake.token({ uid: 'silver-member', phone: '+85512345678' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token));
    await q("insert into loyalty_accounts (user_id, tier) select id, 'silver' from users where firebase_uid = 'silver-member'");
    const res = await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: v.boot, qty: 1 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.cart.pricing.discounts).toEqual([{ kind: 'member', label: 'Silver member discount', amountCents: 2500 }]);
    expect((await request(ctx.app).get('/v1/cart')).body.cart.lines).toEqual([]);
  });
});

describe('changes after adding', () => {
  it('shows new prices and flags archived products', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 });
    await agent.post('/v1/cart/items').send({ variantId: v.boot, qty: 1 });
    await q("update variants set price_cents = 3000 where id = $1", [v.jerseyM]);
    const repriced = (await agent.get('/v1/cart')).body.cart;
    expect(repriced.lines.find((l: Line) => l.size === 'M').unitPriceCents).toBe(3000);
    await q("update products set status = 'archived' where slug = $1", [BOOT]);
    const cart = (await agent.get('/v1/cart')).body.cart;
    expect(cart.lines.find((l: Line) => l.problem === 'unavailable')).toBeDefined();
    expect(cart.pricing.merchandiseCents).toBe(3000);
    expect(cart.checkoutReady).toBe(false);
  });

  it('flags lines that now exceed what can be sold', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 3 });
    await setProductStock(database, JERSEY, 0, 'M');
    await q("update stock set on_hand = 2 where variant_id = $1 and branch_id = 'sonthormuk'", [v.jerseyM]);
    const cart = (await agent.get('/v1/cart')).body.cart;
    expect(cart.lines[0]).toMatchObject({ qty: 3, maxQty: 1, problem: 'exceeds_stock' });
    expect(cart.pricing.totalCents).toBeGreaterThan(0);
    expect(cart.checkoutReady).toBe(false);
  });
});

describe('expired sign-in on bag actions', () => {
  it('asks the client to sign in again instead of quietly using a guest bag', async () => {
    const res = await request(ctx.app).post('/v1/cart/items').set(bearer('expired-token')).send({ variantId: v.jerseyM, qty: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_token');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
