import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let jersey: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  jersey = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await setStockAt(database, jersey, { sonthormuk: 10 });
  ctx = memberApp(database);
});

async function memberOrder(uid: string) {
  const token = ctx.fake.token({ uid, phone: '+85512345678' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
  await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jersey, qty: 2 }).expect(200);
  const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(await phnomPenhAddress(database))).expect(201);
  return { token, number: placed.body.order.number as string };
}

describe('return information on the order', () => {
  it('shows no return window before delivery', async () => {
    const { token, number } = await memberOrder('returns-before');
    const res = await request(ctx.app).get(`/v1/me/orders/${number}`).set(bearer(token)).expect(200);
    expect(res.body.order).toMatchObject({ deliveredAt: null, returnWindow: null });
    expect(res.body.order.items[0].returnableQty).toBe(0);
  });

  it('shows the exchange and refund deadlines and the units still returnable after delivery', async () => {
    const { token, number } = await memberOrder('returns-after');
    const delivered = new Date(Date.now() - 3 * 86_400_000);
    delivered.setUTCMilliseconds(0);
    const plus = (days: number) => new Date(delivered.getTime() + days * 86_400_000).toISOString();
    await q("update orders set status = 'delivered', payment_status = 'paid', delivered_at = $2 where number = $1", [number, delivered]);
    const res = await request(ctx.app).get(`/v1/me/orders/${number}`).set(bearer(token)).expect(200);
    expect(res.body.order.deliveredAt).toBe(delivered.toISOString());
    expect(res.body.order.returnWindow).toEqual({ exchangeUntil: plus(30), refundUntil: plus(14) });
    expect(res.body.order.items[0].returnableQty).toBe(2);
  });

  it('shows nothing returnable once both windows have closed', async () => {
    const { token, number } = await memberOrder('returns-late');
    await q("update orders set status = 'completed', payment_status = 'paid', delivered_at = now() - interval '40 days' where number = $1", [number]);
    const res = await request(ctx.app).get(`/v1/me/orders/${number}`).set(bearer(token)).expect(200);
    expect(res.body.order.returnWindow).not.toBeNull();
    expect(res.body.order.items[0].returnableQty).toBe(0);
  });
});
