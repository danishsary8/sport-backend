import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, placeGuestOrder, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await setProductStock(database, JERSEY, 10);
  ctx = memberApp(database);
});

describe('GET /v1/orders/:number/payment-status', () => {
  it('answers the owner holding the token, and nobody else', async () => {
    const a = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const b = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const ok = await request(ctx.app).get(`/v1/orders/${a.body.order.number}/payment-status`).set('x-order-token', a.body.orderAccessToken!).expect(200);
    expect(ok.body).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid', latestPayment: { attempt: 1, status: 'pending' } });
    expect(ok.headers['cache-control']).toBe('no-store');
    const wrong = await request(ctx.app).get(`/v1/orders/${a.body.order.number}/payment-status`).set('x-order-token', b.body.orderAccessToken!).expect(404);
    expect(wrong.body.error.code).toBe('order_not_found');
    await request(ctx.app).get(`/v1/orders/${a.body.order.number}/payment-status`).expect(404);
    await request(ctx.app).get('/v1/orders/SC-2611-NOPE0/payment-status').set('x-order-token', a.body.orderAccessToken!).expect(404);
  });

  it('lets the member who placed it check, but not another member', async () => {
    const owner = ctx.fake.token({ uid: 'status-owner', phone: '+85512000666' });
    await request(ctx.app).post('/v1/cart/items').set(bearer(owner)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(owner)).set(idem()).send(guestOrder(address)).expect(201);
    await request(ctx.app).get(`/v1/orders/${placed.body.order.number}/payment-status`).set(bearer(owner)).expect(200);
    const other = ctx.fake.token({ uid: 'status-other', phone: '+85512000777' });
    await request(ctx.app).get(`/v1/orders/${placed.body.order.number}/payment-status`).set(bearer(other)).expect(404);
  });

  it('asks the payment service at most once every 5 seconds', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const before = ctx.payments.checkCalls;
    for (let i = 0; i < 3; i++) {
      await request(ctx.app).get(`/v1/orders/${body.order.number}/payment-status`).set('x-order-token', body.orderAccessToken!).expect(200);
    }
    expect(ctx.payments.checkCalls - before).toBe(1);
  });

  it('reports paid as soon as the provider says so', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    const res = await request(ctx.app).get(`/v1/orders/${body.order.number}/payment-status`).set('x-order-token', body.orderAccessToken!).expect(200);
    expect(res.body).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });
});

describe('POST /v1/orders/:number/payments', () => {
  it('switches to card and cancels the old QR', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const res = await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/payments`)
      .send({ method: 'card', contactPhone: '+855 12 345 678', orderAccessToken: body.orderAccessToken })
      .expect(201);
    expect(res.body.payment).toMatchObject({ attempt: 2, method: 'card', instructions: { kind: 'redirect' } });
    expect(ctx.payments.cancelled).toContain(body.payment!.tranId);
    expect((await q('select status from payments where attempt = 1')).rows[0].status).toBe('cancelled');
  });

  it('needs the right phone as well as the token', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/payments`)
      .send({ method: 'card', contactPhone: '+85599999999', orderAccessToken: body.orderAccessToken })
      .expect(404);
  });

  it('refuses after the hold has expired', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await q("update orders set reserved_until = now() - interval '1 minute'");
    const res = await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/payments`)
      .send({ method: 'aba_khqr', contactPhone: '012345678', orderAccessToken: body.orderAccessToken })
      .expect(409);
    expect(res.body.error.code).toBe('order_not_payable');
  });
});

describe('GET /v1/orders/:number', () => {
  it('shows the guest their order without internal fields', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const res = await request(ctx.app).get(`/v1/orders/${body.order.number}`).set('x-order-token', body.orderAccessToken!).expect(200);
    expect(res.body.order.number).toBe(body.order.number);
    expect(res.body.payment.attempt).toBe(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('allocation');
    expect(text).not.toContain('needsRefund');
  });
});

describe('dev payment routes', () => {
  it('approves a fake payment in development', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const res = await request(ctx.app).post(`/v1/dev/payments/${body.payment!.tranId}/approve`).expect(200);
    expect(res.body.result).toBe('approved');
    const page = await request(ctx.app).get(`/v1/dev/payments/${body.payment!.tranId}/checkout`).expect(200);
    expect(page.text).toContain('Approve test payment');
  });

  it('do not exist in production', async () => {
    const prod = memberApp(database, undefined, { config: { nodeEnv: 'production' } });
    await request(prod.app).post('/v1/dev/payments/SC2611AAAAA-1/approve').expect(404);
  });
});
