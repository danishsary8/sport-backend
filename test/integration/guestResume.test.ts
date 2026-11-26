import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, placeGuestOrder, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jersey: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const reserved = async () => (await q("select reserved from stock where variant_id = $1 and branch_id = 'sonthormuk'", [jersey])).rows[0].reserved;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jersey = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await setStockAt(database, jersey, { sonthormuk: 10 });
  ctx = memberApp(database);
});

describe('a guest who lost the order link', () => {
  it('gets a fresh order token from tracking while the order awaits payment, and can pay again', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jersey, qty: 1 });
    const tracked = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: body.order.number, phone: '012 345 678' }).expect(200);
    expect(tracked.body.orderAccessToken).toEqual(expect.any(String));
    await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/payments`)
      .send({ method: 'card', contactPhone: '012 345 678', orderAccessToken: tracked.body.orderAccessToken })
      .expect(201);
  });

  it('gets no token once the order is paid', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jersey, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    await request(ctx.app).get(`/v1/orders/${body.order.number}/payment-status`).set('x-order-token', body.orderAccessToken!).expect(200);
    const tracked = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: body.order.number, phone: '012 345 678' }).expect(200);
    expect(tracked.body.orderAccessToken).toBeNull();
  });
});

describe('POST /v1/orders/:number/cancel', () => {
  it('lets the guest cancel an unpaid order, releasing stock and closing the QR', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jersey, qty: 2 });
    expect(await reserved()).toBe(2);
    await request(ctx.app).post(`/v1/orders/${body.order.number}/cancel`).send({ contactPhone: '012 345 678' }).expect(404);
    const res = await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/cancel`)
      .set('x-order-token', body.orderAccessToken!)
      .send({ contactPhone: '012 345 678' })
      .expect(200);
    expect(res.body.order.status).toBe('cancelled');
    expect(await reserved()).toBe(0);
    expect(ctx.payments.cancelled).toContain(body.payment!.tranId);
  });

  it('needs the contact phone from a guest', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jersey, qty: 1 });
    await request(ctx.app).post(`/v1/orders/${body.order.number}/cancel`).set('x-order-token', body.orderAccessToken!).send({ contactPhone: '012 000 000' }).expect(404);
  });

  it('refuses once the order is paid', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jersey, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    await request(ctx.app).get(`/v1/orders/${body.order.number}/payment-status`).set('x-order-token', body.orderAccessToken!).expect(200);
    const res = await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/cancel`)
      .set('x-order-token', body.orderAccessToken!)
      .send({ contactPhone: '012 345 678' })
      .expect(409);
    expect(res.body.error.code).toBe('order_not_cancellable');
  });

  it('lets a member cancel their own unpaid order', async () => {
    const token = ctx.fake.token({ uid: 'cancel-member', phone: '+85512345678' });
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jersey, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
    await request(ctx.app).post(`/v1/orders/${placed.body.order.number}/cancel`).set(bearer(token)).send({}).expect(200);
  });
});
