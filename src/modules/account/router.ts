import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { toUserView } from '../users/view.js';

export function accountRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/me', ...ctx.member, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: toUserView(req.user!) });
  });

  return router;
}
