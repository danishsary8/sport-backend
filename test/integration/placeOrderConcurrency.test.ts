import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
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
  await q("delete from stock_movements where reason <> 'import'");
  ctx = memberApp(database);
});

describe('concurrent checkouts', () => {
  it('sells the last unit exactly once', async () => {
    for (let round = 0; round < 5; round++) {
      await q('delete from carts');
      await q('delete from orders');
      // 2 on hand at one branch, buffer 1 → one unit sellable online.
      await setStockAt(database, jerseyM, { sonthormuk: 2 });
      const a = request.agent(ctx.app);
      const b = request.agent(ctx.app);
      await a.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
      await b.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
      const [ra, rb] = await Promise.all([
        a.post('/v1/orders').set(idem()).send(guestOrder(address)),
        b.post('/v1/orders').set(idem()).send(guestOrder(address)),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 409]);
      expect([ra, rb].find((r) => r.status === 409)!.body.error.code).toBe('stock_changed');
      const s = (await q("select on_hand, reserved from stock where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyM])).rows[0];
      expect(s).toEqual({ on_hand: 2, reserved: 1 });
    }
  });

  it('creates one order when the same key arrives twice at once', async () => {
    await setStockAt(database, jerseyM, { sonthormuk: 10 });
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    const key = idem();
    const [r1, r2] = await Promise.all([agent.post('/v1/orders').set(key).send(guestOrder(address)), agent.post('/v1/orders').set(key).send(guestOrder(address))]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) expect([r1, r2].find((r) => r.status === 409)!.body.error.code).toBe('request_in_progress');
    expect((await q('select count(*)::int as n from orders')).rows[0].n).toBe(1);
  });
});
