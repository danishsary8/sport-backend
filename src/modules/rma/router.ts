import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { langSchema, type Lang } from '../catalog/i18n.js';
import { orderScope } from '../orders/admin.js';
import { adminRma, createRma, decideRma, listAdminRmas, listMemberRmas, rmaCreateSchema, type RmaCreateInput } from './service.js';

export function rmaRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const staff = [...ctx.member, requireRole('staff', 'admin')];
  const lang = (q: unknown) => ((q as { lang?: Lang }).lang ?? 'en') as Lang;

  for (const path of ['/me/returns', '/admin/returns']) {
    router.use(path, (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
  }

  router.post('/me/returns', ...ctx.member, validate({ body: rmaCreateSchema, query: z.object({ lang: langSchema }) }), async (req, res) => {
    res.status(201).json({ return: await createRma(db, req.user!, req.body as RmaCreateInput, new Date(), lang(req.query)) });
  });

  router.get('/me/returns', ...ctx.member, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    res.json({ returns: await listMemberRmas(db, req.user!.id, lang(req.query)) });
  });

  router.get(
    '/admin/returns',
    ...staff,
    validate({
      query: z.object({
        status: z.enum(['requested', 'approved', 'rejected']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        lang: langSchema,
      }),
    }),
    async (req, res) => {
      const q = req.query as unknown as { status?: string; page: number; pageSize: number; lang: Lang };
      res.json(await listAdminRmas(db, orderScope(req.user!).branchId, q, q.lang));
    },
  );

  router.get('/admin/returns/:number', ...staff, validate({ query: z.object({ lang: langSchema }) }), async (req, res) => {
    res.json({ return: await adminRma(db, orderScope(req.user!).branchId, String(req.params.number), lang(req.query)) });
  });

  router.post(
    '/admin/returns/:number/decision',
    ...staff,
    validate({ body: z.object({ decision: z.enum(['approve', 'reject']), branchId: z.string().trim().max(40).optional(), note: z.string().trim().max(500).optional() }) }),
    async (req, res) => {
      res.json({ return: await decideRma(db, req.user!, String(req.params.number), req.body, orderScope(req.user!).branchId) });
    },
  );

  return router;
}
