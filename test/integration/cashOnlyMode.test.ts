import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, PAYMENTS_DEFAULT, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jersey: string;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  await database.pool.query("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(PAYMENTS_DEFAULT)]);
  address = await phnomPenhAddress(database);
  jersey = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await database.pool.query('delete from carts');
  await setStockAt(database, jersey, { sonthormuk: 10 });
});

describe('PAYMENT_METHODS_CASH_ONLY', () => {
  const app = () => memberApp(database, undefined, { config: { paymentsCashOnly: true } }).app;

  it('offers only cash on pickup, and nothing for delivery', async () => {
    const agent = request.agent(app());
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 1 }).expect(200);
    const pickup = await agent.post('/v1/checkout/quote').send({ fulfillment: 'pickup', pickupBranchId: 'sonthormuk' }).expect(200);
    expect(pickup.body.paymentMethods).toEqual(['cash_on_pickup']);
    const delivery = await agent.post('/v1/checkout/quote').send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200);
    expect(delivery.body.paymentMethods).toEqual([]);
  });

  it('refuses KHQR orders and accepts cash on pickup', async () => {
    const agent = request.agent(app());
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 1 }).expect(200);
    const khqr = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(400);
    expect(khqr.body.error.code).toBe('payment_method_unavailable');
    const cash = await agent
      .post('/v1/orders')
      .set(idem())
      .send(guestOrder(address, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' }))
      .expect(201);
    expect(cash.body.payment).toBeNull();
  });
});
