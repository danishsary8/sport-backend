import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { orders } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { loadOrderView } from './load.js';
import { listMemberOrders, trackOrder } from './tracking.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function customerOrdersRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const assetBase = ctx.config.assetBaseUrl;

  router.post(
    '/orders/track',
    noStore,
    ctx.routeLimit('track', 10),
    validate({ body: z.object({ orderNumber: z.string().trim().max(40), phone: z.string().trim().max(40), lang: langSchema }) }),
    async (req, res) => {
      const body = req.body as { orderNumber: string; phone: string; lang: Lang };
      res.json(await trackOrder(db, body.orderNumber, normalizePhone(body.phone), { lang: body.lang, assetBase, tokenSecret: ctx.config.cookieSecret, now: new Date() }));
    },
  );

  router.get(
    '/me/orders',
    noStore,
    ...ctx.member,
    validate({ query: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20), lang: langSchema }) }),
    async (req, res) => {
      const q = req.query as unknown as { page: number; pageSize: number; lang: Lang };
      res.json(await listMemberOrders(db, req.user!.id, q.page, q.pageSize, { lang: q.lang, assetBase }));
    },
  );

  router.get('/me/orders/:number', noStore, ...ctx.member, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.number, String(req.params.number).toUpperCase()), eq(orders.userId, req.user!.id)));
    if (!order) throw new AppError('order_not_found', 404, 'Order not found');
    res.json(await loadOrderView(db, order, { lang: (req.query as { lang: Lang }).lang, assetBase }));
  });

  return router;
}
