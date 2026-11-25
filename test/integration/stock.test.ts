import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { adjustStock, recordSale, transferStock } from '../../src/modules/stock/service.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let variantA: string;
let variantB: string;

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const stockOf = async (variantId: string, branchId = 'sonthormuk') =>
  (await q('select on_hand, reserved, needs_count from stock where variant_id = $1 and branch_id = $2', [variantId, branchId])).rows[0];
const movements = async (variantId: string) =>
  (await q('select reason, delta_on_hand, ref_id, branch_id from stock_movements where variant_id = $1 and reason <> $2 order by id', [variantId, 'import'])).rows;
const setStock = (variantId: string, onHand: number, reserved = 0, branchId = 'sonthormuk') =>
  q('update stock set on_hand = $2, reserved = $3 where variant_id = $1 and branch_id = $4', [variantId, onHand, reserved, branchId]);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  const v = await q(
    "select v.id from variants v join products p on p.id = v.product_id where p.slug = 'cambodia-national-team-home-jersey-varaman' order by v.size_sort limit 2",
  );
  variantA = v.rows[0].id;
  variantB = v.rows[1].id;
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from stock_movements where reason <> $1', ['import']);
  await setStock(variantA, 2);
  await setStock(variantB, 2);
});

describe('recordSale', () => {
  it('takes units off the shelf and records the sale', async () => {
    const result = await recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: variantA, qty: 1 }] });
    expect(result.lines).toEqual([{ variantId: variantA, onHand: 1 }]);
    expect((await stockOf(variantA)).on_hand).toBe(1);
    expect(await movements(variantA)).toEqual([{ reason: 'store_sale', delta_on_hand: -1, ref_id: result.saleId, branch_id: 'sonthormuk' }]);
  });

  it('refuses to sell more than is on the shelf', async () => {
    await expect(recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: variantA, qty: 3 }] })).rejects.toMatchObject({
      code: 'insufficient_stock',
      status: 409,
    });
    expect((await stockOf(variantA)).on_hand).toBe(2);
    expect(await movements(variantA)).toEqual([]);
  });

  it('refuses to sell units held for online orders', async () => {
    await setStock(variantA, 2, 2);
    await expect(recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: variantA, qty: 1 }] })).rejects.toMatchObject({
      code: 'held_for_online_order',
    });
  });

  it('sells the last unit only once when two tills race', async () => {
    await setStock(variantA, 1);
    const sale = () => recordSale(database.db, { branchId: 'sonthormuk', lines: [{ variantId: variantA, qty: 1 }] });
    const results = await Promise.allSettled([sale(), sale()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await stockOf(variantA)).on_hand).toBe(0);
    expect(await movements(variantA)).toHaveLength(1);
  });

  it('is all-or-nothing across lines', async () => {
    await expect(
      recordSale(database.db, {
        branchId: 'sonthormuk',
        lines: [
          { variantId: variantA, qty: 1 },
          { variantId: variantB, qty: 5 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    expect((await stockOf(variantA)).on_hand).toBe(2);
  });
});

describe('transferStock and adjustStock', () => {
  it('moves units between branches with a shared reference', async () => {
    await setStock(variantA, 0, 0, 'sensok');
    const { refId } = await transferStock(database.db, { variantId: variantA, from: 'sonthormuk', to: 'sensok', qty: 2 });
    expect((await stockOf(variantA)).on_hand).toBe(0);
    expect((await stockOf(variantA, 'sensok')).on_hand).toBe(2);
    const m = await movements(variantA);
    expect(m.map((x) => x.reason)).toEqual(['transfer_out', 'transfer_in']);
    expect(new Set(m.map((x) => x.ref_id))).toEqual(new Set([refId]));
  });

  it('records a counted correction and clears the needs-count flag', async () => {
    expect((await stockOf(variantA)).needs_count).toBe(true);
    await adjustStock(database.db, { variantId: variantA, branchId: 'sonthormuk', delta: 5, note: 'Counted shelf' });
    expect(await stockOf(variantA)).toMatchObject({ on_hand: 7, needs_count: false });
  });

  it('never lets a correction go below zero', async () => {
    await expect(adjustStock(database.db, { variantId: variantA, branchId: 'sonthormuk', delta: -3, note: 'x' })).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
  });
});
