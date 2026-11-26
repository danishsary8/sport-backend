import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, payOrder, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
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
  await setStockAt(database, jerseyM, { sonthormuk: 10 });
  ctx = memberApp(database);
});

async function memberWithOrder(uid: string) {
  const token = ctx.fake.token({ uid, phone: '+85512009600' });
  await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jerseyM, qty: 1 }).expect(200);
  const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address, { note: 'Call before delivery' })).expect(201);
  return { token, number: placed.body.order.number as string, tranId: placed.body.payment.tranId as string };
}

describe('deleting an account with orders', () => {
  it('waits until every order is finished', async () => {
    const { token } = await memberWithOrder('del-open');
    const res = await request(ctx.app).delete('/v1/me').set(bearer(token)).expect(409);
    expect(res.body.error.code).toBe('open_orders');
  });

  it('keeps finished orders for the accounts but removes who and where', async () => {
    const { token, number, tranId } = await memberWithOrder('del-done');
    await payOrder(ctx.app, tranId);
    await q("update orders set status = 'completed', delivered_at = now() where number = $1", [number]);
    await request(ctx.app).delete('/v1/me').set(bearer(token)).expect(204);
    const order = (await q('select contact_name, contact_phone_e164, contact_email, ship_address, note, total_cents from orders where number = $1', [number])).rows[0];
    expect(order.contact_name).toBe('Deleted customer');
    expect(order.contact_phone_e164).toBe('+85500000000');
    expect(order.contact_email).toBeNull();
    expect(order.note).toBeNull();
    expect(order.total_cents).toBeGreaterThan(0);
    expect(order.ship_address.street).toBeUndefined();
    expect(order.ship_address.phoneE164).toBeUndefined();
    expect(order.ship_address.recipientName).toBe('Deleted customer');
    expect(order.ship_address.provinceCode).toBe('12');
    const items = (await q('select count(*)::int as n from order_items')).rows[0].n;
    expect(items).toBe(1);
  });
});
