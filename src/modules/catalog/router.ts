import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { buildFacets } from './facets.js';
import { catalogQuerySchema, listProducts, resolveFilters, safetyBuffer, type CatalogQuery } from './listing.js';
import { toCard } from './view.js';

export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

export function catalogRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  router.get('/catalog/products', validate({ query: catalogQuerySchema }), async (req, res) => {
    const query = req.query as unknown as CatalogQuery;
    const [filters, buffer] = await Promise.all([resolveFilters(db, query), safetyBuffer(db)]);
    const { rows, total } = await listProducts(db, filters, { ...query, buffer });
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json({
      products: rows.map((r) => toCard(r, query.lang, ctx.config.assetBaseUrl)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  router.get('/catalog/filters', validate({ query: catalogQuerySchema }), async (req, res) => {
    const query = req.query as unknown as CatalogQuery;
    const [filters, buffer] = await Promise.all([resolveFilters(db, query), safetyBuffer(db)]);
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json(await buildFacets(db, filters, query.lang, buffer));
  });

  return router;
}
