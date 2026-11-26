import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let jersey: string;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  jersey = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await database.pool.query('delete from carts');
  await database.pool.query('delete from orders');
});

describe('shoppers never learn exact stock above 3', () => {
  it('does not reveal a count of 7 through maxQty or the stock error', async () => {
    await setStockAt(database, jersey, { sonthormuk: 8 });
    const agent = request.agent(memberApp(database).app);
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 1 }).expect(200);
    const cart = await agent.get('/v1/cart').expect(200);
    expect(cart.body.cart.lines[0]).toMatchObject({ maxQty: 20, availability: 'ok', lowStockCount: null });
    const tooMany = await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 9 }).expect(409);
    expect(tooMany.body.error.code).toBe('insufficient_stock');
    expect(JSON.stringify(tooMany.body)).not.toMatch(/\b7\b/);
    expect(tooMany.body.error.details.available).toBeNull();
  });

  it('flags a bag line above the real stock even though maxQty stays generic', async () => {
    await setStockAt(database, jersey, { sonthormuk: 10 });
    const agent = request.agent(memberApp(database).app);
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 8 }).expect(200);
    await setStockAt(database, jersey, { sonthormuk: 6 });
    const line = (await agent.get('/v1/cart').expect(200)).body.cart.lines[0];
    expect(line).toMatchObject({ maxQty: 20, problem: 'exceeds_stock' });
    const address = await phnomPenhAddress(database);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(409);
    expect(res.body.error.code).toBe('stock_changed');
    expect(res.body.error.details.lines[0].available).toBeNull();
  });

  it('still tells the exact count when only 1–3 are left', async () => {
    await setStockAt(database, jersey, { sonthormuk: 3 }); // the online safety buffer keeps 1 back
    const agent = request.agent(memberApp(database).app);
    await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 1 }).expect(200);
    expect((await agent.get('/v1/cart').expect(200)).body.cart.lines[0]).toMatchObject({ maxQty: 2, availability: 'low', lowStockCount: 2 });
    const res = await agent.post('/v1/cart/items').send({ variantId: jersey, qty: 3 }).expect(409);
    expect(res.body.error).toMatchObject({ message: 'Only 2 available', details: { available: 2 } });
  });
});
