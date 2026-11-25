import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { branches, shippingMethods, shippingRates } from '../../db/schema/index.js';
import { validate } from '../../middleware/validate.js';
import { cartOwner } from '../cart/owner.js';
import { findCart } from '../cart/service.js';
import { langSchema, pick, type Lang } from '../catalog/i18n.js';
import { deliveryRate, type DeliveryChoice } from '../pricing/context.js';
import { availablePaymentMethods, paymentMethodsEnabled } from '../settings/payments.js';
import { pricedCheckout } from './pricing.js';

const DELIVERY_METHODS = ['pp_rider', 'province_courier'] as const;

export const quoteSchema = z.object({
  fulfillment: z.enum(['delivery', 'pickup']),
  shippingMethodId: z.string().trim().max(40).optional(),
  provinceCode: z.string().trim().regex(/^\d{1,3}$/).optional(),
  pickupBranchId: z.string().trim().max(40).optional(),
  promoCode: z.string().trim().min(1).max(40).optional(),
  lang: langSchema,
});
type QuoteInput = z.infer<typeof quoteSchema>;

export function deliveryChoiceOf(input: Pick<QuoteInput, 'fulfillment' | 'shippingMethodId' | 'provinceCode' | 'pickupBranchId'>): DeliveryChoice {
  return input.fulfillment === 'pickup'
    ? { fulfillment: 'pickup', pickupBranchId: input.pickupBranchId }
    : { fulfillment: 'delivery', methodId: input.shippingMethodId, provinceCode: input.provinceCode };
}

export function checkoutRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  router.post('/checkout/quote', ...ctx.guestOrMember, validate({ body: quoteSchema }), async (req: Request, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const input = req.body as QuoteInput;
    const lang = input.lang as Lang;
    const cart = await findCart(db, cartOwner(req, ctx.config));
    const priced = await pricedCheckout(db, cart, {
      user: req.user,
      delivery: deliveryChoiceOf(input),
      lang,
      assetBase: ctx.config.assetBaseUrl,
      promoOverride: input.promoCode,
    });

    const methods = await db.select().from(shippingMethods).where(eq(shippingMethods.active, true)).orderBy(asc(shippingMethods.sort));
    const shippingOptions = [];
    for (const methodId of DELIVERY_METHODS) {
      const method = methods.find((m) => m.id === methodId);
      if (!method) continue;
      const rate = input.provinceCode ? await deliveryRate(db, { fulfillment: 'delivery', methodId, provinceCode: input.provinceCode }) : null;
      const fee = rate?.rate ? priced.reprice(rate).shippingCents : null;
      const [eta] = rate?.rate
        ? await db
            .select({ eta: shippingRates.etaI18n })
            .from(shippingRates)
            .where(and(eq(shippingRates.methodId, methodId), or(eq(shippingRates.provinceCode, input.provinceCode!), isNull(shippingRates.provinceCode))))
            .orderBy(sql`${shippingRates.provinceCode} is null`)
            .limit(1)
        : [];
      shippingOptions.push({ methodId, name: pick(method.nameI18n, lang), available: fee !== null, feeCents: fee, eta: pick(eta?.eta ?? null, lang) });
    }
    const pickupBranches = (await db.select({ id: branches.id, name: branches.name, pickupEnabled: branches.pickupEnabled }).from(branches).orderBy(asc(branches.sort)))
      .filter((b) => b.pickupEnabled)
      .map((b) => ({ id: b.id, name: b.name }));

    res.json({
      cart: priced.view,
      shippingOptions,
      pickupBranches,
      paymentMethods: availablePaymentMethods(await paymentMethodsEnabled(db), input.fulfillment),
    });
  });

  return router;
}
