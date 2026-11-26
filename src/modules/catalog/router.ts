import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { collectionInfo, home, menu, suggest } from './browse.js';
import { productDetail } from './detail.js';
import { buildFacets } from './facets.js';
import { langSchema, type Lang } from './i18n.js';
import { catalogQuerySchema, listProducts, resolveFilters, safetyBuffer, type CatalogQuery } from './listing.js';
import { toCard } from './view.js';
import { loadRules } from '../pricing/context.js';
import { FONT_IDS, PATCH_IDS, type FontId, type PatchId } from '../pricing/print.js';

const PATCH_LABELS: Record<PatchId, string> = {
  none: 'No patch',
  ucl: 'Champions League',
  cpl: 'Cambodian Premier League',
  aff: 'AFF Championship',
  champions: 'Champions badge',
  'f1-paddock': 'F1 paddock',
};
const FONT_LABELS: Record<FontId, string> = { 'pro-condensed': 'Pro condensed', 'classic-block': 'Classic block', 'motorsport-aero': 'Motorsport aero' };

export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

export function catalogRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;

  async function listing(req: Request, res: Response): Promise<void> {
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
  }

  router.get('/catalog/products', validate({ query: catalogQuerySchema }), listing);

  // The search results page: the listing for a query (relevance first), with the same filters.
  router.get(
    '/search',
    validate({ query: catalogQuerySchema }),
    (req, _res, next) => {
      const q = (req.query as unknown as CatalogQuery).q;
      if (!q || q.length < 2) throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'q', message: 'Type at least 2 characters' }]);
      next();
    },
    listing,
  );

  router.get('/catalog/filters', validate({ query: catalogQuerySchema }), async (req, res) => {
    const query = req.query as unknown as CatalogQuery;
    const [filters, buffer] = await Promise.all([resolveFilters(db, query), safetyBuffer(db)]);
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json(await buildFacets(db, filters, query.lang, buffer));
  });

  const langQuery = z.object({ lang: langSchema });
  const lang = (q: unknown) => (q as { lang: Lang }).lang;

  router.get('/catalog/products/:slug', validate({ query: langQuery }), async (req, res) => {
    const buffer = await safetyBuffer(db);
    const product = await productDetail(db, String(req.params.slug), lang(req.query), ctx.config.assetBaseUrl, buffer);
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json({ product });
  });

  router.get(
    '/search/suggest',
    validate({ query: z.object({ q: z.string().trim().min(2).max(60), lang: langSchema }) }),
    async (req, res) => {
      const { q } = req.query as unknown as { q: string };
      const result = await suggest(db, q, lang(req.query), ctx.config.assetBaseUrl, await safetyBuffer(db));
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(result);
    },
  );

  router.get('/catalog/print-options', async (_req, res) => {
    const fees = (await loadRules(db)).printFees;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      baseCents: fees.baseCents,
      patches: PATCH_IDS.map((id) => ({ id, label: PATCH_LABELS[id], feeCents: fees.patches[id] ?? 0 })),
      fonts: FONT_IDS.map((id) => ({ id, label: FONT_LABELS[id] })),
      nameMaxLength: 14,
      numberMin: 1,
      numberMax: 99,
    });
  });

  router.get('/catalog/menu', validate({ query: langQuery }), async (req, res) => {
    const result = await menu(db, lang(req.query), await safetyBuffer(db));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(result);
  });

  router.get('/catalog/collections/:slug', validate({ query: langQuery }), async (req, res) => {
    const collection = await collectionInfo(db, String(req.params.slug), lang(req.query));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ collection });
  });

  router.get('/catalog/home', validate({ query: langQuery }), async (req, res) => {
    const sections = await home(db, lang(req.query), ctx.config.assetBaseUrl, await safetyBuffer(db));
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json({ sections });
  });

  return router;
}
