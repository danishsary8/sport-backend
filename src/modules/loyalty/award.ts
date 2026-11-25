import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/exec.js';
import { loyaltyAccounts, loyaltyLedger, users, type OrderRow } from '../../db/schema/index.js';
import type { LoyaltyRules } from '../pricing/types.js';
import { pointsFor, tierForSpend } from './math.js';

/**
 * Points and lifetime spend for a paid order. Only members with a verified phone earn; the ledger's
 * unique (order, order_paid) row makes a repeat call a no-op.
 */
export async function awardLoyalty(tx: Tx, order: OrderRow, rules: LoyaltyRules): Promise<void> {
  if (!order.userId) return;
  const [user] = await tx.select({ phone: users.phoneE164, deletedAt: users.deletedAt }).from(users).where(eq(users.id, order.userId));
  if (!user?.phone || user.deletedAt) return;
  const spend = Math.max(0, order.totalCents - order.shippingCents);
  const points = pointsFor(order.totalCents, order.shippingCents, rules.pointsPerUsd);
  const inserted = await tx
    .insert(loyaltyLedger)
    .values({ userId: order.userId, delta: points, reason: 'order_paid', orderId: order.id })
    .onConflictDoNothing()
    .returning({ id: loyaltyLedger.id });
  if (inserted.length === 0) return;
  await tx.insert(loyaltyAccounts).values({ userId: order.userId }).onConflictDoNothing();
  const [account] = await tx
    .update(loyaltyAccounts)
    .set({
      pointsBalance: sql`${loyaltyAccounts.pointsBalance} + ${points}`,
      lifetimeSpendCents: sql`${loyaltyAccounts.lifetimeSpendCents} + ${spend}`,
      updatedAt: sql`now()`,
    })
    .where(eq(loyaltyAccounts.userId, order.userId))
    .returning();
  const tier = tierForSpend(account!.lifetimeSpendCents, rules.tiers);
  if (tier !== account!.tier) await tx.update(loyaltyAccounts).set({ tier }).where(eq(loyaltyAccounts.userId, order.userId));
}

/**
 * Takes back points and spend (cancelled order, refunded return). The balance never goes below zero;
 * the tier is recomputed from the reduced lifetime spend.
 */
export async function reverseLoyalty(
  tx: Tx,
  userId: string,
  points: number,
  spendCents: number,
  reason: 'order_cancelled' | 'rma_reversal',
  orderId: string | null,
  rules: LoyaltyRules,
  note?: string,
): Promise<void> {
  const [account] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, userId)).for('update');
  if (!account) return;
  const take = Math.min(points, account.pointsBalance);
  const spend = Math.max(0, account.lifetimeSpendCents - spendCents);
  await tx.insert(loyaltyLedger).values({ userId, delta: -take, reason, orderId, note: note ?? null });
  await tx
    .update(loyaltyAccounts)
    .set({ pointsBalance: account.pointsBalance - take, lifetimeSpendCents: spend, tier: tierForSpend(spend, rules.tiers), updatedAt: sql`now()` })
    .where(eq(loyaltyAccounts.userId, userId));
}
