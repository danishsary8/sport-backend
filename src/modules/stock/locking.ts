import { and, eq, sql } from 'drizzle-orm';
import { stock, type StockRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { applyMovement, type Tx } from './service.js';

export interface StockKey {
  variantId: string;
  branchId: string;
}
export type StockAllocation = StockKey & { qty: number };

const keyOf = (k: StockKey) => `${k.variantId}@${k.branchId}`;
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** Distinct keys in (variantId, branchId) ascending order: the one lock order every stock writer uses. */
export function sortStockKeys(keys: StockKey[]): StockKey[] {
  const unique = new Map(keys.map((k) => [keyOf(k), { variantId: k.variantId, branchId: k.branchId }]));
  return [...unique.values()].sort((p, q) => compare(p.variantId, q.variantId) || compare(p.branchId, q.branchId));
}

/** Locks the stock rows (creating missing ones) in ascending key order. */
export async function lockStock(tx: Tx, keys: StockKey[]): Promise<Map<string, StockRow>> {
  const rows = new Map<string, StockRow>();
  for (const k of sortStockKeys(keys)) {
    await tx.insert(stock).values({ variantId: k.variantId, branchId: k.branchId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(stock)
      .where(and(eq(stock.variantId, k.variantId), eq(stock.branchId, k.branchId)))
      .for('update');
    if (!row) throw new AppError('not_found', 404, 'Unknown variant or branch');
    rows.set(keyOf(k), row);
  }
  return rows;
}

/** Sums quantities per key and returns them in lock order. */
function merged(allocs: StockAllocation[]): StockAllocation[] {
  const sums = new Map<string, number>();
  for (const a of allocs) sums.set(keyOf(a), (sums.get(keyOf(a)) ?? 0) + a.qty);
  return sortStockKeys(allocs).map((k) => ({ ...k, qty: sums.get(keyOf(k))! }));
}

async function bufferSetting(tx: Tx): Promise<number> {
  const r = await tx.execute<{ units: number | null }>(sql`select (value->>'units')::int as units from settings where key = 'online_safety_buffer'`);
  return r.rows[0]?.units ?? 1;
}

/** Holds units for an order (or an exchange); fails with stock_changed if online availability no longer covers them. */
export async function reserveAllocations(
  tx: Tx,
  allocs: StockAllocation[],
  refId: string,
  reason: 'order_reserve' | 'exchange_reserve' = 'order_reserve',
): Promise<void> {
  const lines = merged(allocs);
  const rows = await lockStock(tx, lines);
  const buffer = await bufferSetting(tx);
  const short = lines
    .map((l) => {
      const row = rows.get(keyOf(l))!;
      return { ...l, available: Math.max(0, row.onHand - row.reserved - (row.onlineBuffer ?? buffer)) };
    })
    .filter((l) => l.available < l.qty);
  if (short.length > 0) {
    throw new AppError('stock_changed', 409, 'Some items sold out while you were checking out', {
      lines: short.map((s) => ({ variantId: s.variantId, available: s.available })),
    });
  }
  for (const l of lines) {
    await applyMovement(tx, { variantId: l.variantId, branchId: l.branchId, deltaOnHand: 0, deltaReserved: l.qty, reason, refId });
  }
}

/** Gives held units back to the shop (order expired or cancelled). */
export async function releaseAllocations(tx: Tx, allocs: StockAllocation[], refId: string): Promise<void> {
  const lines = merged(allocs);
  await lockStock(tx, lines);
  for (const l of lines) {
    await applyMovement(tx, { variantId: l.variantId, branchId: l.branchId, deltaOnHand: 0, deltaReserved: -l.qty, reason: 'order_release', refId });
  }
}

/** Paid: the held units leave the shelf. */
export async function commitAllocations(tx: Tx, allocs: StockAllocation[], refId: string): Promise<void> {
  const lines = merged(allocs);
  await lockStock(tx, lines);
  for (const l of lines) {
    await applyMovement(tx, { variantId: l.variantId, branchId: l.branchId, deltaOnHand: -l.qty, deltaReserved: -l.qty, reason: 'order_commit', refId });
  }
}
