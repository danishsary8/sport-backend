import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { toUserView } from '../users/view.js';

export function authRouter(ctx: AppContext): Router {
  const router = Router();

  // Called by the frontend right after Firebase sign-in. Creates the user on first login.
  router.post('/auth/session', ...ctx.member, (req, res) => {
    // Phase 4: merge the guest cart (sc_cart cookie) into the member cart here.
    res.json({ user: toUserView(req.user!), created: req.userCreated === true });
  });

  return router;
}
