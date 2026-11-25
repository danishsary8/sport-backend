import { asc } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { branches } from '../../db/schema/index.js';

export function branchesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/branches', async (_req, res) => {
    const rows = await ctx.database.db.select().from(branches).orderBy(asc(branches.sort));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      branches: rows.map((b) => ({
        id: b.id,
        name: b.name,
        shortName: b.shortName,
        address: b.address,
        district: b.district,
        phone: b.phoneE164,
        telegram: b.telegram,
        hours: b.hours,
        landmarks: b.landmarks,
        lat: b.lat,
        lng: b.lng,
        pickupEnabled: b.pickupEnabled,
      })),
    });
  });

  return router;
}
