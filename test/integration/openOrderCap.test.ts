import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, PAYMENTS_DEFAULT, phnomPenhAddress, placeGuestOrder, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jersey: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  await q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify({ ...PAYMENTS_DEFAULT, cash_on_pickup: true })]);
  address = await phnomPenhAddress(database);
  jersey = await variantId(database, JERSEY, 'M');
});
afterAll(async () => {
  await q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(PAYMENTS_DEFAULT)]);
  await closeTestDb();
});
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await setStockAt(database, jersey, { sonthormuk: 20 });
});

describe('open unpaid orders per phone', () => {
  it('refuses a fourth unpaid order for the same phone, counting cash-on-pickup holds', async () => {
    const { app } = memberApp(database);
    await placeGuestOrder(app, address, { variantId: jersey, qty: 1 });
    await placeGuestOrder(app, address, { variantId: jersey, qty: 1 });
    await placeGuestOrder(app, address, { variantId: jersey, qty: 1 }, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' });
    const agent = request.agent(app);
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 1 }).expect(200);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(429);
    expect(res.body.error.code).toBe('too_many_open_orders');
    expect((await q("select reserved from stock where variant_id = $1 and branch_id = 'sonthormuk'", [jersey])).rows[0].reserved).toBe(3);
    // A different phone is not affected.
    await agent
      .post('/v1/orders')
      .set(idem())
      .send(guestOrder(address, { contact: { name: 'Chan', phone: '012 999 888', email: null, channel: 'phone' } }))
      .expect(201);
  });

  it('frees a slot once an order is paid or expires', async () => {
    const { app } = memberApp(database);
    for (let i = 0; i < 3; i++) await placeGuestOrder(app, address, { variantId: jersey, qty: 1 });
    await q("update orders set status = 'expired' where id = (select id from orders order by created_at limit 1)");
    await placeGuestOrder(app, address, { variantId: jersey, qty: 1 });
  });
});
