import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ORDER_STATUSES, type OrderStatus } from '../../db/schema/index.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { recordEvent } from './events.js';
import {
  adminOrderDetail,
  cancelOrder,
  clearRefundFlag,
  closeProviderAttempts,
  collectCash,
  listAdminOrders,
  markRefunded,
  orderScope,
  withStaffOrder,
  type AdminOrderFilters,
} from './admin.js';
import { transitionOrder } from './transition.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const note = z.string().trim().min(1).max(500);

export function adminOrdersRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const staff = [...ctx.member, requireRole('staff', 'admin')];
  const detail = (req: Request) =>
    adminOrderDetail(db, String(req.params.number), orderScope(req.user!), { lang: (req.query.lang as Lang | undefined) ?? 'en', assetBase: ctx.config.assetBaseUrl });

  router.use('/admin/orders', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/admin/orders',
    ...staff,
    validate({
      query: z.object({
        q: z.string().trim().min(1).max(40).optional(),
        status: z.enum(ORDER_STATUSES).optional(),
        branch: z.string().trim().max(40).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        needsRefund: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
    }),
    async (req, res) => {
      res.json(await listAdminOrders(db, orderScope(req.user!), req.query as unknown as AdminOrderFilters));
    },
  );

  router.get('/admin/orders/:number', ...staff, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/status', ...staff, validate({ body: z.object({ to: z.enum(ORDER_STATUSES), note: note.optional() }) }), async (req, res) => {
    const { to, note: text } = req.body as { to: OrderStatus; note?: string };
    if (to === 'cancelled') {
      const toClose = await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => cancelOrder(tx, order, req.user!.id, text ?? 'Cancelled by staff'));
      await closeProviderAttempts(ctx.payments, toClose);
    } else {
      await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => transitionOrder(tx, order, to, req.user!.id, text));
    }
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/cancel', ...staff, validate({ body: z.object({ reason: note }) }), async (req, res) => {
    const toClose = await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => cancelOrder(tx, order, req.user!.id, req.body.reason));
    await closeProviderAttempts(ctx.payments, toClose);
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/collect-cash', ...staff, async (req, res) => {
    const toClose = await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => collectCash(tx, order, req.user!.id));
    await closeProviderAttempts(ctx.payments, toClose);
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/refunded', ...staff, validate({ body: z.object({ note: note.optional() }) }), async (req, res) => {
    await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => markRefunded(tx, order, req.user!.id, req.body.note));
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/clear-refund-flag', ...staff, validate({ body: z.object({ note }) }), async (req, res) => {
    await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) => clearRefundFlag(tx, order, req.user!.id, req.body.note));
    res.json(await detail(req));
  });

  router.post('/admin/orders/:number/notes', ...staff, validate({ body: z.object({ note }) }), async (req, res) => {
    await withStaffOrder(db, String(req.params.number), orderScope(req.user!), (tx, order) =>
      recordEvent(tx, { orderId: order.id, kind: 'note', actor: req.user!.id, note: req.body.note }),
    );
    res.json(await detail(req));
  });

  return router;
}
