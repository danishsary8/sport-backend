import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { toUserView } from '../users/view.js';
import { deleteAccount, profilePatchSchema, updateProfile } from './service.js';

export function accountRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  router.use('/me', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/me', ...ctx.member, (req, res) => {
    res.json({ user: toUserView(req.user!) });
  });

  router.patch('/me', ...ctx.member, validate({ body: profilePatchSchema }), async (req, res) => {
    const user = await updateProfile(db, req.user!, req.body);
    res.json({ user: toUserView(user) });
  });

  router.delete('/me', ...ctx.member, async (req, res) => {
    await deleteAccount(db, ctx.identity, ctx.logger, req.user!);
    res.status(204).end();
  });

  return router;
}
