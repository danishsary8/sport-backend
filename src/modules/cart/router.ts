import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { customPrintSchema } from '../pricing/print.js';
import { cartOwner, setCartCookie } from './owner.js';
import { addItem, cartView, DEFAULT_DELIVERY, findCart, removeItem, setPromo, updateItem } from './service.js';

const viewQuery = z.object({
  fulfillment: z.enum(['delivery', 'pickup']).default('delivery'),
  shippingMethodId: z.string().trim().max(40).optional(),
  provinceCode: z.string().trim().regex(/^\d{1,3}$/).optional(),
  pickupBranchId: z.string().trim().max(40).optional(),
  lang: langSchema,
});
type ViewQuery = z.infer<typeof viewQuery>;

const qty = z.number().int().min(1).max(20);
const uuid = z.string().uuid();

export function cartRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const chain = [...ctx.guestOrMember, validate({ query: viewQuery })];

  router.use('/cart', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  async function respond(req: Request, res: Response, newToken?: string): Promise<void> {
    if (newToken) setCartCookie(res, newToken, ctx.config);
    const q = req.query as unknown as ViewQuery;
    const owner = newToken ? ({ kind: 'guest', token: newToken } as const) : cartOwner(req, ctx.config);
    const delivery =
      q.fulfillment === 'pickup'
        ? { fulfillment: 'pickup' as const, pickupBranchId: q.pickupBranchId }
        : q.shippingMethodId || q.provinceCode
          ? { fulfillment: 'delivery' as const, methodId: q.shippingMethodId ?? 'pp_rider', provinceCode: q.provinceCode ?? '12' }
          : DEFAULT_DELIVERY;
    const cart = await findCart(db, owner);
    res.json({
      cart: await cartView(db, cart, { user: req.user, delivery, lang: q.lang as Lang, assetBase: ctx.config.assetBaseUrl }),
    });
  }

  router.get('/cart', ...chain, async (req, res) => {
    await respond(req, res);
  });

  router.post(
    '/cart/items',
    ...chain,
    validate({ body: z.object({ variantId: uuid, qty, customPrint: customPrintSchema.optional() }) }),
    async (req, res) => {
      const { newToken } = await addItem(db, cartOwner(req, ctx.config), req.body);
      await respond(req, res, newToken);
    },
  );

  router.patch(
    '/cart/items/:id',
    ...chain,
    validate({
      body: z
        .object({ qty: qty.optional(), variantId: uuid.optional() })
        .refine((v) => v.qty !== undefined || v.variantId !== undefined, { message: 'Nothing to update' }),
    }),
    async (req, res) => {
      await updateItem(db, cartOwner(req, ctx.config), String(req.params.id), req.body);
      await respond(req, res);
    },
  );

  router.delete('/cart/items/:id', ...chain, async (req, res) => {
    await removeItem(db, cartOwner(req, ctx.config), String(req.params.id));
    await respond(req, res);
  });

  router.put('/cart/promo', ...chain, validate({ body: z.object({ code: z.string().trim().min(1).max(40) }) }), async (req, res) => {
    const { newToken } = await setPromo(db, cartOwner(req, ctx.config), req.body.code);
    await respond(req, res, newToken);
  });

  router.delete('/cart/promo', ...chain, async (req, res) => {
    await setPromo(db, cartOwner(req, ctx.config), null);
    await respond(req, res);
  });

  return router;
}
