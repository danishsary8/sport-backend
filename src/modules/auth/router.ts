import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { readCookie, verify } from '../../lib/signedCookie.js';
import { mergeGuestCart } from '../cart/merge.js';
import { CART_COOKIE, clearCartCookie } from '../cart/owner.js';
import { toUserView } from '../users/view.js';

export function authRouter(ctx: AppContext): Router {
  const router = Router();

  // Called by the frontend right after Firebase sign-in. Creates the user on first login and
  // moves any guest bag (sc_cart cookie) into the member's bag.
  router.post('/auth/session', ctx.routeLimit('session', 20), ...ctx.member, async (req, res) => {
    const raw = readCookie(req, CART_COOKIE);
    const token = raw ? verify(raw, ctx.config.cookieSecret) : null;
    let cartMerged: { mergedLines: number; cappedLines: number } | undefined;
    if (raw) {
      if (token) cartMerged = (await mergeGuestCart(ctx.database.db, token, req.user!.id)) ?? undefined;
      clearCartCookie(res, ctx.config);
    }
    res.json({ user: toUserView(req.user!), created: req.userCreated === true, ...(cartMerged ? { cartMerged } : {}) });
  });

  return router;
}
