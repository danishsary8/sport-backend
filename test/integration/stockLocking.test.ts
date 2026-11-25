import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '../../src/db/client.js';
import { commitAllocations, lockStock, releaseAllocations, reserveAllocations, sortStockKeys } from '../../src/modules/stock/locking.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let a: string;
let b: string;

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const stockOf = async (variantId: string, branchId = 'sonthormuk') =>
  (await q('select on_hand, reserved from stock where variant_id = $1 and branch_id = $2', [variantId, branchId])).rows[0];
const setStock = (variantId: string, onHand: number, reserved = 0, branchId = 'sonthormuk') =>
  q('update stock set on_hand = $2, reserved = $3, online_buffer = null where variant_id = $1 and branch_id = $4', [variantId, onHand, reserved, branchId]);
const reasons = async (variantId: string) =>
  (await q("select reason, delta_on_hand, delta_reserved, ref_id from stock_movements where variant_id = $1 and reason <> 'import' order by id", [variantId])).rows;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  const v = await q("select v.id from variants v join products p on p.id = v.product_id where p.slug = 'cambodia-national-team-home-jersey-varaman' order by v.id limit 2");
  [a, b] = [v.rows[0].id, v.rows[1].id];
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q("delete from stock_movements where reason <> 'import'");
  for (const v of [a, b]) for (const br of ['sonthormuk', 'sensok']) await setStock(v, 3, 0, br);
});

describe('sortStockKeys', () => {
  it('orders by variant then branch and drops duplicates', () => {
    expect(
      sortStockKeys([
        { variantId: 'b', branchId: 'x' },
        { variantId: 'a', branchId: 'y' },
        { variantId: 'a', branchId: 'x' },
        { variantId: 'b', branchId: 'x' },
      ]),
    ).toEqual([
      { variantId: 'a', branchId: 'x' },
      { variantId: 'a', branchId: 'y' },
      { variantId: 'b', branchId: 'x' },
    ]);
  });
});

describe('reserve, commit and release', () => {
  it('reserves up to the online availability (after the safety buffer)', async () => {
    await database.db.transaction((tx) => reserveAllocations(tx, [{ variantId: a, branchId: 'sonthormuk', qty: 2 }], 'SC-1'));
    expect(await stockOf(a)).toEqual({ on_hand: 3, reserved: 2 });
    expect(await reasons(a)).toEqual([{ reason: 'order_reserve', delta_on_hand: 0, delta_reserved: 2, ref_id: 'SC-1' }]);
  });

  it('refuses to reserve past the buffer with stock_changed', async () => {
    await expect(
      database.db.transaction((tx) => reserveAllocations(tx, [{ variantId: a, branchId: 'sonthormuk', qty: 3 }], 'SC-2')),
    ).rejects.toMatchObject({ code: 'stock_changed', status: 409, details: { lines: [{ variantId: a, available: 2 }] } });
    expect(await stockOf(a)).toEqual({ on_hand: 3, reserved: 0 });
  });

  it('commits a reservation off the shelf', async () => {
    const allocs = [{ variantId: a, branchId: 'sonthormuk', qty: 2 }];
    await database.db.transaction((tx) => reserveAllocations(tx, allocs, 'SC-3'));
    await database.db.transaction((tx) => commitAllocations(tx, allocs, 'SC-3'));
    expect(await stockOf(a)).toEqual({ on_hand: 1, reserved: 0 });
    expect((await reasons(a)).map((r) => r.reason)).toEqual(['order_reserve', 'order_commit']);
  });

  it('releases a reservation', async () => {
    const allocs = [{ variantId: a, branchId: 'sonthormuk', qty: 1 }];
    await database.db.transaction((tx) => reserveAllocations(tx, allocs, 'SC-4'));
    await database.db.transaction((tx) => releaseAllocations(tx, allocs, 'SC-4'));
    expect(await stockOf(a)).toEqual({ on_hand: 3, reserved: 0 });
    expect((await reasons(a)).map((r) => r.reason)).toEqual(['order_reserve', 'order_release']);
  });

  it('locks rows in one order, so opposite-order callers never deadlock', async () => {
    for (let round = 0; round < 5; round++) {
      const one = database.db.transaction(async (tx) => {
        await lockStock(tx, [{ variantId: b, branchId: 'sensok' }, { variantId: a, branchId: 'sonthormuk' }]);
        await tx.execute(sql`select pg_sleep(0.1)`);
      });
      const two = database.db.transaction(async (tx) => {
        await lockStock(tx, [{ variantId: a, branchId: 'sonthormuk' }, { variantId: b, branchId: 'sensok' }]);
        await tx.execute(sql`select pg_sleep(0.1)`);
      });
      await expect(Promise.all([one, two])).resolves.toBeDefined();
    }
  });
});
