import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { toUserView } from '../users/view.js';
import {
  addressCreateSchema,
  addressPatchSchema,
  createAddress,
  deleteAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
} from './addresses.js';
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

  router.get('/me/addresses', ...ctx.member, async (req, res) => {
    res.json({ addresses: await listAddresses(db, req.user!.id) });
  });

  router.post('/me/addresses', ...ctx.member, validate({ body: addressCreateSchema }), async (req, res) => {
    res.status(201).json({ address: await createAddress(db, req.user!.id, req.body) });
  });

  router.patch('/me/addresses/:id', ...ctx.member, validate({ body: addressPatchSchema }), async (req, res) => {
    res.json({ address: await updateAddress(db, req.user!.id, String(req.params.id), req.body) });
  });

  router.post('/me/addresses/:id/default', ...ctx.member, async (req, res) => {
    res.json({ address: await setDefaultAddress(db, req.user!.id, String(req.params.id)) });
  });

  router.delete('/me/addresses/:id', ...ctx.member, async (req, res) => {
    await deleteAddress(db, req.user!.id, String(req.params.id));
    res.status(204).end();
  });

  return router;
}
