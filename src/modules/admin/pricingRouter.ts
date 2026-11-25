import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { PROMOTION_TYPES, promotions, settings, shippingRates } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { isPricingSettingKey, PRICING_SETTINGS } from '../pricing/rulesSchema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugs = z.array(z.string().trim().min(1).max(40)).max(20);
const promoFields = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(PROMOTION_TYPES),
  value: z.number().int().min(0).max(10_000_000),
  minSubtotalCents: z.number().int().min(0).max(10_000_000),
  scope: z.object({ categories: slugs.optional(), brands: slugs.optional(), methods: slugs.optional() }),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
  maxUses: z.number().int().min(1).nullable(),
  maxUsesPerUser: z.number().int().min(1).nullable(),
  active: z.boolean(),
};
const valueOk = (v: { type?: string; value?: number }) =>
  v.type === undefined || v.value === undefined || (v.type === 'percent' ? v.value >= 1 && v.value <= 100 : v.type === 'fixed' ? v.value >= 1 : true);
const valueMessage = { message: 'Percent codes need 1–100; fixed codes need at least 1 cent', path: ['value'] };

interface PromoShape {
  type: string;
  value: number;
  scope?: { categories?: string[]; brands?: string[]; methods?: string[] } | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

/** Rules across fields: dates in order, free delivery is a delivery effect only, money-off never targets delivery methods. */
export function promoProblems(p: PromoShape): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  if (p.startsAt && p.endsAt && p.startsAt >= p.endsAt) problems.push({ path: 'endsAt', message: 'Must be after startsAt' });
  const scope = p.scope ?? {};
  if (p.type === 'free_shipping') {
    if (p.value !== 0) problems.push({ path: 'value', message: 'Free delivery promotions have value 0' });
    if (scope.categories?.length || scope.brands?.length) problems.push({ path: 'scope', message: 'Free delivery applies to the whole order; remove categories/brands' });
  } else if (scope.methods?.length) {
    problems.push({ path: 'scope.methods', message: 'Only free delivery promotions can be limited to delivery methods' });
  }
  return problems;
}

const promoCreate = z
  .object({
    code: z.string().trim().min(3).max(30).transform((c) => c.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_-]+$/, 'Use A–Z, 0–9, _ and -')),
    ...promoFields,
    minSubtotalCents: promoFields.minSubtotalCents.default(0),
    scope: promoFields.scope.default({}),
    startsAt: promoFields.startsAt.optional(),
    endsAt: promoFields.endsAt.optional(),
    maxUses: promoFields.maxUses.optional(),
    maxUsesPerUser: promoFields.maxUsesPerUser.optional(),
    active: promoFields.active.default(true),
    value: promoFields.value.default(0),
  })
  .refine(valueOk, valueMessage);
const promoPatch = z
  .object(promoFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const ratePut = z.object({
  feeCents: z.number().int().min(0).max(1_000_000),
  freeOverCents: z.number().int().min(0).max(10_000_000).nullable(),
  etaEn: z.string().trim().max(60).optional(),
  etaKm: z.string().trim().max(60).optional(),
});

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

export function adminPricingRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const admin = [...ctx.member, requireRole('admin')];
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  router.use(['/admin/promotions', '/admin/shipping-rates', '/admin/settings'], noStore);

  router.get('/admin/promotions', ...admin, async (_req, res) => {
    res.json({ promotions: await db.select().from(promotions).orderBy(asc(promotions.code)) });
  });

  router.post('/admin/promotions', ...admin, validate({ body: promoCreate }), async (req, res) => {
    const problems = promoProblems(req.body);
    if (problems.length) throw new AppError('validation_failed', 400, 'Validation failed', problems);
    try {
      const [promotion] = await db.insert(promotions).values(req.body).returning();
      ctx.logger.info({ actorId: req.user!.id, code: promotion!.code }, 'Promotion created');
      res.status(201).json({ promotion });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('code_taken', 409, 'That code already exists');
      throw error;
    }
  });

  router.patch('/admin/promotions/:id', ...admin, validate({ body: promoPatch }), async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Promotion not found');
    const [current] = await db.select().from(promotions).where(eq(promotions.id, id));
    if (!current) throw new AppError('not_found', 404, 'Promotion not found');
    if (!valueOk({ type: req.body.type ?? current.type, value: req.body.value ?? current.value })) {
      throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'value', message: valueMessage.message }]);
    }
    const problems = promoProblems({ ...current, ...req.body });
    if (problems.length) throw new AppError('validation_failed', 400, 'Validation failed', problems);
    const [promotion] = await db.update(promotions).set(req.body).where(eq(promotions.id, id)).returning();
    ctx.logger.info({ actorId: req.user!.id, code: promotion!.code, change: req.body }, 'Promotion updated');
    res.json({ promotion });
  });

  router.get('/admin/shipping-rates', ...admin, async (_req, res) => {
    res.json({ rates: await db.select().from(shippingRates).orderBy(asc(shippingRates.methodId), asc(shippingRates.provinceCode)) });
  });

  router.put('/admin/shipping-rates/:id', ...admin, validate({ body: ratePut }), async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Rate not found');
    const { etaEn, etaKm, ...fees } = req.body as z.infer<typeof ratePut>;
    const [current] = await db.select().from(shippingRates).where(eq(shippingRates.id, id));
    if (!current) throw new AppError('not_found', 404, 'Rate not found');
    const eta = etaEn || etaKm ? { en: etaEn ?? current.etaI18n?.en ?? '', ...(etaKm ? { km: etaKm } : {}) } : current.etaI18n;
    const [rate] = await db
      .update(shippingRates)
      .set({ ...fees, etaI18n: eta, needsReview: false })
      .where(eq(shippingRates.id, id))
      .returning();
    ctx.logger.info({ actorId: req.user!.id, rateId: id, ...fees }, 'Shipping rate updated');
    res.json({ rate });
  });

  router.get('/admin/settings/pricing', ...admin, async (_req, res) => {
    const rows = await db.select().from(settings).where(inArray(settings.key, Object.keys(PRICING_SETTINGS)));
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  });

  router.put('/admin/settings/pricing/:key', ...admin, async (req, res) => {
    const key = String(req.params.key);
    if (!isPricingSettingKey(key)) throw new AppError('not_found', 404, 'Unknown pricing setting');
    const parsed = PRICING_SETTINGS[key].safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'validation_failed',
        400,
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    await db
      .insert(settings)
      .values({ key, value: parsed.data })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data, updatedAt: sql`now()` } });
    ctx.logger.info({ actorId: req.user!.id, key }, 'Pricing setting updated');
    res.json({ key, value: parsed.data });
  });

  return router;
}
