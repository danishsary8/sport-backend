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

describe('POST /v1/orders/track', () => {
  it('shows status, timeline, items and totals with the address masked', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const res = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: body.order.number, phone: '012 345 678' }).expect(200);
    const { order } = res.body;
    expect(order.number).toBe(body.order.number);
    expect(order.status).toBe('pending_payment');
    expect(order.timeline.map((t: { to: string }) => t.to)).toEqual(['pending_payment']);
    expect(order.items).toHaveLength(1);
    expect(order.pricing.totalCents).toBe(body.order.pricing.totalCents);
    expect(order.shipAddress).toEqual({
      recipient: 'Sok D.',
      communeName: expect.any(Object),
      districtName: expect.any(Object),
      provinceName: expect.any(Object),
    });
    expect(order.contact).toEqual({ name: 'Sok D.', phone: '***678', channel: 'telegram' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('St 271');
    expect(text).not.toContain('12345678');
    expect(text).not.toContain('dara@example.com');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('gives the same 404 for a wrong phone, an unknown number or a malformed one', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const wrong = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: body.order.number, phone: '099 999 999' }).expect(404);
    const unknown = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: 'SC-2611-ZZZZZ', phone: '012 345 678' }).expect(404);
    const malformed = await request(ctx.app).post('/v1/orders/track').send({ orderNumber: 'SC-bad', phone: '012 345 678' }).expect(404);
    expect(wrong.body).toEqual(unknown.body);
    expect(malformed.body).toEqual(unknown.body);
    expect(unknown.body.error.code).toBe('order_not_found');
  });

  it('limits tracking to 10 tries a minute per address', async () => {
    const limited = memberApp(database, undefined, { routeLimits: true });
    for (let i = 0; i < 10; i++) await request(limited.app).post('/v1/orders/track').send({ orderNumber: 'SC-2611-ZZZZZ', phone: '012345678' }).expect(404);
    await request(limited.app).post('/v1/orders/track').send({ orderNumber: 'SC-2611-ZZZZZ', phone: '012345678' }).expect(429);
  });
});

describe('member order history', () => {
  async function memberOrder(token: string) {
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const res = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
    return res.body.order.number as string;
  }

  it('lists only my orders, newest first, with paging', async () => {
    const me = ctx.fake.token({ uid: 'history-me', phone: '+85512000888' });
    const other = ctx.fake.token({ uid: 'history-other', phone: '+85512000999' });
    const first = await memberOrder(me);
    const second = await memberOrder(me);
    await memberOrder(other);
    const page1 = await request(ctx.app).get('/v1/me/orders?pageSize=1').set(bearer(me)).expect(200);
    expect(page1.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(page1.body.orders[0]).toMatchObject({ number: second, status: 'pending_payment', itemCount: 1 });
    expect(page1.body.orders[0].firstItem.name).toBeTruthy();
    const page2 = await request(ctx.app).get('/v1/me/orders?pageSize=1&page=2').set(bearer(me)).expect(200);
    expect(page2.body.orders[0].number).toBe(first);
  });

  it('shows my order in full but not someone else’s', async () => {
    const me = ctx.fake.token({ uid: 'detail-me', phone: '+85512001111' });
    const other = ctx.fake.token({ uid: 'detail-other', phone: '+85512002222' });
    const mine = await memberOrder(me);
    const res = await request(ctx.app).get(`/v1/me/orders/${mine}`).set(bearer(me)).expect(200);
    expect(res.body.order.shipAddress.street).toBe('St 271, #12');
    expect(res.body.payment.attempt).toBe(1);
    await request(ctx.app).get(`/v1/me/orders/${mine}`).set(bearer(other)).expect(404);
  });
});
