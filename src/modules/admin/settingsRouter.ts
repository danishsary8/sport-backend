import { inArray, sql } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { PAYMENT_METHODS, settings } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';

const i18nText = z.strictObject({ en: z.string().trim().min(1).max(200), km: z.string().trim().max(200).optional() });

const sizeGuide = z
  .strictObject({
    title: i18nText,
    columns: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    rows: z.array(z.array(z.string().trim().max(40))).max(60),
    note: z.strictObject({ en: z.string().trim().max(500), km: z.string().trim().max(500).optional() }).nullable(),
  })
  .refine((g) => g.rows.every((r) => r.length === g.columns.length), { message: 'Every row needs one value per column', path: ['rows'] });

/** Shop settings an admin may change, each with its own shape. Pricing settings live in pricingRouter. */
export const OPERATIONAL_SETTINGS = {
  payment_methods_enabled: z.strictObject(Object.fromEntries(PAYMENT_METHODS.map((m) => [m, z.boolean()])) as Record<(typeof PAYMENT_METHODS)[number], z.ZodBoolean>),
  reservation_minutes: z.strictObject({ minutes: z.number().int().min(10).max(120) }),
  cash_on_pickup_hours: z.strictObject({ hours: z.number().int().min(1).max(168) }),
  online_safety_buffer: z.strictObject({ units: z.number().int().min(0).max(10) }),
  return_rules: z
    .strictObject({
      exchangeDays: z.number().int().min(0).max(365),
      refundDays: z.number().int().min(0).max(365),
      nonReturnable: z.array(z.string().trim().min(1).max(60)).max(50),
    })
    .refine((r) => r.refundDays <= r.exchangeDays, { message: 'The refund window cannot be longer than the exchange window', path: ['refundDays'] }),
  /** Prices end in .90 ($12 → $11.90) when on; off saves prices exactly as typed. */
  price_rounding: z.strictObject({ endInNinety: z.boolean() }),
  size_guides: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), sizeGuide),
} as const;

type OperationalKey = keyof typeof OPERATIONAL_SETTINGS;
const isOperationalKey = (k: string): k is OperationalKey => Object.hasOwn(OPERATIONAL_SETTINGS, k);

export function adminSettingsRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const admin = [...ctx.member, requireRole('admin')];
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  router.get('/admin/settings', noStore, ...admin, async (_req, res) => {
    const rows = await db.select().from(settings).where(inArray(settings.key, Object.keys(OPERATIONAL_SETTINGS)));
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  });

  router.put('/admin/settings/:key', noStore, ...admin, async (req, res, next) => {
    const key = String(req.params.key);
    if (key === 'pricing') return next();
    if (!isOperationalKey(key)) throw new AppError('not_found', 404, 'Unknown setting');
    const parsed = OPERATIONAL_SETTINGS[key].safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('validation_failed', 400, 'Validation failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    await db
      .insert(settings)
      .values({ key, value: parsed.data })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data, updatedAt: sql`now()` } });
    ctx.logger.info({ actorId: req.user!.id, key, value: parsed.data }, 'Setting updated');
    res.json({ key, value: parsed.data });
  });

  return router;
}
