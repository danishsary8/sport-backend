import { desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { loyaltyAccounts, loyaltyLedger, orders, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { loadRules } from '../pricing/context.js';
import type { LoyaltyRules, TierId } from '../pricing/types.js';
import { memberInsights } from './insights.js';
import { tierForSpend } from './math.js';

const RANK: Record<TierId, number> = { bronze: 0, silver: 1, gold: 2, pro: 3 };

/** The perks a tier enjoys, from the loyalty rules (cumulative up the tiers). */
export function perksFor(tier: TierId, rules: LoyaltyRules) {
  const at = (t: TierId) => RANK[tier] >= RANK[t];
  return {
    ...(at(rules.memberDiscount.fromTier) ? { memberDiscountPercent: rules.memberDiscount.percent, memberDiscountCategories: rules.memberDiscount.categories } : {}),
    ...(at(rules.freeDelivery.fromTier) ? { freeDelivery: rules.freeDelivery.methods } : {}),
    ...(at(rules.freePrinting.fromTier) ? { freePrinting: true } : {}),
  };
}

export function loyaltyRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const noStore = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  router.get('/me/loyalty', noStore, ...ctx.member, async (req, res) => {
    const user = req.user!;
    const rules = (await loadRules(db)).loyalty;
    const [account] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, user.id));
    const spend = account?.lifetimeSpendCents ?? 0;
    const tier = (account?.tier as TierId | undefined) ?? tierForSpend(spend, rules.tiers);
    const next = [...rules.tiers].sort((a, b) => a.minSpendCents - b.minSpendCents).find((t) => t.minSpendCents > spend && RANK[t.id] > RANK[tier]);
    const ledger = await db
      .select({ delta: loyaltyLedger.delta, reason: loyaltyLedger.reason, note: loyaltyLedger.note, createdAt: loyaltyLedger.createdAt, orderNumber: orders.number })
      .from(loyaltyLedger)
      .leftJoin(orders, eq(orders.id, loyaltyLedger.orderId))
      .where(eq(loyaltyLedger.userId, user.id))
      .orderBy(desc(loyaltyLedger.id))
      .limit(50);
    res.json({
      pointsBalance: account?.pointsBalance ?? 0,
      tier,
      lifetimeSpendCents: spend,
      nextTier: next ? { id: next.id, minSpendCents: next.minSpendCents, remainingCents: next.minSpendCents - spend } : null,
      perks: perksFor(tier, rules),
      pointsPerUsd: rules.pointsPerUsd,
      phoneVerified: Boolean(user.phoneE164),
      ledger: ledger.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    });
  });

  router.get('/me/insights', noStore, ...ctx.member, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    res.json(await memberInsights(db, req.user!.id, (req.query as { lang: Lang }).lang));
  });

  router.post(
    '/admin/users/:id/loyalty',
    noStore,
    ...ctx.member,
    requireRole('admin'),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ delta: z.number().int().min(-100_000).max(100_000).refine((d) => d !== 0, 'Must not be zero'), note: z.string().trim().min(1).max(200) }),
    }),
    async (req, res) => {
      const { id } = req.params as { id: string };
      const { delta, note } = req.body as { delta: number; note: string };
      const result = await db.transaction(async (tx) => {
        const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id));
        if (!user) throw new AppError('not_found', 404, 'User not found');
        await tx.insert(loyaltyAccounts).values({ userId: id }).onConflictDoNothing();
        const [account] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, id)).for('update');
        if (account!.pointsBalance + delta < 0) throw new AppError('insufficient_points', 409, `This member only has ${account!.pointsBalance} points`);
        await tx.insert(loyaltyLedger).values({ userId: id, delta, reason: 'admin', note, actorUserId: req.user!.id });
        const [updated] = await tx
          .update(loyaltyAccounts)
          .set({ pointsBalance: sql`${loyaltyAccounts.pointsBalance} + ${delta}`, updatedAt: sql`now()` })
          .where(eq(loyaltyAccounts.userId, id))
          .returning();
        return updated!;
      });
      res.json({ pointsBalance: result.pointsBalance, tier: result.tier, lifetimeSpendCents: result.lifetimeSpendCents });
    },
  );

  return router;
}
