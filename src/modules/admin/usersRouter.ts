import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { changeRole, roleChangeSchema, searchUsers, userSearchSchema, type UserSearch } from '../users/admin.js';
import { toUserView } from '../users/view.js';

export function adminUsersRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const admin = [...ctx.member, requireRole('admin')];

  router.use('/admin/users', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/admin/users', ...admin, validate({ query: userSearchSchema }), async (req, res) => {
    const search = req.query as unknown as UserSearch;
    const { users, total } = await searchUsers(db, search);
    res.json({ users: users.map(toUserView), total, page: search.page, pageSize: search.pageSize });
  });

  router.patch('/admin/users/:id/role', ...admin, validate({ body: roleChangeSchema }), async (req, res) => {
    const user = await changeRole(db, req.user!, String(req.params.id), req.body);
    ctx.logger.info({ actorId: req.user!.id, targetId: user.id, role: user.role }, 'User role changed');
    res.json({ user: toUserView(user) });
  });

  return router;
}
