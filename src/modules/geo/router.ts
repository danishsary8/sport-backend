import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { geoCommunes, geoDistricts, geoProvinces } from '../../db/schema/index.js';
import { validate } from '../../middleware/validate.js';

const CACHE = 'public, max-age=86400';
const code = z.string().trim().regex(/^\d{1,8}$/, 'Must be a numeric code');

export function geoRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const columns = (t: typeof geoProvinces | typeof geoDistricts | typeof geoCommunes) => ({
    code: t.code,
    nameEn: t.nameEn,
    nameKm: t.nameKm,
  });

  router.get('/geo/provinces', async (_req, res) => {
    const provinces = await db.select(columns(geoProvinces)).from(geoProvinces).orderBy(asc(geoProvinces.nameEn));
    res.setHeader('Cache-Control', CACHE);
    res.json({ provinces });
  });

  router.get('/geo/districts', validate({ query: z.object({ provinceCode: code }) }), async (req, res) => {
    const { provinceCode } = req.query as unknown as { provinceCode: string };
    const districts = await db
      .select(columns(geoDistricts))
      .from(geoDistricts)
      .where(eq(geoDistricts.provinceCode, provinceCode))
      .orderBy(asc(geoDistricts.nameEn));
    res.setHeader('Cache-Control', CACHE);
    res.json({ districts });
  });

  router.get('/geo/communes', validate({ query: z.object({ districtCode: code }) }), async (req, res) => {
    const { districtCode } = req.query as unknown as { districtCode: string };
    const communes = await db
      .select(columns(geoCommunes))
      .from(geoCommunes)
      .where(eq(geoCommunes.districtCode, districtCode))
      .orderBy(asc(geoCommunes.nameEn));
    res.setHeader('Cache-Control', CACHE);
    res.json({ communes });
  });

  return router;
}
