import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { stock, stockMovements, variants, type StockRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { lockStock } from './locking.js';

export type StockReason =
  | 'import'
  | 'admin_adjust'
  | 'store_sale'
  | 'transfer_out'
  | 'transfer_in'
  | 'order_reserve'
  | 'order_release'
  | 'order_commit'
  | 'rma_restock'
  | 'exchange_reserve'
  | 'exchange_commit'
  | 'exchange_release'
  | 'order_cancel';

export type { Tx } from '../../db/exec.js';
import type { Tx } from '../../db/exec.js';

export interface Movement {
  variantId: string;
  branchId: string;
  deltaOnHand: number;
  deltaReserved?: number;
  reason: StockReason;
  refId?: string;
  note?: string;
  actorUserId?: string | null;
}

/**
 * The only way stock changes. Locks the (variant, branch) row, checks the invariants
 * (on_hand ≥ 0, reserved ≥ 0, reserved ≤ on_hand), applies the change and writes the audit row,
 * all inside the caller's transaction.
 */
async function assertVariantExists(tx: Tx, variantId: string): Promise<void> {
  const [row] = await tx.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId));
  if (!row) throw new AppError('not_found', 404, 'Unknown product variant', { variantId });
}

export async function applyMovement(tx: Tx, m: Movement): Promise<StockRow> {
  await assertVariantExists(tx, m.variantId);
  await tx.insert(stock).values({ variantId: m.variantId, branchId: m.branchId }).onConflictDoNothing();
  const [current] = await tx
    .select()
    .from(stock)
    .where(and(eq(stock.variantId, m.variantId), eq(stock.branchId, m.branchId)))
    .for('update');
  if (!current) throw new AppError('not_found', 404, 'Unknown variant or branch');

  const deltaReserved = m.deltaReserved ?? 0;
  const onHand = current.onHand + m.deltaOnHand;
  const reserved = current.reserved + deltaReserved;
  if (onHand < 0) {
    throw new AppError('insufficient_stock', 409, `Only ${current.onHand} on hand`, {
      variantId: m.variantId,
      branchId: m.branchId,
      available: current.onHand,
    });
  }
  if (reserved < 0) throw new Error(`Reservation would go negative for ${m.variantId}@${m.branchId}`);
  if (reserved > onHand) {
    throw new AppError('held_for_online_order', 409, `${current.reserved} unit(s) are held for online orders`, {
      variantId: m.variantId,
      branchId: m.branchId,
      reserved: current.reserved,
    });
  }

  const [updated] = await tx
    .update(stock)
    .set({
      onHand,
      reserved,
      updatedAt: sql`now()`,
      ...(m.reason === 'admin_adjust' ? { needsCount: false } : {}),
    })
    .where(and(eq(stock.variantId, m.variantId), eq(stock.branchId, m.branchId)))
    .returning();
  await tx.insert(stockMovements).values({
    variantId: m.variantId,
    branchId: m.branchId,
    deltaOnHand: m.deltaOnHand,
    deltaReserved,
    reason: m.reason,
    refId: m.refId ?? null,
    note: m.note ?? null,
    actorUserId: m.actorUserId ?? null,
  });
  return updated!;
}

/** A counter sale: every line succeeds or none do. */
export async function recordSale(
  db: Db,
  input: { branchId: string; lines: { variantId: string; qty: number }[]; actorUserId?: string | null; note?: string },
): Promise<{ saleId: string; lines: { variantId: string; onHand: number }[] }> {
  const saleId = `SALE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const lines = input.lines;
  return db.transaction(async (tx) => {
    // Lock every row first, in the shared (variant, branch) order, so sales and orders can't deadlock.
    for (const line of lines) await assertVariantExists(tx, line.variantId);
    await lockStock(tx, lines.map((l) => ({ variantId: l.variantId, branchId: input.branchId })));
    const result: { variantId: string; onHand: number }[] = [];
    for (const line of lines) {
      const row = await applyMovement(tx, {
        variantId: line.variantId,
        branchId: input.branchId,
        deltaOnHand: -line.qty,
        reason: 'store_sale',
        refId: saleId,
        note: input.note,
        actorUserId: input.actorUserId,
      });
      result.push({ variantId: line.variantId, onHand: row.onHand });
    }
    return { saleId, lines: result };
  });
}

export async function adjustStock(
  db: Db,
  input: { variantId: string; branchId: string; delta: number; note: string; actorUserId?: string | null },
): Promise<StockRow> {
  return db.transaction((tx) =>
    applyMovement(tx, {
      variantId: input.variantId,
      branchId: input.branchId,
      deltaOnHand: input.delta,
      reason: 'admin_adjust',
      note: input.note,
      actorUserId: input.actorUserId,
    }),
  );
}

export async function transferStock(
  db: Db,
  input: { variantId: string; from: string; to: string; qty: number; actorUserId?: string | null },
): Promise<{ refId: string }> {
  const refId = `XFER-${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.transaction(async (tx) => {
    await assertVariantExists(tx, input.variantId);
    // Lock both rows in the shared order, then apply out before in.
    await lockStock(tx, [input.from, input.to].map((branchId) => ({ variantId: input.variantId, branchId })));
    const common = { variantId: input.variantId, refId, actorUserId: input.actorUserId };
    await applyMovement(tx, { ...common, branchId: input.from, deltaOnHand: -input.qty, reason: 'transfer_out' });
    await applyMovement(tx, { ...common, branchId: input.to, deltaOnHand: input.qty, reason: 'transfer_in' });
  });
  return { refId };
}
