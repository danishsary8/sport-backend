import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { BOOT, guestOrder, idem, JERSEY, PAYMENTS_DEFAULT, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
const v = {} as Record<'jerseyM' | 'jerseyL' | 'boot', string>;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const setPayments = (value: object) => q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(value)]);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  await setPayments(PAYMENTS_DEFAULT);
  address = await phnomPenhAddress(database);
  v.jerseyM = await variantId(database, JERSEY, 'M');
  v.jerseyL = await variantId(database, JERSEY, 'L');
  v.boot = await variantId(database, BOOT);
});
afterAll(async () => {
  await setPayments(PAYMENTS_DEFAULT);
  await closeTestDb();
});
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await q('delete from notification_outbox');
  await q("delete from stock_movements where reason <> 'import'");
  await q("update products set status = 'active'");
  await q("update promotions set max_uses_per_user = null, used_count = 0, max_uses = null where code = 'CASTLE10'");
  await setProductStock(database, JERSEY, 10);
  await setProductStock(database, BOOT, 10);
  ctx = memberApp(database);
});

async function guestWithBag(lines: { variantId: string; qty: number }[]) {
  const agent = request.agent(ctx.app);
  for (const line of lines) await agent.post('/v1/cart/items').send(line).expect(200);
  return agent;
}

describe('POST /v1/orders — guest', () => {
  it('places a KHQR order priced exactly like the bag and holds the stock', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 2 }]);
    const cart = await agent.get('/v1/cart?provinceCode=12&shippingMethodId=pp_rider').expect(200);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);

    const { order, payment, orderAccessToken } = res.body;
    expect(order.number).toMatch(/^SC-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(order.status).toBe('pending_payment');
    expect(order.pricing.totalCents).toBe(cart.body.cart.pricing.totalCents);
    expect(order.pricing.totalKhr).toBe(cart.body.cart.pricing.totalKhr);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ qty: 2, size: 'M', unitPriceCents: cart.body.cart.lines[0].unitPriceCents });
    expect(order.items[0].allocations).toBeUndefined();
    expect(order.shipAddress).toMatchObject({ provinceCode: '12', street: 'St 271, #12', phoneE164: '+85512345678' });
    expect(order.shipAddress.provinceName.en).toBeTruthy();
    expect(payment).toMatchObject({ attempt: 1, method: 'aba_khqr', status: 'pending', instructions: { kind: 'qr' } });
    expect(payment.amountCents).toBe(order.pricing.totalCents);
    expect(typeof orderAccessToken).toBe('string');

    const reserved = await q('select sum(reserved)::int as n from stock where variant_id = $1', [v.jerseyM]);
    expect(reserved.rows[0].n).toBe(2);
    const moves = await q("select ref_id from stock_movements where reason = 'order_reserve'");
    expect(moves.rows.every((m) => m.ref_id === order.number)).toBe(true);

    const row = (await q('select created_at, reserved_until from orders where number = $1', [order.number])).rows[0];
    expect(new Date(row.reserved_until).getTime() - new Date(row.created_at).getTime()).toBeGreaterThan(30 * 60_000 - 5_000);
    expect(new Date(row.reserved_until).getTime() - new Date(row.created_at).getTime()).toBeLessThan(30 * 60_000 + 5_000);

    const after = await agent.get('/v1/cart').expect(200);
    expect(after.body.cart.lines).toEqual([]);
    const outbox = await q('select template, recipient from notification_outbox');
    expect(outbox.rows).toEqual([{ template: 'order_placed', recipient: 'ops' }]);
  });

  it('requires an Idempotency-Key', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const res = await agent.post('/v1/orders').send(guestOrder(address)).expect(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it('replays the same key with the same response and one order', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const key = idem();
    const first = await agent.post('/v1/orders').set(key).send(guestOrder(address)).expect(201);
    const second = await agent.post('/v1/orders').set(key).send(guestOrder(address)).expect(201);
    expect(second.body).toEqual(first.body);
    expect((await q('select count(*)::int as n from orders')).rows[0].n).toBe(1);
  });

  it('refuses the same key with a different body', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const key = idem();
    await agent.post('/v1/orders').set(key).send(guestOrder(address)).expect(201);
    const res = await agent.post('/v1/orders').set(key).send(guestOrder(address, { note: 'different' })).expect(422);
    expect(res.body.error.code).toBe('idempotency_mismatch');
  });

  it('needs the terms accepted', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    await agent.post('/v1/orders').set(idem()).send(guestOrder(address, { acceptTerms: false })).expect(400);
  });

  it('refuses a payment method the shop has switched off', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address, { paymentMethod: 'wing' })).expect(400);
    expect(res.body.error.code).toBe('payment_method_unavailable');
  });

  it('refuses an empty bag', async () => {
    const res = await request(ctx.app).post('/v1/orders').set(idem()).send(guestOrder(address)).expect(400);
    expect(res.body.error.code).toBe('cart_empty');
  });

  it('blocks a bag with an archived item, and the key can be reused after fixing it', async () => {
    const agent = await guestWithBag([
      { variantId: v.jerseyM, qty: 1 },
      { variantId: v.boot, qty: 1 },
    ]);
    await q("update products set status = 'archived' where slug = $1", [BOOT]);
    const key = idem();
    const res = await agent.post('/v1/orders').set(key).send(guestOrder(address)).expect(409);
    expect(res.body.error.code).toBe('checkout_not_ready');
    expect(res.body.error.details.lines[0].problem).toBe('unavailable');
    const cart = await agent.get('/v1/cart').expect(200);
    const archived = cart.body.cart.lines.find((l: { problem: string | null }) => l.problem === 'unavailable');
    await agent.delete(`/v1/cart/items/${archived.id}`).expect(200);
    await agent.post('/v1/orders').set(key).send(guestOrder(address)).expect(201);
  });

  it('refuses pickup at a branch without the stock', async () => {
    await setStockAt(database, v.jerseyM, { sonthormuk: 10 });
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const res = await agent
      .post('/v1/orders')
      .set(idem())
      .send(guestOrder(address, { fulfillment: 'pickup', pickupBranchId: 'sensok', address: undefined, shippingMethodId: undefined }))
      .expect(409);
    expect(res.body.error.code).toBe('stock_changed');
  });

  it('splits a delivery line across branches', async () => {
    await setStockAt(database, v.jerseyM, { sonthormuk: 3, sensok: 2 });
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 3 }]);
    await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    const allocs = await q('select branch_id, qty from order_item_allocations order by branch_id');
    expect(allocs.rows).toEqual([
      { branch_id: 'sensok', qty: 1 },
      { branch_id: 'sonthormuk', qty: 2 },
    ]);
  });

  it('ignores prices sent by the client', async () => {
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const cart = await agent.get('/v1/cart').expect(200);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address, { totalCents: 1, pricing: { totalCents: 1 } })).expect(201);
    expect(res.body.order.pricing.totalCents).toBe(cart.body.cart.pricing.totalCents);
  });

  it('enforces a per-customer promo limit by phone', async () => {
    await q("update promotions set max_uses_per_user = 1 where code = 'CASTLE10'");
    const first = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    await first.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    const placed = await first.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    expect(placed.body.order.pricing.discounts.some((d: { kind: string }) => d.kind === 'promo')).toBe(true);
    expect((await q("select used_count from promotions where code = 'CASTLE10'")).rows[0].used_count).toBe(1);

    const second = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    await second.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    const res = await second.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(409);
    expect(res.body.error.code).toBe('promo_limit_reached');
  });

  it('keeps the order when the payment service fails, so the customer can retry', async () => {
    ctx.payments.failNextCreate();
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    expect(res.body.payment).toBeNull();
    expect(res.body.paymentError).toMatch(/payment service/i);
    expect(res.body.order.status).toBe('pending_payment');
  });

  it('holds pickup stock for 48 hours for cash on pickup', async () => {
    await setPayments({ ...PAYMENTS_DEFAULT, cash_on_pickup: true });
    try {
      const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
      const res = await agent
        .post('/v1/orders')
        .set(idem())
        .send(guestOrder(address, { fulfillment: 'pickup', pickupBranchId: 'sensok', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' }))
        .expect(201);
      expect(res.body.order.status).toBe('awaiting_pickup_payment');
      expect(res.body.payment).toBeNull();
      const row = (await q('select created_at, reserved_until from orders')).rows[0];
      expect(new Date(row.reserved_until).getTime() - new Date(row.created_at).getTime()).toBeGreaterThan(48 * 3600_000 - 5_000);
    } finally {
      await setPayments(PAYMENTS_DEFAULT);
    }
  });

  it('never writes the customer phone into the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    ctx = memberApp(database, undefined, { logger: createLogger({ logLevel: 'trace', nodeEnv: 'test' }, sink) });
    const agent = await guestWithBag([{ variantId: v.jerseyM, qty: 1 }]);
    await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('12345678');
  });
});

describe('POST /v1/orders — member', () => {
  it('uses a saved address and the member discount the bag showed', async () => {
    const token = ctx.fake.token({ uid: 'order-silver', phone: '+85512000222' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    await q("insert into loyalty_accounts (user_id, tier) select id, 'silver' from users where firebase_uid = 'order-silver'");
    const { label: _label, ...rest } = { label: 'Home', ...address };
    const saved = await request(ctx.app).post('/v1/me/addresses').set(bearer(token)).send({ label: 'Home', ...rest }).expect(201);
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: v.boot, qty: 1 }).expect(200);
    const cart = await request(ctx.app).get('/v1/cart').set(bearer(token)).expect(200);

    const body = guestOrder(address, { address: undefined, addressId: saved.body.address.id });
    const res = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(body).expect(201);
    expect(res.body.order.pricing.discountCents).toBe(cart.body.cart.pricing.discounts.reduce((s: number, d: { amountCents: number }) => s + d.amountCents, 0));
    expect(res.body.order.pricing.totalCents).toBe(cart.body.cart.pricing.totalCents);
    expect(res.body.orderAccessToken).toBeNull();
    expect((await q('select user_id from orders')).rows[0].user_id).toBeTruthy();
  });

  it("can't use another member's address", async () => {
    const owner = ctx.fake.token({ uid: 'addr-owner', phone: '+85512000333' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(owner)).expect(200);
    const saved = await request(ctx.app).post('/v1/me/addresses').set(bearer(owner)).send({ label: 'Home', ...address }).expect(201);
    const thief = ctx.fake.token({ uid: 'addr-thief', phone: '+85512000444' });
    await request(ctx.app).post('/v1/cart/items').set(bearer(thief)).send({ variantId: v.jerseyM, qty: 1 }).expect(200);
    const body = guestOrder(address, { address: undefined, addressId: saved.body.address.id });
    await request(ctx.app).post('/v1/orders').set(bearer(thief)).set(idem()).send(body).expect(404);
  });
});
