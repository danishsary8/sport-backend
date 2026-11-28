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
const PAYMENTS_DEFAULT = { aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false };
const setPayments = (value: object) => q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(value)]);

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
  await setPayments(PAYMENTS_DEFAULT);
  v.jerseyM = await variant(JERSEY, 'M');
  v.boot = await variant(BOOT);
});
afterAll(async () => {
  await setPayments(PAYMENTS_DEFAULT);
  await closeTestDb();
});
beforeEach(async () => {
  await q('delete from carts');
  await setProductStock(database, JERSEY, 10);
  await setProductStock(database, BOOT, 10);
  ctx = memberApp(database);
});

describe('POST /v1/checkout/quote', () => {
  it('prices exactly like the cart for a guest', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const cart = await agent.get('/v1/cart?provinceCode=12&shippingMethodId=pp_rider').expect(200);
    const quote = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(quote.body.cart.pricing).toEqual(cart.body.cart.pricing);
    expect(quote.headers['cache-control']).toBe('no-store');
  });

  it('prices exactly like the cart for a Silver member', async () => {
    const token = ctx.fake.token({ uid: 'quote-silver', phone: '+85512000111' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    await q("insert into loyalty_accounts (user_id, tier) select id, 'silver' from users where firebase_uid = 'quote-silver'");
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: v.boot, qty: 1 }).expect(200);
    const cart = await request(ctx.app).get('/v1/cart').set(bearer(token)).expect(200);
    const quote = await request(ctx.app).post('/v1/checkout/quote').set(bearer(token)).send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(quote.body.cart.pricing).toEqual(cart.body.cart.pricing);
    expect(quote.body.cart.pricing.memberPerks.applied).toContain('member_discount');
  });

  it('offers the courier, not the rider, outside Phnom Penh', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const quote = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '17', shippingMethodId: 'province_courier' }).expect(200);
    const options = Object.fromEntries(quote.body.shippingOptions.map((o: { methodId: string }) => [o.methodId, o]));
    expect(options.pp_rider).toMatchObject({ available: false, feeCents: null });
    expect(options.province_courier).toMatchObject({ available: true, feeCents: 200 });
    expect(quote.body.cart.pricing.shippingCents).toBe(200);
  });

  it('shows the free threshold per option, as this bag would pay it', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 2 }).expect(200);
    const quote = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(quote.body.shippingOptions.find((o: { methodId: string }) => o.methodId === 'pp_rider')).toMatchObject({ available: true, feeCents: 0 });
  });

  it('charges nothing for pickup and lists the pickup branches', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const quote = await agent.post('/v1/checkout/quote').send({ fulfillment: 'pickup', pickupBranchId: 'sensok' }).expect(200);
    expect(quote.body.cart.pricing.shippingCents).toBe(0);
    expect(quote.body.pickupBranches.map((b: { id: string }) => b.id)).toContain('sensok');
  });

  it('tries a promo code without saving it on the bag', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const quote = await agent.post('/v1/checkout/quote').send({ fulfillment: 'pickup', pickupBranchId: 'sensok', promoCode: 'castle10' }).expect(200);
    expect(quote.body.cart.pricing.promo).toMatchObject({ code: 'CASTLE10', applied: true });
    const cart = await agent.get('/v1/cart').expect(200);
    expect(cart.body.cart.promoCode).toBeNull();
  });

  it('lists enabled payment methods, with cash only for pickup', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const delivery = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(delivery.body.paymentMethods).toEqual(['aba_khqr', 'card']);
    await setPayments({ ...PAYMENTS_DEFAULT, cash_on_pickup: true });
    const delivery2 = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(delivery2.body.paymentMethods).toEqual(['aba_khqr', 'card']);
    const pickup = await agent.post('/v1/checkout/quote').send({ fulfillment: 'pickup', pickupBranchId: 'sensok' }).expect(200);
    expect(pickup.body.paymentMethods).toEqual(['aba_khqr', 'card', 'cash_on_pickup']);
    await setPayments(PAYMENTS_DEFAULT);
  });

  it('answers an empty bag without an error', async () => {
    const quote = await request(ctx.app).post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(quote.body.cart.checkoutReady).toBe(false);
    expect(quote.body.cart.lines).toEqual([]);
  });
});
