import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { JERSEY, phnomPenhAddress, placeGuestOrder, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
});
afterAll(closeTestDb);

describe('counter sale blocked by an online order', () => {
  it('tells staff which order holds the unit', async () => {
    const ctx = memberApp(database);
    const jerseyM = await variantId(database, JERSEY, 'M');
    await setStockAt(database, jerseyM, { sonthormuk: 2 });
    const { body } = await placeGuestOrder(ctx.app, await phnomPenhAddress(database), { variantId: jerseyM, qty: 1 });
    const staff = await staffToken(ctx.app, database, ctx.fake, 'counter-staff', 'staff', 'sonthormuk');
    const res = await request(ctx.app).post('/v1/admin/stock/sale').set(bearer(staff)).send({ lines: [{ variantId: jerseyM, qty: 2 }] }).expect(409);
    expect(res.body.error.code).toBe('held_for_online_order');
    expect(res.body.error.details.orders).toEqual([body.order.number]);
  });
});
